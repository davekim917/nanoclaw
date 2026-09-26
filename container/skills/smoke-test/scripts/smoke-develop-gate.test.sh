#!/usr/bin/env bash
# Misconfig fail-closed wake (with throttle), finish validation/state, the
# progress liveness verb, and the poll/claim/reclaim path (gh + curl stubbed
# via PATH so the network poll runs offline against fixtures).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/smoke-develop-gate.sh"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
LEGACY_GATE_BASE=672f03a309a4f11f1ad194900d83a710c55765d6
STATE_DIR="$(mktemp -d)"
TEST_SHARED_ROOT="$(mktemp -d)"
STUB_BIN="$(mktemp -d)"
trap 'rm -rf "$STATE_DIR" "$TEST_SHARED_ROOT" "$STUB_BIN"' EXIT
export SMOKE_GATE_STATE_DIR="$STATE_DIR"
export SMOKE_GATE_SHARED_ROOT="$TEST_SHARED_ROOT"
export SMOKE_GATE_LEASE_DIR="$TEST_SHARED_ROOT/qa-coordinator/leases"
cat > "$STUB_BIN/mountpoint" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-q" ] && [ "${2:-}" = "${SMOKE_GATE_SHARED_ROOT:-}" ]
STUB
chmod +x "$STUB_BIN/mountpoint"
LEGACY_GATE="$STUB_BIN/legacy-smoke-pr-gate.sh"
git -C "$REPO_ROOT" show "$LEGACY_GATE_BASE:container/skills/smoke-test/scripts/smoke-pr-gate.sh" >"$LEGACY_GATE"
chmod +x "$LEGACY_GATE"
export PATH="$STUB_BIN:$PATH"
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
#    A run must own the active slot to record a verdict (poll claims it for a
#    scheduled run); claim stands in for poll here so this needs no network.
bash "$GATE" claim run-1 "$SHA" >/dev/null
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
cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
# Advisory freeze notice: record every status POST so a test can assert which
# PR heads got one, and serve the open-PR head list the notice iterates.
case "$*" in
  *"/statuses/"*)
    [ -n "${STUB_STATUS_LOG:-}" ] && printf '%s\n' "$*" >> "$STUB_STATUS_LOG"
    echo '{}'; exit 0 ;;
esac
case "$1 $2" in
  "pr list") printf '%s\n' ${STUB_PR_HEADS:-}; exit 0 ;;
  "pr view") printf '{"state":"%s"}' "${STUB_FREEZE_PR_STATE:-OPEN}"; exit 0 ;;
  "api repos/org/repo/branches/develop")
    printf '{"commit":{"sha":"%s"}}' "$STUB_SOURCE_SHA" ;;
  "run list")
    # wait-settled tests only: flip from failure to success after N calls, so
    # a bounded poll loop can observe a build settle mid-wait instead of every
    # attempt reading the same static fixture. Unset = unchanged behavior.
    FRONTEND_CI="${STUB_FRONTEND_CI:-success}"
    if [ -n "${STUB_UNSETTLE_COUNTER_FILE:-}" ]; then
      COUNT=$(( $(cat "$STUB_UNSETTLE_COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
      printf '%s' "$COUNT" > "$STUB_UNSETTLE_COUNTER_FILE"
      if [ "$COUNT" -lt "${STUB_UNSETTLE_UNTIL_ATTEMPT:-999999}" ]; then FRONTEND_CI=failure; else FRONTEND_CI=success; fi
    fi
    printf '[{"headSha":"%s","status":"completed","conclusion":"%s","workflowName":"Frontend CI"},
             {"headSha":"%s","status":"completed","conclusion":"success","workflowName":"Backend CI"}]' \
      "$STUB_SOURCE_SHA" "$FRONTEND_CI" "$STUB_SOURCE_SHA" ;;
  *)
    case "$2" in
      */compare/*)
        printf '{"status":"%s","behind_by":0,"files":%s}' \
          "${STUB_COMPARE_STATUS:-ahead}" "${STUB_COMPARE_FILES:-[]}" ;;
      # The PR gate's `claim` reads the head COMMIT (freeze_head_probe) to
      # decide whether the head is a freeze — a freeze is admitted only with
      # its pins, which needs the PR gate's whole evaluation surface
      # (smoke-pr-gate.test.sh 5l covers that). This suite's cross-gate claim
      # (33b) exercises the state fields the PR gate writes, so the head is
      # served as an ordinary commit and the claim stays the plain ownership
      # path. The develop gate's own parent lookup (--jq) is unaffected.
      */commits/*) if [ "$#" -eq 2 ]; then printf '{"sha":"%s","parents":[{"sha":"p"}],"files":[]}' "${2##*/commits/}"; else echo '{}'; fi ;;
      *) echo '{}' ;;
    esac ;;
esac
STUB
cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *srv-b*) printf '[{"status":"live","commit":{"id":"%s"}}]' "${STUB_BACKEND_SHA:-$STUB_SOURCE_SHA}" ;;
  *)       printf '[{"status":"live","commit":{"id":"%s"}}]' "${STUB_FRONTEND_SHA:-$STUB_SOURCE_SHA}" ;;
esac
STUB
cat > "$STUB_BIN/freeze-helper" <<'STUB'
#!/usr/bin/env bash
set -u
[ -n "${STUB_FREEZE_EXIT+x}" ] || STUB_FREEZE_EXIT=0
[ -n "${STUB_FREEZE_JSON+x}" ] || STUB_FREEZE_JSON='{"ok":false,"error":"no STUB_FREEZE_JSON configured"}'
[ -n "${STUB_FREEZE_SLEEP:-}" ] && sleep "$STUB_FREEZE_SLEEP"
printf '%s' "$STUB_FREEZE_JSON"
exit "$STUB_FREEZE_EXIT"
STUB
chmod +x "$STUB_BIN/gh" "$STUB_BIN/curl" "$STUB_BIN/freeze-helper"
export PATH="$STUB_BIN:$PATH"
export STUB_SOURCE_SHA="$BUILD_SHA"
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-b \
  SMOKE_GATE_FRONTEND_SERVICE=srv-f SMOKE_GATE_DEV_URL=https://dev.example.test \
  SMOKE_GATE_DEBOUNCE_SECONDS=0

# 7. Settled new SHA: first poll debounces, second claims the run. The quiet
# poll declares an empty observation (W2), a helper-valid one.
DEBOUNCE_OUT="$(bash "$GATE" poll)"
jq -e '
  .wakeAgent == false and .data.trigger == "debouncing_candidate" and
  .observation.kind == "empty" and .observation.bound == "2h" and
  .observation.evidence.trigger == "debouncing_candidate"
' <<<"$DEBOUNCE_OUT" >/dev/null
python3 -c 'import json,sys; sys.path.insert(0, sys.argv[2]); import task_observation as t
sys.exit(0 if t.observation_problem(json.loads(sys.argv[1])["observation"]) is None else 1)' \
  "$DEBOUNCE_OUT" "$SCRIPT_DIR/../../task-observation"
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

# 13. CONTRACT REVERSED 2026-08-25: the hard ceiling no longer wins over a
# fresh stamp. It used to — this test asserted the reclaim — and that WAS the
# duplicate-coordinator fault. A coordinator stamping `progress` every few
# minutes went "not live" the instant it crossed ACTIVE_STALE_SECONDS, the next
# poll handed its environment to a rival, and nothing told the first: it kept
# dispatching lanes and mutating the same seat for hours. The PR gate's
# identical code displaced a live run at 4h00m03s past its claim, three seconds
# past the ceiling, and that campaign never published a verdict at all.
#
# Liveness is now the progress stamp alone. Overrun makes a run REFUSE new
# claims, with an explicit human `--takeover` as the only override. Nothing
# automatic — no poll, ever — can produce a second campaign on one environment.
ANCIENT="$(date -u -d '@'$(( $(date -u +%s) - 15000 )) +'%Y-%m-%dT%H:%M:%SZ')"
jq --arg t "$ANCIENT" '.activeStartedAt=$t' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
bash "$GATE" progress "$RUN_ID2" | jq -e '.ok == true' >/dev/null
# The ceiling still RINGS — it just no longer kills. A zombie stamper (heartbeat
# alive, work wedged) is now surfaced by an alarm rather than by silently
# spawning a rival campaign. Once per overrun run, then latched.
bash "$GATE" poll | jq -e --arg run "$RUN_ID2" '
  .wakeAgent == true and .data.trigger == "develop_run_overrun" and
  .data.runId == $run and .data.activeAgeSeconds >= 14400
' >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.trigger == "already_active"
' >/dev/null
[ "$(jq -r '.activeRunId' "$STATE_FILE")" = "$RUN_ID2" ]
# A rival claim is refused and told how a human forces the issue.
bash "$GATE" claim run-rival "$BUILD_SHA" | jq -e --arg active "$RUN_ID2" '
  .ok == false and .activeRunId == $active and (.error | test("--takeover"))
' >/dev/null
[ "$(jq -r '.activeRunId' "$STATE_FILE")" = "$RUN_ID2" ]
# --takeover past the ceiling works, and the displacement is LOUD: the gate
# cannot kill the incumbent's container, so the displaced run's next gate verb
# is the only channel that reaches it and must say stop, not just "not active".
bash "$GATE" claim run-takeover "$BUILD_SHA" --takeover | jq -e '.ok == true' >/dev/null
jq -e --arg prev "$RUN_ID2" '.displacedRunId == $prev and .displacedAt != null' "$STATE_FILE" >/dev/null
for VERB in progress release finish; do
  case "$VERB" in
    finish) OUT="$(bash "$GATE" finish "$BUILD_SHA" "$RUN_ID2" GO)" ;;
    *)      OUT="$(bash "$GATE" "$VERB" "$RUN_ID2")" ;;
  esac
  jq -e --arg by run-takeover '
    .ok == false and (.error | test("STOP THIS CAMPAIGN")) and
    (.error | test("--takeover")) and .activeRunId == $by and .displacedAt != null
  ' <<<"$OUT" >/dev/null || { echo "expected $VERB to hand the displaced run a stop instruction, got: $OUT" >&2; exit 1; }
done
# An unrelated stale run id still gets the ordinary refusal, not a stop order.
bash "$GATE" progress some-other-run | jq -e '
  .ok == false and (.error | test("not the active run")) and (.error | test("STOP") | not)
' >/dev/null
# An ordinary (non-takeover) claim clears the name, so it can never mis-accuse.
bash "$GATE" release run-takeover >/dev/null
bash "$GATE" claim run-clean "$BUILD_SHA" >/dev/null
jq -e '.displacedRunId == null and .displacedAt == null' "$STATE_FILE" >/dev/null
bash "$GATE" release run-clean >/dev/null
bash "$GATE" claim run-takeover "$BUILD_SHA" >/dev/null
# An explicit --takeover works below the ceiling too — see the matching note in
# the PR gate test. A BARE claim below the ceiling is still refused; only the
# deliberate flag gets through.
bash "$GATE" claim run-too-soon "$BUILD_SHA" --takeover | jq -e '
  .ok == true and .runId == "run-too-soon"
' >/dev/null
# The displacement IS recorded in state (this gate's claim output has no
# tookOverFrom field the way the PR gate's does — the state file is where the
# displaced run's next verb reads it from).
jq -e '.displacedRunId == "run-takeover"' "$STATE_FILE" >/dev/null
bash "$GATE" release run-too-soon >/dev/null
bash "$GATE" claim run-takeover "$BUILD_SHA" >/dev/null
bash "$GATE" claim run-too-soon "$BUILD_SHA" | jq -e '
  .ok == false and (.error | test("wait for it or ask its coordinator"))
' >/dev/null

# 14. finish publishes the verdict artifact when SMOKE_GATE_PUBLISH_FILE is set.
PUBLISH="$STATE_DIR/pub/latest-verdict.json"
# Test 13's takeover claimed a fresh run, so finish the run that actually owns
# the slot — a verdict from any other run is refused now.
RUN_ID3="$(jq -r '.activeRunId' "$STATE_FILE")"
SMOKE_GATE_PUBLISH_FILE="$PUBLISH" bash "$GATE" finish "$BUILD_SHA" "$RUN_ID3" NO_GO \
  | jq -e '.ok == true' >/dev/null
jq -e --arg sha "$BUILD_SHA" --arg run "$RUN_ID3" '
  .schemaVersion == 1 and .sha == $sha and .runId == $run and
  .verdict == "NO_GO" and (.finishedAt | type == "string")
' "$PUBLISH" >/dev/null

# 15. Hold flag: NO_GO raises it, BLOCKED leaves it untouched, GO clears it.
HOLD="$STATE_DIR/pub/develop-hold.json"
bash "$GATE" claim run-hold-1 "$BUILD_SHA" >/dev/null
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" finish "$BUILD_SHA" run-hold-1 NO_GO >/dev/null
jq -e --arg sha "$BUILD_SHA" '
  .verdict == "NO_GO" and .sha == $sha and .runId == "run-hold-1" and
  (.reason | length > 0)
' "$HOLD" >/dev/null
bash "$GATE" claim run-hold-2 "$BUILD_SHA" >/dev/null
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" finish "$BUILD_SHA" run-hold-2 BLOCKED >/dev/null
jq -e '.runId == "run-hold-1"' "$HOLD" >/dev/null   # unchanged by BLOCKED
# HUMAN_DECISION RAISES the hold (owner decision 2026-08-25). It used to leave
# it untouched — default-open — which made a verdict meaning "the system does
# not know whether this is safe" behave as GO on exactly the cases flagged as
# needing judgment. `reason` distinguishes it from a defects hold.
bash "$GATE" claim run-hold-hd "$BUILD_SHA" >/dev/null
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" finish "$BUILD_SHA" run-hold-hd HUMAN_DECISION >/dev/null
jq -e --arg sha "$BUILD_SHA" '
  .verdict == "HUMAN_DECISION" and .sha == $sha and .runId == "run-hold-hd" and
  .reason == "needs_human_decision"
' "$HOLD" >/dev/null
# ...and the hold reconciler now expects it, so a builder deleting a
# HUMAN_DECISION hold is detected exactly like a deleted NO_GO hold.
rm -f "$HOLD"
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "gate_hold_tampered" and
  .data.holdIntegrity == "missing" and .data.ledgerVerdict == "HUMAN_DECISION"
' >/dev/null
bash "$GATE" claim run-hold-restore "$BUILD_SHA" >/dev/null
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" finish "$BUILD_SHA" run-hold-restore NO_GO >/dev/null
bash "$GATE" claim run-hold-3 "$BUILD_SHA" >/dev/null
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" finish "$BUILD_SHA" run-hold-3 GO >/dev/null
[ ! -e "$HOLD" ]
# GO with no prior hold is a no-op, not an error.
bash "$GATE" claim run-hold-4 "$BUILD_SHA" >/dev/null
SMOKE_GATE_HOLD_FILE="$HOLD" bash "$GATE" finish "$BUILD_SHA" run-hold-4 GO \
  | jq -e '.ok == true' >/dev/null

# --- Deploy-lag acceptance, stuck-head alert, live-run artifact -------------
# Fresh state dir per scenario: these assert first-claim behaviour.
OLD_SHA="$(printf 'c%.0s' $(seq 40))"
fresh_state() {
  STATE_DIR2="$(mktemp -d)"
  export SMOKE_GATE_STATE_DIR="$STATE_DIR2"
  export SMOKE_GATE_DEBOUNCE_SECONDS=0
  unset SMOKE_GATE_FRONTEND_PATHS SMOKE_GATE_BACKEND_PATHS SMOKE_GATE_ACTIVE_FILE \
        STUB_FRONTEND_SHA STUB_BACKEND_SHA STUB_FRONTEND_CI STUB_COMPARE_FILES \
        SMOKE_GATE_UNSETTLED_ALERT_SECONDS \
        SMOKE_GATE_FREEZE_HANDOFF SMOKE_GATE_FREEZE_HELPER SMOKE_GATE_HOLD_FILE \
        STUB_FREEZE_EXIT STUB_FREEZE_JSON STUB_FREEZE_PR_STATE \
        SMOKE_GATE_PR_STATE_DIR SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS 2>/dev/null || true
}

# 16. Backend-only merge: frontend deploy lags, nothing under frontend paths
# changed → the lag is accepted and the run claims, flagged in the payload.
fresh_state
export STUB_FRONTEND_SHA="$OLD_SHA"
export STUB_COMPARE_FILES='[{"filename":"XZO-BACKEND/src/approvals.ts"},{"filename":"docs/notes.md"}]'
export SMOKE_GATE_FRONTEND_PATHS="XZO-FRONTEND/,frontend/"
export SMOKE_GATE_BACKEND_PATHS="XZO-BACKEND/"
bash "$GATE" poll | jq -e '.wakeAgent == false' >/dev/null          # debounce
bash "$GATE" poll | jq -e --arg old "$OLD_SHA" --arg sha "$BUILD_SHA" '
  .wakeAgent == true and .data.trigger == "develop_build_settled" and
  .data.sourceSha == $sha and .data.frontendDeploySha == $old and
  .data.deployLagAccepted.frontend == true and
  .data.deployLagAccepted.backend == false
' >/dev/null

# 17. Same lag, but a frontend file DID change → never settles (fail-closed).
fresh_state
export STUB_FRONTEND_SHA="$OLD_SHA"
export STUB_COMPARE_FILES='[{"filename":"XZO-FRONTEND/src/App.tsx"}]'
export SMOKE_GATE_FRONTEND_PATHS="XZO-FRONTEND/"
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "waiting_for_settled_build"' >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "waiting_for_settled_build"' >/dev/null

