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

[ -n "$COMMAND" ] || die "usage: smoke-run-scaffold.sh <contract|marker> <run-dir> ..."
[ -n "$RUN_DIR" ] || die "a run directory is required"

CONTRACT="$RUN_DIR/completion-contract.json"

case "$COMMAND" in
contract)
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
