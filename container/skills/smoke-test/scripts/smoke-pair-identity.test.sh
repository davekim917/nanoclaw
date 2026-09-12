#!/usr/bin/env bash
# Exercises smoke-pair-identity.sh end to end through its real verbs against
# fixture Render responses (SMOKE_PAIR_FIXTURE_DIR) — no network. Covers the
# three review rounds that shaped this script (wrong serving identity, drift
# erased by re-initialization, success without durable evidence) plus the
# bounded re-freeze this PR adds: one re-freeze allowed per run, a second
# drift after it stays BLOCKED, and a stale-generation receipt never counts
# toward the current baseline.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/smoke-pair-identity.sh"

T="$(mktemp -d)"
cleanup() { rm -rf "$T"; }
trap cleanup EXIT

export SMOKE_PAIR_FIXTURE_DIR="$T/fx"
export SMOKE_GATE_FRONTEND_SERVICE="srv-fe00000000001"
export SMOKE_GATE_BACKEND_SERVICE="srv-be00000000001"
mkdir -p "$SMOKE_PAIR_FIXTURE_DIR"

A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
C=cccccccccccccccccccccccccccccccccccccccc

mk() { printf '[{"deploy":{"id":"%s","status":"%s","finishedAt":"2026-09-10T00:00:00Z","commit":{"id":"%s"}}}]' "$1" "$2" "$3"; }
mk2() { printf '[{"deploy":{"id":"%s","status":"%s","commit":{"id":"%s"}}},{"deploy":{"id":"%s","status":"%s","commit":{"id":"%s"}}}]' "$@"; }

run() { bash "$SCRIPT" "$@" >"$T/out" 2>"$T/err"; echo $?; }
out() { cat "$T/out"; }
err() { cat "$T/err"; }

fail() { echo "FAIL: $1" >&2; echo "-- stdout --" >&2; out >&2; echo "-- stderr --" >&2; err >&2; exit 1; }
expect_rc() { [ "$1" = "$2" ] || fail "$3: expected exit $2, got $1"; }

# --- missing service ids fail closed, in every mode, not just fixture mode -
RC="$(SMOKE_GATE_FRONTEND_SERVICE= SMOKE_GATE_BACKEND_SERVICE= bash "$SCRIPT" read >"$T/out" 2>"$T/err"; echo $?)"
expect_rc "$RC" 2 missing-services
err | grep -q 'SMOKE_GATE_FRONTEND_SERVICE' || fail "missing-services: message did not name the required env var"

# --- 1. Happy path: start freezes the LIVE pair, check/finish clean --------
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
RUN1="$T/run1"; mkdir -p "$RUN1"
expect_rc "$(run start "$RUN1")" 0 start-valid
jq -e '.frontend.deploy == "dep-fe000000001" and .backend.deploy == "dep-be000000001" and .freezeGeneration == 1 and .history == []' \
  "$RUN1/coordinator/identity.json" >/dev/null || fail "start-valid: identity.json shape wrong"
expect_rc "$(run check "$RUN1" lane-a-start)" 0 check-unchanged
expect_rc "$(run finish "$RUN1")" 0 finish-clean
tail -1 "$RUN1/coordinator/identity-checks.ndjson" | jq -e '.freezeGeneration == 1' >/dev/null || \
  fail "check-unchanged: receipt not tagged with freezeGeneration 1"

# --- 2. Wrong serving identity: only a status:"live" record may freeze -----
RUN2="$T/run2"; mkdir -p "$RUN2"
mk2 dep-fe000000009 build_in_progress "$C" dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN2")" 0 start-nonlive-first
grep -q 'dep-fe000000001' "$RUN2/coordinator/identity.json" || fail "start-nonlive-first: froze the building deploy, not the live one"
mk dep-fe000000001 deactivated "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
expect_rc "$(run check "$RUN2" deactivated)" 2 live-to-deactivated
printf '[{"deploy":{"id":12345,"status":"live","commit":{"id":"%s"}}}]' "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
expect_rc "$(run check "$RUN2" numeric-id)" 2 numeric-id
printf '[{"deploy":{"id":"dep-fe000000001","status":"live","commit":{"id":"notasha"}}}]' > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
expect_rc "$(run check "$RUN2" bad-sha)" 2 bad-sha

