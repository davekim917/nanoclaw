#!/usr/bin/env bash
# Misconfig fail-closed wake (with throttle), finish validation/state, the
# progress liveness verb, and the poll/claim/reclaim path (gh + curl stubbed
# via PATH so the network poll runs offline against fixtures).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/smoke-develop-gate.sh"
STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$STATE_DIR"' EXIT
export SMOKE_GATE_STATE_DIR="$STATE_DIR"
unset SMOKE_GATE_REPO SMOKE_GATE_BACKEND_SERVICE SMOKE_GATE_FRONTEND_SERVICE SMOKE_GATE_DEV_URL 2>/dev/null || true

# 1. Missing config wakes once with the missing list...
bash "$GATE" poll | jq -e '
  .wakeAgent == true and
  .data.trigger == "gate_misconfigured" and
  (.data.missing | length == 4)
' >/dev/null

# 2. ...and the immediate next poll is throttled to a silent no-wake.
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.trigger == "gate_misconfigured"
' >/dev/null

# 3. Partial config still reports exactly the absent variables.
SMOKE_GATE_REPO=org/repo SMOKE_GATE_DEV_URL=https://dev.example.test \
  bash "$GATE" poll | jq -e '
    .data.missing == ["SMOKE_GATE_BACKEND_SERVICE","SMOKE_GATE_FRONTEND_SERVICE"]
  ' >/dev/null

# 4. finish rejects a short SHA and a bad verdict.
if bash "$GATE" finish abc123 run-1 GO | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "expected short SHA to be rejected" >&2; exit 1
fi
SHA="$(printf 'a%.0s' $(seq 40))"
if bash "$GATE" finish "$SHA" run-1 SHIP_IT | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "expected invalid verdict to be rejected" >&2; exit 1
fi

# 5. finish records the completed run and clears active/candidate state.
bash "$GATE" finish "$SHA" run-1 NO_GO | jq -e '.ok == true' >/dev/null
jq -e --arg sha "$SHA" '
  .completedSha == $sha and .completedVerdict == "NO_GO" and
  .activeSha == null and .candidateSha == null and .activeProgressAt == null
' "$STATE_DIR/develop-state.json" >/dev/null

# 6. progress with no active run refuses (nothing to stamp).
bash "$GATE" progress run-x | jq -e '.ok == false and .activeRunId == null' >/dev/null

# --- Poll path against stubbed gh/curl -------------------------------------
STATE_FILE="$STATE_DIR/develop-state.json"
BUILD_SHA="$(printf 'b%.0s' $(seq 40))"
STUB_BIN="$(mktemp -d)"
trap 'rm -rf "$STATE_DIR" "$STUB_BIN"' EXIT
cat > "$STUB_BIN/gh" <<STUB
#!/usr/bin/env bash
case "\$1 \$2" in
  "api repos/org/repo/branches/develop") echo '{"commit":{"sha":"$BUILD_SHA"}}' ;;
  "run list") echo '[{"headSha":"$BUILD_SHA","status":"completed","conclusion":"success","workflowName":"Frontend CI"}]' ;;
  *) echo '{}' ;;
esac
STUB
cat > "$STUB_BIN/curl" <<STUB
#!/usr/bin/env bash
echo '[{"status":"live","commit":{"id":"$BUILD_SHA"}}]'
STUB
chmod +x "$STUB_BIN/gh" "$STUB_BIN/curl"
export PATH="$STUB_BIN:$PATH"
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-b \
  SMOKE_GATE_FRONTEND_SERVICE=srv-f SMOKE_GATE_DEV_URL=https://dev.example.test \
  SMOKE_GATE_DEBOUNCE_SECONDS=0

# 7. Settled new SHA: first poll debounces, second claims the run.
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.trigger == "debouncing_candidate"
' >/dev/null
bash "$GATE" poll | jq -e --arg sha "$BUILD_SHA" '
  .wakeAgent == true and .data.trigger == "develop_build_settled" and
  .data.sourceSha == $sha and .data.recovery == false and
  .data.abandonedActiveSha == null