# 17b. Lag with paths unset stays strict even when nothing relevant changed.
fresh_state
export STUB_FRONTEND_SHA="$OLD_SHA"
export STUB_COMPARE_FILES='[{"filename":"docs/notes.md"}]'
bash "$GATE" poll | jq -e '.data.trigger == "waiting_for_settled_build"' >/dev/null

# 18. Red CI: one wake per stuck head after the alert window, never a re-spam.
fresh_state
export STUB_FRONTEND_CI=failure
export SMOKE_GATE_UNSETTLED_ALERT_SECONDS=0
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "develop_unsettled" and
  .data.failedChecks == 1 and .data.pendingChecks == 0 and
  (.data.failedWorkflows | index("Frontend CI")) != null and
  .data.frontendDeployLag == false and (.data.unsettledForSeconds | type) == "number"
' >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "waiting_for_settled_build"' >/dev/null
# Recovery of the same head clears the alert state so a later stall re-alerts.
unset STUB_FRONTEND_CI
bash "$GATE" poll >/dev/null
jq -e '.unsettledSha == null and .unsettledWakeSha == null' "$STATE_DIR2/develop-state.json" >/dev/null

# 19. Live-run artifact: written on claim with a merge-hold cap, refreshed by
# progress, removed by finish.
fresh_state
export SMOKE_GATE_ACTIVE_FILE="$STATE_DIR2/pub/run-active.json"
export SMOKE_GATE_MERGE_HOLD_SECONDS=5400
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == true' >/dev/null
ACTIVE_RUN="$(jq -r '.activeRunId' "$STATE_DIR2/develop-state.json")"
jq -e --arg run "$ACTIVE_RUN" --arg sha "$BUILD_SHA" '
  .schemaVersion == 1 and .runId == $run and .sha == $sha and
  .progressAt == null and
  ((.holdMergesUntil | fromdateiso8601) - (.startedAt | fromdateiso8601) == 5400)
' "$SMOKE_GATE_ACTIVE_FILE" >/dev/null
bash "$GATE" progress "$ACTIVE_RUN" | jq -e '.ok == true' >/dev/null
jq -e '.progressAt != null' "$SMOKE_GATE_ACTIVE_FILE" >/dev/null

# 19b. A PR opened AFTER the freeze still gets the advisory notice, because
# progress re-posts it. Claim could only reach the heads that existed then.
export SMOKE_GATE_FREEZE_STATUS_CONTEXT="qa/freeze"
export STUB_STATUS_LOG="$STATE_DIR2/statuses.log"
export STUB_PR_HEADS="head-opened-mid-run"
: > "$STUB_STATUS_LOG"
bash "$GATE" progress "$ACTIVE_RUN" | jq -e '.mergeHold == true' >/dev/null
grep -q "statuses/head-opened-mid-run" "$STUB_STATUS_LOG"
grep -q "QA smoke run active on develop" "$STUB_STATUS_LOG"
# A campaign that opted out of the hold must not raise one from a stamp.
bash "$GATE" claim "$ACTIVE_RUN" "$BUILD_SHA" false >/dev/null
: > "$STUB_STATUS_LOG"
bash "$GATE" progress "$ACTIVE_RUN" | jq -e '.mergeHold == false' >/dev/null
[ ! -s "$STUB_STATUS_LOG" ]
bash "$GATE" claim "$ACTIVE_RUN" "$BUILD_SHA" true >/dev/null
unset SMOKE_GATE_FREEZE_STATUS_CONTEXT STUB_STATUS_LOG STUB_PR_HEADS

bash "$GATE" finish "$BUILD_SHA" "$ACTIVE_RUN" GO | jq -e '.ok == true' >/dev/null
[ ! -e "$SMOKE_GATE_ACTIVE_FILE" ]

# 18. Hold reconciliation: a NO_GO ledger whose hold file was deleted by
# something other than this gate wakes once, then stays quiet until it changes.
HOLD2="$STATE_DIR/pub2/develop-hold.json"
bash "$GATE" claim run-tamper "$BUILD_SHA" >/dev/null
SMOKE_GATE_HOLD_FILE="$HOLD2" bash "$GATE" finish "$BUILD_SHA" run-tamper NO_GO >/dev/null
[ -s "$HOLD2" ]
trash "$HOLD2" 2>/dev/null || command rm -f "$HOLD2"   # a sibling clears the objection
export STUB_SOURCE_SHA="$(printf 'c%.0s' $(seq 40))"
SMOKE_GATE_HOLD_FILE="$HOLD2" bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "gate_hold_tampered" and
  .data.holdIntegrity == "missing" and .data.ledgerVerdict == "NO_GO"
' >/dev/null
SMOKE_GATE_HOLD_FILE="$HOLD2" bash "$GATE" poll | jq -e '
  .data.trigger != "gate_hold_tampered"
' >/dev/null                                    # throttled, not a wake per poll

# 19. A hold whose runId is not the ledger's is tampering too, not just absence.
printf '{"runId":"someone-else","verdict":"NO_GO"}' > "$HOLD2"
SMOKE_GATE_HOLD_FILE="$HOLD2" bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.holdIntegrity == "mismatched"
' >/dev/null

# 20. With no hold file configured the reconciliation is inert.
bash "$GATE" poll | jq -e '.data.trigger != "gate_hold_tampered"' >/dev/null

# 21. Wake window. Pure-logic table over in_wake_window — the campaign wake is
# the only trigger it gates, and the two failure shapes that would be invisible
# in production are a midnight-wrapping window and the `08`/`09` octal trap
# (without `10#` the gate errors every day between 08:00 and 09:59).
WIN_FN="$STATE_DIR/in-wake-window.sh"
sed -n '/^in_wake_window() {/,/^}/p' "$GATE" > "$WIN_FN"
win_case() {                                    # window now expected
  local got
  got="$(WAKE_WINDOW="$1" WAKE_TZ=UTC bash -c "
    $(cat "$WIN_FN")
    date() { echo '$2'; }
    in_wake_window")"
  [ "$got" = "$3" ] || { echo "wake window: $1 at $2 gave $got, wanted $3" >&2; exit 1; }
}
win_case "03:00-06:00" "03:00" true             # inclusive lower bound
win_case "03:00-06:00" "05:59" true
win_case "03:00-06:00" "06:00" false            # exclusive upper bound
win_case "03:00-06:00" "02:59" false
win_case "03:00-06:00" "08:15" false            # octal trap
win_case "03:00-06:00" "09:09" false            # octal trap
win_case "22:00-02:00" "23:30" true             # wraps midnight
win_case "22:00-02:00" "01:59" true
win_case "22:00-02:00" "02:00" false
win_case "22:00-02:00" "12:00" false

# 22. An unset window is always open — no deployment changes behaviour by
# picking up a new skill version, and the campaign wake still fires.
export STUB_SOURCE_SHA="$(printf 'd%.0s' $(seq 40))"
bash "$GATE" poll >/dev/null                     # debounce: first sighting
bash "$GATE" poll | jq -e '.data.trigger == "outside_wake_window" | not' >/dev/null

# 23. Campaign preflight. A failing precondition must REFUSE the campaign and
# still be heard — a silent no-wake here would stack a silent refusal on top of
# the silent failure the check exists to catch. It must also not re-alarm every
# poll, must re-arm the moment the reason text changes, and must never leave a
# stale latch behind once the precondition is repaired.
# Own state dir, per this file's convention from case 16 on — the cases above
# leave a claimed run behind, and `$STATE_FILE` still points at the ORIGINAL
# dir rather than the rebound one, so asserting against it here would read an
# unrelated file while every poll returned `queued_behind_active_run`.
fresh_state
PF_STATE="$SMOKE_GATE_STATE_DIR/develop-state.json"

# ONE poll per call. A refused campaign leaves the candidate settled (that is
# the design — the campaign opens as soon as the precondition is repaired), so a
# helper that polled twice would run the preflight twice and only ever return
# the throttled second result, hiding every re-arm.
pf_poll() { SMOKE_GATE_PREFLIGHT_CMD="$1" bash "$GATE" poll; }

# Push the last preflight wake back past the re-arm floor. Cases that assert a
# changed reason DOES wake have to say so explicitly now — the floor is the
# default, and a test that got a wake without ageing the latch would be
# asserting the bug the floor exists to prevent.
pf_age() {
  local t; t="$(date -u -d '@'$(( $(date -u +%s) - 1000 )) +'%Y-%m-%dT%H:%M:%SZ')"
  jq --arg t "$t" '.preflightWakeAt=$t' "$PF_STATE" > "$PF_STATE.tmp" && mv "$PF_STATE.tmp" "$PF_STATE"
}

pf_sha() {                                       # new SHA: first sighting debounces
  export STUB_SOURCE_SHA="$(printf "$1%.0s" $(seq 40))"
  SMOKE_GATE_PREFLIGHT_CMD='exit 0' bash "$GATE" poll >/dev/null
}
pf_sha e

# Fails -> wakes with the last line of output as the reason, campaign not opened.
pf_poll 'echo noise; echo "3 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == true and .data.trigger == "preflight_failed" and
  .data.reason == "3 of 8 QA seats could not be verified" and .data.exitCode == 1
' >/dev/null
jq -e '.activeSha == null and .candidateSha != null' "$PF_STATE" >/dev/null

# Same reason on the next poll is throttled to a no-wake, and the candidate is
# still preserved so the campaign opens as soon as the seats are fixed.
pf_poll 'echo "3 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == false and .data.trigger == "preflight_failed"
' >/dev/null

# A CHANGED reason does NOT re-arm inside the floor. The reason text names
# which checks failed, so it is rewritten by any flap — network blip, one seat
# recovering — and text-change alone would wake once per poll. The gate's own
# rule is that an alarm nobody can ignore is one that does not repeat every ten
# minutes.
pf_poll 'echo "8 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == false and .data.trigger == "preflight_failed"
' >/dev/null
# ...but the new text IS recorded, so it is the text the next wake compares
# against rather than a stale one.
jq -e '.preflightReason == "8 of 8 QA seats could not be verified"' "$PF_STATE" >/dev/null

# ...and once the floor has passed, a reason that RETURNS to the last ALARMED
# one must NOT re-arm. This is the case that separates INVARIANT 2's
# fingerprint latch from a reason latch, and nothing else in this suite does:
# the throttled branch above persists `.preflightReason` but deliberately NOT
# `.preflightFingerprint`, so "last seen" and "last alarmed" diverge the moment
# a flap is throttled. Keying on the reason would read 3 -> 8 -> 3 as news and
# wake for an incident the operator has already been told about, every time the
# text flaps back. Every other preflight case here either runs inside the floor
# or sets SMOKE_GATE_PREFLIGHT_ALERT_SECONDS=0, which disables the throttle and
# makes both keyings behave identically.
pf_age
pf_poll 'echo "3 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == false and .data.trigger == "preflight_failed"
' >/dev/null

# Once the floor has passed, a changed reason re-arms — 3 dead seats becoming 8
# is news, and the floor delays that news, never suppresses it.
pf_age
pf_poll 'echo "6 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == true and .data.reason == "6 of 8 QA seats could not be verified"
' >/dev/null

# Silent failure still yields a usable reason rather than an empty Slack line.
pf_age
pf_poll 'exit 3' | jq -e '
  .wakeAgent == true and .data.exitCode == 3 and
  (.data.reason | test("exited 3 with no output"))
' >/dev/null

# A hanging preflight is a failure, not a hang: bounded and reported as one.
pf_age
SMOKE_GATE_PREFLIGHT_TIMEOUT=1 pf_poll 'sleep 30' | jq -e '
  .wakeAgent == true and .data.exitCode == 124 and (.data.reason | test("timed out"))
' >/dev/null

# Passing preflight opens the campaign AND clears the latch, so the next failure
# alarms immediately instead of inheriting a throttle window from a fixed outage.
pf_poll 'echo "All 8 QA seats authenticated."; exit 0' | jq -e '
  .wakeAgent == true and .data.trigger == "develop_build_settled"
' >/dev/null
jq -e '.preflightReason == null and .preflightWakeAt == null' "$PF_STATE" >/dev/null

# 24. With no preflight configured the seam is inert — a deployment that never
# sets it behaves exactly as it did before the check existed.
bash "$GATE" finish \
  "$(jq -r '.activeSha' "$PF_STATE")" "$(jq -r '.activeRunId' "$PF_STATE")" GO \
  | jq -e '.ok == true' >/dev/null
export STUB_SOURCE_SHA="$(printf '1%.0s' $(seq 40))"   # hex only: the gate validates ^[0-9a-f]{40}$
unset SMOKE_GATE_PREFLIGHT_CMD 2>/dev/null || true
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_build_settled"' >/dev/null

# --- 25. Handoff mode: settle cuts a freeze PR instead of opening a QA
# campaign, at the exact point develop_build_settled would otherwise fire.
# wakeAgent stays FALSE — zero agent tokens on the trigger step.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
FREEZE_TARGET="$(printf '1%.0s' $(seq 40))"
FREEZE_HEAD="$(printf '2%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$FREEZE_TARGET"
export STUB_FREEZE_JSON="{\"prNumber\":21,\"branch\":\"smoke/freeze-h\",\"freezeSha\":\"$FREEZE_HEAD\",\"targetSha\":\"$FREEZE_TARGET\"}"
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "debouncing_candidate"' >/dev/null
bash "$GATE" poll | jq -e --arg sha "$FREEZE_TARGET" --arg freeze "$FREEZE_HEAD" '
  .wakeAgent == false and .data.trigger == "develop_freeze_opened" and
  .data.freezePr == 21 and .data.freezeSha == $freeze and
  .data.targetSha == $sha and .data.sourceSha == $sha
' >/dev/null
jq -e --arg sha "$FREEZE_TARGET" --arg freeze "$FREEZE_HEAD" '
  .handoffFreezePr == 21 and .handoffFreezeSha == $freeze and .handoffTargetSha == $sha and
  .activeSha == null and .activeRunId == null
' "$STATE_DIR2/develop-state.json" >/dev/null

# --- 26. A new settled candidate while the handoff is open queues exactly
# like queued_behind_active_run — never a second freeze (one at a time, v1).
NEW_HEAD_SHA="$(printf '3%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$NEW_HEAD_SHA"
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "queued_behind_active_run"' >/dev/null
jq -e --arg sha "$FREEZE_TARGET" --arg newsha "$NEW_HEAD_SHA" '
  .handoffTargetSha == $sha and .candidateSha == $newsha
' "$STATE_DIR2/develop-state.json" >/dev/null

# --- 27. Abandoned-handoff recovery: the freeze PR closed with no completed
# verdict ever recorded. Frees the slot AND alarms in the same poll — a
# closed-with-no-verdict freeze PR is evidence a campaign died silently.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
ABANDON_TARGET="$(printf '4%.0s' $(seq 40))"
ABANDON_HEAD="$(printf '5%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$ABANDON_TARGET"
export STUB_FREEZE_JSON="{\"prNumber\":33,\"branch\":\"smoke/freeze-m\",\"freezeSha\":\"$ABANDON_HEAD\",\"targetSha\":\"$ABANDON_TARGET\"}"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null
export STUB_FREEZE_PR_STATE=CLOSED
bash "$GATE" poll | jq -e --argjson pr 33 --arg sha "$ABANDON_TARGET" '
  .wakeAgent == true and .data.trigger == "develop_freeze_abandoned" and
  .data.freezePr == $pr and .data.targetSha == $sha
' >/dev/null
jq -e '
  .handoffFreezePr == null and .handoffTargetSha == null and .completedSha == null
' "$STATE_DIR2/develop-state.json" >/dev/null

# --- 28. Dedup advance: smoke-pr-gate.sh's finish appends a ledger entry for
# the target sha. The next poll on the SAME source sha adopts it as completed
# (already_completed) instead of re-freezing — the ledger is the single
# source of truth for "this develop SHA already ran."
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
DEDUP_TARGET="$(printf '6%.0s' $(seq 40))"
DEDUP_HEAD="$(printf '7%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$DEDUP_TARGET"
export STUB_FREEZE_JSON="{\"prNumber\":44,\"branch\":\"smoke/freeze-p\",\"freezeSha\":\"$DEDUP_HEAD\",\"targetSha\":\"$DEDUP_TARGET\"}"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null
jq -cn --arg target "$DEDUP_TARGET" --arg freeze "$DEDUP_HEAD" --argjson pr 44 \
  --arg run "smoke-pr44-run-1" --arg verdict "GO" --arg now "2026-08-12T00:00:00Z" \
  '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,freezePr:$pr,runId:$run,verdict:$verdict,finishedAt:$now}' \
  >> "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "already_completed"' >/dev/null
jq -e --arg sha "$DEDUP_TARGET" --arg run "smoke-pr44-run-1" '
  .completedSha == $sha and .completedVerdict == "GO" and .completedRunId == $run and
  .handoffFreezePr == null and .handoffTargetSha == null
' "$STATE_DIR2/develop-state.json" >/dev/null

