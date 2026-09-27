#!/usr/bin/env bash
# smoke-config-check.sh: required-key and cross-file agreement report over an
# install's gate config files, read as data. Fictional install throughout.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/smoke-config-check.sh"
GATE="$SCRIPT_DIR/smoke-pr-gate.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAIL=0
fail() { echo "  FAIL $1" >&2; FAIL=1; }
ok() { echo "  ok   $1"; }

# --- 1. The required set is the gate's own list, at both of its sites -------
GATE_LISTS="$(sed -n -E 's/^[[:space:]]*for k in (.*); do$/\1/p' "$GATE" | sort -u)"
[ "$(wc -l <<<"$GATE_LISTS")" -eq 1 ] || fail "smoke-pr-gate.sh's required-key loops disagree: $GATE_LISTS"
CHECK_LIST="$(sed -n -E 's/^GATE_REQUIRED="(.*)"$/\1/p' "$CHECK")"
[ "$GATE_LISTS" = "$CHECK_LIST" ] && ok "required set pinned to smoke-pr-gate.sh" \
  || fail "required set drift: gate [$GATE_LISTS] check [$CHECK_LIST]"
# The layout prefixes come from the one validator both scripts source.
grep -q 'smoke-gate-layout.sh' "$GATE" && grep -q 'smoke-gate-layout.sh' "$CHECK" \
  && grep -q '^REQUIRED="\$GATE_REQUIRED \$LAYOUT_PREFIX_KEYS"$' "$CHECK" \
  && ok "layout prefixes come from smoke-gate-layout.sh in both" || fail "layout prefixes not shared through smoke-gate-layout.sh"

write_env() { # <file> <extra lines...>
  local f="$1"; shift
  {
    echo '#!/usr/bin/env bash'
    echo '# fictional install'
    echo 'set -u'
    echo 'export SMOKE_GATE_REPO="acme/widget"'
    echo "export SMOKE_GATE_BACKEND_SERVICE='srv-acme-api'"
    echo 'export SMOKE_GATE_FRONTEND_SERVICE=srv-acme-web  # bare token'
    echo 'export SMOKE_GATE_FRONTEND_PREFIX="web/"'
    echo 'export SMOKE_GATE_BACKEND_PREFIX="api/"'
    echo 'export SMOKE_GATE_MIGRATIONS_PREFIX="api/migrations/"'
    printf '%s\n' "$@"
  } >"$f"
}

# --- 2. Two complete, agreeing files: ok, exit 0, no value in the output ----
write_env "$T/env.sh"
write_env "$T/wrapper.sh" 'export SMOKE_GATE_STATE_DIR="/workspace/agent/other"' 'exec bash /app/skills/smoke-test/scripts/smoke-develop-gate.sh "$@"'
OUT="$(bash "$CHECK" "$T/env.sh" "$T/wrapper.sh")"; RC=$?
[ "$RC" -eq 0 ] && jq -e '.ok == true and (.files | length == 2) and (.files | all(.missing == [])) and .mismatched == []' <<<"$OUT" >/dev/null \
  && ok "complete agreeing files pass" || fail "complete files: rc=$RC out=$OUT"
grep -Eq 'acme|web/|api/' <<<"$OUT" && fail "output leaked a value: $OUT" || ok "names only, no values"

# --- 3. A missing key is named for its file only; exit 2 --------------------
write_env "$T/short.sh"
sed -i '/SMOKE_GATE_MIGRATIONS_PREFIX/d' "$T/short.sh"
OUT="$(bash "$CHECK" "$T/env.sh" "$T/short.sh")"; RC=$?
[ "$RC" -eq 2 ] && jq -e '.ok == false and .files[0].missing == [] and .files[1].missing == ["SMOKE_GATE_MIGRATIONS_PREFIX"] and .mismatched == []' <<<"$OUT" >/dev/null \
  && ok "missing key named per file" || fail "missing: rc=$RC out=$OUT"

# --- 4. Set-but-empty and non-literal values count as missing ---------------
write_env "$T/empty.sh" 'export SMOKE_GATE_BACKEND_PREFIX=""'
sed -i 's|^export SMOKE_GATE_FRONTEND_PREFIX="web/"$|export SMOKE_GATE_FRONTEND_PREFIX="${ROOT}/web/"|' "$T/empty.sh"
OUT="$(bash "$CHECK" "$T/empty.sh")"; RC=$?
[ "$RC" -eq 2 ] && jq -e '.files[0].missing == ["SMOKE_GATE_FRONTEND_PREFIX","SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null \
  && ok "empty and \$-expanding values are not configuration" || fail "empty/non-literal: rc=$RC out=$OUT"

# --- 5. Files that disagree on a required key: mismatched, exit 2 -----------
write_env "$T/other.sh" 'export SMOKE_GATE_BACKEND_PREFIX="server/"'
OUT="$(bash "$CHECK" "$T/env.sh" "$T/other.sh")"; RC=$?
[ "$RC" -eq 2 ] && jq -e '.ok == false and .mismatched == ["SMOKE_GATE_BACKEND_PREFIX"] and (.files | all(.missing == []))' <<<"$OUT" >/dev/null \
  && ok "cross-file disagreement named" || fail "mismatch: rc=$RC out=$OUT"
grep -q 'server/' <<<"$OUT" && fail "mismatch output leaked a value" || true

# --- 5b. A prefix without its trailing "/" is malformed, as the gate reads it --
write_env "$T/noslash.sh" 'export SMOKE_GATE_MIGRATIONS_PREFIX="api/migrations"'
OUT="$(bash "$CHECK" "$T/noslash.sh")"; RC=$?
[ "$RC" -eq 2 ] && jq -e '.ok == false and .files[0].missing == [] and .files[0].malformed == ["SMOKE_GATE_MIGRATIONS_PREFIX"]' <<<"$OUT" >/dev/null \
  && ok "prefix without trailing / named malformed" || fail "malformed: rc=$RC out=$OUT"
write_env "$T/dotted.sh" 'export SMOKE_GATE_FRONTEND_PREFIX="./web/"' 'export SMOKE_GATE_BACKEND_PREFIX="/api/"'
OUT="$(bash "$CHECK" "$T/dotted.sh")"; RC=$?
[ "$RC" -eq 2 ] && jq -e '.files[0].malformed == ["SMOKE_GATE_FRONTEND_PREFIX","SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null \
  && ok "non-relative prefixes named malformed" || fail "non-relative: rc=$RC out=$OUT"

# --- 6. Unreadable file: exit 3 ---------------------------------------------
OUT="$(bash "$CHECK" "$T/env.sh" "$T/absent.sh")"; RC=$?
[ "$RC" -eq 3 ] && jq -e '.ok == false and .path == "'"$T/absent.sh"'"' <<<"$OUT" >/dev/null \
  && ok "absent file refused" || fail "absent: rc=$RC out=$OUT"

# --- 7. The file is data: a command in it never runs ------------------------
write_env "$T/trap.sh" "touch $T/RAN"
bash "$CHECK" "$T/trap.sh" >/dev/null; [ ! -e "$T/RAN" ] && ok "file never sourced" || fail "config file was executed"

[ "$FAIL" -eq 0 ] && echo "PASS smoke-config-check.test.sh" || { echo "FAIL smoke-config-check.test.sh" >&2; exit 1; }
