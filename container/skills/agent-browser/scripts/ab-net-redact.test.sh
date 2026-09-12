#!/usr/bin/env bash
# Covers the harness security defect this wrapper closes: raw agent-browser
# network/HAR captures must never reach disk with a live Authorization
# header, cookie, or JWT-shaped string still readable — in either capture
# shape (`network requests`/`request --json`, and `network har stop`), and
# fail-closed (never echo raw bytes) when a capture can't be parsed.
#
# `agent-browser` is stubbed via PATH so this runs offline, same pattern as
# smoke-build-identity.test.sh.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/ab-net-redact.sh"

STUB_BIN="$(mktemp -d)"
WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "$STUB_BIN" "$WORKDIR"; }
trap cleanup EXIT

FAIL=0
pass() { echo "ok - $1"; }
fail() { echo "FAIL - $1"; FAIL=1; }

# --- stub agent-browser: `network requests|request --json ...` prints
#     $STUB_REQUESTS_JSON to stdout; `network har stop <path> ...` writes
#     $STUB_HAR_JSON to <path> (or fails if STUB_HAR_FAIL=1).
cat > "$STUB_BIN/agent-browser" <<'STUB'
#!/usr/bin/env bash
set -u
EMPTY_OBJ='{}'
if [ "${1:-}" = "network" ]; then
  case "${2:-}" in
    requests|request)
      printf '%s' "${STUB_REQUESTS_JSON:-$EMPTY_OBJ}"
      exit "${STUB_REQUESTS_EXIT:-0}"
      ;;
    har)
      if [ "${3:-}" = "stop" ]; then
        OUT="${4:-}"
        if [ "${STUB_HAR_FAIL:-0}" = "1" ]; then
          exit 1
        fi
        printf '%s' "${STUB_HAR_JSON:-$EMPTY_OBJ}" > "$OUT"
        exit 0
      fi
      ;;
  esac
fi
exit 1
STUB
chmod +x "$STUB_BIN/agent-browser"
export PATH="$STUB_BIN:$PATH"

reset_stubs() {
  unset STUB_REQUESTS_JSON STUB_REQUESTS_EXIT STUB_HAR_JSON STUB_HAR_FAIL 2>/dev/null || true
}

# 1. Authorization header redacted (requests --json path)
reset_stubs
export STUB_REQUESTS_JSON='[{"url":"https://app.example.com/depletions/forecast","headers":{"Authorization":"Bearer abc.def.ghi","Accept":"application/json"}}]'
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -q "abc.def.ghi"; then fail "requests: live Authorization header value survived"; else pass "requests: Authorization header redacted"; fi
if echo "$OUT" | grep -q '"Authorization": "\[REDACTED\]"'; then pass "requests: Authorization header marked [REDACTED]"; else fail "requests: Authorization header not marked [REDACTED] ($OUT)"; fi

# 2. Cookie / Set-Cookie redacted
reset_stubs
export STUB_REQUESTS_JSON='[{"url":"https://app.example.com/depletions/forecast","headers":{"Cookie":"session=live-secret-value"},"response":{"headers":{"Set-Cookie":"session=live-secret-value; HttpOnly"}}}]'
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -q "live-secret-value"; then fail "requests: live cookie value survived"; else pass "requests: Cookie/Set-Cookie redacted"; fi

# 3. JWT-shaped string in an allowlisted body, and in a non-allowlisted URL
reset_stubs
JWT='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuvwxyz012345'
export STUB_REQUESTS_JSON="[{\"url\":\"https://app.example.com/depletions/forecast\",\"postData\":\"{\\\"note\\\":\\\"tok $JWT\\\"}\"}]"
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -qF "$JWT"; then fail "requests: JWT-shaped string in allowlisted body survived"; else pass "requests: JWT-shaped string in body redacted"; fi