# --- 3. Drift erased by re-initialization: start is no-clobber -------------
RUN3="$T/run3"; mkdir -p "$RUN3"
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN3")" 0 drift-start
mk dep-be000000002 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run check "$RUN3" moved)" 3 same-commit-redeploy-drift
expect_rc "$(run start "$RUN3")" 4 restart-after-drift-refused
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run finish "$RUN3")" 3 finish-after-recorded-drift

# --- 4. Success without durable evidence: a failed check log write refuses -
RUN4="$T/run4"; mkdir -p "$RUN4"
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN4")" 0 evidence-start
chmod 500 "$RUN4/coordinator"
expect_rc "$(run check "$RUN4" ro)" 2 check-log-unwritable
chmod 700 "$RUN4/coordinator"
expect_rc "$(run finish "$RUN4")" 2 finish-no-successful-check

# --- 5. Bounded re-freeze: first drift may re-freeze once, second is BLOCKED
RUN5="$T/run5"; mkdir -p "$RUN5"
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN5")" 0 refreeze-start
mk dep-be000000009 live "$C" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run check "$RUN5" preflight)" 3 refreeze-first-drift-detected
expect_rc "$(run refreeze "$RUN5" "")" 2 refreeze-requires-reason
expect_rc "$(run refreeze "$RUN5" "backend replaced mid-run")" 0 refreeze-allowed
jq -e '.freezeGeneration == 2' "$RUN5/coordinator/identity.json" >/dev/null || fail "refreeze-allowed: freezeGeneration did not bump to 2"
jq -e '.history | length == 1 and .[0].backend.deploy == "dep-be000000001" and .[0].reason == "backend replaced mid-run"' \
  "$RUN5/coordinator/identity.json" >/dev/null || fail "refreeze-allowed: history did not name the OLD pair and reason"
jq -e '.backend.deploy == "dep-be000000009"' "$RUN5/coordinator/identity.json" >/dev/null || \
  fail "refreeze-allowed: current pair is not the NEW pair"
# The pre-refreeze drift receipt is generation 1; it must not stand in for a
# fresh generation-2 receipt (a stale-generation marker doesn't count).
expect_rc "$(run finish "$RUN5")" 2 finish-before-fresh-gen2-check
expect_rc "$(run check "$RUN5" postfreeze)" 0 check-after-refreeze
LAST_REC="$(tail -1 "$RUN5/coordinator/identity-checks.ndjson")"
jq -e '.freezeGeneration == 2' <<<"$LAST_REC" >/dev/null || fail "check-after-refreeze: receipt not tagged generation 2"
expect_rc "$(run finish "$RUN5")" 0 finish-after-refreeze
# Second drift after the one allowed re-freeze: check still reports it, but
# a second refreeze call is refused outright — this run is done re-freezing.
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run check "$RUN5" seconddrift)" 3 second-drift-after-refreeze
RC="$(run refreeze "$RUN5" "trying again")"
expect_rc "$RC" 4 second-refreeze-refused
err | grep -qi 'already re-froze' || fail "second-refreeze-refused: message did not name the one-per-run bound"
expect_rc "$(run finish "$RUN5")" 3 finish-after-second-drift-blocked

# refreeze itself requires a prior identity.json, and refuses a corrupt one
RUN6="$T/run6"; mkdir -p "$RUN6"
expect_rc "$(run refreeze "$RUN6" "no baseline yet")" 2 refreeze-without-start
mkdir -p "$RUN6/coordinator"; printf 'not json' > "$RUN6/coordinator/identity.json"
expect_rc "$(run refreeze "$RUN6" "corrupt")" 2 refreeze-corrupt-baseline

# --- 6. Success without evidence: an actual truncated write is refused -----
# Needs mount privilege (a full 64k tmpfs forces a real short write); skip
# quietly otherwise — the read-back-before-install code path this exercises
# is unchanged from the reviewed v3 script and isn't re-derived here.
if command -v mount >/dev/null 2>&1 && mkdir -p "$T/tiny" && mount -t tmpfs -o size=64k tmpfs "$T/tiny" 2>/dev/null; then
  dd if=/dev/zero of="$T/tiny/fill" bs=1k count=62 2>/dev/null
  mkdir -p "$T/tiny/run"
  expect_rc "$(run start "$T/tiny/run")" 2 start-partial-write
  [ -e "$T/tiny/run/coordinator/identity.json" ] && fail "start-partial-write: a truncated write still installed a baseline"
  umount "$T/tiny" 2>/dev/null || true
else
  echo "note: tmpfs partial-write fixture skipped (no mount privilege)"
fi

echo "smoke pair identity tests passed"
