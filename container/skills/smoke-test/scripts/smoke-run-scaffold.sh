#!/usr/bin/env bash
# Write the run's completion contract and lane markers, so their shape cannot
# drift away from what smoke-evidence-barrier.sh validates.
#
# Freehand artifacts are why the barrier silently failed open: on the
# 2026-08-07 marketing campaign the contract carried `lanes[]`/`markerDir`
# while the barrier required `requiredLaneMarkers[]`, and markers carried
# `finishedAt` with no `sourceSha`. The barrier could only ever return
# ready:false, so the run proceeded on prose self-discipline while reporting a
# barrier-governed posture it did not have. A gate whose failure mode is
# silent reversion to vibes is worse than no gate.
#
#   smoke-run-scaffold.sh contract    <run-dir> <source-sha> <lane>[:kind[:title]]... [--regenerate]
#   smoke-run-scaffold.sh marker      <run-dir> <lane-id> <status> [summary] [evidence-csv]
#   smoke-run-scaffold.sh redispatch  <run-dir> <lane-id>
#
# The marker verb reads sourceSha from the contract rather than taking it as
# an argument. A worker therefore cannot stamp a marker with a build it was
# not assigned, which is the property the barrier's SHA check exists to
# enforce and the one freehand markers dropped.
#
# LANE GENERATIONS. smoke-evidence-barrier.sh validates a marker's
# `.generation` against the contract's `.lanes[].generation`, which closes two
# holes a sourceSha check cannot see: a lane RE-DISPATCHED mid-run (its old
# terminal marker is still SHA-correct and still terminal, so the barrier
# reported ready while a live worker was mid-flight) and a contract
# RE-SCAFFOLDED into the same run dir on the same SHA (a lane id repurposed to
# mean something else, with the old marker still validating). This script is
# the ONLY sanctioned writer of either artifact — SKILL.md forbids hand-writing
# them — so until it could produce a generation, that whole check was
# unreachable and the barrier was enforcing a field nothing could emit.
#
# Two writers, matching the two holes:
#   * `contract --regenerate` refuses a silent overwrite whenever this run
#     ALREADY HAS A CONTRACT on the same sourceSha — marker count is irrelevant,
#     since lanes get redefined before any marker lands — and, when forced,
#     bumps EVERY lane past the highest generation found in the old contract OR
#     in any marker on disk. (A re-freeze on a NEW SHA needs none of this: the
#     barrier's sourceSha check already retires those markers, loudly.)
#   * `redispatch <lane-id>` bumps ONE lane, for the ordinary case of
#     re-running a single lane while the finished lanes keep counting.
# Both leave the stale markers on disk on purpose: the barrier then names them
# in `invalid[]` with a "stale generation" reason, which is loud. Deleting them
# would make a re-dispatch look identical to a lane that never ran.
set -euo pipefail

# `--regenerate` may appear anywhere in the argument list, same convention as
# `--takeover` in the gate scripts, so no verb has to know its position and a
# stale positional can never mean "retire every marker".
REGENERATE=false
_ARGS=()
for _a in "$@"; do
  if [ "$_a" = "--regenerate" ]; then REGENERATE=true; else _ARGS+=("$_a"); fi
done
set -- ${_ARGS[@]+"${_ARGS[@]}"}

COMMAND="${1:-}"
RUN_DIR="${2:-}"

die() { jq -cn --arg e "$1" '{ok:false,error:$e}'; exit 2; }

iso_now() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }

