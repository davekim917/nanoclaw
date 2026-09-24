#!/usr/bin/env bash
# Tests for smoke-campaign-controller.py (shadow mode; live mode is in
# smoke-campaign-controller-live.test.sh).
#
# Covers the spec's fault injections (CONTROLLER-SPEC rev 3 s3): kill between
# gate claim and the journal write, between intent and enqueue, between
# enqueue and the delivery receipt, between `ncl tasks create` and its record
# (ambiguous dispatch), a GitHub write with an unknown outcome, exhausted sends
# (failed_terminal -> BLOCKED only), stale synthesis (-> BLOCKED), and a
# missing / torn journal (-> hard error, never "empty"). Plus the shadow hard
# property: no external command runs and nothing outside --out-dir changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTL="$SCRIPT_DIR/smoke-campaign-controller.py"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

unset SMOKE_CONTROLLER_MODE SMOKE_CONTROLLER_CRASH_AT SMOKE_CONTROLLER_SHADOW_DIR \
  SMOKE_GATE_STATE_DIR SMOKE_GATE_RUN_ROOT || true
export SMOKE_GATE_LEASE_DIR="$T/leases"
mkdir -p "$SMOKE_GATE_LEASE_DIR"

# Every command a live controller would use for an effect, shimmed to leave a
# trace. Shadow must never reach any of them.
SHIM="$T/shim"
mkdir -p "$SHIM"
for cmd in gh ncl git curl sqlite3 bun node; do
  cat >"$SHIM/$cmd" <<SH
#!/usr/bin/env bash
echo "$cmd \$*" >>"$T/effects.log"
exit 97
SH
  chmod +x "$SHIM/$cmd"
done
export PATH="$SHIM:$PATH"

fail() { echo "FAIL: $*" >&2; exit 1; }

SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHA2=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PR=7
RUN=xzo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z

key() { python3 -c 'import hashlib,sys; print(hashlib.sha256("|".join(sys.argv[1:]).encode()).hexdigest())' "$@"; }

# --- per-case fixture -------------------------------------------------------

new_case() {
  C="$T/$1"
  mkdir -p "$C/state" "$C/runs" "$C/out"
  R="$C/runs/$RUN"
  printf '{"%s":"%s"}\n' "$PR" "$SHA" >"$C/heads.json"
  printf '[]\n' >"$C/tasks.json"
  printf '{}\n' >"$C/receipts.json"
  python3 "$CTL" init --shadow --out-dir "$C/out" --gate-state-dir "$C/state" >/dev/null
}

claim() { # [deadline]
  local deadline="${1:-2026-09-18T11:30:00Z}"
  jq -cn --arg run "$RUN" --arg sha "$SHA" --arg dl "$deadline" --argjson pr "$PR" \
    '{schemaVersion:1,pr:$pr,activeRunId:$run,activeSha:$sha,challengerDeadline:$dl,challengerDisposition:null}' \
    >"$C/state/pr-$PR-state.json"
}

wake_json() {
  jq -cn --arg run "$RUN" --arg sha "$SHA" --argjson pr "$PR" \
    '{wakeAgent:true,data:{trigger:"pr_build_settled",runId:$run,pr:$pr,sourceSha:$sha,isFreezePr:true}}' \
    >"$C/wake.json"
}

contract() {
  mkdir -p "$R/markers" "$R/evidence" "$R/coordinator" "$R/challenger"
  jq -cn --arg run "$RUN" --arg sha "$SHA" --argjson pr "$PR" '{
    schemaVersion:2, runId:$run, pr:$pr, repoSlug:"acme/app", sourceSha:$sha,
    ownershipKind:"pr", coordinatorOwnerToken:"owner-test",
    requiredLaneMarkers:["markers/A1.json","markers/B1.json"],
    lanes:[{id:"A1",kind:"lane",generation:1},{id:"B1",kind:"lane",generation:2}]}' \
    >"$R/completion-contract.json"
}

marker() { # lane gen status [confirmedFindings-json]
  printf 'shot\n' >"$R/evidence/$1.png"
  jq -cn --arg lane "$1" --argjson gen "$2" --arg st "$3" --arg sha "$SHA" --argjson cf "${4:-null}" '
    {schemaVersion:1,lane:$lane,sourceSha:$sha,generation:$gen,status:$st,
     completedAt:"2026-09-18T10:15:00Z",evidence:["evidence/\($lane).png"]}
    + (if $cf == null then {} else {confirmedFindings:$cf,
         evidence:(["evidence/\($lane).png"] + [$cf[] | "clip-skipped: \(.): no recorder in test"])} end)' \
    >"$R/markers/$1.json"
}

lanes_pass() { marker A1 1 pass; marker B1 2 pass; }

parent_conclusions() { # [challenger-disposition] [dissent-ids-json]
  printf 'prelim\n' >"$R/coordinator/preliminary.md"
  printf 'disposition\n' >"$R/challenger/disposition.md"
  jq -cn --arg d "${1:-CLEAR}" --argjson ids "${2:-null}" \
    '{schemaVersion:1,lane:"challenger",status:"completed",disposition:$d}
     + (if $ids == null then {} else {dissents:$ids} end)' \
    >"$R/challenger/challenge.complete.json"
  printf '{"label":"end","verdict":"ok"}\n' >"$R/coordinator/identity-checks.ndjson"
}

synthesis() { # verdict [jq-merge]
  jq -cn --arg run "$RUN" --arg sha "$SHA" --arg v "$1" \
    '{schemaVersion:1,runId:$run,sourceSha:$sha,verdict:$v,laneGenerations:{A1:1,B1:2},findings:[],gaps:[],dissents:[]}' \
    | jq -c "${2:-.}" >"$R/synthesis.json"
}

ready_run() { claim; contract; lanes_pass; parent_conclusions "${1:-CLEAR}"; }

STEP_OUT=""
STEP_RC=0
step() { # now [extra args...]
  local now="$1"; shift
  set +e
  STEP_OUT="$(python3 "$CTL" step --shadow --out-dir "$C/out" --gate-state-dir "$C/state" \
    --run-root "$C/runs" --pr-heads-json "$C/heads.json" --tasks-json "$C/tasks.json" \
    --receipts-json "$C/receipts.json" --now "$now" --lock-timeout 1 "$@" 2>"$C/stderr")"
  STEP_RC=$?
  set -e
}
# A step that could not take control.lock prints `skipped` and exits 0
# (smoke-campaign-controller.py:3922-3924), having judged nothing. step_ok
# refuses it, so a lock that is busy when it should not be names itself here
# instead of surfacing later as a missing decision (#1120).
step_ok() {
  step "$@"
  [ "$STEP_RC" = 0 ] || fail "step $1 exited $STEP_RC: $STEP_OUT $(cat "$C/stderr")"
  if jq -e 'has("skipped")' <<<"$STEP_OUT" >/dev/null 2>&1; then
    fail "step $1 was skipped, not run: $STEP_OUT"
  fi
}