# --- 29. Tamper check accepts a legitimate freeze-run hold, and still fires
# on a genuinely foreign one. The ledger consult (28) runs BEFORE hold-file
# reconciliation every poll, so a hold this exact finish wrote is never read
# as tampered — not even transiently on the first poll that sees it.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
TAMPER_HOLD="$STATE_DIR2/pub/develop-hold.json"
export SMOKE_GATE_HOLD_FILE="$TAMPER_HOLD"
TAMPER_TARGET="$(printf '8%.0s' $(seq 40))"
TAMPER_HEAD="$(printf '9%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$TAMPER_TARGET"
export STUB_FREEZE_JSON="{\"prNumber\":55,\"branch\":\"smoke/freeze-r\",\"freezeSha\":\"$TAMPER_HEAD\",\"targetSha\":\"$TAMPER_TARGET\"}"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null
FREEZE_RUN_ID="smoke-pr55-run-tamper-ok"
mkdir -p "$(dirname "$TAMPER_HOLD")"
jq -cn --arg sha "$TAMPER_TARGET" --arg run "$FREEZE_RUN_ID" --arg now "2026-08-12T00:00:00Z" \
  '{schemaVersion:1,sha:$sha,runId:$run,verdict:"NO_GO",raisedAt:$now,reason:"x"}' > "$TAMPER_HOLD"
jq -cn --arg target "$TAMPER_TARGET" --arg freeze "$TAMPER_HEAD" --argjson pr 55 \
  --arg run "$FREEZE_RUN_ID" --arg verdict "NO_GO" --arg now "2026-08-12T00:00:00Z" \
  '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,freezePr:$pr,runId:$run,verdict:$verdict,finishedAt:$now}' \
  >> "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll | jq -e '
  .data.trigger == "already_completed" and .data.trigger != "gate_hold_tampered"
' >/dev/null
# Now corrupt the hold to a runId that matches neither the ledger nor this
# gate's own completedRunId — a genuinely foreign hold must still be caught.
printf '{"runId":"someone-else-entirely"}' > "$TAMPER_HOLD"
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "gate_hold_tampered" and .data.holdIntegrity == "mismatched"
' >/dev/null

# --- 30. P1 regression: ledger adoption must bind to the SAME freezePr as
# the currently open handoff, not just targetSha — targetSha is the develop
# head SHA, public and echoed in our own wake payload, so it alone proves
# nothing. Reproduced exactly as reported: a forged/stale line naming a
# DIFFERENT freezePr (999) for the real handoff's targetSha must never be
# adopted, must never free the real handoff (PR 100), and must alarm once
# rather than silently mis-completing a campaign that never ran.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
FORGE_TARGET="$(printf 'a%.0s' $(seq 40))"
FORGE_HEAD="$(printf 'b%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$FORGE_TARGET"
export STUB_FREEZE_JSON="{\"prNumber\":100,\"branch\":\"smoke/freeze-a\",\"freezeSha\":\"$FORGE_HEAD\",\"targetSha\":\"$FORGE_TARGET\"}"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened" and .data.freezePr == 100' >/dev/null
jq -cn --arg target "$FORGE_TARGET" --arg freeze "$FORGE_HEAD" --argjson pr 999 \
  --arg run "smoke-pr999-fake-run" --arg verdict "GO" --arg now "2026-08-12T00:00:00Z" \
  '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,freezePr:$pr,runId:$run,verdict:$verdict,finishedAt:$now}' \
  >> "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll | jq -e --argjson expected 100 --argjson got 999 --arg sha "$FORGE_TARGET" '
  .wakeAgent == true and .data.trigger == "develop_freeze_ledger_tampered" and
  .data.expectedFreezePr == $expected and .data.gotFreezePr == $got and .data.targetSha == $sha
' >/dev/null
jq -e --argjson pr 100 --arg sha "$FORGE_TARGET" '
  .handoffFreezePr == $pr and .handoffTargetSha == $sha and .completedSha == null
' "$STATE_DIR2/develop-state.json" >/dev/null
# Latched: the identical mismatch does not re-alarm every poll — the real
# handoff (PR 100) is still open, so the busy-check reports it as such.
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "already_active"' >/dev/null

# --- 31. develop_freeze_abandoned now names the target SHA's own hold/
# publish artifacts, so the responder checks for a completed-but-unrecorded
# campaign before assuming the campaign died silently.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
HINT_PUBLISH="$STATE_DIR2/pub/latest-verdict.json"
HINT_HOLD="$STATE_DIR2/pub/develop-hold.json"
export SMOKE_GATE_PUBLISH_FILE="$HINT_PUBLISH" SMOKE_GATE_HOLD_FILE="$HINT_HOLD"
HINT_TARGET="$(printf 'c%.0s' $(seq 40))"
HINT_HEAD="$(printf 'd%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$HINT_TARGET"
export STUB_FREEZE_JSON="{\"prNumber\":66,\"branch\":\"smoke/freeze-c\",\"freezeSha\":\"$HINT_HEAD\",\"targetSha\":\"$HINT_TARGET\"}"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null
export STUB_FREEZE_PR_STATE=CLOSED
bash "$GATE" poll | jq -e --arg publish "$HINT_PUBLISH" --arg hold "$HINT_HOLD" '
  .data.trigger == "develop_freeze_abandoned" and
  (.data.hint | length) > 0 and .data.publishFile == $publish and .data.holdFile == $hold
' >/dev/null
unset SMOKE_GATE_PUBLISH_FILE SMOKE_GATE_HOLD_FILE STUB_FREEZE_PR_STATE

# --- 32. P3: a freeze-helper "branch already exists" failure names the
# orphaned branch in the alarm data, not just the free-text reason.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
ORPHAN_SHA="$(printf 'e%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$ORPHAN_SHA"
export STUB_FREEZE_JSON='{"ok":false,"error":"branch already exists — delete it first or pick a different target","branch":"smoke/freeze-eeeeeeeeeeee"}'
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "develop_freeze_failed" and
  .data.orphanBranch == "smoke/freeze-eeeeeeeeeeee"
' >/dev/null

# --- 33. P2 regression: a latched tamper mismatch must never shadow
# abandonment. Reviewer's exact repro: latch the tamper alarm via a
# mismatched ledger entry, then close the real freeze PR — abandonment must
# still fire and free the slot. Before the fix, the abandonment check sat
# only in the `elif` (ledger entirely empty), so ANY targetSha-matching
# entry — including a mismatched one that only latches the tamper alarm —
# shadowed it forever: every later poll reported already_active, no
# abandonment ever fired, and no gate command could clear
# handoffFreezePr/handoffTargetSha by hand.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
WEDGE_TARGET="$(printf 'f%.0s' $(seq 40))"
WEDGE_HEAD="$(printf '0%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$WEDGE_TARGET"
export STUB_FREEZE_JSON="{\"prNumber\":200,\"branch\":\"smoke/freeze-f\",\"freezeSha\":\"$WEDGE_HEAD\",\"targetSha\":\"$WEDGE_TARGET\"}"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened" and .data.freezePr == 200' >/dev/null
jq -cn --arg target "$WEDGE_TARGET" --arg freeze "$WEDGE_HEAD" --argjson pr 777 \
  --arg run "smoke-pr777-fake-run" --arg verdict "GO" --arg now "2026-08-12T00:00:00Z" \
  '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,freezePr:$pr,runId:$run,verdict:$verdict,finishedAt:$now}' \
  >> "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_ledger_tampered"' >/dev/null
# The real freeze PR closes with no matching verdict ever recorded.
export STUB_FREEZE_PR_STATE=CLOSED
bash "$GATE" poll | jq -e --argjson pr 200 --arg sha "$WEDGE_TARGET" '
  .wakeAgent == true and .data.trigger == "develop_freeze_abandoned" and
  .data.freezePr == $pr and .data.targetSha == $sha
' >/dev/null
jq -e '
  .handoffFreezePr == null and .handoffTargetSha == null and .completedSha == null
' "$STATE_DIR2/develop-state.json" >/dev/null
unset STUB_FREEZE_PR_STATE

# --- 34. A ledger line with no freezePr at all (malformed) must never crash
# the tamper-alarm jq (tonumber on the literal "null") — it is treated as a
# mismatch and still alarms, reporting the raw value instead of erroring
# into an empty-stdout poll.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
MALFORMED_TARGET="$(printf '3%.0s' $(seq 40))"
MALFORMED_HEAD="$(printf '4%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$MALFORMED_TARGET"
export STUB_FREEZE_JSON="{\"prNumber\":300,\"branch\":\"smoke/freeze-3\",\"freezeSha\":\"$MALFORMED_HEAD\",\"targetSha\":\"$MALFORMED_TARGET\"}"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null
jq -cn --arg target "$MALFORMED_TARGET" --arg freeze "$MALFORMED_HEAD" \
  --arg run "smoke-malformed-run" --arg verdict "GO" --arg now "2026-08-12T00:00:00Z" \
  '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,runId:$run,verdict:$verdict,finishedAt:$now}' \
  >> "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "develop_freeze_ledger_tampered" and .data.gotFreezePr == "null"
' >/dev/null

# --- 33. Staleness ceiling: a freeze that outlives the ceiling while develop
# moves on frees its slot and alarms, so the next poll re-freezes on current
# head instead of campaigning a superseded build. The first live cycle ran a
# 14-hour-old freeze for exactly this reason.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
STALE_TARGET="$(printf '6%.0s' $(seq 40))"
STALE_FREEZE="$(printf '7%.0s' $(seq 40))"
MOVED_HEAD="$(printf '8%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$STALE_TARGET"
export STUB_FREEZE_JSON="{\"prNumber\":44,\"branch\":\"smoke/freeze-s\",\"freezeSha\":\"$STALE_FREEZE\",\"targetSha\":\"$STALE_TARGET\"}"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null

# Ceiling not reached: still held, no alarm, even once develop moves.
export STUB_SOURCE_SHA="$MOVED_HEAD"
export SMOKE_GATE_FREEZE_STALE_SECONDS=99999
bash "$GATE" poll | jq -e '.data.trigger != "develop_freeze_stale"' >/dev/null
jq -e --argjson pr 44 '.handoffFreezePr == $pr' "$STATE_DIR2/develop-state.json" >/dev/null

# Ceiling reached but develop has NOT moved: the freeze still describes the
# current head, so there is nothing stale about it.
export STUB_SOURCE_SHA="$STALE_TARGET"
export SMOKE_GATE_FREEZE_STALE_SECONDS=0
bash "$GATE" poll | jq -e '.data.trigger != "develop_freeze_stale"' >/dev/null
jq -e --argjson pr 44 '.handoffFreezePr == $pr' "$STATE_DIR2/develop-state.json" >/dev/null

# Both: alarm once, slot freed, no verdict invented for the stale target.
export STUB_SOURCE_SHA="$MOVED_HEAD"
bash "$GATE" poll | jq -e --argjson pr 44 --arg sha "$STALE_TARGET" --arg cur "$MOVED_HEAD" '
  .wakeAgent == true and .data.trigger == "develop_freeze_stale" and
  .data.freezePr == $pr and .data.targetSha == $sha and .data.currentSha == $cur
' >/dev/null
jq -e '
  .handoffFreezePr == null and .handoffTargetSha == null and .completedSha == null
' "$STATE_DIR2/develop-state.json" >/dev/null
# Slot free: the next poll cuts a fresh freeze on the CURRENT head.
export STUB_FREEZE_JSON="{\"prNumber\":45,\"branch\":\"smoke/freeze-s2\",\"freezeSha\":\"$STALE_FREEZE\",\"targetSha\":\"$MOVED_HEAD\"}"
# The moved head was already debounced during the checks above, so the freeze
# may open on this poll or the next; accept either rather than pinning the
# debounce bookkeeping this test is not about.
STALE_OUT="$(bash "$GATE" poll)"
jq -e '.data.trigger == "develop_freeze_opened"' <<<"$STALE_OUT" >/dev/null ||
  STALE_OUT="$(bash "$GATE" poll)"
jq -e --arg sha "$MOVED_HEAD" '
  .data.trigger == "develop_freeze_opened" and .data.targetSha == $sha
' <<<"$STALE_OUT" >/dev/null

# --- 33b. Handoff disposition (SMOKE_GATE_PR_STATE_DIR). An open freeze is
# classified from the PR gate's own per-PR state, and a freeze no campaign ever
# started on raises ONE latched develop_freeze_unclaimed well before the stale
# path. Live: six consecutive freezes were cut, never polled, aged out and
# closed with no alarm while the PR-gate watcher series was wedged.
UC_TARGET="$(printf '1%.0s' $(seq 40))"
UC_FREEZE="$(printf '2%.0s' $(seq 40))"
UC_MOVED="$(printf '5%.0s' $(seq 40))"
uc_open() {  # <pr> — fresh state dir with one open handoff on UC_TARGET
  fresh_state
  export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
  export SMOKE_GATE_FREEZE_STALE_SECONDS=14400
  export STUB_SOURCE_SHA="$UC_TARGET"
  export STUB_FREEZE_JSON="{\"prNumber\":$1,\"branch\":\"smoke/freeze-uc\",\"freezeSha\":\"$UC_FREEZE\",\"targetSha\":\"$UC_TARGET\"}"
  bash "$GATE" poll >/dev/null
  bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null
  PR_DIR="$(mktemp -d)"
}
uc_age() {  # <seconds> — backdate the open handoff
  jq --arg t "$(/usr/bin/date -u -d "@$(( $(/usr/bin/date -u +%s) - $1 ))" +'%Y-%m-%dT%H:%M:%SZ')" \
    '.handoffOpenedAt=$t' "$STATE_DIR2/develop-state.json" > "$STATE_DIR2/develop-state.json.tmp" &&
    mv "$STATE_DIR2/develop-state.json.tmp" "$STATE_DIR2/develop-state.json"
}
uc_ago() { /usr/bin/date -u -d "@$(( $(/usr/bin/date -u +%s) - $1 ))" +'%Y-%m-%dT%H:%M:%SZ'; }
uc_fail() { echo "33b: $1" >&2; exit 1; }

# Env unset = inert, byte-for-byte: no field on the no-wake line, the stale
# payload keeps its exact key list and its exact hint, no alarm at any age.
uc_open 60
uc_age 9000
UC_OUT="$(bash "$GATE" poll)"
[ "$(jq -c '[.wakeAgent, (.data | keys_unsorted)]' <<<"$UC_OUT")" = \
  '[false,["schemaVersion","trigger","sourceSha","backendDeploySha","frontendDeploySha","checkCount"]]' ] ||
  uc_fail "inert no-wake line changed shape: $UC_OUT"
jq -e '.handoffUnclaimedAlertFor == null' "$STATE_DIR2/develop-state.json" >/dev/null
export STUB_SOURCE_SHA="$UC_MOVED" SMOKE_GATE_FREEZE_STALE_SECONDS=0
UC_OUT="$(bash "$GATE" poll)"
[ "$(jq -c '.data | keys_unsorted' <<<"$UC_OUT")" = \
  '["schemaVersion","trigger","freezePr","targetSha","currentSha","ageSeconds","hint"]' ] ||
  uc_fail "inert stale payload changed shape: $UC_OUT"
[ "$(jq -r '.data.hint' <<<"$UC_OUT")" = "This freeze is older than the staleness ceiling and develop has moved past it. Close the freeze PR (this also tears down its previews) unless a campaign is still live on it; a fresh freeze is cut on the next poll. Do not publish a verdict for a build nobody ships." ] ||
  uc_fail "inert stale hint changed: $UC_OUT"

# Healthy delayed readiness: young freeze, PR gate has written nothing yet
# (it writes no per-PR state until the preview backend is live) — classified,
# silent, not latched.
uc_open 61
export SMOKE_GATE_PR_STATE_DIR="$PR_DIR" SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS=5400
uc_age 600
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.trigger == "already_active" and .data.freezePr == 61 and
  .data.campaignTrace.disposition == "never_started" and
  .data.campaignTrace.detail == "no_pr_gate_state"
' >/dev/null || uc_fail "young unclaimed freeze was not a silent classified no-wake"
jq -e '.handoffUnclaimedAlertFor == null' "$STATE_DIR2/develop-state.json" >/dev/null

# No watcher: past the window with no per-PR state → exactly one wake. The slot
# stays held and nothing tells the responder to close.
uc_age 6000
UC_OUT="$(bash "$GATE" poll)"
jq -e --arg sha "$UC_TARGET" '
  .wakeAgent == true and .data.trigger == "develop_freeze_unclaimed" and
  .data.freezePr == 61 and .data.targetSha == $sha and .data.ageSeconds >= 6000 and
  .data.unclaimedAfterSeconds == 5400 and .data.staleAfterSeconds == 14400 and
  .data.campaignTrace.disposition == "never_started" and
  (.data.hint | test("Do NOT close"))
' <<<"$UC_OUT" >/dev/null || uc_fail "no-watcher freeze did not alarm: $UC_OUT"
jq -e '.handoffFreezePr == 61 and .handoffUnclaimedAlertFor == "61"' "$STATE_DIR2/develop-state.json" >/dev/null
# No repeated noise: latched for this freeze PR.
for _ in 1 2; do
  bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "already_active"' >/dev/null ||
    uc_fail "unclaimed alarm re-fired for the same freeze PR"
done
# Cross-gate: the REAL smoke-pr-gate.sh claims it in its own state dir — so the
# fields this gate reads are the ones that gate writes, not a fixture's guess —
# and the classification follows, still silent.
SMOKE_GATE_STATE_DIR="$PR_DIR" bash "$SCRIPT_DIR/smoke-pr-gate.sh" claim run-uc-61 61 "$UC_FREEZE" |
  jq -e '.ok == true' >/dev/null || uc_fail "real PR-gate claim failed"
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.campaignTrace.disposition == "campaign_live" and
  .data.campaignTrace.runId == "run-uc-61"
' >/dev/null || uc_fail "claimed freeze still reads never_started"

