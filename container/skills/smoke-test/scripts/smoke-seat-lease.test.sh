#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
L="${SMOKE_SEAT_LEASE_SCRIPT:-$SCRIPT_DIR/smoke-seat-lease.py}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
unset SMOKE_GATE_SHARED_ROOT SMOKE_SEAT_LEASE_IDENTITY_FILE || true
. "$SCRIPT_DIR/smoke-case.sh"

mkdir -p "$T/bin"
cat >"$T/bin/mountpoint" <<'STUB'
#!/usr/bin/env bash
[ "$1" = -q ] && shift
for m in ${FAKE_MOUNTED:-}; do [ "$1" = "$m" ] && exit 0; done
exit 1
STUB
chmod +x "$T/bin/mountpoint"
export PATH="$T/bin:$PATH"

SEAT="qa-seat-one@example.test"
FAILS=0
fail() { echo "FAIL: $*" >&2; FAILS=$((FAILS + 1)); }

fresh() {
  ROOT="$T/$1/shared"
  rm -rf "$T/$1"
  mkdir -p "$ROOT/qa-coordinator" "$T/$1/ids"
  for g in group-a group-b group-c; do printf '{"groupName":"%s"}' "$g" >"$T/$1/ids/$g.json"; done
  export SMOKE_GATE_SHARED_ROOT="$ROOT" FAKE_MOUNTED="$ROOT"
  IDS="$T/$1/ids"
  LEDGER="$ROOT/qa-coordinator/seat-leases"
}

as() {
  local group="$1"; shift
  OUT="$(SMOKE_SEAT_LEASE_IDENTITY_FILE="$IDS/$group.json" python3 "$L" "$@" 2>"$T/err")"
  RC=$?
  ERR="$(cat "$T/err")"
}

future() { date -u -d "+2 hours" +%Y-%m-%dT%H:%M:%SZ; }

expect_issue() {
  as "$1" check "$SEAT"
  [ "$RC" = 0 ] || fail "$2: $1 refused (rc=$RC): $ERR"
  [ -z "$OUT" ] || fail "$2: check wrote to stdout: $OUT"
}

expect_refused() {
  as "$1" check "$SEAT"
  [ "$RC" = 69 ] || fail "$2: $1 got rc=$RC, want 69"
  [ -z "$OUT" ] || fail "$2: check wrote to stdout: $OUT"
  case "$ERR" in *"SEAT_LEASE_REFUSED reason=$3"*) ;; *) fail "$2: stderr lacks reason=$3: $ERR" ;; esac
}

if smoke_case unleased-seat-issues; then
  fresh unleased
  expect_issue group-a "no ledger yet"
  mkdir -p "$LEDGER"
  expect_issue group-b "empty ledger"
fi

if smoke_case grant-binds-seat-to-holder; then
  fresh grant
  as group-a grant "$SEAT" --to group-b --until "$(future)"
  [ "$RC" = 0 ] || fail "grant: rc=$RC $ERR"
  expect_issue group-b "holder after grant"
  expect_refused group-a "grantor after grant" leased-elsewhere
  case "$ERR" in *"holder=group-b"*"caller=group-a"*) ;; *) fail "refusal does not name holder and caller: $ERR" ;; esac
  expect_refused group-c "bystander after grant" leased-elsewhere
  as group-c grant "$SEAT" --to group-c --until "$(future)"
  [ "$RC" = 3 ] || fail "grant over a live lease: rc=$RC, want 3"
  expect_issue group-b "holder after refused re-grant"
fi

if smoke_case transfer-ends-old-holder-access; then
  fresh transfer
  as group-a grant "$SEAT" --to group-a --until "$(future)"
  expect_issue group-a "holder before transfer"
  as group-a transfer "$SEAT" --to group-b --until "$(future)"
  [ "$RC" = 0 ] || fail "transfer: rc=$RC $ERR"
  expect_refused group-a "old holder after transfer" leased-elsewhere
  expect_issue group-b "new holder after transfer"
  [ "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["previousHolder"])' "$LEDGER/$SEAT.json")" = group-a ] ||
    fail "transfer did not record the previous holder"
fi

if smoke_case only-holder-transfers-or-releases; then
  fresh nonholder
  as group-a grant "$SEAT" --to group-b --until "$(future)"
  as group-a transfer "$SEAT" --to group-a --until "$(future)"
  [ "$RC" = 3 ] || fail "non-holder transfer: rc=$RC, want 3"
  as group-a release "$SEAT"
  [ "$RC" = 3 ] || fail "non-holder release: rc=$RC, want 3"
  expect_issue group-b "holder after refused transfer and release"
  expect_refused group-a "non-holder still refused" leased-elsewhere
  as group-b release "$SEAT"
  [ "$RC" = 0 ] || fail "holder release: rc=$RC $ERR"
  [ ! -e "$LEDGER/$SEAT.json" ] || fail "release left the lease file"
  expect_issue group-a "after release"
