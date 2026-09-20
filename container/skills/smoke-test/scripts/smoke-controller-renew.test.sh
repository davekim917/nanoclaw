#!/usr/bin/env bash
# Tests for smoke-controller-renew.sh (the claim renewer for the live PR
# smoke-campaign controller).
#
# Two harnesses. The REAL-GATE arm drives smoke-pr-gate.sh with a shimmed
# clock, so the lease is the real lease and "still held after the TTL" is the
# gate's own answer, not a mock's. The STUB-GATE arm replaces the gate with a
# logger, so what the tick did and did not invoke is exact.
#
# Covers: the XZO #2024 regression (an owner step outliving the 900 s lease)
# and its control arm (no renewer -> the lease expires, which is the pre-fix
# behaviour and the renewer-killed degradation); a step that completes; an
# abandoned run; the ceiling; a withdrawn/absent ack; the kill switch; a torn
# journal tail (tolerated) vs a corrupt middle line (refuses the tick); the
# never-wake guarantee; "renewal and nothing else" (no claim/finish/release/
# poll, no write under the run root); the claimant the gate is called with;
# and the env-file rules.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so a reviewer can point the same suite at an older revision of
# the script and see which assertions the fix is carrying:
#   git show <sha>:container/skills/smoke-test/scripts/smoke-controller-renew.sh > /tmp/old.sh
#   SMOKE_RENEW_SCRIPT=/tmp/old.sh bash smoke-controller-renew.test.sh
R="${SMOKE_RENEW_SCRIPT:-$SCRIPT_DIR/smoke-controller-renew.sh}"
GATE="$SCRIPT_DIR/smoke-pr-gate.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

unset SMOKE_CONTROLLER_MODE SMOKE_CONTROLLER_OUT_DIR SMOKE_CONTROLLER_GATE_CMD SMOKE_CONTROLLER_ENV_FILE \
  SMOKE_GATE_RUN_ROOT SMOKE_GATE_STATE_DIR SMOKE_GATE_SHARED_ROOT SMOKE_GATE_LEASE_DIR \
  SMOKE_GATE_CLAIMANT SMOKE_CONTROLLER_RENEW_CEILING_SECONDS FAKE_CLOCK_OFFSET || true

# SMOKE_RENEW_TEST_CONTINUE=1 records failures instead of stopping at the
# first, so one run against an older revision shows every assertion the fix
# is carrying rather than only the earliest.
FAILURES=0
fail() {
  echo "FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
  [ -n "${SMOKE_RENEW_TEST_CONTINUE:-}" ] || exit 1
}
PASSES=0
ok() { PASSES=$((PASSES + 1)); }

# ── shims ────────────────────────────────────────────────────────────────────
SHIM="$T/shim"
mkdir -p "$SHIM"
# The workgroup mount the gate insists on (lease_dir_prepare).
cat >"$SHIM/mountpoint" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = "-q" ] && [ "${2:-}" = "${SMOKE_GATE_SHARED_ROOT:-}" ]
SH
# A movable clock. Only "now" shifts: anything with an explicit -d/-r is a
# conversion of a value that was already computed against the shifted now.
cat >"$SHIM/date" <<'SH'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in -d|--date=*|-r) exec /usr/bin/date "$@";; esac; done
exec /usr/bin/date -u -d "@$(( $(/usr/bin/date -u +%s) + ${FAKE_CLOCK_OFFSET:-0} ))" "$@"
SH
chmod +x "$SHIM/mountpoint" "$SHIM/date"
export PATH="$SHIM:$PATH"
export FAKE_CLOCK_OFFSET=0

RUN=demo-pr-pr7-aaaaaaaaaaaa-20260920T000000Z
PR=7
SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TOKEN=owner-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

iso() { /usr/bin/date -u -d "@$1" +'%Y-%m-%dT%H:%M:%SZ'; }