# ...and when that run dies without finishing, the PR gate's release returns
# the freeze to never_started (latched: no second wake for the same PR).
SMOKE_GATE_STATE_DIR="$PR_DIR" bash "$SCRIPT_DIR/smoke-pr-gate.sh" release run-uc-61 | jq -e '.ok == true' >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.campaignTrace.disposition == "never_started" and
  .data.campaignTrace.detail == "observed_not_claimed"
' >/dev/null || uc_fail "released freeze not reclassified never_started"
# Stale-close race: the PR is closed between polls. Abandonment still wins (its
# ordering is untouched) and now carries the trace; the latch does not block it.
export STUB_FREEZE_PR_STATE=CLOSED
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "develop_freeze_abandoned" and
  .data.freezePr == 61 and .data.campaignTrace.disposition == "never_started"
' >/dev/null || uc_fail "closed freeze PR did not win over the unclaimed path"
unset STUB_FREEZE_PR_STATE
# The latch re-arms only because the freeze PR changed: a NEW freeze on the
# same state dir alarms again. (Failed wake: the PR gate observed this one —
# per-PR state exists — but no run ever claimed it.)
export STUB_FREEZE_JSON="{\"prNumber\":62,\"branch\":\"smoke/freeze-uc2\",\"freezeSha\":\"$UC_FREEZE\",\"targetSha\":\"$UC_TARGET\"}"
UC_OUT="$(bash "$GATE" poll)"
jq -e '.data.trigger == "develop_freeze_opened"' <<<"$UC_OUT" >/dev/null || UC_OUT="$(bash "$GATE" poll)"
jq -e '.data.trigger == "develop_freeze_opened" and .data.freezePr == 62' <<<"$UC_OUT" >/dev/null ||
  uc_fail "slot did not re-freeze after abandonment: $UC_OUT"
jq -cn --arg sha "$UC_FREEZE" '{schemaVersion:1,pr:62,activeRunId:null,deployLiveSha:$sha,completedSha:null}' \
  > "$PR_DIR/pr-62-state.json"
uc_age 6000
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "develop_freeze_unclaimed" and .data.freezePr == 62 and
  .data.campaignTrace.detail == "observed_not_claimed"
' >/dev/null || uc_fail "observed-but-unclaimed freeze did not alarm"
bash "$GATE" poll | jq -e '.wakeAgent == false' >/dev/null
# An unreadable per-PR state file fails toward the alarm, never aborts the poll.
uc_open 63
export SMOKE_GATE_PR_STATE_DIR="$PR_DIR" SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS=5400
printf 'not json\n' > "$PR_DIR/pr-63-state.json"
uc_age 6000
bash "$GATE" poll | jq -e '
  .data.trigger == "develop_freeze_unclaimed" and .data.campaignTrace.detail == "pr_gate_state_unreadable"
' >/dev/null || uc_fail "unreadable per-PR state did not fail toward the alarm"

# Develop RED: every other handoff step waits for a settled build, this alarm
# must not — a dead PR-gate watcher has nothing to do with develop's CI, and an
# outage during a red develop would otherwise be exactly as silent as before.
uc_open 64
export SMOKE_GATE_PR_STATE_DIR="$PR_DIR" SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS=5400
export STUB_FRONTEND_CI=failure
uc_age 600
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "waiting_for_settled_build"' >/dev/null ||
  uc_fail "young freeze alarmed on a red develop"
uc_age 6000
UC_OUT="$(bash "$GATE" poll)"
jq -e --arg sha "$UC_TARGET" '
  .wakeAgent == true and .data.trigger == "develop_freeze_unclaimed" and .data.freezePr == 64 and
  .data.targetSha == $sha and .data.campaignTrace.disposition == "never_started"
' <<<"$UC_OUT" >/dev/null || uc_fail "never-started freeze stayed silent while develop was red: $UC_OUT"
jq -e '.handoffFreezePr == 64 and .handoffUnclaimedAlertFor == "64" and .unsettledSha != null' \
  "$STATE_DIR2/develop-state.json" >/dev/null || uc_fail "red-develop alarm lost the slot or the unsettled bookkeeping"
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "waiting_for_settled_build"' >/dev/null ||
  uc_fail "unclaimed alarm re-fired on a red develop"
# ...and the latch is the same one: once develop goes green, no second wake.
unset STUB_FRONTEND_CI
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "already_active"' >/dev/null ||
  uc_fail "unclaimed alarm fired twice across red -> green"
# Red develop, but the freeze is NOT never-started in any sense the settled
# path would accept: closed PR (abandonment owns it), a matching ledger row
# (adoption owns it), a live run. None may alarm from the unsettled branch.
uc_open 65
export SMOKE_GATE_PR_STATE_DIR="$PR_DIR" SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS=5400 STUB_FRONTEND_CI=failure
uc_age 6000
STUB_FREEZE_PR_STATE=CLOSED bash "$GATE" poll | jq -e '.wakeAgent == false' >/dev/null ||
  uc_fail "red develop alarmed over a closed freeze PR"
jq -cn --arg t "$UC_TARGET" --arg f "$UC_FREEZE" \
  '{schemaVersion:1,targetSha:$t,freezeSha:$f,freezePr:65,runId:"run-uc-65",verdict:"GO",finishedAt:"2026-09-15T12:00:00Z"}' \
  >> "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll | jq -e '.wakeAgent == false' >/dev/null || uc_fail "red develop alarmed over a finished freeze"
jq -e '.handoffUnclaimedAlertFor == null' "$STATE_DIR2/develop-state.json" >/dev/null
uc_open 66
export SMOKE_GATE_PR_STATE_DIR="$PR_DIR" SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS=5400 STUB_FRONTEND_CI=failure
SMOKE_GATE_STATE_DIR="$PR_DIR" bash "$SCRIPT_DIR/smoke-pr-gate.sh" claim run-uc-66 66 "$UC_FREEZE" >/dev/null
uc_age 6000
bash "$GATE" poll | jq -e '.wakeAgent == false' >/dev/null || uc_fail "red develop alarmed over a live campaign"
# Env unset on a red develop: inert, exact historic line, no latch.
uc_open 67
export STUB_FRONTEND_CI=failure
uc_age 9000
UC_OUT="$(bash "$GATE" poll)"
[ "$(jq -c '[.wakeAgent, .data.trigger, (.data | keys_unsorted)]' <<<"$UC_OUT")" = \
  '[false,"waiting_for_settled_build",["schemaVersion","trigger","sourceSha","backendDeploySha","frontendDeploySha","checkCount"]]' ] ||
  uc_fail "inert red-develop line changed: $UC_OUT"
jq -e '.handoffUnclaimedAlertFor == null' "$STATE_DIR2/develop-state.json" >/dev/null
unset STUB_FRONTEND_CI

# Supersession, one case per disposition. Past BOTH windows with develop moved:
# the stale wake still frees the slot, carries the trace, and only tells the
# responder to close a freeze nothing is running on.
uc_stale() {  # <pr> <pr-state-json or ""> → prints the stale poll line
  uc_open "$1"
  export SMOKE_GATE_PR_STATE_DIR="$PR_DIR" SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS=5400
  [ -z "$2" ] || printf '%s\n' "$2" > "$PR_DIR/pr-$1-state.json"
  uc_age 20000
  export STUB_SOURCE_SHA="$UC_MOVED"
  bash "$GATE" poll
  jq -e '.handoffFreezePr == null' "$STATE_DIR2/develop-state.json" >/dev/null ||
    uc_fail "stale wake for PR $1 did not free the slot"
}
# Never started: stale outranks the unclaimed alarm, and says what it is.
uc_stale 70 "" | jq -e '
  .data.trigger == "develop_freeze_stale" and .data.campaignTrace.disposition == "never_started" and
  (.data.hint | test("NO campaign ever started")) and (.data.hint | test("never-started"))
' >/dev/null || uc_fail "never-started supersession not accounted for"
# Campaign live: never "close".
uc_stale 71 "$(jq -cn --arg now "$(uc_ago 120)" --arg old "$(uc_ago 19000)" \
  '{activeRunId:"run-uc-71",activeStartedAt:$old,activeProgressAt:$now}')" | jq -e '
  .data.trigger == "develop_freeze_stale" and .data.campaignTrace.disposition == "campaign_live" and
  .data.campaignTrace.runId == "run-uc-71" and (.data.hint | test("Do NOT close"))
' >/dev/null || uc_fail "live campaign was told to close"
# Claimed/hung run: slot held, liveness signal older than the progress window.
uc_stale 72 "$(jq -cn --arg old "$(uc_ago 19000)" \
  '{activeRunId:"run-uc-72",activeStartedAt:$old,activeProgressAt:$old}')" | jq -e '
  .data.campaignTrace.disposition == "stalled" and .data.campaignTrace.runId == "run-uc-72" and
  (.data.campaignTrace.lastSignalAt | type == "string") and (.data.hint | test("stalled"))
' >/dev/null || uc_fail "hung run not classified stalled"
# Failed ledger append after a valid finish: finish recorded its intent, the
# ledger append failed, the slot stayed held for retry.
uc_stale 73 "$(jq -cn --arg old "$(uc_ago 19000)" --arg sha "$UC_FREEZE" \
  '{activeRunId:"run-uc-73",activeStartedAt:$old,activeProgressAt:$old,
    finishIntent:{runId:"run-uc-73",sha:$sha,verdict:"NO_GO",finishedAt:$old,digest:"d",recordedAt:$old}}')" |
  jq -e '
  .data.campaignTrace.disposition == "terminal_unreported" and
  .data.campaignTrace.detail == "finish_not_committed" and
  (.data.campaignTrace.verdictFile | endswith("/runs/run-uc-73/verdict.json")) and (.data.hint | test("Do NOT close"))
' >/dev/null || uc_fail "finish-without-ledger-row not classified terminal_unreported"
# ...and the committed shape (a finish that had no ledger configured).
uc_stale 74 "$(jq -cn --arg sha "$UC_FREEZE" \
  '{activeRunId:null,completedSha:$sha,completedRunId:"run-uc-74",completedAt:"2026-09-15T12:00:00Z"}')" | jq -e '
  .data.campaignTrace.disposition == "terminal_unreported" and
  .data.campaignTrace.detail == "completed_without_ledger_row" and
  .data.campaignTrace.runId == "run-uc-74"
' >/dev/null || uc_fail "completed-without-ledger-row not classified terminal_unreported"
# An intent for some OTHER sha is not this freeze's terminal state.
uc_stale 75 "$(jq -cn --arg now "$(uc_ago 60)" \
  '{activeRunId:"run-uc-75",activeStartedAt:$now,finishIntent:{runId:"run-uc-75",sha:"ffff"}}')" | jq -e '
  .data.campaignTrace.disposition == "campaign_live"
' >/dev/null || uc_fail "foreign finishIntent read as terminal"
# A reported terminal outcome never reaches classification: the ledger row is
# adopted exactly as before.
uc_open 76
export SMOKE_GATE_PR_STATE_DIR="$PR_DIR" SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS=5400
uc_age 6000
jq -cn --arg t "$UC_TARGET" --arg f "$UC_FREEZE" \
  '{schemaVersion:1,targetSha:$t,freezeSha:$f,freezePr:76,runId:"run-uc-76",verdict:"GO",finishedAt:"2026-09-15T12:00:00Z"}' \
  >> "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll | jq -e '.data.trigger != "develop_freeze_unclaimed"' >/dev/null
jq -e '.completedRunId == "run-uc-76" and .handoffFreezePr == null' "$STATE_DIR2/develop-state.json" >/dev/null ||
  uc_fail "ledger adoption changed"
# The new knob goes through num_env like every other; the trigger is ackable.
uc_open 77
SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS=90m bash "$GATE" poll | jq -e '
  .data.trigger == "gate_misconfigured" and (.data.missing | index("SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS") != null)
' >/dev/null || uc_fail "bad SMOKE_GATE_HANDOFF_UNCLAIMED_SECONDS was not named"
bash "$GATE" ack develop_freeze_unclaimed "77" acked | jq -e '.ok == true and .silenceable == false' >/dev/null
# Leave the ambient ceiling exactly as case 33 left it for the cases below.
export SMOKE_GATE_FREEZE_STALE_SECONDS=0

# --- 34. Campaign cadence floor: a settled head inside the cooldown does NOT
# freeze (candidate preserved), and the first poll past it freezes whatever
# develop has settled on by then — merges during cooldown batch into one
# campaign. Floor unset/0 = no behavior change (covered by every prior test).
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
CD_FIRST="$(printf '9%.0s' $(seq 40))"
CD_SECOND="$(printf 'a%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$CD_FIRST"
export STUB_FREEZE_JSON="{\"prNumber\":50,\"branch\":\"smoke/freeze-c1\",\"freezeSha\":\"$CD_FIRST\",\"targetSha\":\"$CD_FIRST\"}"
export SMOKE_GATE_FREEZE_MIN_INTERVAL_SECONDS=99999
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null

# Complete run 50 via ledger so the slot frees, then settle a NEW head inside
# the cooldown: no freeze, candidate survives.
printf '%s\n' "{\"schemaVersion\":1,\"targetSha\":\"$CD_FIRST\",\"freezeSha\":\"$CD_FIRST\",\"freezePr\":50,\"runId\":\"r50\",\"verdict\":\"GO\",\"finishedAt\":\"2026-01-01T00:00:00Z\"}" >> "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll >/dev/null
export STUB_SOURCE_SHA="$CD_SECOND"
bash "$GATE" poll >/dev/null   # debounce mark
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "freeze_cooldown"' >/dev/null
jq -e '.handoffFreezePr == null and .candidateSha != null' "$STATE_DIR2/develop-state.json" >/dev/null

# Cooldown elapsed: the SAME preserved candidate freezes on the next poll.
export SMOKE_GATE_FREEZE_MIN_INTERVAL_SECONDS=0
export STUB_FREEZE_JSON="{\"prNumber\":51,\"branch\":\"smoke/freeze-c2\",\"freezeSha\":\"$CD_SECOND\",\"targetSha\":\"$CD_SECOND\"}"
bash "$GATE" poll | jq -e --arg sha "$CD_SECOND" '
  .data.trigger == "develop_freeze_opened" and .data.targetSha == $sha
' >/dev/null

# --- 35. Handoff mode disables develop-gate claim: shared dev is not a
# campaign environment once campaigns run on previews. Chat-requested
# campaigns must route through the freeze flow; the refusal names it.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
CLAIM_SHA="$(printf 'b%.0s' $(seq 40))"
bash "$GATE" claim manual-run "$CLAIM_SHA" | jq -e '
  .ok == false and (.error | test("freeze")) and (.requestedCampaignFlow | length > 0)
' >/dev/null
# Refused before any state write: no state file at all, or no active run.
[ ! -s "$STATE_DIR2/develop-state.json" ] || jq -e '.activeRunId == null' "$STATE_DIR2/develop-state.json" >/dev/null
# Off-mode: claim still works exactly as before.
export SMOKE_GATE_FREEZE_HANDOFF=false
bash "$GATE" claim manual-run "$CLAIM_SHA" | jq -e '.ok == true and .runId == "manual-run"' >/dev/null

# --- 36. N4: a torn ledger line must not hide a LATER adoption match --------
# The ledger is appended to by smoke-pr-gate.sh, so a torn write is ordinary. A
# streaming `jq select()` aborts at the first malformed line and `2>/dev/null`
# hides it, so the outcome this poll is waiting for was silently invisible and
# the handoff sat open until the staleness ceiling. Same bug as the retention
# scan's, smaller blast radius.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
TORN_TARGET="$(printf 'c%.0s' $(seq 40))"
TORN_HEAD="$(printf 'd%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$TORN_TARGET"
export STUB_FREEZE_JSON="{\"prNumber\":55,\"branch\":\"smoke/freeze-t\",\"freezeSha\":\"$TORN_HEAD\",\"targetSha\":\"$TORN_TARGET\"}"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null
# A torn append lands BEFORE the real outcome line.
printf '{"schemaVersion":1,"targetSha":"%s","runId":"tor\n' "$TORN_TARGET" \
  >> "$STATE_DIR2/handoff-ledger.jsonl"
jq -cn --arg target "$TORN_TARGET" --arg freeze "$TORN_HEAD" --argjson pr 55 \
  --arg run "smoke-pr55-run-1" --arg verdict "NO_GO" --arg now "2026-08-25T00:00:00Z" \
  '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,freezePr:$pr,runId:$run,verdict:$verdict,finishedAt:$now}' \
  >> "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll | jq -e '.data.trigger == "already_completed"' >/dev/null
jq -e --arg sha "$TORN_TARGET" --arg run "smoke-pr55-run-1" '
  .completedSha == $sha and .completedVerdict == "NO_GO" and .completedRunId == $run and
  .handoffFreezePr == null and .handoffTargetSha == null
' "$STATE_DIR2/develop-state.json" >/dev/null

# --- 37. N3: the freeze helper is timed out like every other network call --
# It makes five sequential GitHub calls and was the only untimed one — and it
# runs holding the state lock, so a hung forge wedged the gate for as long as
# the call hung. Exit 124 lands in the existing throttled freeze-failure alarm.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
HANG_SHA="$(printf 'e%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$HANG_SHA"
export SMOKE_GATE_FREEZE_HELPER_TIMEOUT=1 STUB_FREEZE_SLEEP=5
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "develop_freeze_failed" and .data.exitCode == 124
' >/dev/null
unset STUB_FREEZE_SLEEP SMOKE_GATE_FREEZE_HELPER_TIMEOUT

