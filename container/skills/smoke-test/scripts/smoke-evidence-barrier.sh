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
      continue
      ;;
  esac

  marker_path="$RUN_DIR/$marker"
  if [ ! -s "$marker_path" ]; then
    MISSING+=("$marker")
    continue
  fi

  if ! jq -e --arg sha "$SOURCE_SHA" '
    .sourceSha == $sha and
    (.status == "pass" or
     .status == "fail" or
     .status == "blocked" or
     .status == "void" or
     .status == "completed") and
    (.completedAt | type == "string" and length > 0)
  ' "$marker_path" >/dev/null 2>&1; then
    INVALID+=("$marker")
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

if [ "${#MISSING[@]}" -gt 0 ] || [ "${#INVALID[@]}" -gt 0 ]; then
  jq -cn \
    --arg phase "$PHASE" \
    --arg sha "$SOURCE_SHA" \
    --argjson missing "$missing_json" \
    --argjson invalid "$invalid_json" \
    '{ready:false,phase:$phase,sourceSha:$sha,missing:$missing,invalid:$invalid}'
  exit 1
fi

jq -cn \
  --arg phase "$PHASE" \
  --arg sha "$SOURCE_SHA" \
  '{ready:true,phase:$phase,sourceSha:$sha,missing:[],invalid:[]}'
