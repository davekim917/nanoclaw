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
  (.schemaVersion == 1 or .schemaVersion == 2) and
  (.sourceSha | type == "string" and test("^[0-9a-f]{40}$")) and
  (.requiredLaneMarkers | type == "array" and length > 0) and
  all(.requiredLaneMarkers[]; type == "string" and length > 0)
' "$CONTRACT" >/dev/null 2>&1; then
  jq -cn --arg path "$CONTRACT" '{ready:false,missing:[],invalid:[$path]}'
  exit 1
fi

# Every contract the scaffold writes carries `ownershipKind` — `contract`
# sets it from $FENCED_STATE_KIND unconditionally (smoke-run-scaffold.sh:414),
# and $FENCED_STATE_KIND is always "pr", "develop", or "task"
# (smoke-run-scaffold.sh:159/165/175's state_kind assignments, copied to
# FENCED_STATE_KIND at :182 only after the `count -eq 1` guard at :177
# guarantees exactly one of those three branches ran) — begin_active_run_fence
# dies before reaching that line for anything else. A contract with no
# `ownershipKind` at all therefore did not come from the scaffold; it is the
# exact hand-composed shape a freehand contract took on the certify-1657 run.
if ! jq -e '(.ownershipKind | type == "string")' "$CONTRACT" >/dev/null 2>&1; then
  jq -cn --arg path "$CONTRACT" \
    '{ready:false,missing:[],invalid:[$path],
      invalidReasons:["completion contract has no ownershipKind — this was not written by the scaffold; claim the run first (smoke-pr-gate.sh claim for a PR, task-claim for a task-scoped run) and let smoke-run-scaffold.sh write the contract"]}'
  exit 1
fi

# A pr- or task-owned contract with no coordinatorOwnerToken is the OTHER
# half of the same hand-composed shape: smoke-run-scaffold.sh's `contract`
# verb can ONLY produce a null token for a `develop`-fenced run.
# begin_active_run_fence sets FENCED_OWNER="" only on the develop branch
# (smoke-run-scaffold.sh:186); the pr branch (smoke-run-scaffold.sh:236) and
# the task branch (smoke-run-scaffold.sh:201) both always set it to
# $DEFAULT_OWNER before the contract is written, and DEFAULT_OWNER
# (smoke-run-scaffold.sh:125,
# `${SMOKE_GATE_OWNER:-${HOSTNAME:-unknown-host}}`) can never resolve to an
# empty string — bash's `:-` falls through on empty too, so an unset or
# empty HOSTNAME still lands on the literal "unknown-host". So a null token
# on a contract that itself claims `ownershipKind: "pr"` or `"task"` did not
# come from a live claim.
if ! jq -e '
  (.ownershipKind != "pr" and .ownershipKind != "task") or
  ((.coordinatorOwnerToken // null) != null)
' "$CONTRACT" >/dev/null 2>&1; then
  OWNERSHIP_KIND="$(jq -r '.ownershipKind // "?"' "$CONTRACT" 2>/dev/null || printf '?')"
  jq -cn --arg path "$CONTRACT" --arg kind "$OWNERSHIP_KIND" \
    '{ready:false,missing:[],invalid:[$path],
      invalidReasons:[("completion contract declares ownershipKind " + $kind +
        " with no coordinatorOwnerToken — this was not written by a live claim; claim the run first (smoke-pr-gate.sh claim for a PR, task-claim for a task-scoped run) and let the scaffold write the contract")]}'
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

# A pass says the lane has affirmative evidence. Requiring a nonempty, regular
# file inside the run root makes that claim durable instead of letting an empty
# evidence array, a future screenshot path, or a host path clear the synthesis
# barrier. The one non-file form is the same well-formed clip-skipped line that
# finding_clip_problem accepts for a confirmed finding: a recording failure is
# an explicit account, not a promised file. Non-pass markers deliberately do
# not use this check: a concrete blocker or failure reason is a valid terminal
# result even when no success evidence exists.
valid_clip_skip_entry() { # <marker-path> <evidence-entry>
  jq -e --arg entry "$2" '
    (.confirmedFindings | type == "array") and
    any(.confirmedFindings[];
      . as $finding |
      type == "string" and length > 0 and
      ($entry | startswith("clip-skipped: " + $finding + ": ")) and
      ($entry | ltrimstr("clip-skipped: " + $finding + ": ") | length > 0))
  ' "$1" >/dev/null 2>&1
}

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
      clip-skipped:*)
        if valid_clip_skip_entry "$marker_path" "$evidence_path"; then
          continue
        fi
        printf 'pass marker clip-skipped evidence is not a nonempty skip reason for a confirmed finding: %s' "$evidence_path"
        return
        ;;
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