reset_stubs
export STUB_REQUESTS_JSON="[{\"url\":\"https://app.example.com/callback?access_token=$JWT\"}]"
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -qF "$JWT"; then fail "requests: JWT-shaped string in URL survived"; else pass "requests: JWT-shaped string in URL redacted"; fi

# 4. Non-allowlisted body dropped outright (not just header-scrubbed)
reset_stubs
export STUB_REQUESTS_JSON='[{"url":"https://app.example.com/some/other/route","postData":"{\"password\":\"hunter2\"}"}]'
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -q "hunter2"; then fail "requests: non-allowlisted body content survived"; else pass "requests: non-allowlisted body dropped"; fi

# 5. har-stop: HAR with Authorization header, cookie pair, and JWT in an
#    allowlisted postData.text all redacted in the output; raw temp file
#    does not survive.
reset_stubs
export STUB_HAR_JSON=$(cat <<EOF
{"log":{"entries":[{"request":{"url":"https://app.example.com/depletions/summary","headers":[{"name":"Authorization","value":"Bearer $JWT"}],"cookies":[{"name":"session","value":"live-secret-value"}],"postData":{"mimeType":"application/json","text":"{\"note\":\"$JWT\"}"}},"response":{"headers":[{"name":"Set-Cookie","value":"session=live-secret-value"}],"content":{"mimeType":"application/json","text":"{\"ok\":true}"}}}]}}
EOF
)
BEFORE_TMP=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'ab-net-raw.*' 2>/dev/null | wc -l)
OUT_PATH="$WORKDIR/capture.har.json"
if "$WRAPPER" har-stop "$OUT_PATH" >/dev/null 2>"$WORKDIR/har.err"; then
  pass "har-stop: wrapper exited 0"
else
  fail "har-stop: wrapper failed unexpectedly ($(cat "$WORKDIR/har.err"))"
fi
if [ -s "$OUT_PATH" ]; then
  CONTENT="$(cat "$OUT_PATH")"
  if echo "$CONTENT" | grep -qF "live-secret-value" || echo "$CONTENT" | grep -qF "$JWT"; then
    fail "har-stop: redacted output still contains a live credential"
  else
    pass "har-stop: Authorization/cookie/JWT redacted in HAR output"
  fi
else
  fail "har-stop: no output file written"
fi
AFTER_TMP=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'ab-net-raw.*' 2>/dev/null | wc -l)
if [ "$AFTER_TMP" -le "$BEFORE_TMP" ]; then pass "har-stop: raw HAR temp file cleaned up"; else fail "har-stop: raw HAR temp file left behind"; fi

# 6. Fail-closed: unparsable capture is dropped, never echoed, non-zero exit
reset_stubs
export STUB_REQUESTS_JSON='not json at all, just text with a Bearer abc123 and eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoxfQ.notarealsig'
set +e
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
RC=$?
set -e 2>/dev/null || true
if [ "$RC" -ne 0 ]; then pass "requests: unparsable capture exits non-zero"; else fail "requests: unparsable capture exited 0"; fi
if echo "$OUT" | grep -q "abc123\|notarealsig"; then fail "requests: unparsable capture echoed raw content"; else pass "requests: unparsable capture never echoed raw content"; fi

# 6b. Fail-closed for har-stop: agent-browser itself fails -> no output file
reset_stubs
export STUB_HAR_FAIL=1
OUT_PATH2="$WORKDIR/should-not-exist.json"
set +e
"$WRAPPER" har-stop "$OUT_PATH2" >/dev/null 2>/dev/null
RC=$?
set -e 2>/dev/null || true
if [ "$RC" -ne 0 ]; then pass "har-stop: agent-browser failure surfaces non-zero"; else fail "har-stop: agent-browser failure was swallowed"; fi
if [ -e "$OUT_PATH2" ]; then fail "har-stop: output path exists despite capture failure"; else pass "har-stop: no output file on capture failure"; fi

if [ "$FAIL" -ne 0 ]; then
  echo "--- FAILED ---"
  exit 1
fi
echo "--- all ab-net-redact tests passed ---"
