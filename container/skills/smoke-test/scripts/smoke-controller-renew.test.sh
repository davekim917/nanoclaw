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
# journal tail (tolerated) vs a complete corrupt record or a bad schema
# (refuses the tick); the freshness window, including a quiet-but-fresh owner,
# a resumed one, and a live CHALLENGER that must not keep a silent owner's
# claim alive; both clamp-down-only overrides; a run id of `..`; the
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
  SMOKE_GATE_CLAIMANT SMOKE_CONTROLLER_RENEW_CEILING_SECONDS SMOKE_CONTROLLER_RENEW_FRESHNESS_SECONDS \
  FAKE_CLOCK_OFFSET || true

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

# The owner's live container writing artifacts under the run. File mtimes are
# real time while `date` is shimmed, so every simulated write is stamped at
# the SHIFTED now -- otherwise a fixture would read as an hour stale the
# moment the clock moves.
owner_writes() { # [epoch, default = shifted now]
  local at="${1:-$(date -u +%s)}"
  mkdir -p "$C/runs/$RUN/evidence"
  : >"$C/runs/$RUN/evidence/progress.txt"
  touch -d "@$at" "$C/runs/$RUN/evidence/progress.txt"
}
# The CHALLENGER writing under its own directory. Same run, different session,
# and explicitly not evidence that the coordinator's owner is alive.
challenger_writes() { # [epoch, default = shifted now]
  local at="${1:-$(date -u +%s)}"
  mkdir -p "$C/runs/$RUN/challenger"
  : >"$C/runs/$RUN/challenger/disposition.md"
  touch -d "@$at" "$C/runs/$RUN/challenger/disposition.md"
}

# A gate that logs its argv and always succeeds. Used by cases that assert
# what the tick DECIDED, so the real lease's state cannot colour the answer.
STUB="$T/stub-gate.sh"
use_stub_gate() {
  cat >"$STUB" <<'SH'
#!/usr/bin/env bash
printf '%s claimant=%s\n' "$*" "${SMOKE_GATE_CLAIMANT:-}" >>"$GATE_LOG"
echo '{"ok":true,"leaseRenewed":true}'
SH
  chmod +x "$STUB"
  export SMOKE_CONTROLLER_GATE_CMD="$STUB"
  export GATE_LOG="$C/gate.log"
  : >"$GATE_LOG"
}

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
  owner_writes "$1"
}

# One tick with the owner having just written, which is what a working turn
# looks like between ticks.
tick_working() { owner_writes; tick; }

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
  tick_working
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
tick_working
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
  tick_working
done
[ "$(field '.data.renewed | length')" = 1 ] || fail "should still renew just inside the ceiling: $LAST"
# The owner is still writing here, so the ceiling — not freshness — is what
# stops the renewal.
FAKE_CLOCK_OFFSET=3700
tick_working
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
owner_writes
SMOKE_CONTROLLER_RENEW_CEILING_SECONDS=60 tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "a lowered ceiling was not honoured"
FAKE_CLOCK_OFFSET=5000
owner_writes
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
tick_working
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed a brief nobody acked"
grep -q 'brief-lanes.ack absent' <<<"$(field '.data.skipped[0].reason')" || fail "wrong reason: $LAST"
ok
# The owner withdraws its ack to hand the step back — renewal stops there too.
ack lanes
tick_working
[ "$(field '.data.renewed | length')" = 1 ] || fail "an acked step should be renewed"
unack lanes
tick_working
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

echo "== 5b. freshness: the ack says the step was TAKEN, the run tree says it is WORKED =="
# The ack is written once and never refreshed (router :31 creates it; the
# controller only tests existence, :1966, and re-offers only while it is
# ABSENT, :1961-1972). So an owner that crashes after acking would otherwise
# be renewed to the ceiling. Freshness is measured on coordinator-side writes.
new_case stale-owner
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"      # writes one artifact, at START, and nothing after
# Quiet but inside the window: renewal continues. A step is not required to
# write on every single tick — 1200 s is 4.7x the largest gap measured on the
# real 46-minute lanes step (253 s).
for OFFSET in 300 600 1000; do
  FAKE_CLOCK_OFFSET="$OFFSET"
  tick
  [ "$(field '.data.renewed | length')" = 1 ] ||
    fail "a quiet-but-fresh owner must still be renewed at +$OFFSET: $LAST"