# ── fixture ──────────────────────────────────────────────────────────────────
# A run the controller claimed, plus a controller journal. Written directly
# rather than through `claim`, which needs gh: the schemas are the gate's own
# (smoke-pr-gate.sh:3287-3297 state, :534-537 lease, :325-336 authority).
new_case() { # <name>
  C="$T/$1"
  mkdir -p "$C/state" "$C/runs/$RUN/controller" "$C/wg/qa-coordinator/leases" "$C/out"
  export SMOKE_GATE_STATE_DIR="$C/state"
  export SMOKE_GATE_RUN_ROOT="$C/runs"
  export SMOKE_GATE_SHARED_ROOT="$C/wg"
  export SMOKE_GATE_LEASE_DIR="$C/wg/qa-coordinator/leases"
  export SMOKE_CONTROLLER_ENV_FILE="$C/env.sh"
  export SMOKE_CONTROLLER_OUT_DIR="$C/out"
  # In production this is the gate WRAPPER, which sources the env file and
  # execs the gate; here the gate is called directly and takes its own
  # SMOKE_GATE_* from the process env the test exports.
  export SMOKE_CONTROLLER_GATE_CMD="$GATE"
  JOURNAL="$C/out/journal.ndjson"
  : >"$JOURNAL"
  write_env live
  FAKE_CLOCK_OFFSET=0
}

write_env() { # <mode|""> [extra lines...]
  {
    [ -z "$1" ] || echo "export SMOKE_CONTROLLER_MODE='$1'"
    echo "export SMOKE_GATE_RUN_ROOT='$C/runs'"
    echo "export SMOKE_CONTROLLER_OUT_DIR='$C/out'"
    shift || true
    for line in "$@"; do echo "$line"; done
  } >"$C/env.sh"
}

claim_files() { # [epoch-of-claim]
  local at="${1:-$(/usr/bin/date -u +%s)}"
  jq -cn --argjson pr "$PR" --arg run "$RUN" --arg sha "$SHA" --arg owner "$TOKEN" --arg now "$(iso "$at")" \
    '{schemaVersion:1,pr:$pr,activeSha:$sha,activeStartedAt:$now,activeRunId:$run,activeProgressAt:$now,
      activeLeaseOwner:$owner,activeClaimant:"controller",challengerDeadline:"2099-01-01T00:00:00Z",
      challengerDisposition:null,finishIntent:null}' >"$C/state/pr-$PR-state.json"
  jq -cn --argjson pr "$PR" --arg owner "$TOKEN" --arg now "$(iso "$at")" --arg exp "$(iso $((at + 900)))" \
    '{schemaVersion:1,pr:$pr,owner:$owner,claimedAt:$now,renewedAt:$now,expiresAt:$exp}' \
    >"$C/wg/qa-coordinator/leases/lease-$RUN.json"
  jq -cn --argjson pr "$PR" --arg run "$RUN" --arg owner "$TOKEN" --arg now "$(iso "$at")" \
    '{schemaVersion:1,pr:$pr,runId:$run,owner:$owner,boundAt:$now}' \
    >"$C/wg/qa-coordinator/leases/pr-$PR-authority.json"
}

jrec() { # <kind> <slot> <state> <at-epoch> [detail-json]
  jq -cn --arg run "$RUN" --arg kind "$1" --arg slot "$2" --arg state "$3" --arg at "$(iso "$4")" \
    --argjson detail "${5:-null}" \
    '{at:$at,fire:$at,runId:$run,kind:$kind,slot:$slot,
      key:("k-" + $kind + "-" + $slot),state:$state,mode:"live",attempt:1,v:1}
     + (if $detail == null then {} else {detail:$detail} end)' >>"$JOURNAL"
}

ack()   { : >"$C/runs/$RUN/controller/brief-$1.ack"; }
unack() { rm -f "$C/runs/$RUN/controller/brief-$1.ack"; }

tick() { LAST="$(bash "$R" 2>>"$C/renew.err")"; }
field() { jq -r "$1" <<<"$LAST" 2>/dev/null; }

# `//` is the wrong operator for a boolean field: jq treats `false` as empty,
# so `.held // "?"` answers "?" for a lease that is legitimately not held.
lease_held() {
  SMOKE_GATE_CLAIMANT=controller bash "$GATE" lease-status "$RUN" "$TOKEN" 2>/dev/null |
    tail -n 1 | jq -r 'if has("held") then .held else "?" end'
}
progress_ok() {
  SMOKE_GATE_CLAIMANT=controller bash "$GATE" progress "$RUN" "$TOKEN" 2>/dev/null |
    tail -n 1 | jq -r 'if has("ok") then .ok else "?" end'
}
progress_at() { jq -r '.activeProgressAt // ""' "$C/state/pr-$PR-state.json"; }

