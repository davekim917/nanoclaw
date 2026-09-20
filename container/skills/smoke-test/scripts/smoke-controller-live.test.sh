#!/usr/bin/env bash
# Tests for smoke-controller-live.sh, the LIVE task-script wrapper: the final
# line contract (wakeAgent true for a due owner step, with {step, runId,
# brief}, OR for a fire that failed closed, with {failure, detail, fire, note};
# false only for the two named non-failure ends), the kill switch (not live =
# nothing runs), the cutover file written once before the first poll, the
# claimant the poll runs with, progress before poll, receipts read from the
# session's inbound.db, a hard budget, and poll failures that still step.
# The wrapper posts nothing itself: the owner does, on a failure wake.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$SCRIPT_DIR/smoke-controller-live.sh"
FAKES="$SCRIPT_DIR/testdata/controller-live-fakes.py"
T="$(mktemp -d)"
[ -n "${KEEP_TMP:-}" ] && echo "keeping $T" >&2 || trap 'rm -rf "$T"' EXIT
unset SMOKE_CONTROLLER_MODE SMOKE_GATE_CLAIMANT SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS || true

fail() { echo "FAIL: $*" >&2; exit 1; }

SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PR=7
RUN=xzo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z
LEGACY=xzo-pr-pr9-cccccccccccc-20260918T090000Z
TOKEN=owner-ctl-2222

new_case() {
  C="$T/$1"
  mkdir -p "$C/agent/state" "$C/wg/runs" "$C/fake" "$C/bin"
  R="$C/wg/runs/$RUN"
  OUT="$C/wg/controller"
  export FAKE_STATE="$C/fake" FAKE_LOG="$C/fake/calls.ndjson" FAKE_GATE_STATE="$C/agent/state"
  : >"$FAKE_LOG"
  jq -cn --arg sha "$SHA" '{prs:{"7":{state:"OPEN",headRefOid:$sha,headRefName:"smoke/freeze-1"}},comments:{},issues:[]}' \
    >"$C/fake/gh.json"
  # The gate: `poll` is scripted (and records its claimant and whether the
  # cutover existed when it ran); every other verb is the recording fake.
  cat >"$C/bin/gate.sh" <<SH
#!/usr/bin/env bash
if [ "\$1" = poll ]; then
  jq -cn --arg cl "\${SMOKE_GATE_CLAIMANT:-}" --argjson cut "\$([ -e '$C/wg/controller/cutover.json' ] && echo true || echo false)" \
    '{tool:"gate",op:"poll",claimant:\$cl,cutoverExisted:\$cut}' >>'$FAKE_LOG'
  echo '{"wakeAgent":true,"data":{"forged":"a child line never reaches the runner"}}'
  if [ -e '$C/poll-sleep' ]; then sleep "\$(cat '$C/poll-sleep')"; fi
  if [ -e '$C/poll-next.sh' ]; then bash '$C/poll-next.sh'; rm -f '$C/poll-next.sh'; exit 0; fi
  echo '{"wakeAgent":false,"data":{"schemaVersion":1,"trigger":"waiting_for_candidates"}}'
  exit 0
fi
exec python3 '$FAKES' gate "\$@"
SH
  write_env live
}

write_env() { # mode [skip-send-to]
  {
    echo 'set -u'
    echo "export SMOKE_GATE_STATE_DIR='$C/agent/state'"
    echo "export SMOKE_GATE_RUN_ROOT='$C/wg/runs'"
    echo "export SMOKE_GATE_REPO='acme/app'"
    echo "export SMOKE_CONTROLLER_GATE_CMD='$C/bin/gate.sh'"
    [ -n "${2:-}" ] || echo "export SMOKE_CONTROLLER_SEND_TO='campaign-room'"
    echo "echo '{\"wakeAgent\":true}'"
    [ -z "$1" ] || echo "export SMOKE_CONTROLLER_MODE='$1'"
  } >"$C/env.sh"
}

# The next poll claims $RUN for the controller, as the real gate does
# (state first, then the wake with the owner token).
next_poll_claims() {
  cat >"$C/poll-next.sh" <<SH
jq -cn --arg run "$RUN" --arg sha "$SHA" --arg tok "$TOKEN" \
  '{schemaVersion:1,pr:$PR,activeRunId:\$run,activeSha:\$sha,challengerDeadline:"2099-01-01T00:00:00Z",
    challengerDisposition:null,activeLeaseOwner:\$tok,activeClaimant:(env.SMOKE_GATE_CLAIMANT // null)}' \
  >'$C/agent/state/pr-$PR-state.json'
jq -cn --arg run "$RUN" --arg sha "$SHA" --arg tok "$TOKEN" \
  '{wakeAgent:true,data:{schemaVersion:1,trigger:"pr_build_settled",runId:\$run,pr:$PR,sourceSha:\$sha,
    coordinatorOwnerToken:\$tok,isFreezePr:true}}'
SH
}

inbound_db() { # message-id status
  python3 - "$C/inbound.db" "$1" "$2" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE IF NOT EXISTS delivered (message_out_id TEXT PRIMARY KEY, platform_message_id TEXT, status TEXT NOT NULL DEFAULT 'delivered', delivered_at TEXT NOT NULL)")
c.execute("INSERT OR REPLACE INTO delivered VALUES (?, 'p1', ?, '2026-09-18T10:00:00Z')", (sys.argv[2], sys.argv[3]))
c.commit()
PY
}

OUTPUT=""
DATA=""
WAKE=""
ELAPSED=0
fire() { # [env assignments...]
  local s rc
  s="$(date +%s)"
  set +e
  OUTPUT="$(env SMOKE_CONTROLLER_ENV_FILE="$C/env.sh" \
    SMOKE_CONTROLLER_LIVE_GH_CMD="python3 $FAKES gh" SMOKE_CONTROLLER_LIVE_NCL_CMD="python3 $FAKES ncl" \
    SMOKE_CONTROLLER_LIVE_ENQUEUE_CMD="python3 $FAKES enqueue" SMOKE_CONTROLLER_LIVE_INBOUND_DB="$C/inbound.db" \
    "$@" bash "$W" 2>"$T/stderr")"
  rc=$?
  set -e
  ELAPSED=$(( $(date +%s) - s ))
  [ "$rc" = 0 ] || fail "wrapper exited $rc (must always be 0): $(tail -5 "$T/stderr")"
  [ "$(printf '%s\n' "$OUTPUT" | wc -l)" = 1 ] || fail "stdout must be exactly one line, got: $OUTPUT"
  printf '%s\n' "$OUTPUT" | jq -e '(keys == ["data","wakeAgent"]) and (.wakeAgent | type == "boolean") and (.data | type == "object")' \
    >/dev/null || fail "last line is not {wakeAgent:<bool>,data:{...}}: $OUTPUT"
  WAKE="$(jq -r .wakeAgent <<<"$OUTPUT")"
  DATA="$(jq -c .data <<<"$OUTPUT")"
}
d() { jq -r "$1" <<<"$DATA"; }
calls() { jq -s -c "$1" "$FAKE_LOG"; }