done
ok
# Past the window with nothing written: the owner is gone, renewal stops.
# (Lease still live here — the lapse is asserted below, after it runs out.)
FAKE_CLOCK_OFFSET=1300
tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed an owner that stopped writing: $LAST"
grep -q 'no coordinator-side write for' <<<"$(field '.data.skipped[0].reason')" ||
  fail "wrong staleness reason: $LAST"
ok
# A write inside the window puts it back in flight — this is the multi-wake
# step `continue_work` produces, and the case the ack's own mtime can never
# see, because the ack is written once and never again.
FAKE_CLOCK_OFFSET=1400
owner_writes
tick
[ "$(field '.data.renewed | length')" = 1 ] || fail "a resumed owner must be renewed again: $LAST"
ok
# Now let it go quiet for good: renewal stops and the claim expires on its own
# TTL, which is the whole point — the degradation is claim expiry.
FAKE_CLOCK_OFFSET=2700
tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "renewed a permanently silent owner: $LAST"
[ "$(lease_held)" = false ] || fail "a stale owner's lease must lapse"
ok

# The CHALLENGER is the other side of the campaign, in its own session. Its
# writes say nothing about the coordinator's owner, and the lease being
# renewed is the coordinator's — so a healthy challenger must not hold a dead
# owner's claim open.
new_case challenger-only
use_stub_gate              # a decision test: the real lease must not colour it
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
mkdir -p "$C/runs/$RUN/challenger"
# Ticks only PAST the freshness window, so the owner's single write at START
# is stale and the challenger's writes are the only fresh thing on disk.
for OFFSET in 1300 1500 1700; do
  FAKE_CLOCK_OFFSET="$OFFSET"
  challenger_writes          # the challenger is alive and working
  tick                       # the owner has written nothing since START
done
[ "$(field '.data.renewed | length')" = 0 ] ||
  fail "a live challenger kept a silent owner's claim alive: $LAST"
grep -q 'no coordinator-side write for' <<<"$(field '.data.skipped[0].reason')" ||
  fail "challenger writes were counted as coordinator activity: $LAST"
[ ! -s "$GATE_LOG" ] || fail "the gate was called for a silent owner: $(cat "$GATE_LOG")"
ok
# Same fixture, owner writing too: it is the OWNER's write that matters.
FAKE_CLOCK_OFFSET=1300
owner_writes
tick
[ "$(field '.data.renewed | length')" = 1 ] || fail "an owner writing alongside the challenger must renew: $LAST"
ok

# The freshness override clamps DOWN only, exactly like the ceiling.
new_case freshness-override
use_stub_gate              # decision-only: a dead lease must not stand in for
                           # the window being honoured
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
FAKE_CLOCK_OFFSET=200
SMOKE_CONTROLLER_RENEW_FRESHNESS_SECONDS=60 tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "a lowered freshness window was not honoured: $LAST"
FAKE_CLOCK_OFFSET=1300
SMOKE_CONTROLLER_RENEW_FRESHNESS_SECONDS=99999 tick
[ "$(field '.data.renewed | length')" = 0 ] || fail "the freshness window was raised above 1200: $LAST"
ok

