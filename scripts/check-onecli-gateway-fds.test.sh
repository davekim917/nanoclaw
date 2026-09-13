#!/bin/bash
# Parity test for the watchdog's .env parser.
#
# check-onecli-gateway-fds.sh mirrors src/env.ts:24-36 in awk instead of calling
# it, because the real parser is TypeScript and resolving the container name
# runs on every timer tick (see the comment on read_env_value). A mirror that
# drifts is worse than no mirror: the host would read one container name and the
# watchdog another, and the watchdog would exit on every check while reporting
# nothing — the silent-failure mode it exists to prevent.
#
# So these vectors are the SAME ones src/env-file.test.ts asserts against the
# real parser, plus the trailing-whitespace cases that motivated this fix.
#
# Run: bash scripts/check-onecli-gateway-fds.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/check-onecli-gateway-fds.sh"
[ -f "$TARGET" ] || { echo "FAIL: $TARGET not found" >&2; exit 1; }

# Pull the real function out of the watchdog rather than restating it here —
# a copy would pass while the script it is supposed to guard drifts away.
FN="$(sed -n '/^read_env_value() {$/,/^}$/p' "$TARGET")"
[ -n "$FN" ] || { echo "FAIL: read_env_value() not found in $TARGET" >&2; exit 1; }
eval "$FN"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ENVF="$TMP/.env"

pass=0; fail=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: %s\n  expected: [%s]\n  actual:   [%s]\n' "$1" "$2" "$3" >&2
  fi
}

# --- vectors mirrored from src/env-file.test.ts:30-48 ---
{
  echo '# leading comment'
  echo ''
  echo 'ENVF_PLAIN=value1'
  echo '  ENVF_INDENTED = spaced '
  echo 'ENVF_DQUOTED="double quoted"'
  echo "ENVF_SQUOTED='single quoted'"
  echo 'ENVF_EMPTY='
  echo '# ENVF_COMMENTED=nope'
  echo 'NOT_AN_ASSIGNMENT'
} > "$ENVF"

check "plain"           "value1"          "$(read_env_value ENVF_PLAIN "$ENVF")"
check "indented+spaced" "spaced"          "$(read_env_value ENVF_INDENTED "$ENVF")"
check "double quoted"   "double quoted"   "$(read_env_value ENVF_DQUOTED "$ENVF")"
check "single quoted"   "single quoted"   "$(read_env_value ENVF_SQUOTED "$ENVF")"
check "empty is unset"  ""                "$(read_env_value ENVF_EMPTY "$ENVF")"
check "commented out"   ""                "$(read_env_value ENVF_COMMENTED "$ENVF")"
check "not assignment"  ""                "$(read_env_value NOT_AN_ASSIGNMENT "$ENVF")"
check "absent key"      ""                "$(read_env_value ENVF_MISSING "$ENVF")"

# --- the cases that motivated this fix (round 2 review) ---
printf 'ONECLI_GATEWAY_CONTAINER=custom-gw   \n' > "$ENVF"
check "trailing ws, bare"   "custom-gw" "$(read_env_value ONECLI_GATEWAY_CONTAINER "$ENVF")"

printf 'ONECLI_GATEWAY_CONTAINER="custom-gw"   \n' > "$ENVF"
check "trailing ws, quoted" "custom-gw" "$(read_env_value ONECLI_GATEWAY_CONTAINER "$ENVF")"

# --- last assignment wins, matching env.ts's overwrite loop ---
printf 'K=first\nK=second\n' > "$ENVF"
check "last wins"           "second"    "$(read_env_value K "$ENVF")"

# --- an unbalanced quote is a literal, not a strip (env.ts requires both ends) ---
printf 'K="unbalanced\n' > "$ENVF"
check "unbalanced quote"    '"unbalanced' "$(read_env_value K "$ENVF")"

# --- a value containing '=' keeps everything after the first one ---
printf 'K=a=b=c\n' > "$ENVF"
check "equals in value"     "a=b=c"     "$(read_env_value K "$ENVF")"

# --- a missing file is not an error, just unset ---
check "missing file"        ""          "$(read_env_value K "$TMP/nope.env")"

# --- Config validation (runs the real script) ---
# A malformed override must be refused BEFORE the comparison that uses it:
# `[ 5 -lt 70% ]` returns status 2, and because it is an `if` condition `set -e`
# does not stop the script — it falls through and restarts the gateway on every
# tick. Every invocation below uses deterministic command shims, so a future
# ordering regression cannot turn this test into a production-daemon probe.
expect_reject() { # <label> <VAR=value> <expected substring>
  local out
  if out="$(run_watchdog "$2" DRY_RUN=1 2>&1)"; then
    fail=$((fail + 1))
    printf 'FAIL: %s — accepted, should have been refused\n' "$1" >&2
    return
  fi
  case "$out" in
    *"$3"*) pass=$((pass + 1)) ;;
    *) fail=$((fail + 1))
       printf 'FAIL: %s\n  wanted substring: [%s]\n  got: [%s]\n' "$1" "$3" "$out" >&2 ;;
  esac
}