# $1 case, $2 slug. The wake carries a ready-to-run enqueue-send: an id and a
# fingerprint the helper's patterns accept, a non-empty fire (it rejects an
# empty one, cli/enqueue-send.ts:157), a thread key, and the exact text. The
# text never names the fire or the detail, because the id is per cause per day
# and a different payload under it is a mismatch, not a replay.
alarm_selfcontained() {
  local day
  day="$(d .fire | cut -c1-10 | tr -d -)"
  [ "$(d .alarm.id)" = "ctl.failure.$2.$day#1" ] && [ "$(d .alarm.fingerprint)" = "$2" ] \
    && [ "$(d .alarm.threadKey)" = "ctl.failure-$2-$day" ] && [ "$(d .alarm.runId)" = "ctl.wrapper.$day" ] \
    || fail "$1: the wake must carry the alarm's ids: $OUTPUT"
  [ -n "$(d .alarm.fire)" ] && [ "$(d .alarm.fire)" != null ] && [ -n "$(d .alarm.text)" ] \
    && [ "$(d .alarm.text)" != null ] || fail "$1: the wake must carry a fire and the post text: $OUTPUT"
  d .alarm.text | grep -q "UNCERTAIN" || fail "$1: the post must not claim the fire changed nothing: $OUTPUT"
  if d .alarm.text | grep -qF "$(d .fire)"; then
    fail "$1: the post text carries the fire timestamp, so tomorrow's replay is a mismatch: $OUTPUT"
  fi
  return 0
}

# --- kill switch: anything but live does nothing ---------------------------------
for m in "" shadow off; do
  new_case "not-live-${m:-unset}"
  write_env "$m"
  fire
  [ "$WAKE" = false ] && d .skipped | grep -q "not live" || fail "mode '${m:-unset}' must do nothing: $OUTPUT"
  [ ! -s "$FAKE_LOG" ] || fail "mode '${m:-unset}' must call nothing: $(cat "$FAKE_LOG")"
  [ ! -e "$OUT" ] || fail "mode '${m:-unset}' must not create the out-dir"
done
new_case misconfigured
write_env live skip-send-to
fire
[ "$WAKE" = true ] && [ "$(d .failure)" = misconfigured ] && [ "$(d '.misconfigured[0]')" = SMOKE_CONTROLLER_SEND_TO ] \
  || fail "live without a destination: $OUTPUT"
[ -n "$(d .detail)" ] && [ "$(d .detail)" != null ] && [ "$(d .fire)" != null ] \
  || fail "every failure carries {failure, detail, fire}: $OUTPUT"
[ ! -s "$FAKE_LOG" ] || fail "a misconfigured live fire must call nothing"
# Codex round-5 finding 2: a fault BEFORE the out-dir resolves used to bypass
# the ledger silently. It is now the same wake as any other.
new_case early-fault
rm -f "$C/bin/gate.sh"
fire
[ "$WAKE" = true ] && [ "$(d .failure)" = misconfigured ] && [ ! -e "$OUT" ] \
  || fail "a fault before the out-dir resolves still reports: $OUTPUT"

new_case claimant-in-env
echo "export SMOKE_GATE_CLAIMANT=controller" >>"$C/env.sh"
fire
[ "$WAKE" = true ] && [ "$(d .failure)" = misconfigured ] && [ "$(d '.misconfigured[0]')" = SMOKE_GATE_CLAIMANT ] \
  || fail "a claimant in the shared env file would tag legacy gate calls: $OUTPUT"
# Fail-closed: no call of any kind. The wrapper does not post -- the wake is
# the report (review round 5: the alarm ledger and the wrapper's own send are
# deleted; the owner posts).
calls 'length == 0' | grep -qx true \
  || fail "a claimant in the env file must call nothing at all: $(cat "$FAKE_LOG")"
[ ! -e "$C/fake/enqueue.json" ] || fail "the wrapper never enqueues anything itself: $(cat "$C/fake/enqueue.json")"

# --- first live fire: cutover before poll, claim, intake wake --------------------
new_case flip
jq -cn --arg run "$LEGACY" --arg sha "$SHA" \
  '{schemaVersion:1,pr:9,activeRunId:$run,activeSha:$sha,activeLeaseOwner:"owner-legacy",challengerDeadline:"2099-01-01T00:00:00Z"}' \
  >"$C/agent/state/pr-9-state.json"
next_poll_claims
fire
jq -e --arg l "$LEGACY" '.legacyRuns == [$l] and (.flippedAt | type == "string")' "$OUT/cutover.json" >/dev/null \
  || fail "the cutover names every run claimed before the flip: $(cat "$OUT/cutover.json")"
calls '[.[] | select(.op=="poll")] | .[0] | .claimant == "controller" and .cutoverExisted == true' | grep -qx true \
  || fail "poll runs as the controller's claimant, after the cutover is on disk: $(cat "$FAKE_LOG")"
[ "$WAKE" = true ] || fail "a new claim wakes the owner for intake: $OUTPUT"
jq -e --arg run "$RUN" --arg b "$R/controller/brief-intake.md" \
  '.data.step == "intake" and .data.runId == $run and .data.brief == $b' <<<"$OUTPUT" >/dev/null \
  || fail "the wake carries {step, runId, brief}: $OUTPUT"
[ -s "$R/controller/brief-intake.md" ] && jq -e --arg t "$TOKEN" '.coordinatorOwnerToken == $t' "$R/controller/wake.json" >/dev/null \
  || fail "intake brief and frozen wake written"
jq -s -e --arg run "$LEGACY" '[.[] | select(.runId == $run)] | length == 0' "$OUT/journal.ndjson" >/dev/null \
  || fail "the legacy run is never journaled"
before="$(cat "$OUT/cutover.json")"

# --- second fire: acked brief -> no wake; progress before poll; cutover kept -------
: >"$R/controller/brief-intake.ack"
: >"$FAKE_LOG"
fire
[ "$WAKE" = false ] && [ "$(d .stepped)" = true ] || fail "an acked step does not wake again: $OUTPUT"
[ "$(cat "$OUT/cutover.json")" = "$before" ] || fail "the cutover is written once, never rewritten"
calls 'map(.op) | index("progress") < index("poll")' | grep -qx true \
  || fail "our run's progress is stamped before the poll can judge it stale: $(cat "$FAKE_LOG")"