# --- 38. Undecided promotion hold suppresses the NEXT round ----------------
# The loop this closes: a HUMAN_DECISION/NO_GO hold names findings a human has
# been asked to rule on, develop keeps moving, and every expiry of the cadence
# floor opened a fresh campaign to re-derive the same answer. Nothing in this
# file read the hold before opening a campaign — it only ever wrote it.
fresh_state
unset SMOKE_GATE_DECISION_LEDGER SMOKE_GATE_HOLD_ALERT_SECONDS 2>/dev/null || true
HOLD_SHA="$(printf 'f%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$HOLD_SHA"
HOLD_FILE="$STATE_DIR2/develop-hold.json"
LEDGER_DIR="$STATE_DIR2/gates"
mkdir -p "$LEDGER_DIR"
export SMOKE_GATE_HOLD_FILE="$HOLD_FILE" SMOKE_GATE_DECISION_LEDGER="$LEDGER_DIR"
hold_up() {
  jq -cn --arg run "$1" --arg sha "$2" \
    '{schemaVersion:1,sha:$sha,runId:$run,verdict:"HUMAN_DECISION",
      raisedAt:"2026-08-25T18:23:39Z",reason:"needs_human_decision"}' > "$HOLD_FILE"
}
hold_up "held-run-1" "$HOLD_SHA"
# First poll debounces, second alarms (new hold run id) and opens NOTHING.
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "develop_hold_undecided" and
  .data.holdRunId == "held-run-1" and .data.holdVerdict == "HUMAN_DECISION" and
  .data.pendingSeconds > 0
' >/dev/null
jq -e '.activeSha == null and .activeRunId == null' "$STATE_DIR2/develop-state.json" >/dev/null
# Third poll is throttled to a silent no-wake — still no campaign.
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.trigger == "hold_undecided"
' >/dev/null
jq -e '.activeSha == null' "$STATE_DIR2/develop-state.json" >/dev/null

# --- 38b. The hold is NEVER touched by any of this -------------------------
# Suppressing the round must not weaken the promotion gate: only a human clears
# a hold. If this ever passes with the file gone, the design is wrong.
jq -e '.runId == "held-run-1" and .verdict == "HUMAN_DECISION"' "$HOLD_FILE" >/dev/null

# --- 38c. An `override` on that run id re-opens the round ------------------
# The re-open trigger is the decision itself — no human restarts anything.
jq -cn '{ts:"2026-08-25T19:21:33Z",user:"approver",action:"override",
         target:"smoke_hold:held-run-1"}' > "$LEDGER_DIR/2026-08-25.jsonl"
bash "$GATE" poll | jq -e --arg sha "$HOLD_SHA" '
  .wakeAgent == true and .data.trigger == "develop_build_settled" and .data.sourceSha == $sha
' >/dev/null

# --- 38d. A later `correction` on the SAME target is NOT a decision --------
# Live case: a human wrote an override at 19:21:33Z and the desk wrote
# "not a human gate, authorizes nothing" on the same target at 20:27:00Z.
# Newest-line-wins is what tells those apart; matching any override anywhere in
# the file would read the corrected one as decided.
fresh_state
HOLD_FILE="$STATE_DIR2/develop-hold.json"
LEDGER_DIR="$STATE_DIR2/gates"
mkdir -p "$LEDGER_DIR"
export SMOKE_GATE_HOLD_FILE="$HOLD_FILE" SMOKE_GATE_DECISION_LEDGER="$LEDGER_DIR"
hold_up "held-run-2" "$HOLD_SHA"
{
  jq -cn '{ts:"2026-08-25T19:21:33Z",user:"approver",action:"override",target:"smoke_hold:held-run-2"}'
  jq -cn '{ts:"2026-08-25T20:27:00Z",user:"Barry",action:"correction",target:"smoke_hold:held-run-2"}'
} > "$LEDGER_DIR/2026-08-25.jsonl"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_hold_undecided"' >/dev/null

# --- 38e. An override for a DIFFERENT hold does not decide this one --------
jq -cn '{ts:"2026-08-25T21:00:00Z",user:"approver",action:"override",target:"smoke_hold:some-other-run"}' \
  >> "$LEDGER_DIR/2026-08-25.jsonl"
bash "$GATE" poll | jq -e '.data.trigger == "hold_undecided"' >/dev/null

# --- 38f. A torn append before the override must not hide it ---------------
# The desk appends live. A streaming `jq select` aborts at the first malformed
# line and drops every LATER match — including the decision we are looking for.
printf '{"ts":"2026-08-25T21:30:00Z","action":"over\n' >> "$LEDGER_DIR/2026-08-25.jsonl"
jq -cn '{ts:"2026-08-25T22:00:00Z",user:"approver",action:"override",target:"smoke_hold:held-run-2"}' \
  >> "$LEDGER_DIR/2026-08-25.jsonl"
bash "$GATE" poll | jq -e '.data.trigger == "develop_build_settled"' >/dev/null

# --- 38g. FAIL OPEN: an unreadable ledger proceeds as if undeployed --------
# "The check did not say yes" is not "the check said no". A missing dir, an
# unset path and an unreadable file are all `unknown`, and unknown must never
# wedge the fleet — failing closed on something unavailable where the code runs
# is the shape that caused two fleet-wide outages on 2026-08-25.
fresh_state
HOLD_FILE="$STATE_DIR2/develop-hold.json"
export SMOKE_GATE_HOLD_FILE="$HOLD_FILE"
export SMOKE_GATE_DECISION_LEDGER="$STATE_DIR2/does-not-exist"
hold_up "held-run-3" "$HOLD_SHA"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_build_settled"' >/dev/null

# ...and an existing-but-unreadable ledger file is `unknown` too, not "nobody
# decided". Skipped under root, which ignores file modes.
fresh_state
HOLD_FILE="$STATE_DIR2/develop-hold.json"
LEDGER_DIR="$STATE_DIR2/gates"
mkdir -p "$LEDGER_DIR"
export SMOKE_GATE_HOLD_FILE="$HOLD_FILE" SMOKE_GATE_DECISION_LEDGER="$LEDGER_DIR"
hold_up "held-run-4" "$HOLD_SHA"
echo '{}' > "$LEDGER_DIR/2026-08-25.jsonl"
chmod 000 "$LEDGER_DIR/2026-08-25.jsonl"
if [ "$(id -u)" -ne 0 ]; then
  bash "$GATE" poll >/dev/null
  bash "$GATE" poll | jq -e '.data.trigger == "develop_build_settled"' >/dev/null
fi
chmod 644 "$LEDGER_DIR/2026-08-25.jsonl"

# --- 38h. Unset SMOKE_GATE_DECISION_LEDGER is fully inert ------------------
# A deployment that never wires this keeps today's behavior byte for byte.
fresh_state
HOLD_FILE="$STATE_DIR2/develop-hold.json"
export SMOKE_GATE_HOLD_FILE="$HOLD_FILE"
unset SMOKE_GATE_DECISION_LEDGER 2>/dev/null || true
hold_up "held-run-5" "$HOLD_SHA"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_build_settled"' >/dev/null

# --- 39. An out-of-band freeze's verdict advances completedSha -------------
# A human-requested campaign cuts its freeze PR by calling smoke-freeze-pr.sh
# directly — supported, and it deliberately bypasses the cadence floor. It also
# bypasses the handoff bookkeeping, so its ledger line could never be adopted:
# `completedSha` never advanced and the SHA just tested stayed eligible to be
# frozen and tested AGAIN. Live: #1195 re-froze `8dfca446` after #1188 had
# already produced a verdict for it.
fresh_state
OOB_SHA="$(printf '9%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$OOB_SHA"
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
jq -cn --arg target "$OOB_SHA" --arg freeze "deadbeef" --argjson pr 1195 \
  --arg run "xzo-pr-pr1195-oob" --arg verdict "HUMAN_DECISION" --arg now "2026-08-25T10:45:07Z" \
  '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,freezePr:$pr,runId:$run,verdict:$verdict,finishedAt:$now}' \
  > "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "already_completed"' >/dev/null
jq -e --arg sha "$OOB_SHA" --arg run "xzo-pr-pr1195-oob" '
  .completedSha == $sha and .completedRunId == $run and .completedVerdict == "HUMAN_DECISION"
' "$STATE_DIR2/develop-state.json" >/dev/null

# --- 39b. ...but never while this gate has its OWN handoff open ------------
# Adoption into an open handoff is bound to the matching freeze PR on purpose
# (the tamper shield). This fallback must not become a way around it.
fresh_state
OOB2_SHA="$(printf '8%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$OOB2_SHA"
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
export STUB_FREEZE_JSON="{\"prNumber\":77,\"branch\":\"smoke/freeze-x\",\"freezeSha\":\"abc\",\"targetSha\":\"$OOB2_SHA\"}"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null
# A line naming a DIFFERENT freeze PR for our open handoff's target is
# tamper-shaped and must not be adopted by either path.
jq -cn --arg target "$OOB2_SHA" --arg freeze "zzz" --argjson pr 99 \
  --arg run "rival-run" --arg verdict "GO" --arg now "2026-08-25T11:00:00Z" \
  '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,freezePr:$pr,runId:$run,verdict:$verdict,finishedAt:$now}' \
  > "$STATE_DIR2/handoff-ledger.jsonl"
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_ledger_tampered"' >/dev/null
jq -e '.completedRunId != "rival-run"' "$STATE_DIR2/develop-state.json" >/dev/null

# --- 39c. A deliberate re-smoke of the SAME SHA is adopted (#1108) -------
# Live: develop@6a0b65df froze as XZO #2121 (void, BLOCKED, adopted), then was
# re-smoked as #2126 (HUMAN_DECISION, hold raised). Adoption keyed on SHA only,
# so state kept the void BLOCKED -- which implies no hold, so the reconciler
# watched nothing and the live hold could be deleted unnoticed. A newer line
# for the same SHA (different run, later finishedAt) is adopted; an older,
# same-run or unparsable one is not; and the hold is never touched.
fresh_state
RS_SHA="$(printf '7%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$RS_SHA"
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
HOLD_FILE="$STATE_DIR2/develop-hold.json"
export SMOKE_GATE_HOLD_FILE="$HOLD_FILE"
LEDGER="$STATE_DIR2/handoff-ledger.jsonl"
ledger_line() {  # <run> <verdict> <finishedAt> <freezePr>
  jq -cn --arg target "$RS_SHA" --arg run "$1" --arg verdict "$2" --arg at "$3" --argjson pr "$4" \
    '{schemaVersion:1,targetSha:$target,freezeSha:"f00d",freezePr:$pr,runId:$run,verdict:$verdict,finishedAt:$at}' >>"$LEDGER"
}
rs_fail() { echo "39c: $1" >&2; exit 1; }
completed() { jq -c '[.completedRunId, .completedVerdict, .completedAt]' "$STATE_DIR2/develop-state.json"; }
ledger_line run-void BLOCKED 2026-09-23T11:31:24Z 2121
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.data.trigger == "already_completed"' >/dev/null
[ "$(completed)" = '["run-void","BLOCKED","2026-09-23T11:31:24Z"]' ] || rs_fail "first line not adopted: $(completed)"
# The re-smoke raises its hold, then its line lands: adopted, hold byte-identical,
# and the reconciler now expects that hold and finds it (no tamper wake).
hold_up run-resmoke "$RS_SHA"
HOLD_SUM="$(sha256sum "$HOLD_FILE")"
ledger_line run-resmoke HUMAN_DECISION 2026-09-23T16:50:56Z 2126
bash "$GATE" poll | jq -e '.data.trigger == "already_completed"' >/dev/null \
  || rs_fail "re-smoke adoption must not alarm"
[ "$(completed)" = '["run-resmoke","HUMAN_DECISION","2026-09-23T16:50:56Z"]' ] \
  || rs_fail "same-SHA re-smoke not adopted: $(completed)"
[ "$(sha256sum "$HOLD_FILE")" = "$HOLD_SUM" ] || rs_fail "adoption touched the hold"
# Tamper detection is live again: deleting the re-smoke's hold now alarms.
mv "$HOLD_FILE" "$HOLD_FILE.aside"
bash "$GATE" poll | jq -e '.data.trigger == "gate_hold_tampered" and .data.holdIntegrity == "missing" and
  .data.ledgerRunId == "run-resmoke"' >/dev/null || rs_fail "deleted re-smoke hold not detected"
mv "$HOLD_FILE.aside" "$HOLD_FILE"
bash "$GATE" poll >/dev/null
# Not adopted: an OLDER line, the SAME run again, or an unparsable timestamp.
for spec in 'run-older GO 2026-09-23T12:00:00Z' 'run-resmoke GO 2026-09-24T09:00:00Z' 'run-garbled GO yesterday'; do
  read -r rs_run rs_verdict rs_at <<<"$spec"
  ledger_line "$rs_run" "$rs_verdict" "$rs_at" 1
  bash "$GATE" poll >/dev/null
  [ "$(completed)" = '["run-resmoke","HUMAN_DECISION","2026-09-23T16:50:56Z"]' ] \
    || rs_fail "adopted a line it must not ($spec): $(completed)"
done
# A forged NEWER GO line is adopted -- and only makes the reconciler louder:
# GO with the hold still present is `unexpected`, and the hold is untouched.
ledger_line run-forged GO 2026-09-24T10:00:00Z 3
bash "$GATE" poll | jq -e '.data.trigger == "gate_hold_tampered" and .data.holdIntegrity == "unexpected"' >/dev/null \
  || rs_fail "forged newer GO with a hold present must alarm unexpected"
[ "$(sha256sum "$HOLD_FILE")" = "$HOLD_SUM" ] || rs_fail "a forged line touched the hold"
unset SMOKE_GATE_HOLD_FILE

# --- 39d. A freeze whose target develop has moved past is adopted (#1134) --
# XZO #2176 froze fe92bc76; develop reached ef798620 mid-run. Keyed on the
# current head, its NO_GO line was never adopted: state kept #2161 while the
# hold named #2176, and the reconciler woke gate_hold_tampered "mismatched".
# The newest later line is adopted whatever its target; completedAt never
# moves backwards; the hold is never touched.
fresh_state
OLD_T="$(printf 'a%.0s' $(seq 40))"; FROZEN_T="$(printf 'b%.0s' $(seq 40))"; HEAD_T="$(printf 'c%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$HEAD_T"
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
HOLD_FILE="$STATE_DIR2/develop-hold.json"
export SMOKE_GATE_HOLD_FILE="$HOLD_FILE"
LEDGER="$STATE_DIR2/handoff-ledger.jsonl"
mv_fail() { echo "39d: $1" >&2; exit 1; }
mv_line() {  # <target> <run> <verdict> <finishedAt>
  jq -cn --arg t "$1" --arg run "$2" --arg v "$3" --arg at "$4" \
    '{schemaVersion:1,targetSha:$t,freezeSha:"f00d",freezePr:1,runId:$run,verdict:$v,finishedAt:$at}' >>"$LEDGER"
}
mv_state() { jq -c '[.completedSha[0:1], .completedRunId, .completedVerdict, .completedAt]' "$STATE_DIR2/develop-state.json"; }
# #2161's round, adopted as the state's record (its hold stands).
mv_line "$OLD_T" run-2161 NO_GO 2026-09-24T11:31:03Z
jq -cn --arg sha "$OLD_T" '{schemaVersion:1,sha:$sha,runId:"run-2161",verdict:"NO_GO",raisedAt:"2026-09-24T11:31:03Z",reason:"no_go"}' >"$HOLD_FILE"
bash "$GATE" poll >/dev/null; bash "$GATE" poll >/dev/null
[ "$(mv_state)" = '["a","run-2161","NO_GO","2026-09-24T11:31:03Z"]' ] || mv_fail "first line not adopted: $(mv_state)"
# #2176 freezes an older head, finishes NO_GO and replaces the hold; develop has moved on.
jq -cn --arg sha "$FROZEN_T" '{schemaVersion:1,sha:$sha,runId:"run-2176",verdict:"NO_GO",raisedAt:"2026-09-24T17:52:05Z",reason:"no_go"}' >"$HOLD_FILE"
HOLD_SUM="$(sha256sum "$HOLD_FILE")"
mv_line "$FROZEN_T" run-2176 NO_GO 2026-09-24T17:52:05Z
OUT="$(bash "$GATE" poll)"
jq -e '.data.trigger != "gate_hold_tampered"' <<<"$OUT" >/dev/null || mv_fail "a moved-past freeze read as tamper: $OUT"
[ "$(mv_state)" = '["b","run-2176","NO_GO","2026-09-24T17:52:05Z"]' ] || mv_fail "moved-past freeze not adopted: $(mv_state)"
[ "$(sha256sum "$HOLD_FILE")" = "$HOLD_SUM" ] || mv_fail "adoption touched the hold"
# Never backwards: an OLDER line for another target, appended later, is not adopted.
mv_line "$OLD_T" run-late-append GO 2026-09-24T12:00:00Z
bash "$GATE" poll >/dev/null
[ "$(mv_state)" = '["b","run-2176","NO_GO","2026-09-24T17:52:05Z"]' ] || mv_fail "adopted an older line: $(mv_state)"
unset SMOKE_GATE_HOLD_FILE