# ═════════════════════════════════════════════════════════════════════════════
# 6. STUB GATE — what the tick invokes, and what it must never invoke.
# ═════════════════════════════════════════════════════════════════════════════
echo "== 6. renewal and nothing else =="
new_case stub
use_stub_gate
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
# The env file is the list of keys, not a copy of it kept in this tick
# (XZO #2047). A name outside the four this tick reads for itself must still
# reach the gate call -- here the gate is invoked directly, so its lease dir
# comes from nowhere else -- and a name the tick has never heard of must pass
# through rather than be dropped or crash.
new_case env-is-the-list
claim_files
in_flight_at "$(/usr/bin/date -u +%s)"
# A lease dir that is NOT the gate's own fallback
# ($SMOKE_GATE_SHARED_ROOT/qa-coordinator/leases, smoke-pr-gate.sh:241), named
# only by the env file -- the install's shape, and the one that strands when
# the key is dropped: the gate call then looks somewhere with no lease.
PR_LEASES="$C/wg/pr-gate/leases"
mkdir -p "$PR_LEASES"
mv "$C/wg/qa-coordinator/leases/lease-$RUN.json" "$C/wg/qa-coordinator/leases/pr-$PR-authority.json" \
   "$PR_LEASES/"
unset SMOKE_GATE_LEASE_DIR      # only the env file can supply it now
write_env live "export SMOKE_GATE_LEASE_DIR='$PR_LEASES'" \
  "export SMOKE_GATE_FUTURE_KNOB='tomorrow'" \
  "export PATH='/nonexistent-from-the-env-file'" \
  "export LD_PRELOAD='/nonexistent/evil.so'"
tick
[ "$(field '.data.renewed | length')" = 1 ] \
  || fail "the lease dir from the env file never reached the gate call: $LAST"
ok
export SMOKE_GATE_LEASE_DIR="$PR_LEASES"
# A non-literal value is refused for any name the file may set, not just the
# four -- guessing it would run the tick under configuration nobody wrote.
write_env live 'export SMOKE_GATE_LEASE_DIR="$HOME/leases"'
tick
[ "$(field '.data.status')" = misconfigured ] \
  || fail "a non-literal value outside the old four-key list was not refused: $LAST"
grep -q SMOKE_GATE_LEASE_DIR <<<"$(field '.data.detail')" || fail "the refusal did not name the key: $LAST"
ok
# `unset` still clears, over the same widened set.
write_env live "export SMOKE_GATE_LEASE_DIR='$PR_LEASES'" \
  "export SMOKE_GATE_FUTURE_KNOB='tomorrow'" "unset SMOKE_GATE_FUTURE_KNOB"
tick
[ "$(field '.data.status')" != misconfigured ] || fail "an unset line must not read as non-literal: $LAST"
ok
# A line OUTSIDE the config namespace is inert -- not config, and above all not
# a reason to stop renewing. Refusing over one would be persistent campaign
# failure from a benign file, the same outage class this fix is about.
write_env live "export SMOKE_GATE_LEASE_DIR='$PR_LEASES'" \
  'EXTRA="$HOME/cache"' 'MY_TOOL_ARGS="--out=$(pwd)"' "export BUN_OPTIONS='--preload=/nonexistent/pre.cjs'"
tick
[ "$(field '.data.status')" != misconfigured ] \
  || fail "a foreign line must be ignored, not stop the tick: $LAST"
[ "$(field '.data.renewed | length')" = 1 ] \
  || fail "the tick must renew normally alongside a foreign line: $LAST"
ok

# --- imported config never touches this script's own variables --------------
# The tick's internals are ours and can be renamed at any time, so no deny list
# can protect them in general: config goes into the CHILD environment only.
# CEILING_MAX is the renewal ceiling added for XZO #2024; NOW stamps the final
# line. At 760e6220c the env file could overwrite both.
new_case env-cannot-clobber-internals
START="$(/usr/bin/date -u +%s)"
claim_files "$START"
in_flight_at "$START"
write_env live "export CEILING_MAX='9999'" "export NOW='not-a-timestamp'" \
  "export JOURNAL='/nonexistent/journal.ndjson'" "export RESULT_RENEWED='[\"forged\"]'"
