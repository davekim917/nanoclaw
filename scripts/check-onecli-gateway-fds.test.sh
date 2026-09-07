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
# tick. Invalid config exits before touching docker, so these stay hermetic.
expect_reject() { # <label> <VAR=value> <expected substring>
  local out
  if out="$(env "$2" DRY_RUN=1 bash "$TARGET" 2>&1)"; then
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

expect_reject "RESTART_PCT non-numeric"  RESTART_PCT=70%    "RESTART_PCT must be an integer 1-100"
expect_reject "RESTART_PCT zero"         RESTART_PCT=0      "RESTART_PCT must be 1-100"
expect_reject "RESTART_PCT over 100"     RESTART_PCT=101    "RESTART_PCT must be 1-100"
# Empty is NOT invalid — `${RESTART_PCT:-70}` treats it as unset, matching
# src/env.ts (`if (value)`: an empty value means not set). Assert the fallback
# rather than a rejection, so nobody "fixes" this into an error later.
out="$(env RESTART_PCT= DRY_RUN=1 bash "$TARGET" 2>&1 || true)"
case "$out" in
  *"RESTART_PCT must be"*)
    fail=$((fail + 1)); printf 'FAIL: empty RESTART_PCT should fall back to the default, not be refused\n' >&2 ;;
  *) pass=$((pass + 1)) ;;
esac

expect_reject "SETTLE_SECONDS bad"       SETTLE_SECONDS=abc "SETTLE_SECONDS must be an integer 1-300"
expect_reject "SETTLE_SECONDS zero"      SETTLE_SECONDS=0   "SETTLE_SECONDS must be 1-300"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
