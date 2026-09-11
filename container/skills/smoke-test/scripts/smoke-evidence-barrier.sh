#!/usr/bin/env bash
# Refuse preliminary/final synthesis until every declared lane has a durable,
# SHA-bound terminal marker. This prevents a fast Slack session from racing a
# slower browser worker whose evidence is still being written.
set -euo pipefail

RUN_DIR="${1:-}"
PHASE="${2:-synthesis}"

if [ -z "$RUN_DIR" ]; then
  jq -cn '{ready:false,error:"usage: smoke-evidence-barrier.sh <run-dir> <lanes|synthesis>"}'
  exit 2
fi

case "$PHASE" in
  lanes|synthesis|disposition) ;;
  *)
    jq -cn --arg phase "$PHASE" '{ready:false,error:("unknown phase: " + $phase)}'
    exit 2
    ;;
esac

CONTRACT="$RUN_DIR/completion-contract.json"
if [ ! -s "$CONTRACT" ]; then
  jq -cn --arg path "$CONTRACT" '{ready:false,missing:[$path],invalid:[]}'
  exit 1
fi

if ! jq -e '
  .schemaVersion == 1 and
  (.sourceSha | type == "string" and test("^[0-9a-f]{40}$")) and
  (.requiredLaneMarkers | type == "array" and length > 0) and
  all(.requiredLaneMarkers[]; type == "string" and length > 0)
' "$CONTRACT" >/dev/null 2>&1; then
  jq -cn --arg path "$CONTRACT" '{ready:false,missing:[],invalid:[$path]}'
  exit 1
fi

SOURCE_SHA="$(jq -r '.sourceSha' "$CONTRACT")"
MISSING=()
INVALID=()
INVALID_REASONS=()

# Generation binds a marker to the CURRENT dispatch of its lane — added
# 2026-08-24 after PR #1188's run bit this three times: a re-dispatched lane's
# OLD terminal marker still satisfied this barrier (it was still sourceSha-
# correct and still terminal), so the barrier reported ready while a live
# worker was mid-flight, caught only by hand each time. The SAME hole let a
# contract re-scaffold silently pass too: lane B2 was repurposed from
# "permission crossings" to "publish/exports" under the same sourceSha, and
# the OLD B2 marker (written against the old meaning) still validated because
# nothing here has ever read what a lane id currently MEANS.
#
# `.lanes[]` in the contract is optional and BACKWARD COMPATIBLE — a contract
# without it (or without `.generation` on an entry) behaves exactly as before,
# because every lookup below defaults to generation 1 on both the contract
# and the marker side. Nothing changes until a coordinator actively bumps a
# lane's generation to signal "anything written before this does not count",
# which is the moment a re-dispatch or a re-scaffold actually happens.
LANES_HAVE_GENERATIONS="$(jq -r '(has("lanes") and (.lanes | type) == "array")' "$CONTRACT" 2>/dev/null)"
[ "$LANES_HAVE_GENERATIONS" = true ] || LANES_HAVE_GENERATIONS=false

expected_generation() {
  # $1 = lane id. Prints the generation the CURRENT contract expects, "1" when
  # the contract carries no lanes[] at all or no entry for this id.
  local lane_id="$1" found
  if [ "$LANES_HAVE_GENERATIONS" = true ]; then
    # `.lanes[]?` and `select(type=="object")` keep a malformed entry (a
    # stray non-object in the array) from turning into a jq runtime error
    # that would abort this whole script under `set -e` — a bad lanes[]
    # entry degrades to "generation not determinable, default 1", never a
    # crash with no verdict printed at all.
    found="$(jq -r --arg id "$lane_id" \
      '[.lanes[]? | select(type=="object") | select(.id == $id) | ((.generation // 1) | tostring)][0] // empty' \
      "$CONTRACT" 2>/dev/null)" || found=""
    [ -n "$found" ] && { printf '%s' "$found"; return; }
  fi
  printf '1'
}