# An owner step that started `age` seconds ago and is being worked right now.
in_flight_at() { # <started-epoch>
  jrec run claim enqueued "$1" '{"origin":"poll-wake","pr":7,"ownerToken":"'"$TOKEN"'"}'
  jrec owner lanes intent "$1"
  jrec owner lanes enqueued "$1" '{"brief":"controller/brief-lanes.md","outcome":"brief_written"}'
  ack lanes
}

# ═════════════════════════════════════════════════════════════════════════════
# 1. THE REGRESSION (XZO #2024) — an owner step longer than the lease TTL.
#    Control arm first: with no renewer this is exactly today's behaviour.
# ═════════════════════════════════════════════════════════════════════════════
echo "== 1. owner step outlives the 900s lease =="

new_case stranded-no-renewer
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
BEFORE_PROGRESS="$(progress_at)"
# 50 minutes of owner turn, the shape of PR #2022's lanes step. No renewer
# runs — the controller cannot fire during the turn and the owner may not
# stamp progress itself.
FAKE_CLOCK_OFFSET=3000
[ "$(lease_held)" = false ] || fail "control arm: the lease should have expired without a renewer"
ok
# This is the stranding: the coordinator's own `progress` is refused by the
# fence, so every scaffold write under that lease is refused too, and the run
# is left for a recovery poll to reclaim under a fresh token.
REFUSAL="$(SMOKE_GATE_CLAIMANT=controller bash "$GATE" progress "$RUN" "$TOKEN" 2>/dev/null | tail -n 1)"
[ "$(jq -r '.ok' <<<"$REFUSAL")" = false ] || fail "control arm: progress unexpectedly succeeded"
grep -q 'live shared coordinator lease does not belong to this lifecycle owner' <<<"$REFUSAL" ||
  fail "control arm: expected the lease fence refusal, got: $REFUSAL"
ok
# And nothing invented liveness on the way: the run is stale, not falsely alive.
[ "$(progress_at)" = "$BEFORE_PROGRESS" ] || fail "control arm: activeProgressAt moved with no renewer"
ok

new_case stranded-with-renewer
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
# The renewer's own series, ticking every 5 minutes regardless of the owner
# turn and the controller's cadence.
for OFFSET in 300 600 900 1200 1500 1800 2100 2400 2700 3000; do
  FAKE_CLOCK_OFFSET="$OFFSET"
  tick
  [ "$(field '.wakeAgent')" = false ] || fail "the renewer woke an agent at +$OFFSET"
  [ "$(field '.data.renewed | length')" = 1 ] || fail "no renewal at +$OFFSET: $LAST"
  [ "$(field '.data.renewed[0].step')" = lanes ] || fail "renewed the wrong step at +$OFFSET"
done
ok
[ "$(lease_held)" = true ] || fail "the lease should still be held after 50 minutes of ticks"
ok
[ "$(progress_ok)" = true ] || fail "the coordinator should still be able to stamp progress"
ok
# The liveness clock the next poll reads moved too — a lease kept live while
# activeProgressAt went stale is the reclaim-under-a-fresh-token wedge.
[ "$(progress_at)" != "$(iso "$START")" ] || fail "activeProgressAt never advanced"
ok

echo "== 2. the step completes normally: the renewer stops =="
new_case step-done
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
FAKE_CLOCK_OFFSET=300
tick
[ "$(field '.data.renewed | length')" = 1 ] || fail "expected one renewal while in flight"
jrec owner lanes done $((START + 400))
FAKE_CLOCK_OFFSET=600
tick
[ "$(field '.data.status')" = idle ] || fail "a finished step must leave nothing to renew: $LAST"
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed a finished step"
ok
# ...and the lease then lapses on its own, as it should.
FAKE_CLOCK_OFFSET=1500
tick
[ "$(lease_held)" = false ] || fail "the lease should lapse once the step is done"
ok

echo "== 3. the run is abandoned: the renewer stops =="
new_case abandoned
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
jrec owner lanes abandoned $((START + 100)) '{"reason":"run finished"}'
jrec run claim done $((START + 100)) '{"finishedBy":"gate","verdict":"BLOCKED"}'
FAKE_CLOCK_OFFSET=300
tick
[ "$(field '.data.status')" = idle ] || fail "an abandoned step must not be renewed: $LAST"
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed an abandoned run"
ok
# Even an owner obligation still `enqueued` gets nothing once the claim closed.
new_case abandoned-claim-only
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
jrec run claim done $((START + 100)) '{"finishedBy":"gate","verdict":"BLOCKED"}'
FAKE_CLOCK_OFFSET=300
tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed a run whose claim is done"
[ "$(field '.data.skipped[0].reason')" = "no open claim with an owner token for this run" ] ||
  fail "wrong reason for a closed claim: $LAST"