calls '[.[] | select(.tool=="gate" and .op!="poll")] | length > 0 and all(.argv[0] == "progress")' | grep -qx true \
  || fail "the legacy run gets no gate call: $(cat "$FAKE_LOG")"

# --- receipts come from this session's inbound.db ---------------------------------
mkdir -p "$R/markers" "$R/controller"
jq -cn --arg run "$RUN" --arg sha "$SHA" --argjson pr "$PR" '{schemaVersion:2,runId:$run,pr:$pr,sourceSha:$sha,
  ownershipKind:"pr",requiredLaneMarkers:["markers/A1.json"],lanes:[{id:"A1",kind:"lane",generation:1}]}' \
  >"$R/completion-contract.json"
printf 'Checkout changes; checkout journey tested.\n' >"$R/controller/root-summary.md"
fire
mid="$(jq -r '.messages | keys[0]' "$C/fake/enqueue.json")"
[ -n "$mid" ] && [ "$mid" != null ] || fail "the root post was enqueued: $OUTPUT"
[ "$WAKE" = true ] && [ "$(d .step)" = lanes ] || fail "lanes are due next: $OUTPUT"
jq -s -e '[.[] | select(.kind=="send" and .slot=="root")] | last | .state == "enqueued"' "$OUT/journal.ndjson" >/dev/null \
  || fail "root enqueued, awaiting its receipt"
inbound_db "$mid" delivered
fire
jq -s -e '[.[] | select(.kind=="send" and .slot=="root")] | last | .state == "delivered"' "$OUT/journal.ndjson" >/dev/null \
  || fail "the delivered row in inbound.db settles the root send: $(tail -3 "$OUT/journal.ndjson")"

# --- an invalid journal: no progress, no poll, one alarm (review round 1, #3) ------
for variant in torn schema; do
  new_case "journal-$variant"
  fire   # initializes the journal
  jq -cn --arg run "$RUN" --arg tok "$TOKEN" \
    '{v:1,at:"2026-09-18T10:00:00Z",fire:"f",runId:$run,kind:"run",slot:"claim",key:"k1",state:"enqueued",attempt:1,
      mode:"live",detail:{pr:7,ownerToken:$tok}}' >>"$OUT/journal.ndjson"
  jq -cn --arg run "$RUN" --arg sha "$SHA" --arg tok "$TOKEN" \
    '{schemaVersion:1,pr:7,activeRunId:$run,activeSha:$sha,activeLeaseOwner:$tok,activeClaimant:"controller",
      challengerDeadline:"2099-01-01T00:00:00Z"}' >"$C/agent/state/pr-7-state.json"
  if [ "$variant" = torn ]; then
    printf '{"v":1,"key":"k2","runId":"x","state":"int' >>"$OUT/journal.ndjson"
  else
    # Parses, and the old wrapper-side fold accepted it; not a valid record.
    jq -cn '{v:1,key:"k2",runId:"x",kind:"run",slot:"claim",state:"bogus"}' >>"$OUT/journal.ndjson"
  fi
  : >"$FAKE_LOG"
  fire
  [ "$WAKE" = true ] && [ "$(d .failure)" = journal-invalid ] \
    && [ "$(d .controllerAlarm)" = controller_journal_error ] \
    || fail "$variant journal: fails closed and reports: $OUTPUT"
  # Round 7: the per-cause label used to land ON `data.alarm`, replacing the
  # owner's routing payload with a string, so the prescribed send could not run.
  [ "$(d '.alarm|type')" = object ] || fail "$variant journal: data.alarm must stay the routing payload: $OUTPUT"
  alarm_selfcontained "journal-$variant" journal-invalid
  calls '[.[] | select(.tool=="gate")] | length == 0' | grep -qx true \
    || fail "$variant journal: no progress stamp and no poll on an invalid journal: $(cat "$FAKE_LOG")"
  [ ! -e "$C/fake/enqueue.json" ] || fail "$variant journal: the wrapper posts nothing itself"
  fire
  [ "$WAKE" = true ] && [ "$(d .failure)" = journal-invalid ] \
    || fail "$variant journal: a persistent fault re-reports every fire: $OUTPUT"
  calls '[.[] | select(.tool=="gate")] | length == 0' | grep -qx true || fail "$variant journal: still no gate call"
done

# --- one-shot gate alarms survive the poll-return crash window (review round 1, #4) --
new_case alarm-latch
# A latch set before this controller ever polled is the legacy's alarm: baseline.
jq -cn '{schemaVersion:1,pr:5,warmupAlertSha:"dddddddddddddddddddddddddddddddddddddddd"}' >"$C/agent/state/pr-5-state.json"
fire
[ "$(jq '.messages // {} | length' "$C/fake/enqueue.json" 2>/dev/null || echo 0)" = 0 ] \
  || fail "a pre-cutover latch is not re-posted: $(cat "$C/fake/enqueue.json")"
# The gate latched an alarm and the worker died before queueing it: only the
# latch is left. The next fire recovers it, drains it BEFORE polling, posts once.
jq -cn '{schemaVersion:1,pr:5,warmupAlertSha:"dddddddddddddddddddddddddddddddddddddddd",
  refusedAlertSha:"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}' >"$C/agent/state/pr-5-state.json"
: >"$FAKE_LOG"
fire
[ "$(d '.recoveredAlarms | length')" = 1 ] || fail "the lost alarm is recovered from the gate latch: $OUTPUT"
calls '[.[] | select(.op=="poll")] | length == 0' | grep -qx true || fail "a queued alarm is drained before the next poll"
[ "$(d .alarmsQueued)" = 0 ] && [ -z "$(ls -A "$OUT/wrapper/alarms")" ] || fail "the drained alarm leaves the queue: $OUTPUT"
[ "$(jq '[.messages[] | select(.fingerprint | startswith("pr_migrations_refused"))] | length' "$C/fake/enqueue.json")" = 1 ] \
  || fail "the recovered alarm is posted once: $(jq -c '.messages' "$C/fake/enqueue.json")"
