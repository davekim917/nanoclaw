#!/usr/bin/env bash
# Tests for smoke-controller-live.sh, the LIVE task-script wrapper: the final
# line contract (wakeAgent true ONLY for a due owner step, with {step, runId,
# brief}), the kill switch (not live = nothing runs), the cutover file written
# once before the first poll, the claimant the poll runs with, progress before
# poll, receipts read from the session's inbound.db, a hard budget, and poll
# failures that still step.
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
[ "$WAKE" = false ] && [ "$(d '.misconfigured[0]')" = SMOKE_CONTROLLER_SEND_TO ] || fail "live without a destination: $OUTPUT"
[ ! -s "$FAKE_LOG" ] || fail "a misconfigured live fire must call nothing"

new_case claimant-in-env
echo "export SMOKE_GATE_CLAIMANT=controller" >>"$C/env.sh"
fire
[ "$WAKE" = false ] && [ "$(d '.misconfigured[0]')" = SMOKE_GATE_CLAIMANT ] \
  || fail "a claimant in the shared env file would tag legacy gate calls: $OUTPUT"
[ ! -s "$FAKE_LOG" ] || fail "a claimant in the env file must call nothing"

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
  [ "$WAKE" = false ] && [ "$(d .alarm)" = controller_journal_error ] || fail "$variant journal: fails closed: $OUTPUT"
  calls '[.[] | select(.tool=="gate")] | length == 0' | grep -qx true \
    || fail "$variant journal: no progress stamp and no poll on an invalid journal: $(cat "$FAKE_LOG")"
  [ "$(jq '.messages | keys | map(select(startswith("ctl.journal-invalid."))) | length' "$C/fake/enqueue.json")" = 1 ] \
    || fail "$variant journal: one alarm post"
  fire
  [ "$(jq '.messages | length' "$C/fake/enqueue.json")" = 1 ] || fail "$variant journal: the alarm is not re-posted"
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
[ "$WAKE" = false ] && [ "$(d .skipped)" = "fire exceeded its budget and was killed" ] || fail "hung worker: $OUTPUT"
new_case budget
for b in 08 0 1e3 200; do
  write_env off
  fire SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS="$b"
  [ "$(d .budgetRejected)" = "$b" ] && [ "$(d .budgetSeconds)" = 100 ] || fail "budget $b must fall back to 100: $OUTPUT"
done
grep -q '^BUDGET_MAX=110$' "$W" && grep -q 'timeout -k 2 "\$BUDGET"' "$W" \
  || fail "hard kill must land by 110 + 2 s, under the runner's 120 s"

# --- structure: only final() writes to the runner's stdout -------------------------
[ "$(grep -c '>&3' "$W")" = 2 ] || fail "expected exactly final()'s two fd-3 writes"
[ "$(sed -n '/^final() {/,/^}/p' "$W" | grep -c '>&3')" = 2 ] || fail "every fd-3 write must be inside final()"
grep -q "exec 3>&1 1>&2" "$W" || fail "stdout must be moved to fd 3 before anything runs"
[ "$(grep -c 'wakeAgent:true' "$W")" = 1 ] && sed -n '/^final() {/,/^}/p' "$W" | grep -q 'wakeAgent:true' \
  || fail "wakeAgent:true is rendered in exactly one place, inside final()"

echo "smoke controller live wrapper tests passed"