FAKE_CLOCK_OFFSET=3700
tick_working   # the owner IS writing, so the ceiling is what must stop this
[ "$(field '.data.renewed | length')" = 0 ] \
  || fail "the env file raised the renewal ceiling: $LAST"
grep -q 'past the 3600s ceiling' <<<"$(field '.data.skipped[0].reason')" \
  || fail "the ceiling the env file tried to move is not the one that fired: $LAST"
ok
[ -n "$LAST" ] && jq -e '.wakeAgent == false and (.data.tick | test("^[0-9]{4}-"))' <<<"$LAST" >/dev/null \
  || fail "the env file broke the final-line contract: $LAST"
ok
jq -e '.data.renewed == [] and (.data.skipped | type == "array")' <<<"$LAST" >/dev/null \
  || fail "the env file reached the tick's result accumulators: $LAST"
ok
# ...and the gate call still receives the file's real config, because that is
# where imported values are supposed to land.
new_case env-reaches-child-only
claim_files
in_flight_at "$(/usr/bin/date -u +%s)"
use_stub_gate
write_env live "export SMOKE_GATE_FUTURE_KNOB='tomorrow'" "export CEILING_MAX='9999'"
tick
[ "$(field '.data.renewed | length')" = 1 ] || fail "stub-gate renewal did not happen: $LAST"
grep -q 'claimant=controller' "$GATE_LOG" || fail "the gate call lost its claimant: $(cat "$GATE_LOG")"
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
use_stub_gate
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

echo "== 10. claimant comments and timezone-independent step age =="
new_case comment-and-dst
use_stub_gate
# Always exercise summer, even when CI runs in winter.
START="$(/usr/bin/date -u -d '2026-07-15T12:00:00Z' +%s)"
claim_files "$START"
in_flight_at "$START"
printf '\n# Never assign SMOKE_GATE_CLAIMANT here.\n#SMOKE_GATE_CLAIMANT=controller\n' >>"$SMOKE_CONTROLLER_ENV_FILE"
FAKE_CLOCK_OFFSET=$((START + 300 - $(/usr/bin/date -u +%s)))
for ZONE in UTC America/New_York Europe/London Asia/Tokyo; do
  TZ="$ZONE" tick
  [ "$(field '.data.renewed | length')" = 1 ] || fail "comment or $ZONE prevented live-step renewal: $LAST"
  [ "$(field '.wakeAgent')" = false ] || fail "renewal woke a model in $ZONE"
  ok
done
for ASSIGNMENT in 'export SMOKE_GATE_CLAIMANT=controller' 'SMOKE_GATE_CLAIMANT="$OTHER"' \
  'unset SMOKE_GATE_CLAIMANT' 'export OTHER=1 SMOKE_GATE_CLAIMANT=controller' \
  'declare -x SMOKE_GATE_CLAIMANT=controller' 'typeset -x SMOKE_GATE_CLAIMANT=controller' \
  'readonly SMOKE_GATE_CLAIMANT=controller' 'unset -v SMOKE_GATE_CLAIMANT' \
  'OTHER="#"; SMOKE_GATE_CLAIMANT=controller'; do
  write_env live
  printf '\n%s\n' "$ASSIGNMENT" >>"$SMOKE_CONTROLLER_ENV_FILE"
  tick
  [ "$(field '.data.status')" = misconfigured ] || fail "real claimant directive was accepted: $ASSIGNMENT"
  ok
done
unset SMOKE_CONTROLLER_GATE_CMD GATE_LOG

new_case fifo-env
rm "$SMOKE_CONTROLLER_ENV_FILE"
mkfifo "$SMOKE_CONTROLLER_ENV_FILE"
LAST="$(timeout 5 bash "$R" 2>>"$C/renew.err")" || fail 'nonregular env file blocked the renewer'
[ "$(field '.wakeAgent')" = false ] || fail 'nonregular env file woke a model'
ok