# The contract and the lane markers are COORDINATOR-owned slots, and until now
# nothing here had any notion of WHO was writing: a challenger-side worker on
# the right sourceSha, writing a lane the contract had declared, passed every
# other check. That is not theoretical — it happened three times in one run on
# 2026-08-20 (lanes S2, B1, B2) and twice more on 2026-08-22, once overwriting
# a real coordinator marker. Had the barrier fired in that window, a
# challenger's independent conclusion would have counted as the coordinator's
# own lane, collapsing the two-lane contract into one source while the run
# record still claimed two. Briefs telling workers not to do it are a
# mitigation; refusing to resolve the path is the fix.
#
# Fail closed on an unset role. A missing marker is loud — the barrier names it
# in `missing[]` and the run stalls visibly. A wrongly attributed one is
# silent, which is the failure this exists to make impossible.
require_coordinator_role() {
  case "${SMOKE_LANE_ROLE:-}" in
    coordinator) ;;
    challenger)
      die "SMOKE_LANE_ROLE=challenger may not write $1 — challenger output belongs under challenger/, and the barrier never waits on it" ;;
    "")
      die "SMOKE_LANE_ROLE is unset — export it as the writing worker's role (coordinator|challenger) before writing $1" ;;
    *)
      die "SMOKE_LANE_ROLE must be 'coordinator' or 'challenger' (got: ${SMOKE_LANE_ROLE})" ;;
  esac
}

# Being the right role is not the same as still owning the run. `--takeover`
# (and an ordinary stale reclaim) flips the gate's `activeRunId` and nothing
# else — a displaced coordinator does not find out until its NEXT gate verb, and
# in the meantime it keeps writing markers into the run tree the successor is
# now using. `activeRunId` already IS the fencing token for progress/finish;
# this makes it fence the artifact writes too.
#
# ponytail: the run id is the run directory's basename, which is the id the
# contract itself already records (`runId: $(basename $RUN_DIR)`) and the layout
# SKILL.md pins. No second token scheme.
require_active_run() {
  local state_dir="${SMOKE_GATE_STATE_DIR:-}" run_id f
  run_id="$(basename "$RUN_DIR")"
  [ -n "$state_dir" ] ||
    die "SMOKE_GATE_STATE_DIR is unset — the run's gate claim cannot be verified, so $1 is refused"
  for f in "$state_dir"/pr-*-state.json "$state_dir"/develop-state.json; do
    [ -e "$f" ] || continue
    [ "$(jq -r '.activeRunId // empty' "$f" 2>/dev/null)" = "$run_id" ] && return 0
  done
  die "run '$run_id' does not hold the gate — it was reclaimed or taken over. STOP this campaign; do not write $1"
}

# A re-dispatched lane gets a newer generation before its replacement marker
# lands. Preserve the prior raw marker at that boundary so recovering missing
# evidence produces an auditable forward replay instead of rewriting history.
# `ln` creates the history file atomically without overwriting one another
# worker may already have written; the old marker and its archive remain the
# same inode until the replacement `mv` below swaps the live path.
archive_prior_marker_if_superseded() {
  local marker_path="$1" current_generation="$2" prior_generation history_dir history_path
  [ -f "$marker_path" ] || return 0

  prior_generation="$(jq -r '(.generation // 1) | tostring' "$marker_path" 2>/dev/null || printf '')"
  printf '%s' "$prior_generation" | grep -Eq '^[1-9][0-9]*$' || prior_generation=1
  [ "$prior_generation" -lt "$current_generation" ] || return 0

  history_dir="$RUN_DIR/markers/history"
  history_path="$history_dir/$LANE.generation-$prior_generation.json"
  mkdir -p "$history_dir"

  if [ -e "$history_path" ]; then
    cmp -s "$marker_path" "$history_path" ||
      die "refusing to replace $marker_path: $history_path already exists with different raw evidence"
    return 0
  fi

  if ln "$marker_path" "$history_path" 2>/dev/null; then
    return 0
  fi

  # A concurrent recovery may have created the archive after the existence
  # check. Accept only byte-identical history; never overwrite a disagreement.
  if [ -e "$history_path" ] && cmp -s "$marker_path" "$history_path"; then
    return 0
  fi
  die "could not atomically archive superseded marker at $history_path; refusing to replace $marker_path"
}