' >/dev/null
RUN_ID="$(jq -r '.activeRunId' "$STATE_FILE")"
jq -e '.activeProgressAt == null' "$STATE_FILE" >/dev/null

# 8. progress refuses a mismatched run id and does not stamp.
bash "$GATE" progress other-run | jq -e --arg run "$RUN_ID" '
  .ok == false and .activeRunId == $run
' >/dev/null
jq -e '.activeProgressAt == null' "$STATE_FILE" >/dev/null

# 9. progress stamps the active run.
bash "$GATE" progress "$RUN_ID" | jq -e '.ok == true' >/dev/null
jq -e '.activeProgressAt != null' "$STATE_FILE" >/dev/null

# 10. Fresh run: same-SHA poll reports already_active, no wake.
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.trigger == "already_active"
' >/dev/null

# 11. Quiet run (start + last stamp both old): reclaimed via the progress
# window — debounce poll, then a recovery wake naming the abandoned SHA.
OLD="$(date -u -d '@'$(( $(date -u +%s) - 2000 )) +'%Y-%m-%dT%H:%M:%SZ')"
jq --arg t "$OLD" '.activeStartedAt=$t | .activeProgressAt=$t' "$STATE_FILE" > "$STATE_FILE.tmp" \
  && mv "$STATE_FILE.tmp" "$STATE_FILE"
bash "$GATE" poll | jq -e '.wakeAgent == false' >/dev/null
bash "$GATE" poll | jq -e --arg sha "$BUILD_SHA" '
  .wakeAgent == true and .data.recovery == true and .data.abandonedActiveSha == $sha
' >/dev/null
RUN_ID2="$(jq -r '.activeRunId' "$STATE_FILE")"
[ "$RUN_ID2" != "$RUN_ID" ]

# 12. Old-but-stamping run stays live: start beyond the progress window but a
# fresh stamp keeps it under both limits.
jq --arg t "$OLD" '.activeStartedAt=$t' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
bash "$GATE" progress "$RUN_ID2" | jq -e '.ok == true' >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.trigger == "already_active"
' >/dev/null

# 13. Hard ceiling wins over a fresh stamp.
ANCIENT="$(date -u -d '@'$(( $(date -u +%s) - 15000 )) +'%Y-%m-%dT%H:%M:%SZ')"
jq --arg t "$ANCIENT" '.activeStartedAt=$t' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
bash "$GATE" progress "$RUN_ID2" | jq -e '.ok == true' >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false' >/dev/null   # debounce after stale
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.recovery == true
' >/dev/null

# 14. finish publishes the verdict artifact when SMOKE_GATE_PUBLISH_FILE is set.
PUBLISH="$STATE_DIR/pub/latest-verdict.json"
SMOKE_GATE_PUBLISH_FILE="$PUBLISH" bash "$GATE" finish "$BUILD_SHA" "$RUN_ID2" NO_GO \
  | jq -e '.ok == true' >/dev/null
jq -e --arg sha "$BUILD_SHA" --arg run "$RUN_ID2" '
  .schemaVersion == 1 and .sha == $sha and .runId == $run and
  .verdict == "NO_GO" and (.finishedAt | type == "string")
' "$PUBLISH" >/dev/null

# 15. Hold flag: NO_GO raises it, BLOCKED leaves it untouched, GO clears it.
HOLD="$STATE_DIR/pub/develop-hold.json"
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" finish "$BUILD_SHA" run-hold-1 NO_GO >/dev/null
jq -e --arg sha "$BUILD_SHA" '
  .verdict == "NO_GO" and .sha == $sha and .runId == "run-hold-1" and
  (.reason | length > 0)
' "$HOLD" >/dev/null
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" finish "$BUILD_SHA" run-hold-2 BLOCKED >/dev/null
jq -e '.runId == "run-hold-1"' "$HOLD" >/dev/null   # unchanged by BLOCKED
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" finish "$BUILD_SHA" run-hold-3 GO >/dev/null
[ ! -e "$HOLD" ]
# GO with no prior hold is a no-op, not an error.
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" finish "$BUILD_SHA" run-hold-4 GO \
  | jq -e '.ok == true' >/dev/null

echo "smoke develop gate tests passed"
