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
  lanes|synthesis) ;;
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