fire
[ "$(jq '.messages | length' "$C/fake/enqueue.json")" = 1 ] || fail "a recovered alarm is posted once, ever"
# A poll that emits an alarm: queued durably, then the latch acknowledged. If
# the acknowledgment is lost, the latch path re-queues the SAME fingerprint and
# the journal dedupes it.
cat >"$C/poll-next.sh" <<SH
jq -c '.factsStuckAlertSha="ffffffffffffffffffffffffffffffffffffffff"' '$C/agent/state/pr-5-state.json' >'$C/s.tmp'
mv '$C/s.tmp' '$C/agent/state/pr-5-state.json'
jq -cn '{wakeAgent:true,data:{schemaVersion:1,trigger:"pr_facts_unavailable",pr:5,
  sourceSha:"ffffffffffffffffffffffffffffffffffffffff",migrationFiles:[],migrationsDeterminable:false,runId:null,activeAgeSeconds:null}}'
SH
fire
[ "$(jq '[.messages[] | select(.fingerprint | startswith("pr_facts_unavailable"))] | length' "$C/fake/enqueue.json")" = 1 ] \
  || fail "a polled alarm is posted: $OUTPUT $(jq -c '.messages' "$C/fake/enqueue.json")"
jq 'with_entries(select(.key != "5:factsStuckAlertSha"))' "$OUT/wrapper/latches.json" >"$C/l.tmp"
mv "$C/l.tmp" "$OUT/wrapper/latches.json"
fire
[ "$(d '.recoveredAlarms | length')" = 1 ] || fail "the unacknowledged latch is re-queued: $OUTPUT"
[ "$(jq '[.messages[] | select(.fingerprint | startswith("pr_facts_unavailable"))] | length' "$C/fake/enqueue.json")" = 1 ] \
  || fail "poll and latch paths share one fingerprint: never a second post"
# An unreadable queued alarm refuses the step rather than dropping it.
printf '{not json' >"$OUT/wrapper/alarms/broken.json"
fire
[ "$(d .stepped)" = false ] && [ -e "$OUT/wrapper/alarms/broken.json" ] || fail "an unreadable queued alarm is kept: $OUTPUT"

# --- EVERY gate latch is recovered, not just four (review round 2, #1) -------------
# stalledAlertRunId (smoke-pr-gate.sh:4783, checked :4762) and the control-file
# wakes (:1463, :4858, :4908, :5245). The gate wrote the latch; the worker died
# before queueing: the next fire recovers it and posts it exactly once.
posted() { jq --arg p "$1" '[.messages // {} | .[] | select(.fingerprint | startswith($p))] | length' "$C/fake/enqueue.json" 2>/dev/null || echo 0; }
new_case latch-stalled
fire   # baseline: nothing latched yet
jq -cn --arg run "$RUN" --arg sha "$SHA" '{schemaVersion:1,pr:7,activeRunId:$run,activeSha:$sha,
  activeLeaseOwner:"owner-x",challengerDeadline:"2099-01-01T00:00:00Z",stalledAlertRunId:$run}' \
  >"$C/agent/state/pr-7-state.json"
: >"$FAKE_LOG"
fire
[ "$(d '.recoveredAlarms | length')" = 1 ] && d '.recoveredAlarms[0]' | grep -q "pr_run_stalled:7:$RUN" \
  || fail "a lost pr_run_stalled is recovered from stalledAlertRunId, keyed by its run: $OUTPUT"
calls '[.[] | select(.op=="poll")] | length == 0' | grep -qx true || fail "the recovered stall alarm is drained before polling"
[ "$(posted pr_run_stalled)" = 1 ] || fail "the recovered stall alarm is posted: $(cat "$C/fake/enqueue.json")"
fire; fire
[ "$(posted pr_run_stalled)" = 1 ] || fail "the recovered stall alarm is posted once, ever"
# The poll path: the gate emits the stall wake after latching it; the ack of the
# latch is lost; recovery re-queues the SAME fingerprint, so no second post.
jq -c '.stalledAlertRunId=null | .activeRunId="xzo-pr-pr7-bbbbbbbbbbbb-20260918T110000Z"' "$C/agent/state/pr-7-state.json" >"$C/s.tmp"
mv "$C/s.tmp" "$C/agent/state/pr-7-state.json"
fire   # acknowledges the cleared latch
cat >"$C/poll-next.sh" <<SH
jq -c '.stalledAlertRunId=.activeRunId' '$C/agent/state/pr-7-state.json' >'$C/s.tmp'
mv '$C/s.tmp' '$C/agent/state/pr-7-state.json'
jq -cn '{wakeAgent:true,data:{schemaVersion:1,trigger:"pr_run_stalled",pr:7,runId:"xzo-pr-pr7-bbbbbbbbbbbb-20260918T110000Z",
  sourceSha:"$SHA",quietSeconds:4000}}'
SH
fire
[ "$(posted pr_run_stalled)" = 2 ] || fail "the polled stall alarm (a new run) is posted: $(jq -c '.messages' "$C/fake/enqueue.json")"
jq 'with_entries(select(.key != "7:stalledAlertRunId"))' "$OUT/wrapper/latches.json" >"$C/l.tmp"
mv "$C/l.tmp" "$OUT/wrapper/latches.json"
fire
[ "$(d '.recoveredAlarms | length')" = 1 ] || fail "the unacknowledged stall latch is re-queued: $OUTPUT"
[ "$(posted pr_run_stalled)" = 2 ] || fail "poll and latch paths share the run-keyed fingerprint: no second post"

new_case latch-control
fire   # baseline
jq -cn '{lastMisconfigWakeAt:"2026-09-18T10:00:00Z"}' >"$C/agent/state/control.json"
: >"$FAKE_LOG"
fire
[ "$(d '.recoveredAlarms | length')" = 1 ] || fail "a lost gate_misconfigured wake is recovered from control.json: $OUTPUT"
[ "$(posted gate_misconfigured)" = 1 ] || fail "the recovered control alarm is posted: $(cat "$C/fake/enqueue.json" 2>/dev/null)"
fire
[ "$(posted gate_misconfigured)" = 1 ] || fail "the recovered control alarm is posted once"
# The gate re-arms 6h later: a new timestamp is a new emission, posted once more.
jq -c '.lastMisconfigWakeAt="2026-09-18T16:00:00Z"' "$C/agent/state/control.json" >"$C/c.tmp"
mv "$C/c.tmp" "$C/agent/state/control.json"
fire
[ "$(posted gate_misconfigured)" = 2 ] || fail "a re-armed control wake is a new alarm"
# Poll path for a control wake: queued under the timestamp the poll just wrote,
# so a lost ack re-queues the same fingerprint.
cat >"$C/poll-next.sh" <<SH
jq -c '.lastFailureWakeAt="2026-09-18T17:00:00Z"' '$C/agent/state/control.json' >'$C/c.tmp'
mv '$C/c.tmp' '$C/agent/state/control.json'
jq -cn '{ok:false,settled:false,wakeAgent:true,data:{schemaVersion:1,trigger:"gate_fetch_failed",settled:false,consecutiveFailures:3}}'
SH
fire
[ "$(posted gate_fetch_failed)" = 1 ] || fail "a polled control alarm is posted: $(jq -c '.messages' "$C/fake/enqueue.json")"
jq 'with_entries(select(.key != "control:lastFailureWakeAt"))' "$OUT/wrapper/latches.json" >"$C/l.tmp"
mv "$C/l.tmp" "$OUT/wrapper/latches.json"
fire
[ "$(d '.recoveredAlarms | length')" = 1 ] || fail "the unacknowledged control latch is re-queued: $OUTPUT"
[ "$(posted gate_fetch_failed)" = 1 ] || fail "poll and latch paths share the control fingerprint: no second post"