# Empty is NOT invalid — `${RESTART_PCT:-70}` treats it as unset, matching
# src/env.ts (`if (value)`: an empty value means not set). Exercise the real
# default comparison using deterministic command shims: the script must reach
# its 70%-threshold DRY_RUN branch without talking to the production daemon.
WATCHDOG_STUBS="$TMP/watchdog-stubs"
WATCHDOG_LOG="$TMP/watchdog-stub.log"
mkdir -p "$WATCHDOG_STUBS" "$TMP/watchdog-home" "$TMP/watchdog-nanoclaw"

cat > "$WATCHDOG_STUBS/docker" <<'STUB'
#!/bin/bash
set -eu
printf '%s\n' "$*" >> "${WATCHDOG_STUB_LOG:?}"
case "${1:-}" in
  inspect)
    case " $* " in
      *'{{.State.Pid}}'*) printf '1\n' ;;
      *'{{.State.Health.Status}}'*) printf 'healthy\n' ;;
      *) printf '{}\n' ;;
    esac
    ;;
  top) printf 'root %s 0 0 0 0 0 onecli-gateway\n' "${WATCHDOG_TEST_PID:?}" ;;
  restart) printf 'unexpected restart\n' >&2; exit 99 ;;
  *) printf 'unexpected docker invocation: %s\n' "$*" >&2; exit 99 ;;
esac
STUB
cat > "$WATCHDOG_STUBS/ls" <<'STUB'
#!/bin/bash
set -eu
if [ "${1:-}" = "/proc/${WATCHDOG_TEST_PID:?}/fd" ]; then
  for _ in $(seq 1 70); do printf 'fd\n'; done
  exit 0
fi
exec /bin/ls "$@"
STUB
cat > "$WATCHDOG_STUBS/awk" <<'STUB'
#!/bin/bash
set -eu
for arg in "$@"; do
  if [ "$arg" = "/proc/${WATCHDOG_TEST_PID:?}/limits" ]; then
    printf '100\n'
    exit 0
  fi
done
exec /usr/bin/awk "$@"
STUB
cat > "$WATCHDOG_STUBS/nsenter" <<'STUB'
#!/bin/bash
set -eu
printf 'ESTAB 0 0 127.0.0.1:1 127.0.0.1:2\nCLOSE-WAIT 0 0 127.0.0.1:3 127.0.0.1:4\n'
STUB
chmod +x "$WATCHDOG_STUBS/docker" "$WATCHDOG_STUBS/ls" "$WATCHDOG_STUBS/awk" "$WATCHDOG_STUBS/nsenter"

run_watchdog() {
  env -i \
    PATH="$WATCHDOG_STUBS:/usr/bin:/bin" \
    HOME="$TMP/watchdog-home" \
    NANOCLAW_DIR="$TMP/watchdog-nanoclaw" \
    ONECLI_GATEWAY_CONTAINER=test-onecli \
    WATCHDOG_STUB_LOG="$WATCHDOG_LOG" \
    WATCHDOG_TEST_PID="$$" \
    "$@" \
    bash "$TARGET"
}

expect_reject "RESTART_PCT non-numeric"  RESTART_PCT=70%    "RESTART_PCT must be an integer 1-100"
expect_reject "RESTART_PCT zero"         RESTART_PCT=0      "RESTART_PCT must be 1-100"
expect_reject "RESTART_PCT over 100"     RESTART_PCT=101    "RESTART_PCT must be 1-100"

: > "$WATCHDOG_LOG"
if ! out="$(run_watchdog RESTART_PCT= DRY_RUN=1 2>&1)"; then
  fail=$((fail + 1))
  printf 'FAIL: empty RESTART_PCT default run exited nonzero\n%s\n' "$out" >&2
else
  if [[ "$out" == *'fds=70/100 (70%)'* && "$out" == *'threshold=70%'* && "$out" == *"DRY_RUN=1, would restart 'test-onecli'"* ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: empty RESTART_PCT did not reach default threshold branch\n%s\n' "$out" >&2
  fi
fi
grep -q '^inspect test-onecli$' "$WATCHDOG_LOG" \
  && grep -q '^top test-onecli$' "$WATCHDOG_LOG" \
  && ! grep -q '^restart ' "$WATCHDOG_LOG" \
  || { fail=$((fail + 1)); printf 'FAIL: default run did not stay inside the deterministic docker shim\n' >&2; }

expect_reject "RECOVER_WAIT_S bad"      RECOVER_WAIT_S=abc "RECOVER_WAIT_S must be an integer 1-300"
expect_reject "RECOVER_WAIT_S zero"     RECOVER_WAIT_S=0   "RECOVER_WAIT_S must be 1-300"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