jr() { jq -cs "$1" "$C/out/journal.ndjson"; }            # query the journal
dq() { jq -cs "$1" "$C/out/$RUN/decisions.ndjson"; }     # query the decisions
finish_verdict() { jr '[.[] | select(.kind=="gate" and .state=="done") | .detail.verdict] | last'; }
seed() { # kind slot state attempt [detail-json]
  jq -cn --arg run "$RUN" --arg kind "$1" --arg slot "$2" --arg st "$3" --argjson att "$4" \
    --arg key "$(key "$RUN" "$1" "$2")" --argjson detail "${5:-null}" \
    '{v:1,at:"2026-09-18T09:59:00Z",fire:"seed",runId:$run,kind:$kind,slot:$slot,key:$key,state:$st,attempt:$att}
     + (if $detail == null then {} else {detail:$detail} end)' >>"$C/out/journal.ndjson"
}
tree_sum() { (cd "$C" && find runs state -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum); }

# --- mode guards --------------------------------------------------------------

new_case modes
out="$(python3 "$CTL" step --out-dir "$C/out" --gate-state-dir "$C/state")"
echo "$out" | jq -e '.mode == "off" and .ok == true' >/dev/null || fail "default mode must be off: $out"
set +e
out="$(SMOKE_CONTROLLER_MODE=live python3 "$CTL" step --out-dir "$C/out" --gate-state-dir "$C/state")"; rc=$?
set -e
[ "$rc" = 3 ] || fail "SMOKE_CONTROLLER_MODE=live without its config must be refused (rc=$rc)"
echo "$out" | jq -e '.ok == false and (.error | contains("live mode needs"))' >/dev/null || fail "live refusal: $out"
set +e
out="$(SMOKE_CONTROLLER_MODE=bogus python3 "$CTL" step --out-dir "$C/out" --gate-state-dir "$C/state")"; rc=$?
set -e
[ "$rc" = 3 ] && echo "$out" | jq -e '.error | contains("off|shadow|live")' >/dev/null || fail "unknown mode: $out"
out="$(SMOKE_CONTROLLER_MODE=live python3 "$CTL" step --shadow --out-dir "$C/out" --gate-state-dir "$C/state" --run-root "$C/runs")"
echo "$out" | jq -e '.mode == "shadow"' >/dev/null || fail "--shadow must win over the env: $out"
out="$(SMOKE_CONTROLLER_MODE=shadow python3 "$CTL" step --out-dir "$C/out" --gate-state-dir "$C/state" --run-root "$C/runs")"
echo "$out" | jq -e '.mode == "shadow" and .wakeAgent == false' >/dev/null || fail "env shadow: $out"

# --- journal: missing / double init / torn / unparsable -> hard error ---------

C="$T/nojournal"; mkdir -p "$C/state" "$C/runs" "$C/out"; R="$C/runs/$RUN"
printf '{}\n' >"$C/heads.json"; printf '[]\n' >"$C/tasks.json"; printf '{}\n' >"$C/receipts.json"
claim
step 2026-09-18T10:00:00Z
[ "$STEP_RC" = 3 ] || fail "missing journal must be a hard error (rc=$STEP_RC)"
echo "$STEP_OUT" | jq -e '.ok == false and .alarm == "controller_journal_error" and (.error | contains("journal missing"))' \
  >/dev/null || fail "missing journal alarm: $STEP_OUT"
[ ! -e "$C/out/journal.ndjson" ] || fail "a missing journal must never be created as empty by step"
[ ! -e "$C/out/$RUN" ] || fail "no decisions may be written when the journal is missing"

new_case doubleinit
seed run claim enqueued 1
before="$(sha256sum "$C/out/journal.ndjson")"
set +e; out="$(python3 "$CTL" init --shadow --out-dir "$C/out" --gate-state-dir "$C/state")"; rc=$?; set -e
[ "$rc" = 3 ] || fail "second init must refuse (rc=$rc)"
[ "$(sha256sum "$C/out/journal.ndjson")" = "$before" ] || fail "init must never truncate an existing journal"

new_case torn
claim
seed run claim enqueued 1
printf '{"v":1,"runId":"%s","key":"k","state":"int' "$RUN" >>"$C/out/journal.ndjson"
before="$(sha256sum "$C/out/journal.ndjson")"
step 2026-09-18T10:00:00Z
[ "$STEP_RC" = 3 ] || fail "torn journal must be a hard error (rc=$STEP_RC)"
echo "$STEP_OUT" | jq -e '.error | contains("torn")' >/dev/null || fail "torn journal reason: $STEP_OUT"
[ "$(sha256sum "$C/out/journal.ndjson")" = "$before" ] || fail "a torn journal must be left untouched"

new_case garbage
claim
printf 'not json\n' >>"$C/out/journal.ndjson"
step 2026-09-18T10:00:00Z
[ "$STEP_RC" = 3 ] || fail "unparsable journal must be a hard error (rc=$STEP_RC)"
echo "$STEP_OUT" | jq -e '.error | contains("unparsable")' >/dev/null || fail "garbage journal reason: $STEP_OUT"

new_case badrecord
claim
printf '{"v":1,"runId":"x","key":"k","state":"sent"}\n' >>"$C/out/journal.ndjson"
step 2026-09-18T10:00:00Z
[ "$STEP_RC" = 3 ] || fail "a record with an unknown state must be a hard error (rc=$STEP_RC)"

# --- lock contention: skip, never block or act --------------------------------

new_case lock
claim
flock "$C/out/control.lock" sleep 4 &
LOCK_PID=$!
sleep 0.5
step 2026-09-18T10:00:00Z   # not step_ok: skipping is the expected outcome here
[ "$STEP_RC" = 0 ] || fail "a busy lock must exit 0: rc=$STEP_RC $STEP_OUT"
echo "$STEP_OUT" | jq -e '.skipped == "control.lock busy"' >/dev/null || fail "busy lock must skip: $STEP_OUT"
[ "$(wc -c <"$C/out/journal.ndjson")" = 0 ] || fail "a skipped fire must not write the journal"
kill "$LOCK_PID" 2>/dev/null || true
wait "$LOCK_PID" 2>/dev/null || true

# --- the happy path: claim -> ... -> finish GO -> freeze close ----------------

new_case happy
claim
wake_json
sum0="$(tree_sum)"
step_ok 2026-09-18T10:00:00Z --poll-json "$C/wake.json"
jr '[.[] | select(.kind=="run")] | length == 1 and .[0].detail.origin == "poll-wake" and .[0].detail.isFreezePr == true' \
  | grep -qx true || fail "the claim must be journaled from the poll wake: $(jr .)"
echo "$STEP_OUT" | jq -e '[.alarms[] | select(.trigger=="controller_orphan_claim")] | length == 0' >/dev/null \
  || fail "a wake-journaled claim is not an orphan: $STEP_OUT"
dq '[.[] | select(.type=="wake_owner" and .step=="intake")] | length == 1' | grep -qx true \
  || fail "no run dir yet: the owner intake step must be woken once: $(dq .)"

contract
step_ok 2026-09-18T10:10:00Z
dq '[.[] | select(.type=="send" and .slot=="root")] | length == 1' | grep -qx true || fail "root post due once the contract exists"
dq '[.[] | select(.type=="wake_owner" and .step=="lanes")] | length == 1' | grep -qx true || fail "lanes owner step"

lanes_pass
step_ok 2026-09-18T10:20:00Z
dq '[.[] | select(.type=="wake_owner" and .step=="preliminary")] | length == 1' | grep -qx true \
  || fail "lanes barrier ready -> preliminary owner step: $(dq '[.[] | select(.at=="2026-09-18T10:20:00Z")]')"