ok

echo "== 4. the ceiling =="
new_case ceiling
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
# Ticking normally right up to the ceiling — the lease has to stay live for
# the boundary to mean anything.
for OFFSET in 300 600 900 1200 1500 1800 2100 2400 2700 3000 3300 3400; do
  FAKE_CLOCK_OFFSET="$OFFSET"
  tick
done
[ "$(field '.data.renewed | length')" = 1 ] || fail "should still renew just inside the ceiling: $LAST"
FAKE_CLOCK_OFFSET=3700
tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed past the ceiling: $LAST"
grep -q 'past the 3600s ceiling' <<<"$(field '.data.skipped[0].reason')" ||
  fail "wrong ceiling reason: $LAST"
ok
# Past the ceiling the lease is left to lapse, which is what hands the run to
# the controller's existing overdue/escalation path.
FAKE_CLOCK_OFFSET=4600
tick
[ "$(lease_held)" = false ] || fail "the lease must lapse once the ceiling is passed"
ok
# The override can only clamp DOWN. 60 is honoured; 99999 is ignored.
new_case ceiling-override
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
FAKE_CLOCK_OFFSET=120
SMOKE_CONTROLLER_RENEW_CEILING_SECONDS=60 tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "a lowered ceiling was not honoured"
FAKE_CLOCK_OFFSET=5000
SMOKE_CONTROLLER_RENEW_CEILING_SECONDS=99999 tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "the ceiling was raised above 3600"
ok

echo "== 5. no owner turn holds the step =="
new_case no-ack
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
jrec run claim enqueued "$START" '{"origin":"poll-wake","pr":7,"ownerToken":"'"$TOKEN"'"}'
jrec owner lanes enqueued "$START" '{"brief":"controller/brief-lanes.md","outcome":"brief_written"}'
FAKE_CLOCK_OFFSET=300
tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed a brief nobody acked"
grep -q 'brief-lanes.ack absent' <<<"$(field '.data.skipped[0].reason')" || fail "wrong reason: $LAST"
ok
# The owner withdraws its ack to hand the step back — renewal stops there too.
ack lanes
tick
[ "$(field '.data.renewed | length')" = 1 ] || fail "an acked step should be renewed"
unack lanes
tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed after the ack was withdrawn"
ok
# A bare `intent` (a fire that died before writing the brief) is not in flight.
new_case intent-only
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
jrec run claim enqueued "$START" '{"origin":"poll-wake","pr":7,"ownerToken":"'"$TOKEN"'"}'
jrec owner lanes intent "$START"
ack lanes
FAKE_CLOCK_OFFSET=300
tick
[ "$(field '.data.status')" = idle ] || fail "a bare intent must not be renewed: $LAST"
ok

# ═════════════════════════════════════════════════════════════════════════════
# 6. STUB GATE — what the tick invokes, and what it must never invoke.
# ═════════════════════════════════════════════════════════════════════════════
echo "== 6. renewal and nothing else =="
STUB="$T/stub-gate.sh"
cat >"$STUB" <<'SH'
#!/usr/bin/env bash
printf '%s claimant=%s\n' "$*" "${SMOKE_GATE_CLAIMANT:-}" >>"$GATE_LOG"
echo '{"ok":true,"leaseRenewed":true}'
SH
chmod +x "$STUB"

new_case stub
export SMOKE_CONTROLLER_GATE_CMD="$STUB"
export GATE_LOG="$C/gate.log"
: >"$GATE_LOG"
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
BEFORE="$(find "$C/runs" -type f | sort)"
FAKE_CLOCK_OFFSET=300
tick
[ "$(wc -l <"$GATE_LOG")" = 1 ] || fail "expected exactly one gate call, got: $(cat "$GATE_LOG")"
grep -q "^progress $RUN $TOKEN claimant=controller\$" "$GATE_LOG" ||
  fail "wrong gate call: $(cat "$GATE_LOG")"
