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
#   smoke-run-scaffold.sh contract <run-dir> <source-sha> <lane>[:kind[:title]]...
#   smoke-run-scaffold.sh marker   <run-dir> <lane-id> <status> [summary] [evidence-csv]
#
# The marker verb reads sourceSha from the contract rather than taking it as
# an argument. A worker therefore cannot stamp a marker with a build it was
# not assigned, which is the property the barrier's SHA check exists to
# enforce and the one freehand markers dropped.
set -euo pipefail

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

[ -n "$COMMAND" ] || die "usage: smoke-run-scaffold.sh <contract|marker> <run-dir> ..."
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
      '. + [{id:$id,kind:$kind,title:(if $title == "" then null else $title end)}]' <<<"$LANES")"
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
  # Trailing newline is load-bearing: with no input line `jq -R` emits nothing
  # and --argjson then receives an empty string rather than `[]`.
  EVIDENCE="$(printf '%s\n' "$EVIDENCE_CSV" | jq -Rc 'split(",") | map(select(length > 0))')"
  NOW="$(iso_now)"

  mkdir -p "$RUN_DIR/markers"
  tmp="$(mktemp "$RUN_DIR/markers/.marker.XXXXXX")"
  jq -n \
    --arg lane "$LANE" \
    --arg sha "$SOURCE_SHA" \
    --arg status "$STATUS" \
    --arg now "$NOW" \
    --arg summary "$SUMMARY" \
    --argjson evidence "$EVIDENCE" \
    '{schemaVersion:1,
      lane:$lane,
      sourceSha:$sha,
      status:$status,
      completedAt:$now,
      finishedAt:$now,
      summary:(if $summary == "" then null else $summary end),
      evidence:$evidence}' > "$tmp"
  mv "$tmp" "$RUN_DIR/markers/$LANE.json"
  jq -cn --arg lane "$LANE" --arg sha "$SOURCE_SHA" --arg status "$STATUS" \
    '{ok:true,lane:$lane,sourceSha:$sha,status:$status}'
  ;;

*)
  die "unknown command: $COMMAND (expected contract or marker)"
  ;;
esac