# --- a failing or slow poll still steps; a forged child line never escapes --------
new_case poll-fails
printf '5\n' >"$C/poll-sleep"
fire SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS=60
[ "$(d .stepped)" = true ] && [ "$WAKE" = false ] || fail "a slow poll still steps and cannot forge a wake: $OUTPUT"

# --- hard budget: a worker stuck anywhere still ends with the line ---------------
new_case hang
rm "$C/env.sh"
mkfifo "$C/env.sh"   # opening it blocks the worker forever
fire SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS=6
[ "$ELAPSED" -le 9 ] || fail "a hung worker overran a 6 s budget: ${ELAPSED}s"
[ "$WAKE" = true ] && [ "$(d .failure)" = fire-killed ] \
  && [ "$(d .skipped)" = "fire exceeded its budget and was killed" ] || fail "hung worker: $OUTPUT"
new_case budget
for b in 08 0 1e3 200; do
  write_env off
  fire SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS="$b"
  [ "$(d .budgetRejected)" = "$b" ] && [ "$(d .budgetSeconds)" = 100 ] || fail "budget $b must fall back to 100: $OUTPUT"
done
grep -q '^BUDGET_MAX=110$' "$W" && grep -q 'timeout -k 2 "\$BUDGET"' "$W" \
  || fail "hard kill must land by 110 + 2 s, under the runner's 120 s"

# --- every fail-closed worker end wakes the owner with its cause (round 5) --------
# $1 case, $2 description, $3 expected failure slug. The fire must fail closed,
# report itself as wakeAgent:true with {failure, detail, fire, note}, call no
# gate verb, and post NOTHING itself -- the owner is the one that posts.
wrapper_failed() {
  [ "$WAKE" = true ] && [ "$(d .failure)" = "$3" ] \
    || fail "$1: $2 must fail closed as a '$3' wake: $OUTPUT"
  [ "$(d .detail)" != null ] && [ -n "$(d .detail)" ] && [ "$(d .fire)" != null ] && [ "$(d .note)" != null ] \
    || fail "$1: the wake must carry {failure, detail, fire, note}: $OUTPUT"
  # Round 6: the owner must be able to post WITHOUT re-reading the
  # configuration that just failed, so the wake carries the whole send.
  alarm_selfcontained "$1" "$3"
  calls '[.[] | select(.tool=="gate" and .op=="poll")] | length == 0' | grep -qx true \
    || fail "$1: a fail-closed fire never polls: $(cat "$FAKE_LOG")"
  [ ! -e "$C/fake/enqueue.json" ] || [ "$(jq '.messages | length' "$C/fake/enqueue.json")" = 0 ] \
    || fail "$1: the wrapper must post nothing: $(cat "$C/fake/enqueue.json")"
}
# Codex round-3 repro 2: an unreadable control.json after the cutover.
new_case control-unreadable
fire
printf '{"torn' >"$C/agent/state/control.json"
: >"$FAKE_LOG"
fire
wrapper_failed control-unreadable "an unreadable control.json" gate-control-unreadable
fire
wrapper_failed control-unreadable "a repeat of the same failure" gate-control-unreadable
# Gate state unreadable.
new_case state-unreadable
fire
printf 'not json' >"$C/agent/state/pr-7-state.json"
: >"$FAKE_LOG"
fire
wrapper_failed state-unreadable "an unreadable pr state file" gate-state-unreadable
# Another fire holds wrapper.lock.
new_case lock-held
fire
: >"$FAKE_LOG"
(
  exec 9>"$OUT/wrapper/wrapper.lock"
  flock 9
  fire
  printf '%s\n' "$OUTPUT" >"$C/lock-out"
)
OUTPUT="$(cat "$C/lock-out")"; DATA="$(jq -c .data <<<"$OUTPUT")"; WAKE="$(jq -r .wakeAgent <<<"$OUTPUT")"
wrapper_failed lock-held "a held wrapper.lock" lock-held
# An input fetch that blocks the step (gh cannot read a head the run needs).
new_case input-fails
fire
jq -cn --arg run "$RUN" --arg sha "$SHA" --arg tok "$TOKEN" \
  '{schemaVersion:1,pr:7,activeRunId:$run,activeSha:$sha,activeLeaseOwner:$tok,activeClaimant:"controller",
    challengerDeadline:"2099-01-01T00:00:00Z"}' >"$C/agent/state/pr-7-state.json"
: >"$FAKE_LOG"
fire SMOKE_CONTROLLER_LIVE_GH_CMD=false
[ "$WAKE" = true ] && [ "$(d .failure)" = input-fetch-failed ] && [ "$(d .note)" != null ] \
  || fail "input-fails: a blocked input fetch fails closed and reports: $OUTPUT"
[ ! -e "$C/fake/enqueue.json" ] || [ "$(jq '.messages | length' "$C/fake/enqueue.json")" = 0 ] \
  || fail "input-fails: the wrapper posts nothing itself"
# An exception nothing anticipated (wrapper/tmp is a file: makedirs raises).
new_case uncaught
fire
rm -rf "$OUT/wrapper/tmp"; : >"$OUT/wrapper/tmp"
: >"$FAKE_LOG"
fire
wrapper_failed uncaught "an uncaught exception" uncaught-exception
d .skipped | grep -q '^uncaught FileExistsError' || fail "uncaught: routed through the excepthook: $OUTPUT"
# A controller child that cannot answer (its own control.lock is held for
# longer than the fire's --lock-timeout) is a failure too.
new_case controller-refuses
fire
: >"$FAKE_LOG"
(
  exec 8>"$OUT/control.lock"
  flock 8
  fire
  printf '%s\n' "$OUTPUT" >"$C/refused-out"
)
OUTPUT="$(cat "$C/refused-out")"; DATA="$(jq -c .data <<<"$OUTPUT")"; WAKE="$(jq -r .wakeAgent <<<"$OUTPUT")"
[ "$WAKE" = true ] && [ "$(d .failure)" = journal-unvalidated ] && [ "$(d .stepped)" = false ] \
  || fail "controller-refuses: a controller child that cannot answer fails closed: $OUTPUT"

