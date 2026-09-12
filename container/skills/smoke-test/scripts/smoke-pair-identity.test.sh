#!/usr/bin/env bash
# Exercises smoke-pair-identity.sh end to end through its real verbs against
# fixture Render responses (SMOKE_PAIR_FIXTURE_DIR) — no network. Covers the
# three review rounds that shaped this script: wrong serving identity (only a
# status:"live" record may freeze), drift erased by re-initialization (start
# is no-clobber), and success without durable evidence (a failed write never
# reports "frozen").
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
jq -e '.frontend.deploy == "dep-fe000000001" and .backend.deploy == "dep-be000000001"' \
  "$RUN1/coordinator/identity.json" >/dev/null || fail "start-valid: identity.json shape wrong"
expect_rc "$(run check "$RUN1" lane-a-start)" 0 check-unchanged
expect_rc "$(run finish "$RUN1")" 0 finish-clean

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

# --- 5. Success without evidence: an actual truncated write is refused -----
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
