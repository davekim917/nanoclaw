#!/usr/bin/env bash
# Offline paths only: misconfig fail-closed wake (with throttle) and finish
# validation/state. The network poll path needs gh/curl and is exercised live.
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
  .activeSha == null and .candidateSha == null
' "$STATE_DIR/develop-state.json" >/dev/null

echo "smoke develop gate tests passed"