new_case killed-fire
fire
[ ! -e "$OUT/wrapper/fire-open" ] || fail "killed: a completed fire closes its marker"
: >"$OUT/wrapper/fire-open"
fire
# fire-open is FORENSICS ONLY now: it records that the previous fire never
# reached end_fire, and it neither owes an alarm nor blocks this fire.
[ "$(d .previousFireUnclosed)" = true ] && [ "$(d .stepped)" = true ] && [ "$WAKE" = false ] \
  || fail "killed: the next fire records the unclosed marker and steps: $OUTPUT"
[ ! -e "$OUT/wrapper/fire-open" ] || fail "killed: the marker is closed again"
[ ! -e "$C/fake/enqueue.json" ] || [ "$(jq '.messages | length' "$C/fake/enqueue.json")" = 0 ] \
  || fail "killed: no wrapper post: $(cat "$C/fake/enqueue.json")"
[ ! -e "$OUT/wrapper/pending-alarms" ] || fail "killed: there is no alarm ledger any more"

# --- Codex round-5 repros 1 and 3: unwritable and unreadable wrapper state ---------
# 1. An out-dir the fire cannot write used to lose the alarm silently. It is a
#    reported failure now.
new_case out-dir-unwritable
fire
chmod 500 "$OUT/wrapper"
: >"$FAKE_LOG"
fire
chmod 700 "$OUT/wrapper"
[ "$WAKE" = true ] && [ "$(d .failure)" = out-dir-refused ] \
  || fail "out-dir-unwritable: an unwritable wrapper dir reports: $OUTPUT"
calls '[.[] | select(.tool=="gate" and .op=="poll")] | length == 0' | grep -qx true \
  || fail "out-dir-unwritable: it must not poll: $(cat "$FAKE_LOG")"
# 3. An unreadable wrapper directory must never read as "nothing there".
new_case alarms-unreadable
fire
mkdir -p "$OUT/wrapper/alarms"
chmod 000 "$OUT/wrapper/alarms"
: >"$FAKE_LOG"
fire
chmod 755 "$OUT/wrapper/alarms"
[ "$WAKE" = true ] && [ "$(d .failure)" = fire-failed ] \
  || fail "alarms-unreadable: an unreadable alarm queue fails closed, never empty: $OUTPUT"

# --- Codex round-5 repro 4: nothing outside the out-dir is ever unlinked -----------
# Every directory the fire deletes from is reached through the containment
# walk, so a swapped/symlinked directory cannot carry the delete out.
new_case symlink-escape
fire
mkdir -p "$C/outside"
: >"$C/outside/victim.json"
: >"$C/outside/wrapper-error"
rm -rf "$OUT/wrapper/wakes" "$OUT/wrapper/alarms"
ln -s "$C/outside" "$OUT/wrapper/wakes"
ln -s "$C/outside" "$OUT/wrapper/alarms"
: >"$FAKE_LOG"
fire
[ -e "$C/outside/victim.json" ] && [ -e "$C/outside/wrapper-error" ] \
  || fail "symlink-escape: a file outside the out-dir was unlinked: $OUTPUT"
[ -L "$OUT/wrapper/wakes" ] && [ -L "$OUT/wrapper/alarms" ] || fail "symlink-escape: the symlinks themselves stand"
grep -q "pending-alarms" "$SCRIPT_DIR/smoke-controller-live-worker.py" \
  && fail "the pending-alarm ledger must be gone" || true
# The primitive itself, directly: a symlinked directory component refuses both
# the delete and the listing; it never deletes through and never reads empty.
PYTHONDONTWRITEBYTECODE=1 python3 - "$SCRIPT_DIR/smoke-campaign-controller.py" "$C" <<'PY' || fail "containment primitives (see above)"
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("ctl", sys.argv[1])
ctl = importlib.util.module_from_spec(spec); spec.loader.exec_module(ctl)
root, outside = os.path.join(sys.argv[2], "root"), os.path.join(sys.argv[2], "elsewhere")
os.makedirs(os.path.join(root, "real"), exist_ok=True); os.makedirs(outside, exist_ok=True)
open(os.path.join(outside, "victim"), "w").close()
open(os.path.join(root, "real", "mine"), "w").close()
link = os.path.join(root, "linked")
os.path.lexists(link) or os.symlink(outside, link)
errs = []
ctl.unlink_contained(root, ["linked", "victim"])
if not os.path.exists(os.path.join(outside, "victim")):
    errs.append("unlink_contained deleted through a symlinked directory")
if not ctl.unlink_contained(root, ["real", "mine"]):
    errs.append("unlink_contained did not remove its own file")
try:
    ctl.listdir_contained(root, ["linked"])
    errs.append("listdir_contained listed through a symlinked directory")
except ctl.ControllerError:
    pass
if ctl.listdir_contained(root, ["absent"]) != []:
    errs.append("an absent directory must list as empty")
# Round 6: an ancestor nobody can traverse is NOT absence. `lexists` says
# false for both, so answering [] here would drop the live alarm queue.
os.makedirs(os.path.join(root, "shut", "alarms"), exist_ok=True)
open(os.path.join(root, "shut", "alarms", "owed.json"), "w").close()
os.chmod(os.path.join(root, "shut"), 0o000)
try:
    got = ctl.listdir_contained(root, ["shut", "alarms"])
    errs.append("unreadable ancestry listed as {!r} instead of raising".format(got))
except ctl.ControllerError:
    pass
finally:
    os.chmod(os.path.join(root, "shut"), 0o755)
if ctl.listdir_contained(root, ["shut", "alarms"]) != ["owed.json"]:
    errs.append("a readable directory must list its entries")
# Round 6: the root itself is pinned by (st_dev, st_ino) at first use, so a
# root swapped for a symlink to somewhere else is refused, not followed.
outside2 = os.path.join(sys.argv[2], "elsewhere2")
os.makedirs(os.path.join(outside2, "real"), exist_ok=True)
open(os.path.join(outside2, "real", "mine"), "w").close()
swapped = os.path.join(sys.argv[2], "swapped")
os.makedirs(os.path.join(swapped, "real"), exist_ok=True)
open(os.path.join(swapped, "real", "mine"), "w").close()
ctl.listdir_contained(swapped, ["real"])          # pins this identity
os.rename(swapped, swapped + ".gone")             # ... and now it is a different directory
os.symlink(outside2, swapped)
for name, call in (("unlink_contained", lambda: ctl.unlink_contained(swapped, ["real", "mine"])),
                   ("listdir_contained", lambda: ctl.listdir_contained(swapped, ["real"]))):
    try:
        call()
    except ctl.ControllerError:
        continue
    if name == "unlink_contained" and os.path.exists(os.path.join(outside2, "real", "mine")):
        continue  # refused without raising is fine for a delete
    errs.append("{} followed a swapped root".format(name))
