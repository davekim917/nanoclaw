#!/usr/bin/env bash
# smoke-config-check.sh: required-key and cross-file agreement report over an
# install's gate config files, sourced as their wrappers source them and judged
# by the gates' own validator. Fictional install throughout.
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
# The layout prefixes are judged by the one validator the gate sources, never
# by a grammar or pattern of this script's own.
grep -q 'smoke-gate-layout.sh' "$GATE" && grep -q 'smoke-gate-layout.sh' "$CHECK" \
  && grep -q 'layout_prefix_problems' "$CHECK" && ! grep -Eq 'layout_prefix_ok|LAYOUT_PREFIX_RE|sed -n -E "s/\^' "$CHECK" \
  && ok "layout prefixes judged by smoke-gate-layout.sh alone" || fail "config-check re-implements the layout check"

# The gate's verdict on a config file, sourced the way its wrapper does.
gate_on() { # <file>
  env -i PATH="$PATH" bash -c '. "$1" >/dev/null 2>&1; SMOKE_GATE_STATE_DIR="$3" bash "$2" check 1' _ "$1" "$GATE" "$T/state" 2>/dev/null
}

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

# --- 4. What the gate sees after sourcing is what counts --------------------
# Set-but-empty is missing. Assign-then-unset and a non-literal reassignment
# fail here exactly as the gate refuses them.
write_env "$T/empty.sh" 'export SMOKE_GATE_BACKEND_PREFIX=""'
OUT="$(bash "$CHECK" "$T/empty.sh")"; RC=$?
[ "$RC" -eq 2 ] && jq -e '.files[0].missing == ["SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null \
  && ok "an empty value is missing" || fail "empty: rc=$RC out=$OUT"
write_env "$T/unset.sh" 'unset SMOKE_GATE_BACKEND_PREFIX'
OUT="$(bash "$CHECK" "$T/unset.sh")"; RC=$?; G="$(gate_on "$T/unset.sh")"; GRC=$?
[ "$RC" -eq 2 ] && jq -e '.files[0].missing == ["SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null \
  && [ "$GRC" -eq 2 ] && jq -e '.error == "gate misconfigured" and .missing == ["SMOKE_GATE_BACKEND_PREFIX"]' <<<"$G" >/dev/null \
  && ok "assign-then-unset fails here and at the gate" || fail "unset: rc=$RC out=$OUT gate rc=$GRC $G"
write_env "$T/nonlit.sh" 'export SMOKE_GATE_BACKEND_PREFIX="${API_ROOT:-}/api/"'
OUT="$(bash "$CHECK" "$T/nonlit.sh")"; RC=$?; G="$(gate_on "$T/nonlit.sh")"; GRC=$?
[ "$RC" -eq 2 ] && jq -e '.files[0].malformed == ["SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null \
  && [ "$GRC" -eq 2 ] && jq -e '.error == "gate misconfigured" and .missing == ["SMOKE_GATE_BACKEND_PREFIX"]' <<<"$G" >/dev/null \
  && ok "a non-literal reassignment fails here and at the gate" || fail "non-literal: rc=$RC out=$OUT gate rc=$GRC $G"
write_env "$T/unbound.sh" 'export SMOKE_GATE_BACKEND_PREFIX="${API_ROOT}/api/"'
OUT="$(bash "$CHECK" "$T/unbound.sh")"; RC=$?; G="$(gate_on "$T/unbound.sh")"; GRC=$?
[ "$RC" -eq 3 ] && jq -e '.ok == false and .error == "config file failed to source"' <<<"$OUT" >/dev/null && [ "$GRC" -ne 0 ] && [ -z "$G" ] \
  && ok "a file its wrapper cannot source (set -u, unbound) is refused" || fail "unbound: rc=$RC out=$OUT gate rc=$GRC"
# A clean shell: the caller's own environment never fills a gap in the file.
OUT="$(SMOKE_GATE_BACKEND_PREFIX=api/ bash "$CHECK" "$T/unset.sh")"; RC=$?
[ "$RC" -eq 2 ] && jq -e '.files[0].missing == ["SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null \
  && ok "the caller's environment is not inherited" || fail "env leak: rc=$RC out=$OUT"

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
write_env "$T/equal.sh" 'export SMOKE_GATE_FRONTEND_PREFIX="api/"'
OUT="$(bash "$CHECK" "$T/equal.sh")"; RC=$?; G="$(gate_on "$T/equal.sh")"; GRC=$?
[ "$RC" -eq 2 ] && jq -e '.files[0].malformed == ["SMOKE_GATE_FRONTEND_PREFIX","SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null \
  && [ "$GRC" -eq 2 ] && jq -e '.missing == ["SMOKE_GATE_FRONTEND_PREFIX","SMOKE_GATE_BACKEND_PREFIX"]' <<<"$G" >/dev/null \
  && ok "equal frontend and backend prefixes refused here and at the gate" || fail "equal: rc=$RC out=$OUT gate rc=$GRC $G"

# --- 6. Unreadable file: exit 3 ---------------------------------------------
OUT="$(bash "$CHECK" "$T/env.sh" "$T/absent.sh")"; RC=$?
[ "$RC" -eq 3 ] && jq -e '.ok == false and .path == "'"$T/absent.sh"'"' <<<"$OUT" >/dev/null \
  && ok "absent file refused" || fail "absent: rc=$RC out=$OUT"

# --- 7. A wrapper is judged at its exec; the gate it hands off to never starts --
printf '#!/usr/bin/env bash\ntouch "%s"\n' "$T/GATE_RAN" >"$T/fake-gate.sh"
write_env "$T/wrap-exec.sh" "exec bash $T/fake-gate.sh"
bash "$CHECK" "$T/wrap-exec.sh" >/dev/null; RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$T/GATE_RAN" ] && ok "exec hand-off reports instead of starting the gate" || fail "exec: rc=$RC gate ran: $([ -e "$T/GATE_RAN" ] && echo yes)"
write_env "$T/late.sh" "exec bash $T/fake-gate.sh" 'export SMOKE_GATE_REPO=""'
sed -i '/^export SMOKE_GATE_MIGRATIONS_PREFIX=/d' "$T/late.sh"; echo 'export SMOKE_GATE_MIGRATIONS_PREFIX="api/migrations/"' >>"$T/late.sh"
OUT="$(bash "$CHECK" "$T/late.sh")"; RC=$?
[ "$RC" -eq 2 ] && jq -e '.files[0].missing == ["SMOKE_GATE_MIGRATIONS_PREFIX"]' <<<"$OUT" >/dev/null \
  && ok "a key set after the exec is not the gate's" || fail "late: rc=$RC out=$OUT"

[ "$FAIL" -eq 0 ] && echo "PASS smoke-config-check.test.sh" || { echo "FAIL smoke-config-check.test.sh" >&2; exit 1; }