printf 'prelim\n' >"$R/coordinator/preliminary.md"
step_ok 2026-09-18T10:30:00Z
dq '[.[] | select(.at=="2026-09-18T10:30:00Z" and .type=="wait" and .phase=="await_challenger")] | length == 1' \
  | grep -qx true || fail "await challenger phase"

parent_conclusions CLEAR
step_ok 2026-09-18T10:40:00Z
dq '[.[] | select(.type=="wake_owner" and .step=="synthesis")] | length == 1' | grep -qx true || fail "synthesis owner step"

synthesis GO
step_ok 2026-09-18T10:50:00Z
[ "$(finish_verdict)" = '"GO"' ] || fail "a fully bound, fully dispositioned GO must finish GO: $(jr .)"
jr '[.[] | select(.kind=="gh" and .slot=="pr-comment" and .state=="done")] | length == 1' | grep -qx true || fail "pr comment"
jr '[.[] | select(.kind=="send" and .slot=="verdict" and .state=="done")] | length == 1' | grep -qx true || fail "verdict post"
jr '[.[] | select(.kind=="gh" and .slot=="freeze-close" and .state=="done")] | length == 1' | grep -qx true \
  || fail "a freeze PR's close is a post-finish obligation"
jr '[.[] | select(.kind=="owner" and .state=="intent")] as $i | [.[] | select(.kind=="owner" and .state=="done")] as $d
    | ($i | map(.slot) | unique) == ($d | map(.slot) | unique)' | grep -qx true || fail "every owner step closes"
# Order: pr comment and verdict post precede finish; finish precedes the close.
jr 'map(select(.state=="done")) | [.[] | "\(.kind):\(.slot)"] as $s
    | ($s | index("gh:pr-comment")) < ($s | index("gate:finish"))
      and ($s | index("send:verdict")) < ($s | index("gate:finish"))
      and ($s | index("gate:finish")) < ($s | index("gh:freeze-close"))' | grep -qx true \
  || fail "pre-finish obligations must be done before finish, and close after it"

# No obligation acted twice, every fire replayed twice adds nothing.
jr '[.[] | select(.state=="intent") | "\(.key)#\(.attempt // 1)"] | length == (unique | length)' | grep -qx true \
  || fail "duplicate intent for one key+attempt"
n_before="$(wc -l <"$C/out/journal.ndjson")"
step_ok 2026-09-18T10:50:00Z
step_ok 2026-09-18T11:00:00Z
[ "$(wc -l <"$C/out/journal.ndjson")" = "$n_before" ] || fail "re-running finished fires must add no journal record"
echo "$STEP_OUT" | jq -e '.effectsRefused == 0 and .runs == []' >/dev/null || fail "a finished run is idle: $STEP_OUT"

# Shadow hard property: nothing outside --out-dir changed, no effect command ran.
[ "$(tree_sum)" != "$sum0" ] || true   # (the test itself wrote run files; compare from here)
sum1="$(tree_sum)"
step_ok 2026-09-18T11:10:00Z
[ "$(tree_sum)" = "$sum1" ] || fail "a shadow step modified the run or gate state dir"
[ ! -e "$T/effects.log" ] || fail "shadow invoked an effect command: $(cat "$T/effects.log")"
# Every effect decision was refused by the one effect layer.
dq '[.[] | select(.effect != null) | .effect] | unique == ["shadow_refused"]' | grep -qx true \
  || fail "an effect decision was not shadow_refused: $(dq '[.[] | select(.effect != null)]')"

# Structural: exactly one subprocess call site (the allowlisted read-only
# barrier runner) and no network or DB client import anywhere in the file.
[ "$(grep -Ec 'subprocess\.(run|Popen|call|check_call|check_output|getoutput)\(' "$CTL")" = 1 ] \
  || fail "subprocess must be called from exactly one site (run_read_only)"
if grep -Eq 'os\.(system|popen|exec[lv]p?e?|spawn[lv]p?e?|posix_spawn)\(' "$CTL"; then
  fail "the controller must not start processes outside run_read_only"
fi
if grep -Eq '^\s*(import|from)\s+(socket|urllib|http|requests|sqlite3)' "$CTL"; then
  fail "the controller must not import a network or DB client"
fi
grep -q 'return {"outcome": "shadow_refused"}' "$CTL" || fail "the effect layer must refuse"
[ "$(grep -c 'class EffectLayer' "$CTL")" = 1 ] || fail "exactly one effect layer"

# --- kill between gate claim and the journal write -----------------------------

new_case claimcrash
claim
wake_json
set +e
SMOKE_CONTROLLER_CRASH_AT=before-run-record step 2026-09-18T10:00:00Z --poll-json "$C/wake.json"
set -e
[ "$STEP_RC" = 137 ] || fail "injected claim crash must kill the fire (rc=$STEP_RC)"
[ "$(wc -c <"$C/out/journal.ndjson")" = 0 ] || fail "nothing journaled before the crash point"
step_ok 2026-09-18T10:10:00Z
jr '[.[] | select(.kind=="run")] | length == 1 and .[0].detail.origin == "recovered"' | grep -qx true \
  || fail "the next fire must recover the claim from gate state: $(jr .)"
echo "$STEP_OUT" | jq -e '[.alarms[] | select(.trigger=="controller_orphan_claim" and .pr == 7)] | length == 1' \
  >/dev/null || fail "an unjournaled claim must raise controller_orphan_claim: $STEP_OUT"
step_ok 2026-09-18T10:20:00Z
jr '[.[] | select(.kind=="run")] | length == 1' | grep -qx true || fail "recovery must not duplicate the run record"

# --- kill between intent and enqueue / between enqueue and its record ----------

for point in after-intent after-effect; do
  new_case "sendcrash-$point"
  claim; contract
  seed run claim enqueued 1 '{"pr":7}'
  set +e
  SMOKE_CONTROLLER_CRASH_AT="$point:send:root" step 2026-09-18T10:10:00Z
  set -e
  [ "$STEP_RC" = 137 ] || fail "$point: injected crash (rc=$STEP_RC)"
  step_ok 2026-09-18T10:20:00Z
  k="$(key "$RUN" send root)"
  jr --arg k "$k" '[.[] | select(.key==$k and .state=="intent")] | length == 1' 2>/dev/null | grep -qx true \
    || jr "[.[] | select(.key==\"$k\" and .state==\"intent\")] | length == 1" | grep -qx true \
    || fail "$point: exactly one intent for the root send: $(jr .)"
  # The retry re-offers the SAME attempt id: the helper's ON CONFLICT(id) DO
  # NOTHING + read-back makes it a replay, not a second message.
  jq -r 'select(.type=="send" and .slot=="root") | .messageId' "$C/out/$RUN/decisions.ndjson" | sort -u >"$C/mids"
  [ "$(wc -l <"$C/mids")" = 1 ] && grep -qx "$k#1" "$C/mids" \
    || fail "$point: the re-offer must reuse $k#1, got $(cat "$C/mids")"
done

# --- kill between enqueued and the delivery receipt ----------------------------

new_case receipt
claim; contract
seed run claim enqueued 1 '{"pr":7}'
seed send root intent 1
seed send root enqueued 1
k="$(key "$RUN" send root)"
step_ok 2026-09-18T10:10:00Z
dq '[.[] | select(.type=="send" and .slot=="root")] | length == 0' | grep -qx true \
  || fail "an enqueued send with no receipt must wait, never re-send"