# --- 40. `ack`: terminal disposition for an alarm wake ---------------------
# Argument validation first. A typo'd trigger filed under a key nothing reads
# would be an ack-shaped no-op, which is the exact failure class this verb
# exists to close.
fresh_state
if bash "$GATE" ack preflight_failed | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "expected ack with no disposition to be rejected" >&2; exit 1
fi
# Rejections exit 2, so capture before asserting (pipefail would eat the test).
ACK_OUT="$(bash "$GATE" ack preflght_failed "some reason" acked || true)"
jq -e '
  .ok == false and (.error | test("unknown trigger")) and
  (.triggers | index("preflight_failed") != null)
' <<<"$ACK_OUT" >/dev/null
ACK_OUT="$(bash "$GATE" ack preflight_failed "some reason" handled || true)"
jq -e '.ok == false and (.error | test("resolved, acked, or escalated"))' <<<"$ACK_OUT" >/dev/null
# The window is asserted in seconds, not by comment: preflight is deliberately
# shorter than the general TTL, and inverting or deleting that branch has to
# fail here.
bash "$GATE" ack preflight_failed "some reason" acked | jq -e '
  .ok == true and .disposition == "acked" and .silenceable == true and
  ((.silencedUntil | fromdateiso8601) - (.at | fromdateiso8601)) == 43200
' >/dev/null
bash "$GATE" ack develop_freeze_failed "some fingerprint" acked | jq -e '
  ((.silencedUntil | fromdateiso8601) - (.at | fromdateiso8601)) == 86400
' >/dev/null
jq -e '
  .dispositions.preflight_failed.fingerprint == "some reason" and
  .dispositions.preflight_failed.disposition == "acked"
' "$SMOKE_GATE_STATE_DIR/develop-state.json" >/dev/null

# --- 41. An ack silences THAT condition and nothing else -------------------
# ALERT_SECONDS=0 removes the time throttle, so every poll below would alarm
# on its own. Anything that stays silent is silent because of the ack.
fresh_state
PF_STATE="$SMOKE_GATE_STATE_DIR/develop-state.json"
export SMOKE_GATE_PREFLIGHT_ALERT_SECONDS=0
pf_sha f
pf_poll 'echo "3 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == true and .data.trigger == "preflight_failed"
' >/dev/null
# ...and again, un-acked, to prove the throttle is genuinely disarmed.
pf_poll 'echo "3 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == true
' >/dev/null
bash "$GATE" ack preflight_failed "3 of 8 QA seats could not be verified" acked "seat seeding is a human step" >/dev/null
pf_poll 'echo "3 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == false and .data.trigger == "preflight_failed"
' >/dev/null
# A worsened condition is a different fingerprint and still alarms.
pf_poll 'echo "8 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == true and .data.reason == "8 of 8 QA seats could not be verified"
' >/dev/null
# ...and that wake dropped the stale disposition, so it owes a fresh one.
jq -e '.dispositions.preflight_failed == null' "$PF_STATE" >/dev/null

# --- 42. An ack expires. No incident goes dark forever. --------------------
bash "$GATE" ack preflight_failed "8 of 8 QA seats could not be verified" acked >/dev/null
pf_poll 'echo "8 of 8 QA seats could not be verified"; exit 1' | jq -e '.wakeAgent == false' >/dev/null
# Age the ack to ~13h: past preflight's 12h window but INSIDE the general 24h
# one, so this only passes if the shorter per-trigger TTL is really in force.
# The condition and fingerprint are unchanged, so nothing else can wake it.
jq --arg t "$(date -u -d '@'$(( $(date -u +%s) - 46800 )) +'%Y-%m-%dT%H:%M:%SZ')" \
  '.dispositions.preflight_failed.at=$t' "$PF_STATE" > "$PF_STATE.tmp" && mv "$PF_STATE.tmp" "$PF_STATE"
pf_poll 'echo "8 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == true and .data.trigger == "preflight_failed"
' >/dev/null

# --- 43. `resolved` asserts the condition is gone, so it never silences ----
# If the gate can still see the condition, the claim was wrong and the alarm
# has to fire. This is what keeps the three dispositions distinguishable.
bash "$GATE" ack preflight_failed "8 of 8 QA seats could not be verified" resolved | jq -e '
  .ok == true and .disposition == "resolved" and .silencedUntil == null
' >/dev/null
pf_poll 'echo "8 of 8 QA seats could not be verified"; exit 1' | jq -e '.wakeAgent == true' >/dev/null

# --- 44. `escalated` silences like an ack but stays distinguishable, and a
#         condition that CLEARS drops the disposition with it.
bash "$GATE" ack preflight_failed "8 of 8 QA seats could not be verified" escalated "paged the owner" >/dev/null
jq -e '.dispositions.preflight_failed.disposition == "escalated"' "$PF_STATE" >/dev/null
pf_poll 'echo "8 of 8 QA seats could not be verified"; exit 1' | jq -e '.wakeAgent == false' >/dev/null
pf_poll 'echo "All 8 QA seats authenticated."; exit 0' | jq -e '
  .wakeAgent == true and .data.trigger == "develop_build_settled"
' >/dev/null
# Cleared condition, cleared disposition: a recurrence is a new incident.
jq -e '.dispositions.preflight_failed == null' "$PF_STATE" >/dev/null
unset SMOKE_GATE_PREFLIGHT_ALERT_SECONDS

# --- 45. Alarms that exist to chase a human are deliberately un-silenceable.
# `ack` records the disposition but must never claim a mute it will not honor.
# ACK_SILENCEABLE is the PROMISE; the ack_silences call sites in the poll path
# are the DELIVERY. If they ever disagree the verb starts lying, so assert the
# two sets are identical instead of carrying a runtime guard no call site can
# reach.
# Line continuations are joined and then newlines squashed, so a call
# reformatted across lines is still seen — that exact dodge was demonstrated
# against the earlier line-anchored version. Joining `\`-continuations first
# matters: squashing newlines alone leaves a bare `\` sitting where the trigger
# argument should be, which the literal-shape check below would then reject on
# a perfectly good call site.
# `tr -s` squeezes the runs of whitespace joining leaves behind, so the two
# patterns below can stay single-space and readable.
ACK_SRC="$(sed -e ':a' -e 'N;$!ba' -e 's/\\\n[[:space:]]*/ /g' "$GATE" | tr '\n' ' ' | tr -s ' ')"
ACK_DECLARED="$(grep -oP '^ACK_SILENCEABLE="\K[^"]+' "$GATE" | tr ' ' '\n' | grep -v '^$' | sort -u)"
ACK_WIRED="$(grep -oP 'if ack_silences \K[a-z_]+' <<<"$ACK_SRC" | sort -u)"
if [ "$ACK_DECLARED" != "$ACK_WIRED" ]; then
  echo "ACK_SILENCEABLE declares [$ACK_DECLARED] but poll honors [$ACK_WIRED]" >&2; exit 1
fi
# The other dodge: a call site taking a variable instead of a bare literal
# would not be matched above and could diverge silently. Fail on the shape.
if grep -oP 'ack_silences \K\S+' <<<"$ACK_SRC" | grep -qv '^[a-z_]\+$'; then
  echo "an ack_silences call site does not take a bare literal trigger name" >&2; exit 1
fi
# Source matching still cannot see a call routed through a wrapper function.
# The real guarantee is the behavioral cases: ack a non-silenceable trigger and
# prove its alarm still fires. Two of the four are covered that way
# (gate_misconfigured just below, develop_hold_undecided further down);
# gate_fetch_failed and develop_run_overrun are not, and are not claimed to be.
fresh_state
unset SMOKE_GATE_REPO 2>/dev/null || true
bash "$GATE" poll | jq -e '.wakeAgent == true and .data.trigger == "gate_misconfigured"' >/dev/null
bash "$GATE" ack gate_misconfigured "SMOKE_GATE_REPO" acked "known, waiting on a redeploy" >/dev/null
fresh_state   # fresh throttle window, same missing config, same ack in play
bash "$GATE" ack gate_misconfigured "SMOKE_GATE_REPO" acked >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == true and .data.trigger == "gate_misconfigured"' >/dev/null
export SMOKE_GATE_REPO=org/repo
bash "$GATE" ack develop_hold_undecided "run-1" acked | jq -e '
  .ok == true and .silenceable == false and .silencedUntil == null
' >/dev/null
bash "$GATE" ack gate_misconfigured "SMOKE_GATE_REPO" escalated | jq -e '
  .ok == true and .silenceable == false and .silencedUntil == null
' >/dev/null
# ...and the report is honest: an ack on one of them does NOT mute its alarm.
# A pending human decision is chased until a human answers it, ack or no ack.
fresh_state
unset SMOKE_GATE_DECISION_LEDGER SMOKE_GATE_HOLD_ALERT_SECONDS 2>/dev/null || true
export SMOKE_GATE_HOLD_ALERT_SECONDS=0
ACK_HOLD_SHA="$(printf 'c%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$ACK_HOLD_SHA"
export SMOKE_GATE_HOLD_FILE="$SMOKE_GATE_STATE_DIR/develop-hold.json"
export SMOKE_GATE_DECISION_LEDGER="$SMOKE_GATE_STATE_DIR/gates"
mkdir -p "$SMOKE_GATE_DECISION_LEDGER"
jq -cn --arg sha "$ACK_HOLD_SHA" \
  '{schemaVersion:1,sha:$sha,runId:"ack-held-run",verdict:"HUMAN_DECISION",
    raisedAt:"2026-08-25T18:23:39Z",reason:"needs_human_decision"}' \
  > "$SMOKE_GATE_HOLD_FILE"
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == true and .data.trigger == "develop_hold_undecided"' >/dev/null
bash "$GATE" ack develop_hold_undecided "ack-held-run" acked "waiting on the release desk" >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == true and .data.trigger == "develop_hold_undecided"' >/dev/null
unset SMOKE_GATE_HOLD_ALERT_SECONDS SMOKE_GATE_HOLD_FILE SMOKE_GATE_DECISION_LEDGER

# --- 46. The freeze-failure alarm — the 2026-08-25/26 case that motivated the
#         verb: three identical wakes, 6h apart, nothing dispositioned.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
export SMOKE_GATE_PREFLIGHT_ALERT_SECONDS=0
ACK_SHA="$(printf 'd%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$ACK_SHA"
export STUB_FREEZE_JSON='{"ok":false,"error":"branch already exists","branch":"smoke/freeze-dddddddddddd"}'
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "develop_freeze_failed"
' >/dev/null
# The gate hands the agent the fingerprint; the agent never builds one.
ACK_FP="$(bash "$GATE" poll | jq -r '.data.fingerprint')"
bash "$GATE" ack develop_freeze_failed "$ACK_FP" acked "orphan branch left in place on purpose" \
  | jq -e '.ok == true and .silenceable == true' >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.trigger == "develop_freeze_failed"
' >/dev/null
# A DIFFERENT helper failure is a different incident and alarms through the ack.
export STUB_FREEZE_JSON='{"ok":false,"error":"gh pr create failed"}'
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.reason == "gh pr create failed"
' >/dev/null
# ...and that wake cleared the stale disposition, so it owes a fresh one too.
jq -e '.dispositions.develop_freeze_failed == null' "$SMOKE_GATE_STATE_DIR/develop-state.json" >/dev/null
# The freeze finally succeeding clears the incident, disposition included.
ACK_FP2="$(bash "$GATE" poll | jq -r '.data.fingerprint')"
bash "$GATE" ack develop_freeze_failed "$ACK_FP2" acked >/dev/null
export STUB_FREEZE_JSON="{\"prNumber\":77,\"branch\":\"smoke/freeze-d\",\"freezeSha\":\"abc\",\"targetSha\":\"$ACK_SHA\"}"
bash "$GATE" poll | jq -e '.data.trigger == "develop_freeze_opened"' >/dev/null
jq -e '.dispositions.develop_freeze_failed == null' "$SMOKE_GATE_STATE_DIR/develop-state.json" >/dev/null
unset SMOKE_GATE_PREFLIGHT_ALERT_SECONDS

# --- 47. REGRESSION (Codex High 1): the freeze reason is a STATIC constant ---
# `smoke-freeze-pr.sh:69` emits byte-identical text for every branch collision
# and puts the branch in a separate field. Fingerprinting on the reason alone
# meant acking one collision silenced every future collision on any SHA for a
# day. The fingerprint must fold in what actually varies.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
export SMOKE_GATE_PREFLIGHT_ALERT_SECONDS=0
COLLIDE='branch already exists — delete it first or pick a different target'
SHA_A="$(printf 'a%.0s' $(seq 40))"
SHA_B="$(printf 'b%.0s' $(seq 40))"

export STUB_SOURCE_SHA="$SHA_A"
export STUB_FREEZE_JSON="{\"ok\":false,\"error\":\"$COLLIDE\",\"branch\":\"smoke/freeze-aaaaaaaaaaaa\"}"
bash "$GATE" poll >/dev/null
FP_A="$(bash "$GATE" poll | jq -r '.data.fingerprint')"
bash "$GATE" ack develop_freeze_failed "$FP_A" acked "left in place on purpose" >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false' >/dev/null   # A stays silenced

# Develop advances. A genuinely new collision, same constant reason text —
# and now with the DEPLOYED 6h throttle armed, not disabled. Disabling it is
# what hid the second half of this bug: the ack fingerprint was widened but the
# re-arm latch still compared the reason, so B was silently throttled.
# Ageing past the re-arm FLOOR only (900s, not the 6h ceiling) leaves the
# changed-fingerprint clause as the only thing that can produce a wake.
unset SMOKE_GATE_PREFLIGHT_ALERT_SECONDS
export STUB_SOURCE_SHA="$SHA_B"
export STUB_FREEZE_JSON="{\"ok\":false,\"error\":\"$COLLIDE\",\"branch\":\"smoke/freeze-bbbbbbbbbbbb\"}"
FZ_STATE="$SMOKE_GATE_STATE_DIR/develop-state.json"
jq --arg t "$(date -u -d '@'$(( $(date -u +%s) - 1000 )) +'%Y-%m-%dT%H:%M:%SZ')" \
  '.freezeFailWakeAt=$t' "$FZ_STATE" > "$FZ_STATE.tmp" && mv "$FZ_STATE.tmp" "$FZ_STATE"
bash "$GATE" poll >/dev/null
# ONE wake, asserted once: a second poll would be legitimately throttled by the
# latch this wake just reset, and would hide the result.
WAKE_B="$(bash "$GATE" poll)"
FP_B="$(jq -r '.data.fingerprint' <<<"$WAKE_B")"
if [ "$FP_A" = "$FP_B" ]; then
  echo "two different freeze incidents produced the same fingerprint: $FP_A" >&2; exit 1
fi
# Both carry the SAME reason — proving it is the fingerprint, not the reason,
# doing the discriminating, on both the ack path and the throttle path.
jq -e --arg r "$COLLIDE" '
  .wakeAgent == true and .data.reason == $r and .data.trigger == "develop_freeze_failed"
' <<<"$WAKE_B" >/dev/null
jq -e --arg f "$FP_B" '.freezeFailFingerprint == $f' "$FZ_STATE" >/dev/null

# --- 48. Every silenceable trigger emits a `fingerprint` the agent can echo --
# Structural: a third silenceable trigger added without one would leave the
# agent guessing again, which is how High 1 happened.
# INVARIANT 2, checked over EVERY producer in the skill — not just this gate.
# smoke-pr-gate.sh emits `preflight_failed` too, and the develop gate owns the
# only `ack` verb, so a PR-gate alarm without a discriminating fingerprint
# resolves into the develop gate's silenceable namespace.
for t in $(grep -oP '^ACK_SILENCEABLE="\K[^"]+' "$GATE"); do
  for producer in "$SCRIPT_DIR"/smoke-*-gate.sh; do
    grep -q "trigger:\"$t\"" "$producer" || continue
    # `exit 1` inside a rule jumps to END, so the status must be set THERE —
    # an `END { exit 0 }` silently overwrites it and the check never fails.
    awk -v t="trigger:\"$t\"" '
      index($0, t) && !/wakeAgent:false/ { found=1; ok=0 }
      found && /fingerprint:/ { ok=1 }
      found && /}}/ { if (!ok) bad=1; found=0 }
      END { exit bad }
    ' "$producer" || {
      echo "$(basename "$producer") emits silenceable $t with no fingerprint" >&2; exit 1; }
  done
done
# ...and the RE-ARM latch keys on that fingerprint too. Widening only the ack
# left distinct incidents cross-silencing through the throttle instead.
for latch in preflightFingerprint freezeFailFingerprint; do
  grep -q "\.$latch=\\\$f" "$GATE" || { echo "latch $latch is never persisted" >&2; exit 1; }
  grep -q "\.$latch // empty" "$GATE" || { echo "latch $latch is never compared" >&2; exit 1; }
done
grep -q '\.preflightFingerprint=\$f' "$SCRIPT_DIR/smoke-pr-gate.sh" \
  || { echo "pr gate never persists a preflight fingerprint" >&2; exit 1; }
# The PR gate's fingerprint must be GATE-SCOPED, not merely present. Both gates
# run the same preflight family with byte-identical constants, and the develop
# gate owns the only `ack` verb — so an unprefixed PR-gate fingerprint would
# resolve against the develop gate's own silenceable key. The two scripts have
# separate state files, so this is the structural check; there is no single
# process in which both can be exercised together.
grep -q 'PREFLIGHT_FINGERPRINT="pr|' "$SCRIPT_DIR/smoke-pr-gate.sh" \
  || { echo "pr gate preflight fingerprint is not gate-scoped" >&2; exit 1; }