# A `floor` lane's `pass` marker must carry real browser evidence — an
# API-only campaign lane resets that entry's staleness clock with no journey
# ever walked, exactly the silent regression the coverage floor exists to
# catch (SKILL.md "The coverage floor"). The one exemption is a lane whose
# CONTRACT entry (not the marker — a marker cannot self-declare its way out of
# this) carries `evidence:"api"`, set only by `smoke-run-scaffold.sh contract
# --evidence <lane-id>=api` at scaffold time. Reads the contract fresh per
# lane rather than caching it: this runs once per marker in a bounded loop,
# same cost class as expected_generation() above.
lane_kind() {
  local lane_id="$1" found
  found="$(jq -r --arg id "$lane_id" \
    '[.lanes[]? | select(type=="object") | select(.id == $id) | (.kind // "lane")][0] // empty' \
    "$CONTRACT" 2>/dev/null)" || found=""
  [ -n "$found" ] && printf '%s' "$found" || printf 'lane'
}

lane_declares_api_evidence() {
  local lane_id="$1"
  jq -e --arg id "$lane_id" \
    '[.lanes[]? | select(type=="object") | select(.id == $id) | (.evidence // "")][0] == "api"' \
    "$CONTRACT" >/dev/null 2>&1
}

FLOOR_MEDIA_EXTENSIONS='png|jpg|jpeg|webp|gif|mp4|webm'