ok
for verb in claim finish release poll challenger-timeout lease-claim lease-release; do
  grep -q "^$verb " "$GATE_LOG" && fail "the renewer invoked $verb"
done
ok
[ "$(find "$C/runs" -type f | sort)" = "$BEFORE" ] || fail "the renewer wrote under the run root"
[ ! -e "$C/out/journal.ndjson.tmp" ] || fail "the renewer touched the journal"
JOURNAL_SUM="$(md5sum <"$JOURNAL")"
tick
[ "$(md5sum <"$JOURNAL")" = "$JOURNAL_SUM" ] || fail "the renewer modified the journal"
ok
# A gate refusal is recorded, not worked around.
cat >"$STUB" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GATE_LOG"
echo '{"ok":false,"error":"not the active run (reclaimed or finished) - stop this campaign"}'
SH
chmod +x "$STUB"
tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "counted a refused call as a renewal"
grep -q 'gate refused progress' <<<"$(field '.data.skipped[0].reason')" || fail "refusal not recorded: $LAST"
ok
unset SMOKE_CONTROLLER_GATE_CMD GATE_LOG

echo "== 7. kill switch and configuration =="
new_case killswitch
claim_files
in_flight_at "$(/usr/bin/date -u +%s)"
write_env shadow
tick
[ "$(field '.data.status')" = not-live ] || fail "shadow mode must do nothing: $LAST"
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed in shadow mode"
ok
write_env ""
tick
[ "$(field '.data.status')" = not-live ] || fail "an unset mode must default to shadow: $LAST"
ok
# The env file may not name SMOKE_GATE_CLAIMANT: the gate wrapper sources it
# for every caller, so a claimant there would mis-stamp the legacy coordinator.
write_env live "export SMOKE_GATE_CLAIMANT='controller'"
tick
[ "$(field '.data.status')" = misconfigured ] || fail "SMOKE_GATE_CLAIMANT in the env file was not refused: $LAST"
ok
write_env live
sed -i "s|export SMOKE_CONTROLLER_OUT_DIR=.*|export SMOKE_CONTROLLER_OUT_DIR=\"\$HOME/out\"|" "$C/env.sh"
tick
[ "$(field '.data.status')" = misconfigured ] || fail "a non-literal value was not refused: $LAST"
ok

echo "== 8. an unreadable journal renews nothing =="
new_case torn
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
FAKE_CLOCK_OFFSET=300
# A torn LAST line is what a concurrent append can leave; it is dropped.
printf '{"at":"2026-09' >>"$JOURNAL"
tick
[ "$(field '.data.renewed | length')" = 1 ] || fail "a torn tail should not stop the tick: $LAST"
ok
# Anything unparseable EARLIER means the journal is not evidence of anything.
printf '\n{"at":"2026-09-20T00:00:00Z","kind":"owner","slot":"x","state":"done","runId":"r","key":"k"}\n' >>"$JOURNAL"
tick
[ "$(field '.data.status')" = journal-unreadable ] || fail "a corrupt line must refuse the tick: $LAST"
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed against a corrupt journal"
ok

# A COMPLETE corrupt record — newline-terminated — is not an interrupted
# append and must never be dropped, even as the last line. (Codex P2: at
# 3f4bf2b6 any unparseable final line was dropped and the tick renewed from
# the older records.)
new_case corrupt-terminated
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
FAKE_CLOCK_OFFSET=300
printf 'CORRUPT\n' >>"$JOURNAL"
tick
[ "$(field '.data.status')" = journal-unreadable ] ||
  fail "a newline-terminated corrupt line must refuse the tick: $LAST"
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed past a complete corrupt record"
ok
# The refusal names the line, so the failure is recorded and not just silent.
grep -q 'journal line' <<<"$(field '.data.detail')" || fail "the refusal did not name the line: $LAST"
ok

# A record that parses but fails the schema check fails the tick closed too —
# including a claim in a state this tick does not understand, which at
# 3f4bf2b6 qualified as OPEN ("not done and not abandoned") and was renewed.
new_case bad-claim-state
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
jrec run claim weird $((START + 10)) '{"ownerToken":"'"$TOKEN"'"}'
FAKE_CLOCK_OFFSET=300
tick
[ "$(field '.data.status')" = journal-unreadable ] ||
  fail "an unknown claim state must refuse the tick, not read as open: $LAST"
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed under an unknown claim state"
ok
# Same for a record missing a required field, and for a non-object detail.
new_case bad-schema
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
printf '{"at":"%s","runId":"%s","kind":"owner","slot":"lanes","state":"enqueued","key":"k-owner-lanes","detail":"nope","v":1}\n' \
  "$(iso "$START")" "$RUN" >>"$JOURNAL"