# ...and the payload's `fp` must be BOUND to the fingerprint variable, not
# merely present. The awk check above passes on `--arg fp "$PREFLIGHT_REASON"`
# because the emitted key is still `fingerprint:$fp`. For this trigger the
# fingerprint and the reason are equal by assignment today (preflight is
# deliberately NOT SHA-scoped — a per-SHA one-shot would re-alarm on every
# merge), so no behavioural test can separate the two bindings: mutating one
# into the other produces byte-identical output. The binding is the only
# checkable form of INVARIANT 2 here, and it is the part that matters — it is
# what makes the payload follow the fingerprint if it ever gains a
# discriminator, which is the whole reason the variable exists.
for producer in "$GATE" "$SCRIPT_DIR/smoke-pr-gate.sh"; do
  grep -q -- '--arg fp "\$PREFLIGHT_FINGERPRINT"' "$producer" \
    || { echo "$(basename "$producer") does not bind fp to PREFLIGHT_FINGERPRINT" >&2; exit 1; }
done

# --- 48b. The prune window is the LONGEST of the two TTLs ------------------
# They are independently overridable. Taking the general one alone would delete
# a preflight ack still inside its own window and void a silence the operator
# was promised via `silencedUntil`.
fresh_state
TTL_STATE="$SMOKE_GATE_STATE_DIR/develop-state.json"
export STUB_SOURCE_SHA="$(printf '2%.0s' $(seq 40))"
SMOKE_GATE_ACK_MAX_SILENCE_SECONDS=3600 \
SMOKE_GATE_ACK_MAX_SILENCE_PREFLIGHT_SECONDS=86400 \
  bash "$GATE" ack preflight_failed "seats down" acked >/dev/null
jq --arg t "$(date -u -d '@'$(( $(date -u +%s) - 7200 )) +'%Y-%m-%dT%H:%M:%SZ')" \
  '.dispositions.preflight_failed.at=$t' "$TTL_STATE" > "$TTL_STATE.tmp" && mv "$TTL_STATE.tmp" "$TTL_STATE"
SMOKE_GATE_ACK_MAX_SILENCE_SECONDS=3600 \
SMOKE_GATE_ACK_MAX_SILENCE_PREFLIGHT_SECONDS=86400 \
  bash "$GATE" poll >/dev/null
jq -e '.dispositions.preflight_failed != null' "$TTL_STATE" >/dev/null \
  || { echo "prune deleted an ack still inside its own TTL" >&2; exit 1; }

# --- 49. INVARIANT 1: every dispositions transform is total ----------------
# Both corruption shapes that have bitten, in one case. `.dispositions` itself
# malformed used to abort ack's jq, empty $STATE, truncate the file and still
# report ok:true; a malformed ENTRY used to abort read_state's prune, which no
# write guard can see because no write happens. Either way the next mandatory
# `progress` stamp told a HEALTHY campaign "not the active run — stop this
# campaign". Normalising on read makes both total, so the gate RECOVERS rather
# than refusing — refusing left every alarm wedged and silent.
for corrupt_shape in \
  '{"activeSha":"deadbeef","activeRunId":"important-run","dispositions":"corrupt-but-valid-json"}' \
  '{"activeSha":"deadbeef","activeRunId":"important-run","dispositions":{"preflight_failed":"junk"}}' \
  '{"activeSha":"deadbeef","activeRunId":"important-run","dispositions":[]}' \
  '{"activeSha":"deadbeef","activeRunId":"important-run","dispositions":{"preflight_failed":{"at":"not-a-date"}}}'
do
  fresh_state
  CORRUPT="$SMOKE_GATE_STATE_DIR/develop-state.json"
  printf '%s\n' "$corrupt_shape" > "$CORRUPT"
  # The live campaign is never told to stop — the harm that matters.
  bash "$GATE" progress important-run \
    | jq -e '.ok == true and .runId == "important-run"' >/dev/null \
    || { echo "progress refused a live run on: $corrupt_shape" >&2; exit 1; }
  # ack works, and leaves state a valid object with the campaign intact.
  bash "$GATE" ack preflight_failed "some reason" acked >/dev/null \
    || { echo "ack failed on: $corrupt_shape" >&2; exit 1; }
  jq -e '
    (.dispositions | type) == "object" and
    .activeRunId == "important-run" and .activeSha == "deadbeef" and
    .dispositions.preflight_failed.fingerprint == "some reason"
  ' "$CORRUPT" >/dev/null || { echo "state not recovered on: $corrupt_shape" >&2; exit 1; }
done

# ...and an alarm-bearing poll still WAKES on a corrupt state file. Refusing to
# write used to exit before the alarm was emitted, wedging every alarm silently.
fresh_state
export SMOKE_GATE_PREFLIGHT_ALERT_SECONDS=0
PF_STATE="$SMOKE_GATE_STATE_DIR/develop-state.json"
pf_sha 5
jq '.dispositions="corrupt-but-valid-json"' "$PF_STATE" > "$PF_STATE.tmp" && mv "$PF_STATE.tmp" "$PF_STATE"
pf_poll 'echo "3 of 8 QA seats could not be verified"; exit 1' | jq -e '
  .wakeAgent == true and .data.trigger == "preflight_failed"
' >/dev/null
unset SMOKE_GATE_PREFLIGHT_ALERT_SECONDS

# --- 50. Dispositions expire out of state, for every trigger ----------------
# Bounds the audit trail: a record cannot outlive its window and keep answering
# "handled?" with a stale yes while a fresh alarm for that trigger fires.
fresh_state
export STUB_SOURCE_SHA="$(printf '7%.0s' $(seq 40))"
PRUNE_STATE="$SMOKE_GATE_STATE_DIR/develop-state.json"
bash "$GATE" poll >/dev/null
bash "$GATE" ack gate_hold_tampered "run-old" escalated "paged the release desk" >/dev/null
jq -e '.dispositions.gate_hold_tampered != null' "$PRUNE_STATE" >/dev/null
jq --arg t "$(date -u -d '@'$(( $(date -u +%s) - 3 * 86400 )) +'%Y-%m-%dT%H:%M:%SZ')" \
  '.dispositions.gate_hold_tampered.at=$t' "$PRUNE_STATE" > "$PRUNE_STATE.tmp" && mv "$PRUNE_STATE.tmp" "$PRUNE_STATE"
bash "$GATE" poll >/dev/null
jq -e '.dispositions.gate_hold_tampered == null' "$PRUNE_STATE" >/dev/null

# --- 51. A future-dated `at` must not silence forever ----------------------
fresh_state
export SMOKE_GATE_PREFLIGHT_ALERT_SECONDS=0
PF_STATE="$SMOKE_GATE_STATE_DIR/develop-state.json"
pf_sha 3
pf_poll 'echo "3 of 8 QA seats could not be verified"; exit 1' >/dev/null
bash "$GATE" ack preflight_failed "3 of 8 QA seats could not be verified" acked >/dev/null
pf_poll 'echo "3 of 8 QA seats could not be verified"; exit 1' | jq -e '.wakeAgent == false' >/dev/null
jq --arg t "$(date -u -d '@'$(( $(date -u +%s) + 3600 )) +'%Y-%m-%dT%H:%M:%SZ')" \
  '.dispositions.preflight_failed.at=$t' "$PF_STATE" > "$PF_STATE.tmp" && mv "$PF_STATE.tmp" "$PF_STATE"
pf_poll 'echo "3 of 8 QA seats could not be verified"; exit 1' | jq -e '.wakeAgent == true' >/dev/null
unset SMOKE_GATE_PREFLIGHT_ALERT_SECONDS

# --- 52. MUST-FIX: `finish` must validate the SHA, not just the run id ------
# The PR gate grew this guard after the live #1211 incident; this gate carries
# identical verdict authority and had the identical hole. Any well-formed SHA
# was accepted, publishing a verdict for a build nobody examined and advancing
# completedSha to an untested commit so it is never campaigned.
fresh_state
FIN_STATE="$SMOKE_GATE_STATE_DIR/develop-state.json"
REAL_SHA="$(printf 'a%.0s' $(seq 40))"
WRONG_SHA="$(printf 'b%.0s' $(seq 40))"
bash "$GATE" claim run-fin "$REAL_SHA" >/dev/null
FIN_OUT="$(bash "$GATE" finish "$WRONG_SHA" run-fin GO || true)"
jq -e '.ok == false and (.error | test("does not match the sha this run claimed"))' <<<"$FIN_OUT" >/dev/null
bash "$GATE" finish "$WRONG_SHA" run-fin GO >/dev/null 2>&1 && { echo "finish accepted a foreign sha" >&2; exit 1; }
# Nothing recorded, and the slot is still held so a correct re-finish works.
jq -e '.completedSha == null and .activeRunId == "run-fin"' "$FIN_STATE" >/dev/null
bash "$GATE" finish "$REAL_SHA" run-fin GO | jq -e '.ok == true' >/dev/null
jq -e --arg s "$REAL_SHA" '.completedSha == $s' "$FIN_STATE" >/dev/null

# --- 53. INVARIANT 1 covers CONFIG too, not just file shapes ---------------
# `--argjson ttl abc` aborted the normaliser itself, emptied $STATE, and the
# next `progress` told a HEALTHY campaign to stop — the flagship harm, through
# the fix for it. Verified live before this case existed.
fresh_state
CFG_STATE="$SMOKE_GATE_STATE_DIR/develop-state.json"
printf '%s\n' '{"activeSha":"deadbeef","activeRunId":"live-run","dispositions":{}}' > "$CFG_STATE"
for bad in abc "" 12x -5; do
  SMOKE_GATE_ACK_MAX_SILENCE_SECONDS="$bad" bash "$GATE" progress live-run \
    | jq -e '.ok == true and .runId == "live-run"' >/dev/null \
    || { echo "garbage TTL '$bad' broke a live run" >&2; exit 1; }
done
# ...and a non-numeric knob is NAMED in the misconfigured alarm rather than
# silently degrading a threshold comparison to false (which never alarms).
fresh_state
unset SMOKE_GATE_REPO 2>/dev/null || true
SMOKE_GATE_ACK_MAX_SILENCE_SECONDS=abc bash "$GATE" poll | jq -e '
  .data.trigger == "gate_misconfigured" and
  (.data.missing | index("SMOKE_GATE_ACK_MAX_SILENCE_SECONDS") != null)
' >/dev/null
# ...and "all digits" is NOT the acceptance rule. Each of these was ADMITTED by
# the digits-only check and is a distinct silent failure — see num_env's own
# comment. A knob that reaches `$(( ))` or `[ -ge ]` in one of these shapes
# either kills the expression or means a different number than it reads as.
for bad in 0900 0100 05900 99999999999999999999 ""; do
  SMOKE_GATE_MERGE_HOLD_SECONDS="$bad" bash "$GATE" poll | jq -e '
    .data.trigger == "gate_misconfigured" and
    (.data.missing | index("SMOKE_GATE_MERGE_HOLD_SECONDS") != null)
  ' >/dev/null || { echo "num_env admitted MERGE_HOLD_SECONDS='$bad'" >&2; exit 1; }
done
# ...while a legitimate value — including a bare 0, which several knobs use as
# "feature off" — is accepted silently. Rejecting these would be the opposite
# bug: an alarm that fires on a correct deployment is one nobody reads.
for ok in 0 1 5400 999999999999999999; do
  SMOKE_GATE_MERGE_HOLD_SECONDS="$ok" bash "$GATE" poll | jq -e '
    .data.missing | index("SMOKE_GATE_MERGE_HOLD_SECONDS") == null
  ' >/dev/null || { echo "num_env rejected the legitimate MERGE_HOLD_SECONDS='$ok'" >&2; exit 1; }
done
# An UNSET knob is silent — only a knob someone actually deployed can be
# misconfigured, and naming an unset one would name every default on the box.
bash "$GATE" poll | jq -e '.data.missing | index("SMOKE_GATE_MERGE_HOLD_SECONDS") == null' >/dev/null
export SMOKE_GATE_REPO=org/repo

# --- 54. A wrong-TYPED freeze helper payload must not wedge the gate -------
# `has("prNumber")` passed `"prNumber":"abc"` at rc 0; the success path's
# --argjson then aborted, emptying $STATE and exiting 3 AFTER the freeze PR was
# created — orphaned PR and branch, no alarm, config present so not
# gate_misconfigured. It must take the throttled freeze-failure path instead.
fresh_state
export SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$STUB_BIN/freeze-helper"
export STUB_SOURCE_SHA="$(printf '6%.0s' $(seq 40))"
export STUB_FREEZE_EXIT=0
export STUB_FREEZE_JSON='{"prNumber":"abc","freezeSha":"x","branch":"smoke/freeze-6"}'
bash "$GATE" poll >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "develop_freeze_failed"
' >/dev/null
jq -e 'type == "object" and .activeRunId == null' "$SMOKE_GATE_STATE_DIR/develop-state.json" >/dev/null
unset STUB_FREEZE_EXIT STUB_FREEZE_JSON

# --- 55. The PR gate's alarms are ackable, and record-only -----------------
# smoke-pr-gate.sh consults no dispositions, so none of its triggers may be
# silenceable — but they must be FILEABLE, or an agent following the contract
# either leaves the wake open or refiles under a develop trigger and clobbers
# that slot.
fresh_state
for t in pr_preflight_failed pr_migrations_refused pr_warmup_stuck pr_facts_unavailable pr_run_overrun pr_run_stalled; do
  bash "$GATE" ack "$t" "pr|some reason|44" acked | jq -e '
    .ok == true and .silenceable == false and .silencedUntil == null
  ' >/dev/null || { echo "$t is not record-only ackable" >&2; exit 1; }
done
# Every pr_* trigger this gate accepts must emit from the PR gate, and none of
# them may be silenceable here.
#
# The extraction MUST be multiline. `grep -oP '^ACK_TRIGGERS="\K[\s\S]*?(?=")'`
# is line-oriented — `[\s\S]*?` cannot span lines — and ACK_TRIGGERS is a
# multi-line declaration, so it matched NOTHING and the loop below ran ZERO
# times. A reviewer renamed the emitted `pr_warmup_stuck` to an unaccepted
# `warmup_stuck` and both suites still passed. `-z` treats the file as one
# NUL-terminated record, so `[^"]+` spans newlines.
ACK_TRIGGER_LIST="$(grep -zoP 'ACK_TRIGGERS="\K[^"]+' "$GATE" | tr -d '\0' | tr -s ' \n' ' ')"
# A parity loop that iterates zero times must fail loudly, not pass. Assert the
# extraction actually recovered the triggers the loop is supposed to walk —
# a partial or empty extraction is the failure mode this whole case exists for.
[ -n "$ACK_TRIGGER_LIST" ] \
  || { echo "ACK_TRIGGERS extraction produced nothing — the parity loop below cannot fail" >&2; exit 1; }
for t in pr_preflight_failed pr_migrations_refused pr_warmup_stuck pr_facts_unavailable pr_run_overrun pr_run_stalled; do
  case " $ACK_TRIGGER_LIST " in
    *" $t "*) ;;
    *) echo "ACK_TRIGGERS extraction lost $t — the parity loop below cannot fail" >&2; exit 1 ;;
  esac
done
for t in $(printf '%s\n' $ACK_TRIGGER_LIST | grep '^pr_'); do
  grep -q "\"$t\"" "$SCRIPT_DIR/smoke-pr-gate.sh" \
    || { echo "develop gate accepts $t but the pr gate never emits it" >&2; exit 1; }
  case " $(grep -oP '^ACK_SILENCEABLE="\K[^"]+' "$GATE") " in
    *" $t "*) echo "$t is silenceable but the pr gate honours no dispositions" >&2; exit 1 ;;
  esac
done

# --- 56. INVARIANT 3: numeric knobs go through num_env in BOTH gates -------
for g in "$GATE" "$SCRIPT_DIR/smoke-pr-gate.sh"; do
  if grep -qP '^[A-Z_]+="\$\{?SMOKE_GATE_[A-Z_]+:-[0-9]+\}?"' "$g"; then
    echo "$(basename "$g") reads a numeric knob without num_env" >&2; exit 1
  fi
  # ...and ANYWHERE, not just in a top-level assignment. The regex above
  # anchors on `^NAME="${VAR:-N}"` and structurally cannot see a use-site
  # default inside a command substitution — which is exactly where
  # SMOKE_GATE_FREEZE_HELPER_TIMEOUT hid: `timeout "${VAR:-90}"` bypassed
  # num_env, so `timeout abc` exited 125 into a silenceable freeze-failure
  # alarm instead of naming the knob in gate_misconfigured.
  if grep -qP 'SMOKE_GATE_[A-Z_]+:-[0-9]+' "$g"; then
    echo "$(basename "$g") defaults a numeric knob at a USE SITE, bypassing num_env:" >&2
    grep -nP 'SMOKE_GATE_[A-Z_]+:-[0-9]+' "$g" >&2; exit 1
  fi
  grep -q 'MISSING="\$MISSING\$BAD_NUMERIC_CONFIG"' "$g" \
    || { echo "$(basename "$g") never reports a bad numeric knob" >&2; exit 1; }
done