if not os.path.exists(os.path.join(outside2, "real", "mine")):
    errs.append("a swapped root carried a delete outside the pinned directory")
for e in errs:
    print("containment:", e)
sys.exit(1 if errs else 0)
PY

# --- structure: every worker exit is end_fire; only _emit leaves the process ------
python3 - "$SCRIPT_DIR/smoke-controller-live-worker.py" <<'PY' || fail "worker exit structure (see above)"
import ast, re, sys
tree = ast.parse(open(sys.argv[1]).read())
funcs = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
errs = []
def calls_in(node, name):
    return [c for c in ast.walk(node) if isinstance(c, ast.Call) and
            ((isinstance(c.func, ast.Name) and c.func.id == name) or
             (isinstance(c.func, ast.Attribute) and c.func.attr == name))]
# 1. The process leaves only through _emit (os._exit), nothing else exits.
for n in ast.walk(tree):
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("_exit", "exit"):
        owner = [f for f in funcs.values() if n in list(ast.walk(f))]
        if [f.name for f in owner] != ["_emit"]:
            errs.append("exit call outside _emit at line {}".format(n.lineno))
    if isinstance(n, ast.Raise) and isinstance(n.exc, ast.Call) and getattr(n.exc.func, "id", "") == "SystemExit":
        errs.append("raise SystemExit at line {}".format(n.lineno))
# 2. _emit is called only by end_fire.
for f in funcs.values():
    if f.name != "end_fire" and calls_in(f, "_emit"):
        errs.append("_emit called from {}".format(f.name))
if [c for c in calls_in(tree, "_emit") if not any(c in list(ast.walk(f)) for f in funcs.values())]:
    errs.append("_emit called at module level")
# 3. main() never returns early: its end is end_fire, not a return.
if [r for r in ast.walk(funcs["main"]) if isinstance(r, ast.Return)]:
    errs.append("main() has a return statement")
# 4. Exactly two non-failure ends, each named.
oks = [kw.value.value for c in calls_in(tree, "end_fire") for kw in c.keywords if kw.arg == "ok"]
if sorted(oks) != ["not-live", "stepped"]:
    errs.append("non-failure ends are {}, want not-live + stepped".format(oks))
# 5. There is no alarm ledger and no wrapper-side send: the wake IS the report.
src = open(sys.argv[1]).read()
for banned in ("pending-alarms", "alarm_owed", "alarm_settle", "alarm_pending", "_wrapper_alarm", "FAIL_TEXT"):
    if banned in src:
        errs.append("the deleted alarm ledger is back: {}".format(banned))
if "ENQUEUE.split()" in src:  # the controller is handed --enqueue-cmd; the wrapper never runs it
    errs.append("the wrapper runs the enqueue-send CLI itself")
# 6. Every fail-closed end carries a stable cause slug, and the two named
#    non-failure ends carry none.
for c in calls_in(tree, "end_fire"):
    kw = {k.arg: k.value for k in c.keywords}
    if "ok" in kw:
        if "failure" in kw:
            errs.append("a non-failure end names a failure at line {}".format(c.lineno))
        continue
    if "failure" not in kw or not isinstance(kw["failure"], ast.Constant) or not kw["failure"].value:
        errs.append("fail-closed end without a stable failure slug at line {}".format(c.lineno))
        continue
    # The owner posts the alarm under this slug, so every slug must be a legal
    # enqueue-send id/fingerprint/thread-key (cli/enqueue-send.ts:66-68,
    # mcp-tools/core.ts THREAD_KEY_PATTERN). Those classes also allow `_`; the
    # narrower spelling below is house style, and what it really buys is
    # keeping a space, a slash or a `#` out of an id the owner pastes.
    slug = kw["failure"].value
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,60}$", slug):
        errs.append("failure slug {!r} is not a legal send id/fingerprint".format(slug))
# 6b. No end_fire call site may pass a field the report owns -- `data.alarm` in
#     particular is the owner's routing payload, and a string there makes the
#     prescribed send impossible (round 7: journal_fail_closed passed
#     "alarm": "controller_journal_error" and _emit's update() replaced it).
RESERVED = {"failure", "detail", "note", "alarm", "outDir"}
for c in calls_in(tree, "end_fire"):
    arg = c.args[0] if c.args else None
    if isinstance(arg, ast.Dict):
        taken = sorted(k.value for k in arg.keys if isinstance(k, ast.Constant) and k.value in RESERVED)
        if taken:
            errs.append("end_fire at line {} passes report-owned field(s) {}".format(c.lineno, taken))
# 7. end_fire sets failure/detail/fire (fire is on the summary from the start).
body = ast.unparse(funcs["end_fire"])
for key in ("failure", "detail", "note"):
    if "'{}'".format(key) not in body:
        errs.append("end_fire does not set {}".format(key))
# 8. NOTHING is deleted through a path a symlinked directory could redirect
#    (round 5, finding 4): every delete goes through ctl.unlink_contained.
for n in ast.walk(tree):
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("unlink", "rmdir", "remove") \
            and isinstance(n.func.value, ast.Name) and n.func.value.id == "os":
        errs.append("uncontained os.{} at line {}".format(n.func.attr, n.lineno))
# 9. Anything uncaught still ends through end_fire.
if not any(isinstance(n, ast.Assign) and any(ast.unparse(t) == "sys.excepthook" for t in n.targets)
           for n in tree.body):
    errs.append("no sys.excepthook")
for e in errs:
    print("worker structure:", e)
sys.exit(1 if errs else 0)
PY

# --- structure: only final() writes to the runner's stdout -------------------------
[ "$(grep -c '>&3' "$W")" = "$(sed -n '/^final() {/,/^}/p' "$W" | grep -c '>&3')" ] \
  || fail "every fd-3 write must be inside final()"
[ "$(sed -n '/^final() {/,/^}/p' "$W" | grep -c '>&3')" = 3 ] \
  || fail "final() writes fd 3 in exactly three places: the jq render and its two fail_json fallbacks"