[ -n "$COMMAND" ] || die "usage: smoke-run-scaffold.sh <contract|marker|redispatch> <run-dir> ..."
[ -n "$RUN_DIR" ] || die "a run directory is required"

CONTRACT="$RUN_DIR/completion-contract.json"

case "$COMMAND" in
contract)
  require_coordinator_role "the completion contract"
  require_active_run "the completion contract"
  SOURCE_SHA="${3:-}"
  shift 3 || die "contract requires a run dir, a source SHA, and at least one lane"
  printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
    die "contract requires the 40-character frozen source SHA"
  [ "$#" -gt 0 ] || die "contract requires at least one lane"

  # Same-SHA re-scaffold guard.
  #
  # Re-freezing on a NEW build already invalidates every old marker — the
  # barrier's sourceSha check does that, loudly, and nothing here needs to
  # help. The hole is the SAME sourceSha: a freeze PR pins one SHA for the
  # whole campaign, so a lane repurposed mid-run (the documented incident: B2
  # went from "permission crossings" to "publish/exports") overwrote the
  # contract while its old marker stayed sourceSha-correct, lane-id-correct and
  # terminal — and generation defaulted to 1 on both sides, so it validated
  # against a definition it had never seen.
  #
  # The guard arms on a PRIOR CONTRACT ALONE — never on marker count. Markers
  # are the LAST thing to land and lane definitions get rewritten BEFORE any of
  # them exist, so an "only if markers are present" condition leaves the entire
  # early-run window open: rewrite at generation 1, then the worker still
  # briefed on the old B2 stamps its marker and INHERITS generation 1, and the
  # barrier reports ready on old-definition evidence. That is the original
  # incident, unchanged. A contract file that exists but cannot be read as one
  # (truncated, corrupt) REFUSES too: that is the case where this script knows
  # least about what the run already committed to, which makes it the worst
  # possible moment to fail open.
  GENERATION=1
  if [ -e "$CONTRACT" ]; then
    PRIOR_SHA="$(jq -r 'if (type == "object" and (.sourceSha | type) == "string")
                        then .sourceSha else "" end' "$CONTRACT" 2>/dev/null || printf '')"
    printf '%s' "$PRIOR_SHA" | grep -Eq '^[0-9a-f]{40}$' || PRIOR_SHA=""
    if [ "$REGENERATE" != true ]; then
      [ -n "$PRIOR_SHA" ] ||
        die "refusing to overwrite $CONTRACT: the file exists but does not read as a contract (truncated or corrupt), so this script cannot tell which lane definitions the run already committed to, nor which markers a rewrite would leave validating. Re-run with --regenerate to retire every existing marker, or remove the run directory and start clean."
      [ "$PRIOR_SHA" != "$SOURCE_SHA" ] ||
        die "refusing to overwrite $CONTRACT: this run already has a contract on the SAME sourceSha. Any marker against it — one already on disk, or one a worker still briefed on the old lane definitions is about to write — would keep validating against lane ids this rewrite may have redefined. Re-run with --regenerate to retire every existing marker, use 'redispatch <lane-id>' to retire just one lane, or write markers against the contract that is already there."
    fi
    if [ "$REGENERATE" = true ]; then
      # Highest generation anywhere in this run dir: the old contract's lanes
      # AND every marker on disk. The markers matter on their own — a truncated
      # contract carries no lanes to read, and bumping to 1 there would re-bless
      # the exact markers --regenerate exists to retire.
      GENERATION="$( {
          jq -r '.lanes[]? | select(type == "object") | (.generation // 1)' "$CONTRACT" 2>/dev/null
          for m in "$RUN_DIR"/markers/*.json; do
            [ -f "$m" ] || continue
            jq -r 'select(type == "object") | (.generation // 1)' "$m" 2>/dev/null
          done
        } | grep -E '^[0-9]+$' | sort -n | tail -1 || true )"
      printf '%s' "$GENERATION" | grep -Eq '^[0-9]+$' || GENERATION=0
      GENERATION=$(( GENERATION + 1 ))
    fi
  fi

  LANES='[]'
  MARKERS='[]'
  for spec in "$@"; do
    id="${spec%%:*}"
    rest="${spec#"$id"}"; rest="${rest#:}"
    kind="${rest%%:*}"
    title="${rest#"$kind"}"; title="${title#:}"
    printf '%s' "$id" | grep -Eq '^[A-Za-z0-9_-]+$' ||
      die "lane id must be alphanumeric/dash/underscore: $id"
    LANES="$(jq -c --arg id "$id" --arg kind "${kind:-lane}" --arg title "$title" \
      --argjson gen "$GENERATION" \
      '. + [{id:$id,kind:$kind,title:(if $title == "" then null else $title end),generation:$gen}]' <<<"$LANES")"
    MARKERS="$(jq -c --arg m "markers/$id.json" '. + [$m]' <<<"$MARKERS")"
  done

  # Deployment-specific fields (environment, leasePolicy, frontendDeploySha…)
  # merge in from $SMOKE_CONTRACT_EXTRA so this script never grows tenant knobs.
  EXTRA="${SMOKE_CONTRACT_EXTRA:-{\}}"
  jq -e 'type == "object"' <<<"$EXTRA" >/dev/null 2>&1 ||
    die "SMOKE_CONTRACT_EXTRA must be a JSON object"

  mkdir -p "$RUN_DIR/markers"
  tmp="$(mktemp "$RUN_DIR/.completion-contract.XXXXXX")"
  jq -n \
    --arg runId "$(basename "$RUN_DIR")" \
    --arg sha "$SOURCE_SHA" \
    --arg now "$(iso_now)" \
    --argjson lanes "$LANES" \
    --argjson markers "$MARKERS" \
    --argjson extra "$EXTRA" \
    '$extra + {
      schemaVersion: 1,
      runId: $runId,
      sourceSha: $sha,
      requiredLaneMarkers: $markers,
      lanes: $lanes,
      markerDir: "markers",
      terminalStatuses: ["pass","fail","blocked","void","completed"],
      createdAt: $now
    }' > "$tmp"
  mv "$tmp" "$CONTRACT"
  jq -cn --arg path "$CONTRACT" --argjson lanes "$LANES" \
    '{ok:true,contract:$path,laneCount:($lanes|length)}'
  ;;

marker)
  require_coordinator_role "a coordinator lane marker"
  require_active_run "a coordinator lane marker"
  LANE="${3:-}"
  STATUS="${4:-}"
  SUMMARY="${5:-}"
  EVIDENCE_CSV="${6:-}"
  [ -n "$LANE" ] || die "marker requires a lane id"
  [ -s "$CONTRACT" ] || die "no completion contract at $CONTRACT — write it before any marker"
  case "$STATUS" in
    pass|fail|blocked|void|completed) ;;
    *) die "status must be one of: pass fail blocked void completed" ;;
  esac

  # The lane must be one the contract declared. An undeclared lane is either a
  # typo — which would leave the real lane forever missing and the barrier
  # forever false — or scope the manifest never committed to.
  jq -e --arg m "markers/$LANE.json" 'any(.requiredLaneMarkers[]; . == $m)' \
    "$CONTRACT" >/dev/null 2>&1 ||
    die "lane '$LANE' is not declared in the contract — add it there first"

  SOURCE_SHA="$(jq -r '.sourceSha' "$CONTRACT")"
  # A marker INHERITS the lane's current generation from the contract, exactly
  # the way it already inherits sourceSha: the writer never states it, so a
  # worker cannot stamp a marker for a dispatch it was not part of. Defaults to
  # 1 for a contract with no lanes[] (or no entry for this lane), which is what
  # the barrier defaults to on both sides — pre-existing contracts are
  # unaffected.
  GENERATION="$(jq -r --arg id "$LANE" \
    '[.lanes[]? | select(type=="object") | select(.id == $id) | (.generation // 1)][0] // 1' \
    "$CONTRACT" 2>/dev/null || printf '')"
  printf '%s' "$GENERATION" | grep -Eq '^[0-9]+$' || GENERATION=1
  # Trailing newline is load-bearing: with no input line `jq -R` emits nothing
  # and --argjson then receives an empty string rather than `[]`.
  EVIDENCE="$(printf '%s\n' "$EVIDENCE_CSV" | jq -Rc 'split(",") | map(select(length > 0))')"
  NOW="$(iso_now)"

  mkdir -p "$RUN_DIR/markers"
  archive_prior_marker_if_superseded "$RUN_DIR/markers/$LANE.json" "$GENERATION"
  tmp="$(mktemp "$RUN_DIR/markers/.marker.XXXXXX")"
  jq -n \
    --arg lane "$LANE" \
    --arg sha "$SOURCE_SHA" \
    --arg status "$STATUS" \
    --arg now "$NOW" \
    --arg summary "$SUMMARY" \
    --argjson evidence "$EVIDENCE" \
    --argjson generation "$GENERATION" \
    '{schemaVersion:1,
      lane:$lane,
      sourceSha:$sha,
      generation:$generation,
      status:$status,
      completedAt:$now,
      finishedAt:$now,
      summary:(if $summary == "" then null else $summary end),
      evidence:$evidence}' > "$tmp"
  mv "$tmp" "$RUN_DIR/markers/$LANE.json"
  jq -cn --arg lane "$LANE" --arg sha "$SOURCE_SHA" --arg status "$STATUS" \
    --argjson generation "$GENERATION" \
    '{ok:true,lane:$lane,sourceSha:$sha,generation:$generation,status:$status}'
  ;;

redispatch)
  # Retire ONE lane's evidence before re-running it. Bumping the whole contract
  # would retire the finished lanes too and stall the run; leaving the old
  # marker in place with a stale generation is what makes the barrier say
  # "a fresh marker has not landed yet" instead of "ready".
  require_coordinator_role "a lane generation bump"
  require_active_run "a lane generation bump"
  LANE="${3:-}"
  [ -n "$LANE" ] || die "redispatch requires a lane id"
  [ -s "$CONTRACT" ] || die "no completion contract at $CONTRACT — write it before redispatching a lane"
  jq -e --arg m "markers/$LANE.json" 'any(.requiredLaneMarkers[]; . == $m)' \
    "$CONTRACT" >/dev/null 2>&1 ||
    die "lane '$LANE' is not declared in the contract — add it there first"

  tmp="$(mktemp "$RUN_DIR/.completion-contract.XXXXXX")"
  # A contract written before lanes[] existed (or by an older scaffold) may
  # carry no entry for this id at all. Create one at generation 2 rather than
  # failing: generation 1 is what every marker already written defaults to, so
  # 2 is the first value that actually retires them.
  jq --arg id "$LANE" '
    (.lanes //= []) |
    if any(.lanes[]?; type == "object" and .id == $id)
    then .lanes = [ .lanes[] |
           if (type == "object" and .id == $id)
           then .generation = ((.generation // 1) + 1)
           else . end ]
    else .lanes += [{id:$id, kind:"lane", title:null, generation:2}] end
  ' "$CONTRACT" > "$tmp"
  mv "$tmp" "$CONTRACT"
  NEXT_GEN="$(jq -r --arg id "$LANE" \
    '[.lanes[]? | select(type=="object") | select(.id == $id) | (.generation // 1)][0] // 1' "$CONTRACT")"
  jq -cn --arg lane "$LANE" --argjson generation "$NEXT_GEN" \
    --argjson retired "$([ -s "$RUN_DIR/markers/$LANE.json" ] && echo true || echo false)" \
    '{ok:true,lane:$lane,generation:$generation,retiredExistingMarker:$retired}'
  ;;

*)
  die "unknown command: $COMMAND (expected contract, marker or redispatch)"
  ;;
esac