FAKE_CLOCK_OFFSET=300
tick
[ "$(field '.data.status')" = journal-unreadable ] || fail "a non-object detail must refuse the tick: $LAST"
ok
new_case missing-field
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
printf '{"at":"%s","runId":"%s","kind":"owner","slot":"lanes","key":"k-owner-lanes","v":1}\n' \
  "$(iso "$START")" "$RUN" >>"$JOURNAL"
FAKE_CLOCK_OFFSET=300
tick
[ "$(field '.data.status')" = journal-unreadable ] || fail "a record with no state must refuse the tick: $LAST"
ok

new_case nojournal
claim_files
rm -f "$JOURNAL"
tick
[ "$(field '.data.status')" = no-journal ] || fail "a missing journal must be a no-op: $LAST"
ok

echo "== 9. every path ends wakeAgent:false =="
new_case never-wake
claim_files
in_flight_at "$(/usr/bin/date -u +%s)"
for SETUP in ok not-live nojournal badrun; do
  case "$SETUP" in
    not-live) write_env shadow ;;
    nojournal) write_env live; rm -f "$JOURNAL" ;;
    badrun) write_env live; : >"$JOURNAL"
            jrec run claim enqueued "$(/usr/bin/date -u +%s)" '{"ownerToken":"'"$TOKEN"'"}'
            printf '{"at":"%s","runId":"../escape","kind":"owner","slot":"lanes","state":"enqueued","key":"k2","v":1}\n' \
              "$(iso "$(/usr/bin/date -u +%s)")" >>"$JOURNAL" ;;
  esac
  tick
  [ "$(field '.wakeAgent')" = false ] || fail "$SETUP woke an agent: $LAST"
  [ "$(jq -e 'has("data")' <<<"$LAST" >/dev/null 2>&1; echo $?)" = 0 ] || fail "$SETUP printed no data"
done
ok
# The traversal attempt above is refused by name, not sanitized.
grep -q 'not well formed' <<<"$(field '.data.skipped[0].reason')" || fail "a bad run id was not refused: $LAST"
ok

# `..` is legal by charset and a directory escape as a path component, so the
# gate rejects it by name (smoke-pr-gate.sh:202) and so must this tick. At
# 3f4bf2b6 it was accepted: the ack lookup resolved to <run-root>/../controller
# and, with an ack planted there, the tick called the gate. Planting it here
# is what makes this a regression rather than a shape assertion.
new_case dotdot
export SMOKE_CONTROLLER_GATE_CMD="$STUB"
export GATE_LOG="$C/gate.log"
: >"$GATE_LOG"
cat >"$STUB" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GATE_LOG"
echo '{"ok":true,"leaseRenewed":true}'
SH
chmod +x "$STUB"
mkdir -p "$C/controller"
: >"$C/controller/brief-lanes.ack"
START="$(/usr/bin/date -u +%s)"
printf '{"at":"%s","runId":"..","kind":"run","slot":"claim","state":"enqueued","key":"k-dd-claim","detail":{"ownerToken":"%s"},"v":1}\n' \
  "$(iso "$START")" "$TOKEN" >>"$JOURNAL"
printf '{"at":"%s","runId":"..","kind":"owner","slot":"lanes","state":"enqueued","key":"k-dd-owner","v":1}\n' \
  "$(iso "$START")" >>"$JOURNAL"
FAKE_CLOCK_OFFSET=300
tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed a run id of '..': $LAST"
[ ! -s "$GATE_LOG" ] || fail "the gate was called for a run id of '..': $(cat "$GATE_LOG")"
grep -q 'not well formed' <<<"$(field '.data.skipped[0].reason')" || fail "'..' was not refused by name: $LAST"
ok
unset SMOKE_CONTROLLER_GATE_CMD GATE_LOG

[ "$FAILURES" = 0 ] || { echo "$FAILURES assertion group(s) FAILED" >&2; exit 1; }
echo "PASS ($PASSES assertions)"