# One jq call per invalid marker (never on the hot/valid path) to say WHICH
# check failed, in the order a reader would want to rule them out: identity
# first (wrong build, wrong lane), then staleness (right build, right lane,
# superseded dispatch), then shape (never even a real terminal marker).
invalid_reason() {
  local marker_path="$1" sha="$2" lane_id="$3" expected_gen="$4"
  jq -r --arg sha "$sha" --arg id "$lane_id" --arg gen "$expected_gen" '
    if .sourceSha != $sha then
      "sourceSha mismatch (marker=" + (.sourceSha // "missing") + ", expected=" + $sha + ") — a marker left over from a different build"
    elif ((.lane // $id) != $id) then
      "lane field mismatch (marker declares lane=\"" + (.lane // "missing") + "\", filename implies \"" + $id + "\")"
    elif (((.generation // 1) | tostring) != $gen) then
      "stale generation (marker generation " + ((.generation // 1) | tostring) + ", contract now expects " + $gen +
        ") — written against a superseded dispatch or a re-scaffolded lane definition; a fresh marker has not landed yet"
    elif (.status != "pass" and .status != "fail" and .status != "blocked" and .status != "void" and .status != "completed") then
      "status \"" + (.status // "missing") + "\" is not one of the terminal statuses"
    else
      "completedAt is missing or empty"
    end
  ' "$marker_path" 2>/dev/null || printf 'not valid JSON'
}

# A `pass` says the lane has affirmative evidence. Requiring a nonempty,
# regular file inside the run root makes that claim durable instead of letting
# an empty evidence array, a future screenshot path, or a host path clear the
# synthesis barrier. Non-pass markers deliberately do not use this check: a
# concrete blocker or failure reason is a valid terminal result even when no
# success evidence exists.
pass_evidence_problem() {
  local marker_path="$1" evidence_path candidate run_root resolved

  if ! jq -e '
    (.evidence | type == "array" and length > 0) and
    all(.evidence[];
      type == "string" and length > 0 and
      (index("\n") | not) and (index("\r") | not))
  ' "$marker_path" >/dev/null 2>&1; then
    printf 'pass marker requires a nonempty evidence array of one-line file paths'
    return
  fi

  run_root="$(realpath -e "$RUN_DIR" 2>/dev/null || true)"
  if [ -z "$run_root" ]; then
    printf 'run root cannot be resolved while validating pass evidence'
    return
  fi

  while IFS= read -r evidence_path; do
    case "$evidence_path" in
      /*|.|..|../*|*/../*|*/..)
        printf 'pass marker evidence path is absolute or escapes the run root: %s' "$evidence_path"
        return
        ;;
    esac
    candidate="$RUN_DIR/$evidence_path"
    if [ ! -e "$candidate" ]; then
      printf 'pass marker evidence file is missing: %s' "$evidence_path"
      return
    fi
    resolved="$(realpath -e "$candidate" 2>/dev/null || true)"
    case "$resolved" in
      "$run_root"/*) ;;
      *)
        printf 'pass marker evidence path resolves outside the run root: %s' "$evidence_path"
        return
        ;;
    esac
    if [ -L "$candidate" ] || [ ! -f "$candidate" ]; then
      printf 'pass marker evidence path is not a regular file in the run: %s' "$evidence_path"
      return
    fi
    if [ ! -s "$candidate" ]; then
      printf 'pass marker evidence file is empty: %s' "$evidence_path"
      return
    fi
  done < <(jq -r '.evidence[]' "$marker_path")
}

# A lane marker declaring one or more CONFIRMED findings (`.confirmedFindings`,
# an array of finding ids) must account for each finding's reproduction clip —
# silence about a promised clip is indistinguishable from "nobody recorded it
# and nobody noticed", the same failure mode pass-marker evidence above
# already guards against, mirrored here for clips. `.confirmedFindings` is
# optional and backward compatible, same convention as `.lanes[]` above: a
# marker without it is unaffected.
#
# Per finding id, the marker's `.evidence` array must carry exactly one of:
#   - "clips/<id>.mp4"                  a real, durable, nonempty file under
#                                        the run root — same file-path safety
#                                        checks as pass_evidence_problem above
#                                        (no absolute/traversal path, no
#                                        symlink escape, must be a regular
#                                        file).
#   - "clip-skipped: <id>: <reason>"    a stated, non-empty reason. The
#                                        `agent-browser` skill's reproduction-
#                                        clips convention treats a failed
#                                        recording (no ffmpeg, no browser
#                                        lease) as normal and non-blocking —
#                                        "a failed recording never blocks".
#                                        This is how that stays true while an
#                                        UNSTATED silence still fails.
# The finding id is embedded in the skip line (not a bare "clip-skipped:
# <reason>") because one marker can carry several confirmed findings and an
# unqualified reason would not say which one it excuses.
finding_clip_problem() {
  local marker_path="$1" finding_id clip_entry skip_prefix skip_reason
  local run_root candidate resolved

  if ! jq -e 'has("confirmedFindings")' "$marker_path" >/dev/null 2>&1; then
    return
  fi
  if ! jq -e '
    (.confirmedFindings | type == "array") and
    all(.confirmedFindings[]; type == "string" and length > 0)
  ' "$marker_path" >/dev/null 2>&1; then
    printf 'confirmedFindings must be an array of non-empty finding ids'
    return
  fi

  run_root="$(realpath -e "$RUN_DIR" 2>/dev/null || true)"
  if [ -z "$run_root" ]; then
    printf 'run root cannot be resolved while validating finding clip evidence'
    return
  fi

  while IFS= read -r finding_id; do
    case "$finding_id" in
      */*|.|..)
        printf 'confirmed finding id is not a safe path segment: %s' "$finding_id"
        return
        ;;
    esac

    clip_entry="clips/$finding_id.mp4"
    skip_prefix="clip-skipped: $finding_id: "

    # A well-formed skip line satisfies this finding on its own — no file to
    # check, matching "a failed recording never blocks".
    skip_reason="$(jq -r --arg pfx "$skip_prefix" '
      [(.evidence // [])[] | select(startswith($pfx)) | ltrimstr($pfx) | select(length > 0)][0] // empty
    ' "$marker_path" 2>/dev/null)"
    if [ -n "$skip_reason" ]; then
      continue
    fi

    if ! jq -e --arg e "$clip_entry" '(.evidence // []) | index($e) != null' \
      "$marker_path" >/dev/null 2>&1; then
      printf 'confirmed finding %s has no clip evidence: expected "%s" or a "%s<reason>" entry in evidence' \
        "$finding_id" "$clip_entry" "$skip_prefix"
      return
    fi

    candidate="$RUN_DIR/$clip_entry"
    if [ ! -e "$candidate" ]; then
      printf 'confirmed finding %s clip is missing: %s' "$finding_id" "$clip_entry"
      return
    fi
    resolved="$(realpath -e "$candidate" 2>/dev/null || true)"
    case "$resolved" in
      "$run_root"/*) ;;
      *)
        printf 'confirmed finding %s clip path resolves outside the run root: %s' \
          "$finding_id" "$clip_entry"
        return
        ;;
    esac
    if [ -L "$candidate" ] || [ ! -f "$candidate" ]; then
      printf 'confirmed finding %s clip path is not a regular file in the run: %s' \
        "$finding_id" "$clip_entry"
      return
    fi
    if [ ! -s "$candidate" ]; then
      printf 'confirmed finding %s clip is empty: %s' "$finding_id" "$clip_entry"
      return
    fi
  done < <(jq -r '.confirmedFindings[]?' "$marker_path")
}

# `disposition` gates the challenger's THREAD POST, not its file write.
#
# Independence was ordered around files, but the disposition is posted in the
# run thread with a mention — a transport that injects its full contents into
# the coordinator's context whether or not the coordinator's own conclusion is
# durable yet. On 2026-08-07 that is exactly what happened: the coordinator's
# preliminary opens "That did not hold, and it was not my choice… I read it
# first", and it struck a valid check on the challenger's say-so, reinstating
# it only after a worker executed the test. You cannot "check only for the
# existence" of a message already in your context.
#
# So the challenger may post once BOTH conclusions are durable: its own (it is
# not posting a conclusion it has not committed to) and the coordinator's (the
# post can no longer contaminate a preliminary that does not exist). Lane
# markers are deliberately NOT required — they belong to the coordinator's
# contract, and the challenger must never wait on the lanes it is challenging.
if [ "$PHASE" = "disposition" ]; then
  for required in challenger/disposition.md coordinator/preliminary.md; do
    [ -s "$RUN_DIR/$required" ] || MISSING+=("$required")
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    jq -cn --arg sha "$SOURCE_SHA" \
      --argjson missing "$(printf '%s\n' "${MISSING[@]-}" | jq -Rsc 'split("\n") | map(select(length > 0))')" \
      '{ready:false,phase:"disposition",sourceSha:$sha,missing:$missing,invalid:[]}'
    exit 1
  fi
  jq -cn --arg sha "$SOURCE_SHA" \
    '{ready:true,phase:"disposition",sourceSha:$sha,missing:[],invalid:[]}'
  exit 0
fi

while IFS= read -r marker; do
  case "$marker" in
    /*|../*|*/../*|*/..)
      INVALID+=("$marker")
      INVALID_REASONS+=("$marker: absolute or path-traversal marker path is not allowed in requiredLaneMarkers")
      continue
      ;;
  esac

  marker_path="$RUN_DIR/$marker"
  if [ ! -s "$marker_path" ]; then
    MISSING+=("$marker")
    continue
  fi

  # Lane id from the marker's own filename (the `markers/<ID>.json` convention
  # every real contract in this fleet already uses) — not from the marker's
  # `.lane` field, which is exactly the field a stale/mislabeled marker could
  # get wrong. expected_generation reads the CURRENT contract, not the marker.
  lane_id="$(basename "$marker" .json)"
  expected_gen="$(expected_generation "$lane_id")"

  marker_valid=true
  evidence_problem=""
  if ! jq -e --arg sha "$SOURCE_SHA" --arg id "$lane_id" --arg gen "$expected_gen" '
    .sourceSha == $sha and
    ((.lane // $id) == $id) and
    (((.generation // 1) | tostring) == $gen) and
    (.status == "pass" or
     .status == "fail" or
     .status == "blocked" or
     .status == "void" or
     .status == "completed") and
    (.completedAt | type == "string" and length > 0)
  ' "$marker_path" >/dev/null 2>&1; then
    marker_valid=false
  else
    if [ "$(jq -r '.status' "$marker_path" 2>/dev/null)" = pass ]; then
      evidence_problem="$(pass_evidence_problem "$marker_path")"
      [ -z "$evidence_problem" ] || marker_valid=false
    fi
    if [ "$marker_valid" = true ]; then
      evidence_problem="$(finding_clip_problem "$marker_path")"
      [ -z "$evidence_problem" ] || marker_valid=false
    fi
  fi

  if [ "$marker_valid" != true ]; then
    INVALID+=("$marker")
    if [ -n "$evidence_problem" ]; then
      INVALID_REASONS+=("$marker: $evidence_problem")
    else
      INVALID_REASONS+=("$marker: $(invalid_reason "$marker_path" "$SOURCE_SHA" "$lane_id" "$expected_gen")")
    fi
  fi
done < <(jq -r '.requiredLaneMarkers[]' "$CONTRACT")

if [ "$PHASE" = "synthesis" ]; then
  for required in coordinator/preliminary.md challenger/disposition.md; do
    if [ ! -s "$RUN_DIR/$required" ]; then
      MISSING+=("$required")
    fi
  done
fi

missing_json="$(printf '%s\n' "${MISSING[@]-}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
invalid_json="$(printf '%s\n' "${INVALID[@]-}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
invalid_reasons_json="$(printf '%s\n' "${INVALID_REASONS[@]-}" | jq -Rsc 'split("\n") | map(select(length > 0))')"

if [ "${#MISSING[@]}" -gt 0 ] || [ "${#INVALID[@]}" -gt 0 ]; then
  jq -cn \
    --arg phase "$PHASE" \
    --arg sha "$SOURCE_SHA" \
    --argjson missing "$missing_json" \
    --argjson invalid "$invalid_json" \
    --argjson invalidReasons "$invalid_reasons_json" \
    '{ready:false,phase:$phase,sourceSha:$sha,missing:$missing,invalid:$invalid,invalidReasons:$invalidReasons}'
  exit 1
fi

jq -cn \
  --arg phase "$PHASE" \
  --arg sha "$SOURCE_SHA" \
  '{ready:true,phase:$phase,sourceSha:$sha,missing:[],invalid:[],invalidReasons:[]}'