dq '[.[] | select(.type=="wait" and .reason=="awaiting delivery receipt")] | length == 1' | grep -qx true || fail "receipt wait"
jq -cn --arg id "$k#1" '{($id):"delivered"}' >"$C/receipts.json"
step_ok 2026-09-18T10:20:00Z
jr "[.[] | select(.key==\"$k\")] | last | .state == \"delivered\"" | grep -qx true || fail "delivered receipt"

# --- a definitive failed receipt advances the attempt --------------------------

new_case failedreceipt
claim; contract
seed run claim enqueued 1 '{"pr":7}'
seed send root intent 1
seed send root enqueued 1
k="$(key "$RUN" send root)"
jq -cn --arg id "$k#1" '{($id):"failed"}' >"$C/receipts.json"
step_ok 2026-09-18T10:10:00Z
jr "[.[] | select(.key==\"$k\") | \"\(.state)@\(.attempt)\"]" \
  | grep -q '"failed@1","intent@2","done@2"' || fail "failed@1 then attempt 2: $(jr "[.[] | select(.key==\"$k\")]")"
dq '[.[] | select(.type=="send" and .slot=="root") | .messageId] == ["'"$k"'#2"]' | grep -qx true \
  || fail "attempt 2 must use a new id (the failed id is terminal on the host)"

# --- exhausted sends -> failed_terminal -> BLOCKED only ------------------------

new_case exhausted
ready_run CLEAR
synthesis GO
seed run claim enqueued 1 '{"pr":7}'
k="$(key "$RUN" send verdict)"
for a in 1 2; do seed send verdict intent "$a"; seed send verdict enqueued "$a"; seed send verdict failed "$a"; done
seed send verdict intent 3
seed send verdict enqueued 3
jq -cn --arg id "$k#3" '{($id):"failed"}' >"$C/receipts.json"
step_ok 2026-09-18T10:50:00Z
jr "[.[] | select(.key==\"$k\")] | last | .state == \"failed_terminal\"" | grep -qx true || fail "attempt 3 failed -> terminal"
echo "$STEP_OUT" | jq -e '[.alarms[] | select(.trigger=="controller_send_failed")] | length == 1' >/dev/null \
  || fail "exhausted sends raise controller_send_failed: $STEP_OUT"
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "a failed_terminal pre-finish send permits only BLOCKED, got $(finish_verdict)"
dq '[.[] | select(.type=="finish") | .failedChecks[]] | any(contains("send:verdict is failed_terminal"))' \
  | grep -qx true || fail "the BLOCKED finish must name the exhausted send"
jr '[.[] | select(.kind=="send" and .slot=="verdict" and .state=="intent" and .attempt==4)] | length == 0' \
  | grep -qx true || fail "no 4th attempt"

# --- stale synthesis -> BLOCKED, naming the failed check ------------------------

expect_blocked() { # name jq-merge-for-synthesis expected-check-substring [setup-fn]
  new_case "stale-$1"
  ready_run CLEAR
  synthesis GO "$2"
  [ -z "${4:-}" ] || "$4"
  step_ok 2026-09-18T10:00:00Z
  step_ok 2026-09-18T10:10:00Z
  [ "$(finish_verdict)" = '"BLOCKED"' ] || fail "$1: expected BLOCKED, got $(finish_verdict)"
  dq '[.[] | select(.type=="finish") | .failedChecks[]]' | grep -q "$3" \
    || fail "$1: failed checks must name '$3': $(dq '[.[] | select(.type=="finish")]')"
}
expect_blocked sha ".sourceSha = \"$SHA2\"" "sourceSha binding"
expect_blocked runid '.runId = "xzo-pr-pr7-other"' "runId"
expect_blocked generation '.laneGenerations.B1 = 1' "evidence generation: lane B1"
head_moved() { printf '{"%s":"%s"}\n' "$PR" "$SHA2" >"$C/heads.json"; }
expect_blocked headmoved '.' "moved off the frozen sha" head_moved
no_head() { printf '{}\n' >"$C/heads.json"; }
expect_blocked nohead '.' "pr head unverified" no_head
expect_blocked schema '.schemaVersion = 0' "schemaVersion"
expect_blocked verdict '.verdict = "SHIP_IT"' "not a legal verdict"
# A stale binding blocks whatever the synthesis proposes, NO_GO included.
expect_blocked nogo-stale ".verdict = \"NO_GO\" | .sourceSha = \"$SHA2\"" "sourceSha binding"

# --- GO needs every gap, finding and dissent closed --------------------------

finding_lane() { marker B1 2 fail '["F1"]'; }
expect_blocked openfinding '.' "gap: lane B1 is fail" finding_lane
expect_blocked findingopen '.gaps = [{lane:"B1",disposition:"not-blocking:flaky preview"}]' "finding F1" finding_lane
expect_blocked refuted-missing \
  '.gaps = [{lane:"B1",disposition:"refuted:evidence/nope.png"}] | .findings = [{id:"F1",confirmed:true,disposition:"fixed-verified"}]' \
  "gap: lane B1" finding_lane
# The dissent inventory is the challenger's own (challenge.complete.json
# dissents[]); the synthesis' list is never taken as complete.
dissent() { parent_conclusions DISSENT '["D1"]'; }
dissent_two() { parent_conclusions DISSENT '["D1",{"id":"D2"}]'; }
dissent_noinv() { parent_conclusions DISSENT; }
dissent_badinv() { parent_conclusions DISSENT '["D1","D1"]'; }
expect_blocked dissent '.' "dissent D1 has no closed disposition" dissent
expect_blocked dissent-open '.dissents = [{id:"D1",disposition:"open"}]' "dissent D1" dissent
# Codex r1 #2: D1+D2 in the challenger, only D1 dispositioned -> BLOCKED on D2.
expect_blocked dissent-partial '.dissents = [{id:"D1",disposition:"refuted:evidence/A1.png"}]' \
  "dissent D2 has no closed disposition" dissent_two
expect_blocked dissent-noinventory '.dissents = [{id:"D1",disposition:"refuted:evidence/A1.png"}]' \
  "no dissent inventory" dissent_noinv
expect_blocked dissent-dupinventory '.dissents = [{id:"D1",disposition:"refuted:evidence/A1.png"}]' \
  "repeats id D1" dissent_badinv
no_complete() { rm -f "$R/challenger/challenge.complete.json"; }
expect_blocked nocomplete '.' "not machine-readable" no_complete
identity_bad() { printf '{"label":"end","verdict":"mismatch"}\n' >>"$R/coordinator/identity-checks.ndjson"; }
expect_blocked identity '.' "pair identity not ok" identity_bad
completed_lane() { marker A1 1 completed; }
expect_blocked completed '.' "gap: lane A1 is completed" completed_lane

expect_go() { # name jq-merge setup-fn
  new_case "go-$1"
  ready_run CLEAR
  synthesis GO "$2"
  [ -z "${3:-}" ] || "$3"
  step_ok 2026-09-18T10:00:00Z
  [ "$(finish_verdict)" = '"GO"' ] || fail "$1: expected GO, got $(finish_verdict): $(dq '[.[] | select(.type=="finish" or .type=="validate")]')"
}
expect_go closed-finding \
  '.gaps = [{lane:"B1",disposition:"refuted:evidence/B1.png"}] | .findings = [{id:"F1",confirmed:true,disposition:"not-blocking:cosmetic, tracked"}]' \
  finding_lane
expect_go dissent-closed '.dissents = [{id:"D1",disposition:"refuted:evidence/A1.png"}]' dissent
expect_go dissent-both-closed \
  '.dissents = [{id:"D1",disposition:"refuted:evidence/A1.png"},{id:"D2",disposition:"not-blocking:copy only"}]' dissent_two

# Non-GO verdicts pass through when bound: the owner's call stands.
new_case nogo
ready_run CLEAR
synthesis NO_GO
step_ok 2026-09-18T10:00:00Z
[ "$(finish_verdict)" = '"NO_GO"' ] || fail "a bound NO_GO finishes NO_GO, got $(finish_verdict)"

# A validated GO whose head moves before finish is superseded -> BLOCKED.
new_case superseded
ready_run CLEAR
synthesis GO
seed run claim enqueued 1 '{"pr":7}'
seed verdict validated done 1 '{"verdict":"GO","failedChecks":[]}'
head_moved
step_ok 2026-09-18T10:00:00Z
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "superseded GO must finish BLOCKED"
echo "$STEP_OUT" | jq -e '[.alarms[] | select(.trigger=="controller_verdict_superseded")] | length == 1' >/dev/null \
  || fail "superseded GO alarm: $STEP_OUT"

# --- ambiguous dispatch: never recreated, escalated, BLOCKED only ------------

new_case ambiguous
claim; contract
mkdir -p "$R/contact-sheet"
seed run claim enqueued 1 '{"pr":7}'
set +e
SMOKE_CONTROLLER_CRASH_AT=after-effect:dispatch:critic step 2026-09-18T10:00:00Z
set -e
[ "$STEP_RC" = 137 ] || fail "injected create crash (rc=$STEP_RC)"
step_ok 2026-09-18T10:10:00Z
echo "$STEP_OUT" | jq -e '[.alarms[] | select(.trigger=="controller_dispatch_ambiguous")] | length == 1' >/dev/null \
  || fail "an intent with no recorded task id is ambiguous: $STEP_OUT"
step_ok 2026-09-18T10:40:00Z
echo "$STEP_OUT" | jq -e '[.alarms[] | select(.trigger=="controller_dispatch_ambiguous")] | length == 0' >/dev/null \
  || fail "the ambiguity alarm is raised once, not every fire"
dq '[.[] | select(.type=="dispatch" and .slot=="critic")] | length == 1' | grep -qx true \
  || fail "an ambiguous dispatch must never be recreated: $(dq '[.[] | select(.slot=="critic")]')"
lanes_pass; parent_conclusions CLEAR; synthesis GO
step_ok 2026-09-18T10:50:00Z
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "an ambiguous dispatch permits only BLOCKED, got $(finish_verdict)"
dq '[.[] | select(.type=="finish") | .failedChecks[]] | any(contains("dispatch:critic is ambiguous"))' \
  | grep -qx true || fail "BLOCKED must name the ambiguous dispatch"

# ...but a task found by its ctl-<key8> slug reconciles instead.
new_case reconciled
claim; contract
mkdir -p "$R/contact-sheet"
seed run claim enqueued 1 '{"pr":7}'
k8="$(key "$RUN" dispatch critic | cut -c1-8)"
seed dispatch critic intent 1 "{\"slug\":\"ctl-$k8\"}"
jq -cn --arg n "ctl-$k8-3f9a" '[{id:"task-1",name:$n,status:"pending"}]' >"$C/tasks.json"
step_ok 2026-09-18T10:10:00Z
jr "[.[] | select(.kind==\"dispatch\")] | last | .state == \"enqueued\" and .detail.taskId == \"task-1\"" | grep -qx true \
  || fail "a live task with the obligation's slug reconciles the intent: $(jr '[.[] | select(.kind=="dispatch")]')"

# The critic's artifact settles the dispatch; the root waits for it (bounded).
new_case critic
claim; contract
mkdir -p "$R/contact-sheet"
printf 'png\n' >"$R/contact-sheet/sheet.png"
seed run claim enqueued 1 '{"pr":7}'
step_ok 2026-09-18T10:00:00Z
dq '[.[] | select(.type=="send")] | length == 0' | grep -qx true || fail "the root waits for the critic"
printf '{"screens":[]}\n' >"$R/contact-sheet/critic.json"
step_ok 2026-09-18T10:10:00Z
dq '[.[] | select(.type=="send") | .slot]' | grep -qx '\["root","root-sheet"\]' \
  || fail "root then sheet once the critic landed: $(dq '[.[] | select(.type=="send")]') (last step: $STEP_OUT)"

new_case criticlate
claim; contract
mkdir -p "$R/contact-sheet"
seed run claim enqueued 1 '{"pr":7}'
step_ok 2026-09-18T10:00:00Z
step_ok 2026-09-18T10:30:00Z
dq '[.[] | select(.type=="send" and .slot=="root")] | length == 1' | grep -qx true \
  || fail "a critic that never answers must not stall the root post past the wait"
# Regression (found by the replay): the rootWithoutCritic record must not turn
# a shadow-assumed create into a false ambiguous dispatch, and re-running the
# same fire must journal nothing new.
before="$(wc -l <"$C/out/journal.ndjson")"
step_ok 2026-09-18T10:30:00Z
[ "$(wc -l <"$C/out/journal.ndjson")" = "$before" ] || fail "a repeated fire must be a journal no-op"
step_ok 2026-09-18T10:40:00Z
dq '[.[] | select(.reason=="controller_dispatch_ambiguous")] | length == 0' | grep -qx true \
  || fail "a shadow-assumed critic create is not an ambiguous dispatch: $(dq '[.[] | select(.slot=="critic")]')"

# --- GitHub write with an unknown outcome: reconcile, never blind retry ----

new_case ghcrash
ready_run CLEAR
synthesis NO_GO
seed run claim enqueued 1 '{"pr":7}'
set +e
SMOKE_CONTROLLER_CRASH_AT=after-effect:gh:pr-comment step 2026-09-18T10:00:00Z
set -e
[ "$STEP_RC" = 137 ] || fail "injected gh crash (rc=$STEP_RC)"
step_ok 2026-09-18T10:10:00Z
dq '[.[] | select(.type=="gh_reconcile" and .slot=="pr-comment")] | length == 1' | grep -qx true || fail "reconcile first"
dq '[.[] | select(.type=="gh" and .slot=="pr-comment")] | map(.afterReconcile) == [false, true]' | grep -qx true \
  || fail "the second offer is a marker search, not a second write: $(dq '[.[] | select(.slot=="pr-comment")]')"
k="$(key "$RUN" gh pr-comment)"
jr "[.[] | select(.key==\"$k\" and .state==\"intent\")] | length == 1" | grep -qx true || fail "one gh intent"
[ "$(finish_verdict)" = '"NO_GO"' ] || fail "gh reconcile then finish"

# --- controller-send budget --------------------------------------------------

new_case budget
claim; contract
seed run claim enqueued 1 '{"pr":7}'
for i in $(seq 1 15); do seed send "x$i" done 1; done
step_ok 2026-09-18T10:00:00Z
echo "$STEP_OUT" | jq -e '[.alarms[] | select(.trigger=="controller_send_budget")] | length >= 1' >/dev/null \
  || fail "a 16th send in one run must be refused: $STEP_OUT"
dq '[.[] | select(.type=="send" and (.slot | startswith("alarm:") | not))] | length == 0' | grep -qx true \
  || fail "no ordinary send past the budget"
# ...but the refusal's own alarm is journaled and rides the separate alarm lane.
jr '[.[] | select(.kind=="send" and (.slot | startswith("alarm:send-budget:")))] | length >= 1' | grep -qx true \
  || fail "the budget refusal journals its alarm: $(jr '[.[] | select(.kind=="send") | .slot] | unique')"

# --- challenger timeout: the gate verb is the terminal verb ----------------

new_case timeout
claim 2026-09-18T10:30:00Z
contract
seed run claim enqueued 1 '{"pr":7}'
step_ok 2026-09-18T10:20:00Z
jr '[.[] | select(.kind=="gate")] | length == 0' | grep -qx true || fail "no timeout before the deadline"
step_ok 2026-09-18T10:40:00Z
jr '[.[] | select(.kind=="gate" and .state=="done") | .slot] == ["challenger-timeout"]' | grep -qx true \
  || fail "past the deadline with no disposition: challenger-timeout only, never a second finish: $(jr '[.[] | select(.kind=="gate")]')"
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "a challenger timeout is BLOCKED"
jr '[.[] | select(.kind=="send" and .slot=="verdict" and .state=="done")] | length == 1' | grep -qx true \
  || fail "the BLOCKED verdict is still posted before the terminal verb"

# --- a run that loses its slot without a verdict ---------------------------

new_case released
claim; contract
seed run claim enqueued 1 '{"pr":7}'
step_ok 2026-09-18T10:00:00Z
jq -cn --argjson pr "$PR" '{schemaVersion:1,pr:$pr,activeRunId:null}' >"$C/state/pr-$PR-state.json"
step_ok 2026-09-18T10:10:00Z
jr '[.[] | select(.state=="intent")] | map(.key) | unique | length' >"$C/open"
jr '[group_by(.key)[] | last | select(.state=="intent" or .state=="enqueued")] | length == 0' | grep -qx true \
  || fail "a released run abandons its open obligations: $(jr '[group_by(.key)[] | last]')"

# ...but an unreadable gate state is not evidence of release.
new_case unreadable
claim; contract
seed run claim enqueued 1 '{"pr":7}'
step_ok 2026-09-18T10:00:00Z
printf '{not json' >"$C/state/pr-$PR-state.json"
step_ok 2026-09-18T10:10:00Z
jr '[.[] | select(.state=="abandoned")] | length == 0' | grep -qx true || fail "unreadable gate state must not abandon"
dq '[.[] | select(.type=="escalate" and .reason=="gate state for this PR is unreadable")] | length == 1' \
  | grep -qx true || fail "unreadable gate state escalates"

# --- finished by someone else (legacy coordinator / gate) ------------------

new_case external
claim; contract
wake_json
step_ok 2026-09-18T10:00:00Z --poll-json "$C/wake.json"
step_ok 2026-09-18T10:10:00Z
mkdir -p "$C/state/runs/$RUN"
jq -cn --arg run "$RUN" --arg sha "$SHA" '{schemaVersion:1,sha:$sha,runId:$run,verdict:"NO_GO",finishedAt:"2026-09-18T10:15:00Z"}' \
  >"$C/state/runs/$RUN/verdict.json"
# verdict.json alone is a PARTIAL finish (the gate writes it before hold/ledger
# and slot cleanup, smoke-pr-gate.sh:4160-4176): never closed from it.
step_ok 2026-09-18T10:15:00Z
jr '[.[] | select(.kind=="run")] | last | .state != "done"' | grep -qx true \
  || fail "a partial gate finish (slot still held) must not close the run"
dq '[.[] | select(.reason=="gate finish partial: verdict.json written, slot still held")] | length >= 1' \
  | grep -qx true || fail "a partial gate finish waits"
jq -cn --argjson pr "$PR" --arg run "$RUN" \
  '{schemaVersion:1,pr:$pr,activeRunId:null,completedRunId:$run,completedVerdict:"NO_GO"}' >"$C/state/pr-$PR-state.json"
step_ok 2026-09-18T10:20:00Z
jr '[.[] | select(.kind=="run")] | last | .state == "done" and .detail.finishedBy == "gate"' | grep -qx true \
  || fail "an external finish closes the run"
jr '[.[] | select(.kind=="gate")] | length == 0' | grep -qx true || fail "no controller finish after an external one"
jr '[group_by(.key)[] | last | select(.kind=="owner" and .state=="intent")] | length == 0' | grep -qx true \
  || fail "owner steps are abandoned once the verdict exists"
jr '[.[] | select(.kind=="gh" and .slot=="freeze-close" and .state=="done")] | length == 1' | grep -qx true \
  || fail "the freeze PR is still closed after an external finish"

# --- an owner's early non-clearing verdict ends the run; an early GO never does

new_case earlyhd
claim; contract
marker A1 1 pass   # B1 never lands: the lanes barrier stays not-ready
seed run claim enqueued 1 '{"pr":7}'
synthesis HUMAN_DECISION
step_ok 2026-09-18T10:00:00Z
[ "$(finish_verdict)" = '"HUMAN_DECISION"' ] || fail "an early bound HUMAN_DECISION finishes as such, got $(finish_verdict)"

new_case earlystale
claim; contract
marker A1 1 pass
seed run claim enqueued 1 '{"pr":7}'
synthesis BLOCKED '.runId = "xzo-pr-pr7-aaaaaaaaaaaa-20260917T100000Z"'
step_ok 2026-09-18T10:00:00Z
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "an early stale synthesis still finishes only BLOCKED"
dq '[.[] | select(.type=="finish") | .failedChecks[]] | any(startswith("runId"))' | grep -qx true \
  || fail "the stale early synthesis names its failed binding"

new_case earlygo
claim; contract
marker A1 1 pass
seed run claim enqueued 1 '{"pr":7}'
synthesis GO
step_ok 2026-09-18T10:00:00Z
step_ok 2026-09-18T10:10:00Z
jr '[.[] | select(.kind=="gate")] | length == 0' | grep -qx true \
  || fail "an early GO must never short-cut the barriers: $(jr '[.[] | select(.kind=="gate")]')"

# --- a silent owner is escalated once as a coordination decision -----------

new_case ownerlate
claim; contract
seed run claim enqueued 1 '{"pr":7}'
step_ok 2026-09-18T10:00:00Z
step_ok 2026-09-18T11:10:00Z
step_ok 2026-09-18T11:20:00Z
dq '[.[] | select(.type=="escalate" and .reason=="owner step overdue")] | length == 1' | grep -qx true \
  || fail "an overdue owner step escalates exactly once: $(dq '[.[] | select(.type=="escalate")]')"

# --- path containment (Codex r1 #1) -------------------------------------------

# A `..` run id -- from a poll wake or from gate state -- is never a run: no
# journal record, and nothing is written at <out-dir>/.. .
new_case dotdot
claim
jq -cn '{wakeAgent:true,data:{trigger:"pr_build_settled",runId:"..",pr:7,sourceSha:"x"}}' >"$C/wake.json"
jq -cn '{schemaVersion:1,pr:8,activeRunId:"..",activeSha:"x"}' >"$C/state/pr-8-state.json"
jq -cn '{schemaVersion:1,pr:9,activeRunId:".hidden",activeSha:"x"}' >"$C/state/pr-9-state.json"
step_ok 2026-09-18T10:00:00Z --poll-json "$C/wake.json"
jr '[.[] | select(.runId == ".." or .runId == ".hidden")] | length == 0' | grep -qx true \
  || fail "a dot run id must never be journaled: $(jr .)"
[ ! -e "$C/decisions.ndjson" ] && [ ! -e "$C/out/../decisions.ndjson" ] && [ ! -e "$C/out/.hidden" ] \
  || fail "a dot run id escaped --out-dir"
python3 -B - "$CTL" <<'PY' || fail "RUN_ID_RE must refuse dot components"
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ctl", sys.argv[1]); m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert not any(m.RUN_ID_RE.match(x) for x in (".", "..", ".hidden", "../x", "a/b", ""))
assert m.RUN_ID_RE.match("xzo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z")
PY

# A symlinked decisions file is refused (O_NOFOLLOW), the fire fails closed,
# and the link's target is never created or written.
new_case symlinkdecisions
claim; contract
seed run claim enqueued 1 '{"pr":7}'
mkdir -p "$C/out/$RUN"
ln -s "$T/outside-decisions.ndjson" "$C/out/$RUN/decisions.ndjson"
step 2026-09-18T10:00:00Z
[ "$STEP_RC" = 3 ] || fail "a symlinked decisions file must fail the fire closed (rc=$STEP_RC): $STEP_OUT"
echo "$STEP_OUT" | jq -e '.ok == false and (.error | test("refusing controller file"))' >/dev/null \
  || fail "the refusal names the path: $STEP_OUT"
[ ! -e "$T/outside-decisions.ndjson" ] || fail "a decision was written through the symlink"

# A symlinked run decisions DIRECTORY is refused the same way.
new_case symlinkrundir
claim; contract
seed run claim enqueued 1 '{"pr":7}'
mkdir -p "$T/outside-dir"
ln -s "$T/outside-dir" "$C/out/$RUN"
step 2026-09-18T10:00:00Z
[ "$STEP_RC" = 3 ] || fail "a symlinked run dir must fail the fire closed (rc=$STEP_RC): $STEP_OUT"
[ -z "$(ls -A "$T/outside-dir")" ] || fail "a decision was written through the symlinked dir"

# --- GO waits on / refuses EVERY unreceipted pre-finish obligation (Codex r1 #3)

# A root post still awaiting its receipt holds GO; the receipt releases it.
new_case go-rootpending
ready_run CLEAR
seed run claim enqueued 1 '{"pr":7}'
seed send root intent 1
seed send root enqueued 1
synthesis GO
step_ok 2026-09-18T10:00:00Z
jr '[.[] | select(.kind=="gate")] | length == 0' | grep -qx true \
  || fail "GO must not finish while the root post awaits its receipt: $(jr '[.[] | select(.kind=="gate")]')"
dq '[.[] | select(.reason=="pre-finish obligations pending") | .pending[] | select(.[0]=="send" and .[1]=="root")] | length >= 1' \
  | grep -qx true || fail "the pending root send is named: $(dq '[.[] | select(.type=="wait")]')"
jq -cn --arg id "$(key "$RUN" send root)#1" '{($id):"delivered"}' >"$C/receipts.json"
step_ok 2026-09-18T10:10:00Z
[ "$(finish_verdict)" = '"GO"' ] || fail "once receipted, GO finishes: $(finish_verdict)"

# The reviewer's repro: a critic enqueued but never answered. Past the critic
# wait the root goes out, but GO waits on the critic, and once the critic is
# older than the owner SLA the GO is refused as BLOCKED naming it.
new_case go-criticpending
ready_run CLEAR
mkdir -p "$R/contact-sheet"
seed run claim enqueued 1 '{"pr":7}'
seed dispatch critic enqueued 1 '{"shadowAssumed":true,"taskId":null}'
synthesis GO
step_ok 2026-09-18T10:30:00Z
jr '[.[] | select(.kind=="gate")] | length == 0' | grep -qx true \
  || fail "an enqueued critic must hold GO: $(jr '[.[] | select(.kind=="gate")]')"
step_ok 2026-09-18T11:00:00Z
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "a critic unreceipted past the SLA refuses GO: $(finish_verdict)"
dq '[.[] | select(.type=="finish") | .failedChecks[]] | any(test("dispatch:critic is enqueued"))' | grep -qx true \
  || fail "the BLOCKED names the critic: $(dq '[.[] | select(.type=="finish")]')"
# Its output arriving in time instead lets the GO through.
new_case go-criticin
ready_run CLEAR
mkdir -p "$R/contact-sheet"
seed run claim enqueued 1 '{"pr":7}'
seed dispatch critic enqueued 1 '{"shadowAssumed":true,"taskId":null}'
printf '{"screens":[]}\n' >"$R/contact-sheet/critic.json"
synthesis GO
step_ok 2026-09-18T10:30:00Z
[ "$(finish_verdict)" = '"GO"' ] || fail "a critic whose output is in does not hold GO: $(finish_verdict)"

# --- post-finish obligations are journaled before the run is done (r1 #4) ---

new_case freezecrash
ready_run CLEAR
seed run claim enqueued 1 '{"pr":7,"isFreezePr":true}'
synthesis GO
set +e
SMOKE_CONTROLLER_CRASH_AT=after-run-done step 2026-09-18T10:00:00Z
set -e
[ "$STEP_RC" = 137 ] || fail "injected crash between run done and freeze close (rc=$STEP_RC)"
jr 'map("\(.kind):\(.slot):\(.state)") as $s | ($s | index("gh:freeze-close:intent")) < ($s | index("run:claim:done"))' \
  | grep -qx true || fail "the freeze close must be journaled before the run is done: $(jr 'map("\(.kind):\(.slot):\(.state)")')"
jr '[.[] | select(.kind=="gh" and .slot=="freeze-close" and .state=="done")] | length == 0' | grep -qx true \
  || fail "the crash lands before the close"
step_ok 2026-09-18T10:10:00Z
jr '[.[] | select(.kind=="gh" and .slot=="freeze-close" and .state=="done")] | length == 1' | grep -qx true \
  || fail "the next fire reconciles the open freeze close despite the run being done: $(jr .)"
dq '[.[] | select(.type=="gh" and .slot=="freeze-close")] | length == 1 and .[0].afterReconcile == true' | grep -qx true \
  || fail "the recovered close searches its marker first, never writes blind: $(dq '[.[] | select(.type=="gh")]')"
step_ok 2026-09-18T10:20:00Z
jr '[.[] | select(.kind=="gh" and .slot=="freeze-close" and .state=="done")] | length == 1' | grep -qx true \
  || fail "the close is done once"

# --- ruling on spec gap 3: challenger BLOCKED + synthesis overdue -> BLOCKED -

new_case synth-overdue-blocked
ready_run BLOCKED
seed run claim enqueued 1 '{"pr":7}'
step_ok 2026-09-18T10:00:00Z
dq '[.[] | select(.type=="wake_owner" and .step=="synthesis")] | length == 1' | grep -qx true || fail "synthesis owner step"
step_ok 2026-09-18T10:50:00Z
jr '[.[] | select(.kind=="gate")] | length == 0' | grep -qx true || fail "within the SLA the owner is waited on"
step_ok 2026-09-18T11:10:00Z
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "overdue synthesis after challenger BLOCKED finishes BLOCKED: $(finish_verdict)"
dq '[.[] | select(.type=="escalate")] | length == 0' | grep -qx true \
  || fail "this path needs no model: $(dq '[.[] | select(.type=="escalate")]')"
dq '[.[] | select(.type=="finish") | .failedChecks[]] | any(test("synthesis overdue"))' | grep -qx true \
  || fail "the finish names why"
# The same silence after a CLEAR challenger is NOT finished: a human decides.
new_case synth-overdue-clear
ready_run CLEAR
seed run claim enqueued 1 '{"pr":7}'
step_ok 2026-09-18T10:00:00Z
step_ok 2026-09-18T11:10:00Z
jr '[.[] | select(.kind=="gate")] | length == 0' | grep -qx true || fail "a CLEAR challenger never short-cuts to a verdict"
dq '[.[] | select(.type=="escalate" and .reason=="owner step overdue")] | length == 1' | grep -qx true \
  || fail "it escalates instead"

# --- round 2: hard links are refused (Codex r2 #1) ------------------------------

# A hard link passes O_NOFOLLOW and resolves under --out-dir, but shares its
# inode with a file outside: refused, the fire fails closed, the file is intact.
new_case hardlinkdecisions
claim; contract
seed run claim enqueued 1 '{"pr":7}'
mkdir -p "$C/out/$RUN"
printf 'outside\n' >"$T/outside-hardlink.ndjson"
ln "$T/outside-hardlink.ndjson" "$C/out/$RUN/decisions.ndjson"
step 2026-09-18T10:00:00Z
[ "$STEP_RC" = 3 ] || fail "a hard-linked decisions file must fail the fire closed (rc=$STEP_RC): $STEP_OUT"
echo "$STEP_OUT" | jq -e '.ok == false and (.error | test("hard links"))' >/dev/null || fail "names the hard link: $STEP_OUT"
[ "$(cat "$T/outside-hardlink.ndjson")" = "outside" ] || fail "the outside file was modified through a hard link"

new_case hardlinkjournal
claim
printf '' >"$T/outside-journal.ndjson"
rm "$C/out/journal.ndjson"
ln "$T/outside-journal.ndjson" "$C/out/journal.ndjson"
step 2026-09-18T10:00:00Z
[ "$STEP_RC" = 3 ] || fail "a hard-linked journal must be a hard error (rc=$STEP_RC): $STEP_OUT"
echo "$STEP_OUT" | jq -e '.alarm == "controller_journal_error"' >/dev/null || fail "journal alarm: $STEP_OUT"
[ ! -s "$T/outside-journal.ndjson" ] || fail "the outside journal was written through a hard link"

# --- round 2: a re-run of the SAME fire after an effect reconciles (Codex r2 #2)

# Crash AFTER the freeze-close effect, then re-run with the SAME fire id: the
# persisted intent is from a dead process, so the retry searches its marker
# (writeOnlyIfMarkerAbsent) instead of writing blind.
new_case samefire-freeze
ready_run CLEAR
seed run claim enqueued 1 '{"pr":7,"isFreezePr":true}'
synthesis GO
set +e
SMOKE_CONTROLLER_CRASH_AT=after-effect:gh:freeze-close step 2026-09-18T10:00:00Z
set -e
[ "$STEP_RC" = 137 ] || fail "injected crash after the freeze-close effect (rc=$STEP_RC)"
step_ok 2026-09-18T10:00:00Z
dq '[.[] | select(.type=="gh" and .slot=="freeze-close") | .afterReconcile] == [false, true]' | grep -qx true \
  || fail "same-fire retry after the effect must reconcile, not write blind: $(dq '[.[] | select(.type=="gh" and .slot=="freeze-close")]')"
jr '[.[] | select(.kind=="gh" and .slot=="freeze-close" and .state=="done")] | length == 1' | grep -qx true \
  || fail "the close is done exactly once"

# The same property for every other effect kind, each crashed after its effect
# and re-run with the same fire id.
new_case samefire-issue
ready_run CLEAR
marker B1 2 fail '["F1"]'
seed run claim enqueued 1 '{"pr":7}'
synthesis NO_GO
set +e
SMOKE_CONTROLLER_CRASH_AT=after-effect:gh:issue:F1 step 2026-09-18T10:00:00Z
set -e
[ "$STEP_RC" = 137 ] || fail "injected crash after the issue effect (rc=$STEP_RC)"
step_ok 2026-09-18T10:00:00Z
dq '[.[] | select(.type=="gh" and .slot=="issue:F1") | .afterReconcile] == [false, true]' | grep -qx true \
  || fail "same-fire issue retry must reconcile: $(dq '[.[] | select(.type=="gh")]')"
jr '[.[] | select(.kind=="gh" and .slot=="issue:F1" and .state=="done")] | length == 1' | grep -qx true \
  || fail "the issue is filed once"

new_case samefire-send
claim; contract
seed run claim enqueued 1 '{"pr":7}'
set +e
SMOKE_CONTROLLER_CRASH_AT=after-effect:send:root step 2026-09-18T10:10:00Z
set -e
[ "$STEP_RC" = 137 ] || fail "injected crash after the root send effect (rc=$STEP_RC)"
step_ok 2026-09-18T10:10:00Z
k="$(key "$RUN" send root)"
jq -r 'select(.type=="send" and .slot=="root") | .messageId' "$C/out/$RUN/decisions.ndjson" >"$C/mids"
[ "$(wc -l <"$C/mids")" = 2 ] && [ "$(sort -u "$C/mids")" = "$k#1" ] \
  || fail "the same-fire re-offer must reuse $k#1 (a helper replay), got $(cat "$C/mids")"
jr "[.[] | select(.key==\"$k\" and .state==\"intent\")] | length == 1" | grep -qx true \
  || fail "no second intent (attempt) for a same-fire retry"

new_case samefire-dispatch
claim; contract
mkdir -p "$R/contact-sheet"
seed run claim enqueued 1 '{"pr":7}'
set +e
SMOKE_CONTROLLER_CRASH_AT=after-effect:dispatch:critic step 2026-09-18T10:10:00Z
set -e
[ "$STEP_RC" = 137 ] || fail "injected crash after the dispatch effect (rc=$STEP_RC)"
step_ok 2026-09-18T10:10:00Z
dq '[.[] | select(.type=="dispatch")] | length == 1' | grep -qx true \
  || fail "a same-fire retry must never recreate the task: $(dq '[.[] | select(.type=="dispatch")]')"
dq '[.[] | select(.type=="escalate" and .reason=="controller_dispatch_ambiguous")] | length == 0' | grep -qx true \
  || fail "a same-fire retry cannot judge the intent: its task listing predates the create"
step_ok 2026-09-18T10:20:00Z
dq '[.[] | select(.type=="dispatch")] | length == 1' | grep -qx true \
  || fail "the next fire must never recreate the task either"
dq '[.[] | select(.type=="escalate" and .reason=="controller_dispatch_ambiguous")] | length >= 1' | grep -qx true \
  || fail "the bare intent is escalated as ambiguous once a later listing still lacks it"

[ ! -e "$T/effects.log" ] || fail "shadow invoked an effect command: $(cat "$T/effects.log")"
echo "smoke campaign controller tests passed"