# ═════════════════════════════════════════════════════════════════════════════
# THE HEARTBEAT (#1031) — every tick that knows the out-dir records that it
# ran and how it ended, in <out>/renewer/heartbeat.json, which the live worker
# reads before it may claim. Every "no heartbeat" assertion first proves the
# tick ran to final() (its own stdout status), so an absent file is the code
# under test deciding, not a tick that never ran.
# ═════════════════════════════════════════════════════════════════════════════
echo "== heartbeat =="
HB() { printf '%s' "$C/out/renewer/heartbeat.json"; }
hb() { jq -r "$1" "$(HB)" 2>/dev/null; }
new_case heartbeat-idle
tick
[ "$(field '.data.status')" = idle ] || fail "heartbeat: precondition -- an empty journal is an idle tick: $LAST"
[ "$(hb .status)" = idle ] && [ "$(hb .tick)" = "$(field '.data.tick')" ] \
  || fail "heartbeat: an idle tick records itself, with the tick it reported: $(cat "$(HB)" 2>&1)"
[ "$(hb .schemaVersion)" = 1 ] && [ "$(hb .tickEpoch)" -gt 0 ] || fail "heartbeat: schema and epoch"
[ "$(stat -c %a "$(HB)")" = 644 ] || fail "heartbeat: readable by the worker's container (0644): $(stat -c %a "$(HB)")"
[ "$(printf '%s\n' "$LAST" | wc -l)" = 1 ] && [ "$(field '.wakeAgent')" = false ] \
  || fail "heartbeat: the tick's stdout contract is unchanged: $LAST"
ok

new_case heartbeat-renewed
use_stub_gate
claim_files
in_flight_at "$(/usr/bin/date -u +%s)"
tick
[ "$(field '.data.renewed | length')" = 1 ] || fail "heartbeat: precondition -- this tick renewed a step: $LAST"
[ "$(hb .status)" = ok ] || fail "heartbeat: a renewing tick records ok: $(cat "$(HB)" 2>&1)"
unset SMOKE_CONTROLLER_GATE_CMD GATE_LOG
ok

new_case heartbeat-failing
export SMOKE_CONTROLLER_GATE_CMD="$C/no-such-gate.sh"
tick
[ "$(field '.data.status')" = misconfigured ] || fail "heartbeat: precondition -- a missing gate wrapper: $LAST"
[ "$(hb .status)" = misconfigured ] \
  || fail "heartbeat: a failing tick records WHY, so the worker can say 'ticking but renewing nothing'"
unset SMOKE_CONTROLLER_GATE_CMD
ok

new_case heartbeat-not-live
write_env shadow
tick
[ "$(field '.data.status')" = not-live ] || fail "heartbeat: precondition -- the kill switch is off: $LAST"
[ ! -e "$C/out/renewer" ] || fail "heartbeat: a tick that is not live writes nothing at all"
ok

new_case heartbeat-no-out-dir
rm -rf "$C/out"
tick
[ "$(field '.data.status')" = no-journal ] || fail "heartbeat: precondition -- the tick ran to its end: $LAST"
[ ! -e "$C/out" ] || fail "heartbeat: the renewer never creates the worker's out-dir"
ok

new_case heartbeat-symlinked-dir
mkdir -p "$C/elsewhere"
ln -s "$C/elsewhere" "$C/out/renewer"
tick
[ "$(field '.data.status')" = idle ] || fail "heartbeat: precondition -- the tick ran to its end: $LAST"
[ -z "$(ls -A "$C/elsewhere")" ] || fail "heartbeat: written THROUGH a symlinked renewer dir: $(ls -A "$C/elsewhere")"
ok