grep -q "exec 3>&1 1>&2" "$W" || fail "stdout must be moved to fd 3 before anything runs"
# Renderings of a true wake ({wakeAgent:true ...} in jq, "wakeAgent":true in
# fail_json's printf), comments excluded: all of them live in final() or in
# fail_json, which only final() calls.
renders() { grep -v '^[[:space:]]*#' | grep -c 'wakeAgent"\?:true'; }
[ "$(renders <"$W")" = "$(sed -n '/^final() {/,/^}/p;/^fail_json() {/,/^}/p' "$W" | renders)" ] \
  || fail "every wakeAgent:true rendering must be inside final() or fail_json"
[ "$(grep -c 'fail_json ' "$W")" = 3 ] \
  && [ "$(sed -n '/^final() {/,/^}/p' "$W" | grep -c 'fail_json ')" = 2 ] \
  || fail "fail_json is called twice inside final() and once in the empty-output branch, nowhere else"
# The two places a failure line can be rendered must render the SAME text: the
# owner posts one id per cause per day and enqueue-send refuses that id with a
# different payload, so drift between them would silently become a mismatch.
python3 - "$W" "$SCRIPT_DIR/smoke-controller-live-worker.py" <<'PY' || fail "alarm text drift (see above)"
import re, sys
sh, py = (open(p).read() for p in sys.argv[1:3])
def sh_var(name):
    return re.search(r'^%s="(.*)"$' % name, sh, re.M).group(1)
def py_const(name):
    m = re.search(r'^%s = \(?(".*?")\)?\n(?=[A-Z_]|\n|def )' % name, py, re.M | re.S)
    return "".join(re.findall(r'"([^"]*)"', m.group(1)))
errs = []
if sh_var("NOTE") != py_const("REPEAT_NOTE"):
    errs.append("NOTE differs from the worker's REPEAT_NOTE")
if sh_var("ALARM_TEXT") != py_const("ALARM_TEXT"):
    errs.append("ALARM_TEXT differs from the worker's ALARM_TEXT")
for e in errs:
    print("alarm text:", e)
sys.exit(1 if errs else 0)
PY

# --- the supervisor's OWN failure paths wake too, and never silently false ---------
# (the hung-worker case above is the timeout half: rc 124 -> fire-killed.)
new_case supervisor-empty
fire SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS=6 PYTHONHOME=/nonexistent   # the interpreter never starts
[ "$WAKE" = true ] && [ "$(d .failure)" = worker-no-output ] && [ "$(d .note)" != null ] \
  || fail "a worker that printed nothing is reported, not a silent false: $OUTPUT"
new_case supervisor-garbage
mkdir -p "$C/shim"
printf '#!/usr/bin/env bash\necho "not json at all"\n' >"$C/shim/python3"
chmod +x "$C/shim/python3"
fire SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS=6 PATH="$C/shim:$PATH"
[ "$WAKE" = true ] && [ "$(d .failure)" = worker-output-invalid ] \
  || fail "a worker line that is not JSON is reported, not a silent false: $OUTPUT"
alarm_selfcontained supervisor-garbage worker-output-invalid
# Round 6: without jq the line is built by bash alone, and STILL carries fire,
# note and the whole alarm -- the owner cannot build the daily id without the
# fire, and enqueue-send rejects an empty one (cli/enqueue-send.ts:157).
new_case supervisor-nojq
mkdir -p "$C/shim"
printf '#!/usr/bin/env bash\nexit 127\n' >"$C/shim/jq"
chmod +x "$C/shim/jq"
fire SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS=6 PATH="$C/shim:$PATH" PYTHONHOME=/nonexistent
[ "$WAKE" = true ] && [ "$(d .failure)" = worker-no-output ] \
  || fail "no jq: the supervisor still names the real cause: $OUTPUT"
[ -n "$(d .fire)" ] && [ "$(d .fire)" != null ] && [ "$(d .note)" != null ] \
  || fail "no jq: the line must still carry fire and note: $OUTPUT"
alarm_selfcontained supervisor-nojq worker-no-output
[ "$(d .alarm.to)" = null ] || fail "no destination in the process env: alarm.to is null, not invented: $OUTPUT"
# Round 7: a destination is operator-supplied configuration. Without jq the
# line is built by printf, so every interpolated value has to be escaped or the
# one hard guarantee -- a final line that parses -- is gone. `fire` already
# checked that the output is one line of well-formed JSON; this pins the value
# through it unchanged.
WEIRD='QA "Campaign" \ tab	end
next'
fire SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS=6 PATH="$C/shim:$PATH" PYTHONHOME=/nonexistent \
  SMOKE_CONTROLLER_SEND_TO="$WEIRD"
[ "$(d .alarm.to)" = "$WEIRD" ] \
  || fail "no jq: a destination with a quote, a backslash, a tab and a newline must survive verbatim: $OUTPUT"
[ "$(d .failure)" = worker-no-output ] || fail "no jq: the cause survives the escaping too: $OUTPUT"
# Round 7: the WORKER's own cause must survive a missing jq. Here the worker
# runs and fails closed for a real reason (no destination configured), and only
# jq is gone -- the line must still say `misconfigured`.
new_case worker-cause-nojq
write_env live skip-send-to
mkdir -p "$C/shim"
printf '#!/usr/bin/env bash\nexit 127\n' >"$C/shim/jq"
chmod +x "$C/shim/jq"
fire PATH="$C/shim:$PATH"
[ "$WAKE" = true ] && [ "$(d .failure)" = misconfigured ] \
  || fail "no jq: the worker's own cause must not be replaced by worker-output-invalid: $OUTPUT"
d .detail | grep -q "misconfigured" || fail "no jq: the detail names the recovered cause: $OUTPUT"
alarm_selfcontained worker-cause-nojq misconfigured
# ... and when the operator exports the destination on the task's script line,
# even a failure that never read the env file can address its alarm.
fire SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS=6 PATH="$C/shim:$PATH" PYTHONHOME=/nonexistent \
  SMOKE_CONTROLLER_SEND_TO=campaign-room
[ "$(d .alarm.to)" = campaign-room ] || fail "no jq: the destination from the task env reaches the wake: $OUTPUT"
# The same, for a worker failure whose cause IS the env file.
new_case env-unreadable
rm -f "$C/env.sh"; mkfifo "$C/env.sh"
fire SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS=6 SMOKE_CONTROLLER_SEND_TO=campaign-room
[ "$WAKE" = true ] && [ "$(d .alarm.to)" = campaign-room ] \
  || fail "a fire hung on the env file still reports somewhere to post: $OUTPUT"

echo "smoke controller live wrapper tests passed"