# --- 57. gate_hold_tampered re-alerts for a DIFFERENT offender -------------
# The latch stored the category (`missing|mismatched|unexpected`) alone, so the
# first offender satisfied it forever and a second, unrelated run in the same
# category never re-alerted.
fresh_state
export STUB_SOURCE_SHA="$(printf '4%.0s' $(seq 40))"
HT_STATE="$SMOKE_GATE_STATE_DIR/develop-state.json"
HT_HOLD="$SMOKE_GATE_STATE_DIR/develop-hold.json"
export SMOKE_GATE_HOLD_FILE="$HT_HOLD"
bash "$GATE" poll >/dev/null
jq '.completedVerdict="NO_GO" | .completedRunId="offender-one"' "$HT_STATE" > "$HT_STATE.t" && mv "$HT_STATE.t" "$HT_STATE"
bash "$GATE" poll | jq -e '.data.trigger == "gate_hold_tampered"' >/dev/null
bash "$GATE" poll | jq -e '.data.trigger != "gate_hold_tampered"' >/dev/null   # latched
jq '.completedRunId="offender-two"' "$HT_STATE" > "$HT_STATE.t" && mv "$HT_STATE.t" "$HT_STATE"
bash "$GATE" poll | jq -e '
  .data.trigger == "gate_hold_tampered" and .data.ledgerRunId == "offender-two"
' >/dev/null
unset SMOKE_GATE_HOLD_FILE

# --- 58. wait-settled: bounded poll, never a FAIL on an unsettled build ----
# A re-verification run must wait and re-check, not score an unsettled/red
# environment as a product FAIL (see SKILL.md's re-verification guidance).

# 58a. Never settles within the bound: exits non-zero, reports timedOut:true,
# and still carries the underlying check's own diagnostic (failedChecks).
fresh_state
export STUB_SOURCE_SHA="$(printf '8%.0s' $(seq 40))"
export STUB_FRONTEND_CI=failure
export SMOKE_GATE_WAIT_INTERVAL_SECONDS=0 SMOKE_GATE_WAIT_MAX_SECONDS=0
if bash "$GATE" wait-settled > "$STATE_DIR2/wait-out.json"; then
  echo "expected wait-settled to exit non-zero when the build never settles" >&2; exit 1
fi
jq -e '.settled == false and .timedOut == true and .failedChecks == 1 and (.attempts | type) == "number"' \
  "$STATE_DIR2/wait-out.json" >/dev/null
unset STUB_FRONTEND_CI SMOKE_GATE_WAIT_INTERVAL_SECONDS SMOKE_GATE_WAIT_MAX_SECONDS

# 58b. Settles mid-wait: the same command that woke on `develop_unsettled`
# eventually observes settled:true without a human re-invoking anything.
fresh_state
export STUB_SOURCE_SHA="$(printf '9%.0s' $(seq 40))"
export STUB_FRONTEND_CI=failure
export STUB_UNSETTLE_COUNTER_FILE="$STATE_DIR2/unsettle-count"
export STUB_UNSETTLE_UNTIL_ATTEMPT=3
export SMOKE_GATE_WAIT_INTERVAL_SECONDS=0 SMOKE_GATE_WAIT_MAX_SECONDS=30
bash "$GATE" wait-settled > "$STATE_DIR2/wait-out2.json"
jq -e '.settled == true and .timedOut == false and .attempts >= 3' "$STATE_DIR2/wait-out2.json" >/dev/null
unset STUB_FRONTEND_CI STUB_UNSETTLE_COUNTER_FILE STUB_UNSETTLE_UNTIL_ATTEMPT \
      SMOKE_GATE_WAIT_INTERVAL_SECONDS SMOKE_GATE_WAIT_MAX_SECONDS

# 58c. Already settled: succeeds on the first attempt, no waiting needed.
fresh_state
export STUB_SOURCE_SHA="$(printf '5%.0s' $(seq 40))"
export SMOKE_GATE_WAIT_INTERVAL_SECONDS=0 SMOKE_GATE_WAIT_MAX_SECONDS=30
bash "$GATE" wait-settled | jq -e '.settled == true and .attempts == 1' >/dev/null
unset SMOKE_GATE_WAIT_INTERVAL_SECONDS SMOKE_GATE_WAIT_MAX_SECONDS

# --- 59. `wait-settled`'s own knobs are wired into gate_misconfigured just
# like every other numeric knob (see num_env's comment above
# WAIT_INTERVAL_SECONDS) — a duration suffix or a leading zero fails BOTH
# `poll` and `check`, not only an agent's own `wait-settled` invocation.
fresh_state
export STUB_SOURCE_SHA="$(printf '3%.0s' $(seq 40))"
for bad in 45m 2700s 0900; do
  SMOKE_GATE_WAIT_MAX_SECONDS="$bad" bash "$GATE" poll | jq -e '
    .data.trigger == "gate_misconfigured" and
    .data.missing == ["SMOKE_GATE_WAIT_MAX_SECONDS"]
  ' >/dev/null || { echo "poll admitted WAIT_MAX_SECONDS='$bad'" >&2; exit 1; }
  SMOKE_GATE_WAIT_MAX_SECONDS="$bad" bash "$GATE" check | jq -e '
    .data.trigger == "gate_misconfigured" and
    .data.missing == ["SMOKE_GATE_WAIT_MAX_SECONDS"]
  ' >/dev/null || { echo "check admitted WAIT_MAX_SECONDS='$bad'" >&2; exit 1; }
done

# --- 60. `claim` refuses a run id already held by a task-scoped certification
# run (#726 F2, develop-gate side — smoke-pr-gate.sh's task-claim already
# makes the reciprocal check against this gate's develop-state.json). Without
# this, `task-claim run-b` followed by a develop-gate `claim run-b` leaves two
# active slots for one run id: the task lease still calls run-b its own, while
# develop-state.json now also claims it.
fresh_state
TASK_SLOT_SHA="$(printf '7%.0s' $(seq 40))"
printf '{"schemaVersion":1,"activeRunId":"run-b","activeSha":"%s","activeStartedAt":"2026-01-01T00:00:00Z","activeProgressAt":"2026-01-01T00:00:00Z","activeLeaseOwner":"owner-x","completedAt":null,"completedRunId":null,"completedVerdict":null}\n' \
  "$TASK_SLOT_SHA" > "$STATE_DIR2/task-run-b-state.json"
bash "$GATE" claim run-b "$TASK_SLOT_SHA" | jq -e --arg path "$STATE_DIR2/task-run-b-state.json" '
  .ok == false and (.error | test("task-scoped certification run")) and .taskStateFile == $path
' >/dev/null
# The refusal happened before any state write — no active slot was opened.
if [ -e "$STATE_DIR2/develop-state.json" ]; then
  jq -e '.activeRunId == null' "$STATE_DIR2/develop-state.json" >/dev/null
fi
# A run id not held by any task slot is unaffected by an unrelated one.
bash "$GATE" claim run-c "$TASK_SLOT_SHA" | jq -e '.ok == true and .runId == "run-c"' >/dev/null

# A finished task has no activeRunId, but its terminal run id still owns the
# shared verdict key and cannot be reused by the develop gate.
fresh_state
printf '{"schemaVersion":1,"activeRunId":null,"activeSha":null,"completedRunId":"run-finished","completedSha":"%s"}\n' \
  "$TASK_SLOT_SHA" > "$STATE_DIR2/task-run-finished-state.json"
FINISHED_TASK_OUT="$(bash "$GATE" claim run-finished "$TASK_SLOT_SHA")"
jq -e '.ok == false and .taskBinding == "completed" and (.error | test("finished"))' \
  <<<"$FINISHED_TASK_OUT" >/dev/null || {
  echo "60: claim took a finished task run id: $FINISHED_TASK_OUT" >&2; exit 1; }
[ ! -e "$STATE_DIR2/develop-state.json" ] ||
  { echo "60: a refused finished-task claim wrote develop state" >&2; exit 1; }

# task-release retains activeSha as its durable task binding. It is not an
# active slot, but this gate still may not take the run id on any SHA.
fresh_state
printf '{"schemaVersion":1,"activeRunId":null,"activeSha":"%s","completedRunId":null,"completedSha":null}\n' \
  "$TASK_SLOT_SHA" > "$STATE_DIR2/task-run-released-state.json"
RELEASED_TASK_OUT="$(bash "$GATE" claim run-released "$TASK_SLOT_SHA")"
jq -e '.ok == false and .taskBinding == "released" and (.error | test("released"))' \
  <<<"$RELEASED_TASK_OUT" >/dev/null || {
  echo "60: claim took a released task run id: $RELEASED_TASK_OUT" >&2; exit 1; }
[ ! -e "$STATE_DIR2/develop-state.json" ] ||
  { echo "60: a refused released-task claim wrote develop state" >&2; exit 1; }

# --- 60b. Shadow-review finding 1: the refusal above must not fail OPEN on
# this run's own unreadable task-scoped state. `jq … 2>/dev/null` used to read
# a malformed, chmod-000, or torn file the same as "no match", letting the
# claim through onto a run id a task-scoped certification run might still
# hold. An EMPTY file (never a real task-claim state) and a bare null
# `activeRunId` with no retained SHA or completed run are not evidence of
# anything and must NOT be refused. A released state retains activeSha and a
# finished state retains completedRunId, both explicitly tested above.
fresh_state
BAD_SHA="$(printf '8%.0s' $(seq 40))"
printf 'not json' > "$STATE_DIR2/task-run-malformed-state.json"
bash "$GATE" claim run-malformed "$BAD_SHA" | jq -e --arg path "$STATE_DIR2/task-run-malformed-state.json" '
  .ok == false and (.error | test("cannot be read")) and .taskStateFile == $path
' >/dev/null || { echo "60b: a malformed own task-state file must refuse fail-closed" >&2; exit 1; }
[ ! -e "$STATE_DIR2/develop-state.json" ] ||
  jq -e '.activeRunId == null' "$STATE_DIR2/develop-state.json" >/dev/null

fresh_state
echo '{"activeRunId":"run-unreadable"}' > "$STATE_DIR2/task-run-unreadable-state.json"
chmod 000 "$STATE_DIR2/task-run-unreadable-state.json"
if [ "$(id -u)" -ne 0 ]; then
  bash "$GATE" claim run-unreadable "$BAD_SHA" | jq -e '
    .ok == false and (.error | test("cannot be read"))
  ' >/dev/null || { echo "60b: an unreadable own task-state file must refuse fail-closed" >&2; exit 1; }
fi
chmod 644 "$STATE_DIR2/task-run-unreadable-state.json"

fresh_state
: > "$STATE_DIR2/task-run-emptyfile-state.json"
bash "$GATE" claim run-emptyfile "$BAD_SHA" | jq -e '
  .ok == true and .runId == "run-emptyfile"
' >/dev/null || { echo "60b: an EMPTY own task-state file must not block the claim" >&2; exit 1; }

fresh_state
printf '{"activeRunId":null}' > "$STATE_DIR2/task-run-nullactive-state.json"
bash "$GATE" claim run-nullactive "$BAD_SHA" | jq -e '
  .ok == true and .runId == "run-nullactive"
' >/dev/null || { echo "60b: a null activeRunId in the own task-state file must not block the claim" >&2; exit 1; }

# --- 60c. Lock parity: `claim`'s task-slot scan through its state write runs
# under CONTROL_LOCK, the SAME lock file smoke-pr-gate.sh's task-claim takes
# (both gates are deployed pointed at one shared SMOKE_GATE_STATE_DIR). Before
# this, the develop `claim` scanned and wrote under develop-state.lock alone,
# so a forced interleaving with a concurrent task-claim could leave two active
# slots for one run id. A held control.lock must make `claim` wait, then fail
# CLOSED (retryable) — never return ok:true while the lock is unavailable.
fresh_state
LOCK_SHA="$(printf '9%.0s' $(seq 40))"
LOCK_HELD="$STATE_DIR2/control-held"
( flock -x 7; : > "$LOCK_HELD"; sleep 3 ) 7>"$STATE_DIR2/control.lock" &
LOCK_BLOCKER=$!
for _ in $(seq 100); do [ -e "$LOCK_HELD" ] && break; sleep 0.05; done
[ -e "$LOCK_HELD" ] || { echo "60c: the control-lock holder never signalled that it held the lock" >&2; exit 1; }
LOCK_BUSY_OUT="$(SMOKE_GATE_LOCK_WAIT_SECONDS=1 bash "$GATE" claim run-lockheld "$LOCK_SHA")"
wait "$LOCK_BLOCKER"
jq -e '.ok == false and .retryable == true and (.error | startswith("gate_lock_busy:"))' <<<"$LOCK_BUSY_OUT" >/dev/null ||
  { echo "60c: claim did not wait on, and fail closed against, a held control lock: $LOCK_BUSY_OUT" >&2; exit 1; }
[ ! -e "$STATE_DIR2/develop-state.json" ] ||
  jq -e '.activeRunId == null' "$STATE_DIR2/develop-state.json" >/dev/null
# The lock released, so the same claim now succeeds.
bash "$GATE" claim run-lockheld "$LOCK_SHA" | jq -e '.ok == true and .runId == "run-lockheld"' >/dev/null ||
  { echo "60c: claim did not succeed once the control lock was free" >&2; exit 1; }

# --- 60d. Automatic develop poll is a claim producer too. Its generated run
# id must consult the same shared task binding under the shared task lock before
# develop-state.json can name it.
fresh_state
AUTO_DEV_SHA="$(printf '6%.0s' $(seq 40))"
AUTO_DEV_LEGACY_SHA="$(printf '7%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$AUTO_DEV_SHA" SMOKE_GATE_RUN_PREFIX=bounddev
export SMOKE_GATE_DEBOUNCE_SECONDS=10
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "debouncing_candidate"' >/dev/null
export SMOKE_GATE_DEBOUNCE_SECONDS=0
mkdir -p "$SMOKE_GATE_LEASE_DIR"
AUTO_DEV_LEGACY_STATE="$STATE_DIR2/legacy-private"
mkdir -p "$AUTO_DEV_LEGACY_STATE"
AUTO_DEV_EPOCH="$(/usr/bin/date -u +%s)"
AUTO_DEV_ISO="$(/usr/bin/date -u -d "@$AUTO_DEV_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
AUTO_DEV_STAMP="$(/usr/bin/date -u -d "@$AUTO_DEV_EPOCH" +%Y%m%dT%H%M%SZ)"
AUTO_DEV_RUN="bounddev-${AUTO_DEV_SHA:0:12}-$AUTO_DEV_STAMP"
AUTO_DEV_DATE_BIN="$STUB_BIN/fixed-date-develop"
mkdir -p "$AUTO_DEV_DATE_BIN"
cat >"$AUTO_DEV_DATE_BIN/date" <<STUB
#!/usr/bin/env bash
if [ "\$*" = '-u +%s' ]; then printf '%s\n' '$AUTO_DEV_EPOCH'
elif [ "\$*" = '-u +%Y-%m-%dT%H:%M:%SZ' ]; then printf '%s\n' '$AUTO_DEV_ISO'
else exec /usr/bin/date "\$@"
fi
STUB
chmod +x "$AUTO_DEV_DATE_BIN/date"
TEST_PATH="$PATH"
export PATH="$AUTO_DEV_DATE_BIN:$PATH"
SMOKE_GATE_STATE_DIR="$AUTO_DEV_LEGACY_STATE" bash "$LEGACY_GATE" task-claim "$AUTO_DEV_RUN" "$AUTO_DEV_LEGACY_SHA" owner-legacy >/dev/null
AUTO_DEV_OUT="$(bash "$GATE" poll)"
export PATH="$TEST_PATH"
jq -e '.ok == false and .wakeAgent == true and .data.trigger == "shared_task_binding_unavailable" and
       (.data.detail.error | test("task-scoped"))' <<<"$AUTO_DEV_OUT" >/dev/null || {
  echo "60d: automatic develop poll ignored shared task binding: $AUTO_DEV_OUT" >&2; exit 1; }
jq -e '.activeRunId == null' "$STATE_DIR2/develop-state.json" >/dev/null
jq -e --arg sha "$AUTO_DEV_LEGACY_SHA" '.deploySha == $sha and .terminal == null' \
  "$SMOKE_GATE_LEASE_DIR/task-binding-$AUTO_DEV_RUN.json" >/dev/null
unset SMOKE_GATE_RUN_PREFIX

# The shared binding path must never be constructed from a traversal-shaped
# manual run id; this gate historically accepted arbitrary ids before it had
# any shared path keyed by them.
UNSAFE_DEV_OUT="$(bash "$GATE" claim ../escaped "$AUTO_DEV_SHA")"
jq -e '.ok == false and (.error | test("unsafe"))' <<<"$UNSAFE_DEV_OUT" >/dev/null || {
  echo "60d: traversal-shaped develop run id reached shared storage: $UNSAFE_DEV_OUT" >&2; exit 1; }
[ ! -e "$TEST_SHARED_ROOT/qa-coordinator/task-lease-escaped.lock" ]

# W2: a poll that cannot read the branch is unreadable, never empty; a
# non-poll verb's output is unchanged. Keys the gate already printed survive.
W2_DIR="$(mktemp -d)"
W2_OUT="$(SMOKE_GATE_STATE_DIR="$W2_DIR" STUB_SOURCE_SHA=not-a-sha bash "$GATE" poll)"
jq -e '.wakeAgent == false and .data.trigger == "gate_fetch_failed" and .ok == false and
       .observation.kind == "unreadable" and .observation.bound == "2h"' <<<"$W2_OUT" >/dev/null || {
  echo "W2: a failed fetch was not declared unreadable: $W2_OUT" >&2; exit 1; }
W2_CHECK="$(SMOKE_GATE_STATE_DIR="$W2_DIR" STUB_SOURCE_SHA=not-a-sha bash "$GATE" check)"
jq -e 'has("observation") | not' <<<"$W2_CHECK" >/dev/null || {
  echo "W2: a non-poll verb grew an observation: $W2_CHECK" >&2; exit 1; }
rm -rf "$W2_DIR"

echo "smoke develop gate tests passed"