# Only called once pass_evidence_problem has already confirmed every listed
# evidence path exists as a nonempty regular file under the run root — this
# only has to ask whether at least one of those already-verified paths looks
# like browser media.
floor_evidence_problem() {
  local marker_path="$1" lane_id="$2"

  # Explicit `return 0` on both early exits, not a bare `return` behind `||`:
  # under `set -e`, `return` with no argument propagates the CURRENT `$?`, and
  # the failed `[ ... ]` test on the left of `||` leaves that at 1 — the
  # assignment `evidence_problem="$(floor_evidence_problem ...)"` then trips
  # errexit and aborts the whole barrier for every non-floor pass marker.
  [ "$(lane_kind "$lane_id")" = "floor" ] || return 0
  lane_declares_api_evidence "$lane_id" && return 0

  if ! jq -e --arg ext "$FLOOR_MEDIA_EXTENSIONS" '
    any((.evidence // [])[];
      (startswith("clip-skipped: ") | not) and
      test("\\.(" + $ext + ")$"; "i"))
  ' "$marker_path" >/dev/null 2>&1; then
    printf 'floor pass without browser evidence'
  fi
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

# PAIR RE-FREEZE. `smoke-pair-identity.sh refreeze` re-baselines the deployed
# pair once per run and snapshots the contract's lane generations into
# coordinator/identity.json. A lane dispatched before it gathered evidence
# against the OLD pair, yet its marker is still sourceSha-correct and at the
# contract's current generation, so every check below would pass it. It stops
# counting only once `smoke-run-scaffold.sh redispatch` moves its generation
# past the snapshot. `smoke-pair-identity.sh finish` refuses on the same rule;
# reading it here too means skipping `finish` does not skip it. The rule lives
# in refreeze-lanes.jq, shared by both. A run with no identity.json never used
# pair identity and is unaffected; an unreadable one fails closed.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDENTITY_REL="coordinator/identity.json"
REFREEZE_STALE=()
if [ -e "$RUN_DIR/$IDENTITY_REL" ]; then
  refreeze_result="$(jq -cs -L "$SCRIPT_DIR" --slurpfile c "$CONTRACT" '
    include "refreeze-lanes";
    if length != 1 then {error: "identity.json is not exactly one JSON document"}
    else .[0] | rl_stale_after_refreeze(if ($c | length) == 1 then $c[0] else "unparsable" end) end
  ' "$RUN_DIR/$IDENTITY_REL" 2>/dev/null)" ||
    refreeze_result='{"error":"identity.json is not valid JSON"}'
  refreeze_error="$(jq -r '.error // empty' <<<"$refreeze_result")"
  if [ -n "$refreeze_error" ]; then
    INVALID+=("$IDENTITY_REL")
    INVALID_REASONS+=("$IDENTITY_REL: $refreeze_error")
  else
    while IFS= read -r stale_lane; do
      [ -n "$stale_lane" ] && REFREEZE_STALE+=("$stale_lane")
    done < <(jq -r '.stale[]' <<<"$refreeze_result")
  fi
fi

lane_stale_after_refreeze() {
  local want="$1" lane
  for lane in ${REFREEZE_STALE[@]+"${REFREEZE_STALE[@]}"}; do
    [ "$lane" = "$want" ] && return 0
  done
  return 1
}

while IFS= read -r marker; do
  case "$marker" in
    /*|../*|*/../*|*/..)
      INVALID+=("$marker")
      INVALID_REASONS+=("$marker: absolute or path-traversal marker path is not allowed in requiredLaneMarkers")
      continue
      ;;
  esac

  # Lane id from the marker's own filename (the `markers/<ID>.json` convention
  # every real contract in this fleet already uses) — not from the marker's
  # `.lane` field, which is exactly the field a stale/mislabeled marker could
  # get wrong. expected_generation reads the CURRENT contract, not the marker.
  lane_id="$(basename "$marker" .json)"

  # Before the missing check: a lane still in flight on the old pair has no
  # marker yet, and the reason to give is the redispatch, not "still running".
  if lane_stale_after_refreeze "$lane_id"; then
    INVALID+=("$marker")
    printf -v redispatch_command '%q redispatch %q %q' "$SCRIPT_DIR/smoke-run-scaffold.sh" "$RUN_DIR" "$lane_id"
    INVALID_REASONS+=("$marker: not redispatched since the pair re-freeze (contract generation $(expected_generation "$lane_id") is not above the refreeze snapshot) — its evidence predates the current pair; run $redispatch_command, then re-run the lane")
    continue
  fi

  marker_path="$RUN_DIR/$marker"
  if [ ! -s "$marker_path" ]; then
    MISSING+=("$marker")
    continue
  fi

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
    if [ "$marker_valid" = true ] && [ "$(jq -r '.status' "$marker_path" 2>/dev/null)" = pass ]; then
      evidence_problem="$(floor_evidence_problem "$marker_path" "$lane_id")"
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

# JOURNEY SELECTION. A run that pinned the gate's journey selection
# (journeys/selection.json, written only by `smoke-journeys.py pin-run`) owes
# two things the lane loop above cannot see: a contract lane for every matched
# journey — whose terminal marker that loop then demands — and a scope
# disposition for every frozen unmapped path. COMPLETENESS ONLY, the same
# bargain as confirmedFindings: a disposition's presence proves bookkeeping,
# and whether it is TRUE is the challenger's question.
#
# WHETHER a run owes this is the gate's decision, never the run's bookkeeping:
# if the PR gate pinned a selection for this campaign, the run must hold those
# exact bytes, so skipping pin-run is a refusal, not an exit from every check
# below. The pin is `journeys-pin-<repo>-pr-<n>-<head sha>.json` in the SHARED
# lease directory (smoke-pr-gate.sh journeys_pin_file — campaign ownership is
# shared, so a second coordinator's barrier finds it too), resolved from the
# same two env vars the gate and the scaffold use.
#
# IDENTITY IS THE CONTRACT'S. The pin is found by the campaign's identity and
# probed by its exact name — never by listing the directory, and never from
# state with a different lifetime than the run: ten review rounds of #898
# found, in turn, a listing that failed reading as "no pin" (compgen, then
# find), a live lease that finish/release delete, and a local catalogue a
# second coordinator may not have — each one switching every check below off.
# The identity now travels in the fenced completion contract, written once by
# the scaffold under the gate's fence (smoke-run-scaffold.sh contract,
# schemaVersion 2: `pr` from the fenced state, `repoSlug` from the gate's
# lease else SMOKE_GATE_REPO, beside `sourceSha`, the head) and never changed
# by adopt or --regenerate (require_contract_identity_unchanged). All of it
# lives in `smoke-journeys.py barrier` (locate_owner → resolve_owner →
# check_pin, exception-preserving lstat/open, the same predicate the gate
# uses), which reads the contract itself. Verdicts, for a pr-owned contract:
# two confirmed-absent pin paths ⇒ the legacy no-pin answer, byte for byte; a
# valid pin ⇒ the run must hold its bytes; invalid ⇒ the gate's RECOVERY pin
# beside it owns instead, neither valid ⇒ not ready; a probe that FAILED
# (unreachable shared storage, EACCES on the pin) ⇒ not ready — DELIBERATELY
# with or without a catalogue: a PR run cannot have written its markers
# without that same shared storage, so this is a retryable fail-closed
# refusal, not a new dependency; a contract that predates campaign identity
# (schemaVersion 1) or a v2 one missing pr/repoSlug ⇒ not ready, naming
# adopt/regenerate, because absent identity was the fail-open every round
# chased. A develop/task contract never takes pin obligations from the lease
# dir and is untouched, except that one whose lease (when it exists) binds it
# to a PR that has a pin is refused for relabelling itself. The run never
# authors what it is held to; a selection with no gate pin behind it is
# refused too. Unconditionally: the contract's runId is this run directory's
# own name.
JOURNEY_LEASE_DIR="${SMOKE_GATE_LEASE_DIR:-${SMOKE_GATE_SHARED_ROOT:-/workspace/workgroup}/qa-coordinator/leases}"
# The run directory's OWN name is the run id; the contract's runId is checked
# against it, so a borrowed runId borrows nothing. Derived exactly as the
# scaffold derives it — the UNRESOLVED `basename "$RUN_DIR"` (its fence
# smoke-run-scaffold.sh:199, the contract's runId :532, adopt :769) — never
# through realpath: a run dir reached through a symlink (run-alias →
# run-storage) is fenced, written and adopted as run-alias, and resolving it
# here rejected that legitimate contract (#898 review 11). File checks keep
# their canonical paths (_run_file_ok resolves under the real run root).
JOURNEY_RUN_NAME="$(basename "$RUN_DIR")"
journeys_result="$(python3 "$SCRIPT_DIR/smoke-journeys.py" barrier "$RUN_DIR" \
  --lease-dir "$JOURNEY_LEASE_DIR" --run-id "$JOURNEY_RUN_NAME" 2>/dev/null)" || journeys_result=""
if ! jq -e '(.missing | type == "array") and (.invalid | type == "array") and (.invalidReasons | type == "array")' \
     <<<"$journeys_result" >/dev/null 2>&1; then
  INVALID+=("journeys/selection.json")
  INVALID_REASONS+=("journeys/selection.json: the journey completeness check could not run")
else
  while IFS= read -r item; do MISSING+=("$item"); done < <(jq -r '.missing[] | select(length > 0)' <<<"$journeys_result")
  while IFS= read -r item; do INVALID+=("$item"); done < <(jq -r '.invalid[] | select(length > 0)' <<<"$journeys_result")
  while IFS= read -r item; do INVALID_REASONS+=("$item"); done < <(jq -r '.invalidReasons[] | select(length > 0)' <<<"$journeys_result")
fi

# VISUAL CANDIDATES. A contact sheet and its screenshot-only critic DETECT;
# nothing they flag may end as "advisory" with no owner. Same bargain as
# confirmedFindings above: COMPLETENESS ONLY. Every candidate (a critic BROKEN,
# a failed or unsettled capture, a critic DEGRADED on a screen the baseline
# diff says this build changed) owes exactly one recorded disposition, and a
# sheet with no critic record is itself not ready — whether a disposition is
# TRUE is the UI adversary's and the challenger's question. This gates
# SYNTHESIS READINESS only and never reads or writes a verdict: a candidate
# reaches the verdict solely as a `confirmed` finding, through that finding's
# normal severity. A run with no contact-sheet dir and no pinned journey
# selection has no user-visible surface on record and is untouched — the
# candidate rule lives in smoke-visual-candidates.py, which is not even run.
#
# OPT-IN: enforced only when the install exports SMOKE_VISUAL_DISPOSITIONS=1.
# container/skills is a live bind mount, so this file is live the moment the
# checkout advances; a campaign whose task prompt does not yet record the
# critic must not start failing on a trunk merge. Unset, every run — a sheet
# with no critic record included — gets exactly the output it got before.
if [ "$PHASE" = "synthesis" ] && [ "${SMOKE_VISUAL_DISPOSITIONS:-}" = 1 ] &&
   { [ -e "$RUN_DIR/contact-sheet" ] || [ -e "$RUN_DIR/journeys/selection.json" ]; }; then
  visual_result="$(python3 "$SCRIPT_DIR/smoke-visual-candidates.py" barrier "$RUN_DIR" 2>/dev/null)" || visual_result=""
  if ! jq -e '(.missing | type == "array") and (.invalid | type == "array") and (.invalidReasons | type == "array")' \
       <<<"$visual_result" >/dev/null 2>&1; then
    INVALID+=("contact-sheet/dispositions.json")
    INVALID_REASONS+=("contact-sheet/dispositions.json: the visual candidate completeness check could not run")
  else
    while IFS= read -r item; do MISSING+=("$item"); done < <(jq -r '.missing[] | select(length > 0)' <<<"$visual_result")
    while IFS= read -r item; do INVALID+=("$item"); done < <(jq -r '.invalid[] | select(length > 0)' <<<"$visual_result")
    while IFS= read -r item; do INVALID_REASONS+=("$item"); done < <(jq -r '.invalidReasons[] | select(length > 0)' <<<"$visual_result")
  fi
fi

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