new_case heartbeat-symlinked-file
mkdir -p "$C/out/renewer" "$C/elsewhere"
printf 'untouched\n' >"$C/elsewhere/target"
ln -s "$C/elsewhere/target" "$C/out/renewer/heartbeat.json"
tick
[ "$(field '.data.status')" = idle ] || fail "heartbeat: precondition -- the tick ran to its end: $LAST"
[ "$(cat "$C/elsewhere/target")" = untouched ] || fail "heartbeat: written through a symlinked heartbeat file"
[ ! -L "$(HB)" ] && [ "$(hb .status)" = idle ] \
  || fail "heartbeat: the link is REPLACED by the real heartbeat (rename, never follow)"
ok

# A tick that REACHED the gate and did not renew is not a healthy tick
# (Codex, PR #1089): a renewer that cannot renew while the worker can still
# claim is the failure the heartbeat exists to surface. `renew-failed` carries
# how many ticks in a row; the worker stops claiming at 2.
reply_gate() { # <one JSON line the gate answers progress with, or "" for none>
  cat >"$STUB" <<SH
#!/usr/bin/env bash
printf '%s claimant=%s\n' "\$*" "\${SMOKE_GATE_CLAIMANT:-}" >>"\$GATE_LOG"
printf '%s\n' '$1'
SH
  chmod +x "$STUB"
  export SMOKE_CONTROLLER_GATE_CMD="$STUB" GATE_LOG="$C/gate.log"
  : >"$GATE_LOG"
}
failed_tick() { # <label> <expected failedTicks>
  tick
  grep -q "^progress $RUN " "$GATE_LOG" || fail "$1: precondition -- the tick reached the gate: $LAST"
  [ "$(field '.data.status')" = renew-failed ] && [ "$(field '.data.renewed | length')" = 0 ] \
    || fail "$1: a refused renewal is not an ok tick: $LAST"
  [ "$(hb .status)" = renew-failed ] && [ "$(hb .failedTicks)" = "$2" ] \
    || fail "$1: heartbeat records renew-failed x$2: $(cat "$(HB)" 2>&1)"
  : >"$GATE_LOG"
}

new_case heartbeat-renew-failed
claim_files
in_flight_at "$(/usr/bin/date -u +%s)"
# The gate did not find the run (pr:null): a wrong state dir answers this too.
reply_gate '{"ok":false,"error":"not the active run (reclaimed or finished) — stop this campaign","runId":"x","pr":null,"activeRunId":null}'
failed_tick "rf1 not-found" 1
failed_tick "rf1 again" 2
failed_tick "rf1 a third" 3
use_stub_gate
tick
[ "$(field '.data.status')" = ok ] && [ "$(hb .status)" = ok ] && [ "$(hb .failedTicks)" = 0 ] \
  || fail "rf1: one renewal resets the count: $(cat "$(HB)" 2>&1)"
ok
reply_gate '{"ok":false,"retryable":true,"error":"gate_lock_busy: ...","pr":7}'
failed_tick "rf2 lock busy" 1
reply_gate '{"ok":false,"error":"caller owner does not match the owner recorded by claim - STOP this campaign","pr":7,"runId":"x","requestedBy":"a","claimedBy":"b"}'
failed_tick "rf3 owner mismatch (a PR but no activeRunId)" 2
reply_gate ''
failed_tick "rf4 no answer (the call timed out)" 3
reply_gate 'not json'
failed_tick "rf5 not JSON" 4
ok

# The gate POSITIVELY saw the run leave its slot: nothing is left to renew,
# and the renewer is not failing for it.
new_case heartbeat-run-gone
claim_files
in_flight_at "$(/usr/bin/date -u +%s)"
reply_gate "{\"ok\":false,\"error\":\"not the active run (reclaimed or finished) — stop this campaign\",\"pr\":7,\"runId\":\"$RUN\",\"activeRunId\":null}"
tick
grep -q "^progress $RUN " "$GATE_LOG" || fail "gone: precondition -- the tick reached the gate: $LAST"
[ "$(field '.data.status')" = ok ] && [ "$(hb .status)" = ok ] && [ "$(hb .failedTicks)" = 0 ] \
  || fail "gone: a run the gate saw finish is not a failed renewal: $LAST / $(cat "$(HB)" 2>&1)"