fi

if smoke_case unreadable-lease-refuses; then
  fresh unreadable
  mkdir -p "$LEDGER"
  printf '{"seat":"%s","holder":' "$SEAT" >"$LEDGER/$SEAT.json"
  expect_refused group-a "truncated lease" unreadable-lease
  expect_refused group-b "truncated lease, any group" unreadable-lease
  printf '{"seat":"other@example.test","holder":"group-a","until":"%s"}' "$(future)" >"$LEDGER/$SEAT.json"
  expect_refused group-a "lease naming another seat" unreadable-lease
  printf '{"seat":"%s","holder":"group-a","until":"soon"}' "$SEAT" >"$LEDGER/$SEAT.json"
  expect_refused group-a "unparseable until" unreadable-lease
  rm "$LEDGER/$SEAT.json"
  printf '{"seat":"%s","holder":"group-a","until":"%s"}' "$SEAT" "$(future)" >"$T/elsewhere.json"
  ln -s "$T/elsewhere.json" "$LEDGER/$SEAT.json"
  expect_refused group-a "symlinked lease" unreadable-lease
  rm "$LEDGER/$SEAT.json"
  mkdir "$LEDGER/$SEAT.json"
  expect_refused group-a "directory in place of a lease" unreadable-lease
  as group-a grant "$SEAT" --to group-a --until "$(future)"
  [ "$RC" = 3 ] || fail "grant over an unreadable lease: rc=$RC, want 3"
fi

if smoke_case unreadable-identity-or-ledger-refuses; then
  fresh ledger
  SMOKE_SEAT_LEASE_IDENTITY_FILE="$IDS/missing.json" python3 "$L" check "$SEAT" 2>"$T/err" >/dev/null
  RC=$?; ERR="$(cat "$T/err")"
  [ "$RC" = 69 ] || fail "missing identity: rc=$RC, want 69"
  case "$ERR" in *"reason=no-identity"*) ;; *) fail "missing identity: $ERR" ;; esac
  printf '{"groupName":""}' >"$IDS/empty.json"
  expect_refused empty "empty groupName" no-identity
  FAKE_MOUNTED="" expect_refused group-a "unmounted shared root" no-ledger
  mkdir -p "$T/ledger/outside"
  ln -s "$T/ledger/outside" "$LEDGER"
  expect_refused group-a "ledger aliased outside the shared root" no-ledger
  rm "$LEDGER"
  printf 'x' >"$LEDGER"
  expect_refused group-a "ledger is a file" no-ledger
fi

if smoke_case expired-lease-is-unleased; then
  fresh expired
  mkdir -p "$LEDGER"
  printf '{"seat":"%s","holder":"group-b","until":"2020-01-01T00:00:00Z"}' "$SEAT" >"$LEDGER/$SEAT.json"
  expect_issue group-a "past --until"
  as group-a status "$SEAT"
  [ "$(printf '%s' "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')" = expired ] ||
    fail "status does not show the expired lease: $OUT"
  as group-b transfer "$SEAT" --to group-a --until "$(future)"
  [ "$RC" = 3 ] || fail "transfer of an expired lease: rc=$RC, want 3"
  as group-b release "$SEAT"
  [ "$RC" = 3 ] || fail "release of an expired lease: rc=$RC, want 3"
  as group-a grant "$SEAT" --to group-a --until "$(future)"
  [ "$RC" = 0 ] || fail "grant over an expired lease: rc=$RC $ERR"
  expect_refused group-b "expired holder after re-grant" leased-elsewhere
fi

if smoke_case arguments-are-validated; then
  fresh args
  as group-a grant "$SEAT" --to group-b --until 2020-01-01T00:00:00Z
  [ "$RC" = 2 ] || fail "past --until: rc=$RC, want 2"
  as group-a grant "$SEAT" --to group-b --until 2030-01-01T00:00:00
  [ "$RC" = 2 ] || fail "zoneless --until: rc=$RC, want 2"
  as group-a grant "../$SEAT" --to group-b --until "$(future)"
  [ "$RC" = 2 ] || fail "path-shaped seat: rc=$RC, want 2"
  as group-a grant "$SEAT" --to "../x" --until "$(future)"
  [ "$RC" = 2 ] || fail "path-shaped group: rc=$RC, want 2"
  as group-a grant "$SEAT" --to group-b
  [ "$RC" = 2 ] || fail "grant without --until: rc=$RC, want 2"
  [ ! -e "$LEDGER" ] || [ -z "$(ls -A "$LEDGER" | grep -v '^\.lock$')" ] || fail "a refused grant wrote a lease"
fi

smoke_cases_done
[ "$FAILS" = 0 ] || { echo "$FAILS failure(s)" >&2; exit 1; }
echo "PASS smoke-seat-lease"
