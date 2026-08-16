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
STUB_BIN="$(mktemp -d)"
trap 'rm -rf "$STATE_DIR" "$STUB_BIN"' EXIT
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
    printf '[{"headSha":"%s","status":"completed","conclusion":"%s","workflowName":"Frontend CI"},
             {"headSha":"%s","status":"completed","conclusion":"success","workflowName":"Backend CI"}]' \
      "$STUB_SOURCE_SHA" "${STUB_FRONTEND_CI:-success}" "$STUB_SOURCE_SHA" ;;
  *)
    case "$2" in
      */compare/*)
        printf '{"status":"%s","behind_by":0,"files":%s}' \
          "${STUB_COMPARE_STATUS:-ahead}" "${STUB_COMPARE_FILES:-[]}" ;;
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
printf '%s' "$STUB_FREEZE_JSON"
exit "$STUB_FREEZE_EXIT"
STUB
chmod +x "$STUB_BIN/gh" "$STUB_BIN/curl" "$STUB_BIN/freeze-helper"
export PATH="$STUB_BIN:$PATH"
export STUB_SOURCE_SHA="$BUILD_SHA"
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
# Test 13's ceiling recovery already claimed a fresh run, so finish the run
# that actually owns the slot — a verdict from any other run is refused now.
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
        STUB_FREEZE_EXIT STUB_FREEZE_JSON STUB_FREEZE_PR_STATE 2>/dev/null || true
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

echo "smoke develop gate tests passed"