[ "$(field '.data.skipped | length')" = 1 ] || fail "gone: still recorded as skipped: $LAST"
reply_gate "{\"ok\":false,\"error\":\"STOP THIS CAMPAIGN. displaced\",\"pr\":7,\"runId\":\"$RUN\",\"activeRunId\":\"other-run\",\"displacedAt\":\"2026-09-23T00:00:00Z\"}"
tick
[ "$(hb .status)" = ok ] || fail "gone: a displaced run is not a failed renewal: $(cat "$(HB)" 2>&1)"
ok

# The count is carried from the renewer's own last heartbeat; one it cannot
# read is not evidence the last tick was healthy.
new_case heartbeat-renew-failed-unreadable-prior
claim_files
in_flight_at "$(/usr/bin/date -u +%s)"
mkdir -p "$C/out/renewer"
printf 'torn{' >"$(HB)"
reply_gate '{"ok":false,"error":"x","pr":null,"activeRunId":null,"runId":"x"}'
failed_tick "rf6 torn prior heartbeat" 2
printf '{"status":"renew-failed","failedTicks":"many"}\n' >"$(HB)"
failed_tick "rf6 non-numeric prior count" 2
printf '{"status":"idle","failedTicks":9}\n' >"$(HB)"
failed_tick "rf6 a healthy prior tick restarts the count" 1
printf '{"status":"ok","failedTicks":0}\n' >"$C/prior-elsewhere.json"
rm -f "$(HB)"; ln -s "$C/prior-elsewhere.json" "$(HB)"
failed_tick "rf6 a symlinked prior heartbeat is not believed" 2
unset SMOKE_CONTROLLER_GATE_CMD GATE_LOG
ok

# More eligible steps than one tick may renew (MAX_RENEWALS, 16): the ones
# past the cap go unrenewed, so the tick is not healthy (Codex, PR #1089).
new_case heartbeat-renewal-cap
use_stub_gate
NOWE="$(/usr/bin/date -u +%s)"
for i in $(seq 1 17); do
  R_I="demo-pr-pr$((100 + i))-aaaaaaaaaaaa-20260920T000000Z"
  mkdir -p "$C/runs/$R_I/controller" "$C/runs/$R_I/evidence"
  : >"$C/runs/$R_I/controller/brief-lanes.ack"
  : >"$C/runs/$R_I/evidence/progress.txt"
  for rec in "run claim enqueued {\"ownerToken\":\"$TOKEN\"}" "owner lanes enqueued {}"; do
    set -- $rec
    jq -cn --arg run "$R_I" --arg kind "$1" --arg slot "$2" --arg state "$3" --arg at "$(iso "$NOWE")" \
      --argjson detail "$4" \
      '{at:$at,fire:$at,runId:$run,kind:$kind,slot:$slot,key:("k-" + $run + "-" + $kind + "-" + $slot),
        state:$state,mode:"live",attempt:1,v:1,detail:$detail}' >>"$JOURNAL"
  done
done
tick
[ "$(field '.data.renewed | length')" = 16 ] || fail "cap: precondition -- 16 renewed: $LAST"
[ "$(field '[.data.skipped[] | select(.reason | test("renewal cap"))] | length')" = 1 ] \
  || fail "cap: precondition -- the 17th hit the cap: $LAST"
[ "$(field '.data.status')" = renew-failed ] && [ "$(hb .status)" = renew-failed ] && [ "$(hb .failedTicks)" = 1 ] \
  || fail "cap: a step left unrenewed by the cap is a failed tick: $LAST / $(cat "$(HB)" 2>&1)"
unset SMOKE_CONTROLLER_GATE_CMD GATE_LOG
ok

[ "$FAILURES" = 0 ] || { echo "$FAILURES assertion group(s) FAILED" >&2; exit 1; }
echo "PASS ($PASSES assertions)"
