#!/usr/bin/env bash
# Covers the harness security defect this wrapper closes: raw agent-browser
# network/HAR captures must never reach disk with a live Authorization
# header, cookie, session token, presigned-URL signature, or JWT-shaped
# string still readable — in either capture shape (`network requests`/
# `request --json`, and `network har stop`), and fail-closed (never echo raw
# bytes, never allowlist a body with no allowlist configured) throughout.
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

# No install allowlist file exists at the real default path in this sandbox,
# so tests that don't explicitly set AB_NET_REDACT_ALLOW_FILE are exercising
# the true "no config" fail-closed default. Tests that need an allowlisted
# route point at their own fixture file instead.
ALLOW_FILE="$WORKDIR/allow.txt"
printf '/depletions/\n# a comment line\n\n' > "$ALLOW_FILE"

reset_stubs() {
  unset STUB_REQUESTS_JSON STUB_REQUESTS_EXIT STUB_HAR_JSON STUB_HAR_FAIL AB_NET_REDACT_ALLOW_FILE 2>/dev/null || true
}

JWT='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuvwxyz012345'

# 1. Authorization header redacted (requests --json path)
reset_stubs
export STUB_REQUESTS_JSON='[{"url":"https://app.example.com/depletions/forecast","headers":{"Authorization":"Bearer abc.def.ghi","Accept":"application/json"}}]'
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -q "abc.def.ghi"; then fail "requests: live Authorization header value survived"; else pass "requests: Authorization header redacted"; fi
if echo "$OUT" | grep -q '"Authorization": "\[REDACTED\]"'; then pass "requests: Authorization header marked [REDACTED]"; else fail "requests: Authorization header not marked [REDACTED] ($OUT)"; fi

# 2. Cookie / Set-Cookie / newer credential header names all redacted
reset_stubs
export STUB_REQUESTS_JSON='[{"url":"https://app.example.com/depletions/forecast","headers":{"Cookie":"session=live-secret-value","X-Csrf-Token":"csrf-live-value"},"response":{"headers":{"Set-Cookie":"session=live-secret-value; HttpOnly"}}}]'
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -q "live-secret-value"; then fail "requests: live cookie value survived"; else pass "requests: Cookie/Set-Cookie redacted"; fi
if echo "$OUT" | grep -q "csrf-live-value"; then fail "requests: X-Csrf-Token value survived"; else pass "requests: X-Csrf-Token header redacted"; fi

# 3. JWT-shaped string in body and in URL
reset_stubs
export AB_NET_REDACT_ALLOW_FILE="$ALLOW_FILE"
export STUB_REQUESTS_JSON="[{\"url\":\"https://app.example.com/depletions/forecast\",\"postData\":\"{\\\"note\\\":\\\"tok $JWT\\\"}\"}]"
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -qF "$JWT"; then fail "requests: JWT-shaped string in allowlisted body survived"; else pass "requests: JWT-shaped string in body redacted"; fi

reset_stubs
export STUB_REQUESTS_JSON="[{\"url\":\"https://app.example.com/callback?access_token=$JWT\"}]"
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -qF "$JWT"; then fail "requests: JWT-shaped string in URL survived"; else pass "requests: JWT-shaped string in URL redacted"; fi

# 4. Allowlist is install config, fail-closed by default:
#    (a) no AB_NET_REDACT_ALLOW_FILE set (default path doesn't exist here) ->
#        even a route that WOULD be allowlisted with config drops its body.
#    (b) same route, with an allowlist file granting it -> body is scrubbed,
#        not dropped.
reset_stubs
export STUB_REQUESTS_JSON='[{"url":"https://app.example.com/depletions/forecast","postData":"{\"password\":\"hunter2\",\"note\":\"ok\"}"}]'
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -q "DROPPED-NOT-ALLOWLISTED"; then pass "requests: no allow-file configured -> body dropped by default (fail closed)"; else fail "requests: body was not dropped with no allowlist configured ($OUT)"; fi
if echo "$OUT" | grep -q "hunter2\|\"ok\""; then fail "requests: body content survived with no allowlist configured"; fi

reset_stubs
export AB_NET_REDACT_ALLOW_FILE="$ALLOW_FILE"
export STUB_REQUESTS_JSON='[{"url":"https://app.example.com/depletions/forecast","postData":"{\"password\":\"hunter2\",\"note\":\"ok\"}"}]'
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -q "hunter2"; then fail "requests: credential-shaped body key survived on an allowlisted route"; else pass "requests: credential key redacted on an allowlisted route"; fi
if echo "$OUT" | grep -q '\\"ok\\"'; then pass "requests: non-credential body content retained on an allowlisted route"; else fail "requests: allowlisted body was dropped instead of scrubbed ($OUT)"; fi

# 4b. A route that isn't in the allow file still gets its body dropped even
#     when an allow file IS configured (allowlist is an allowlist, not a
#     switch that opens every route once any file exists).
reset_stubs
export AB_NET_REDACT_ALLOW_FILE="$ALLOW_FILE"
export STUB_REQUESTS_JSON='[{"url":"https://app.example.com/some/other/route","postData":"{\"password\":\"hunter2\"}"}]'
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -q "hunter2"; then fail "requests: non-allowlisted body content survived"; else pass "requests: non-allowlisted body dropped even with an allow file present"; fi

# 5. Credential-shaped query params in a plain URL string: opaque access_token
#    and a presigned S3 URL's signature/credential/security-token.
reset_stubs
export STUB_REQUESTS_JSON='[{"url":"https://app.example.com/reports?access_token=opaque123&other=keep-me"}]'
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -q "opaque123"; then fail "requests: opaque access_token query param survived"; else pass "requests: opaque access_token query param redacted"; fi
if echo "$OUT" | grep -q "keep-me"; then pass "requests: unrelated query param left intact"; else fail "requests: unrelated query param was dropped too"; fi

reset_stubs
S3URL='https://bucket.s3.amazonaws.com/assets/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260101&X-Amz-Security-Token=liveSecurityTokenValue&X-Amz-Signature=liveSignatureValue'
export STUB_REQUESTS_JSON="[{\"url\":\"$S3URL\"}]"
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
if echo "$OUT" | grep -q "liveSecurityTokenValue\|liveSignatureValue\|AKIAEXAMPLE"; then fail "requests: presigned S3 URL credential material survived"; else pass "requests: presigned S3 URL signature/credential/security-token redacted"; fi

# 5b. Same two cases inside a HAR request.url string.
reset_stubs
export STUB_HAR_JSON="{\"log\":{\"entries\":[{\"request\":{\"url\":\"$S3URL\"},\"response\":{}}]}}"
OUT_PATH_S3="$WORKDIR/s3.har.json"
"$WRAPPER" har-stop "$OUT_PATH_S3" >/dev/null 2>/dev/null
if [ -s "$OUT_PATH_S3" ] && grep -q "liveSecurityTokenValue\|liveSignatureValue\|AKIAEXAMPLE" "$OUT_PATH_S3"; then
  fail "har-stop: presigned S3 URL credential material survived in request.url"
else
  pass "har-stop: presigned S3 URL redacted in request.url"
fi

# 6. har-stop: HAR with Authorization header, cookie pair, and JWT in an
#    allowlisted postData.text all redacted in the output; raw temp file
#    does not survive.
reset_stubs
export AB_NET_REDACT_ALLOW_FILE="$ALLOW_FILE"
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

# 7. Fail-closed: unparsable capture is dropped, never echoed, non-zero exit
reset_stubs
export STUB_REQUESTS_JSON='not json at all, just text with a Bearer abc123 and eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoxfQ.notarealsig'
set +e
OUT="$("$WRAPPER" requests --json 2>/dev/null)"
RC=$?
set -e 2>/dev/null || true
if [ "$RC" -ne 0 ]; then pass "requests: unparsable capture exits non-zero"; else fail "requests: unparsable capture exited 0"; fi
if echo "$OUT" | grep -q "abc123\|notarealsig"; then fail "requests: unparsable capture echoed raw content"; else pass "requests: unparsable capture never echoed raw content"; fi

# 7b. Fail-closed for har-stop: agent-browser itself fails -> no output file
reset_stubs
export STUB_HAR_FAIL=1
OUT_PATH2="$WORKDIR/should-not-exist.json"
set +e
"$WRAPPER" har-stop "$OUT_PATH2" >/dev/null 2>/dev/null
RC=$?
set -e 2>/dev/null || true
if [ "$RC" -ne 0 ]; then pass "har-stop: agent-browser failure surfaces non-zero"; else fail "har-stop: agent-browser failure was swallowed"; fi
if [ -e "$OUT_PATH2" ]; then fail "har-stop: output path exists despite capture failure"; else pass "har-stop: no output file on capture failure"; fi

# 8. Back-compat calling form: pre-v5 callers pass no subcommand at all
#    (`ab-net-redact.sh --session <name> ...`), which historically always
#    meant `network requests --json`.
reset_stubs
export STUB_REQUESTS_JSON='[{"url":"https://app.example.com/depletions/forecast","headers":{"Authorization":"Bearer abc.def.ghi"}}]'
OUT="$("$WRAPPER" --session myapp 2>/dev/null)"
if echo "$OUT" | grep -q "abc.def.ghi"; then fail "back-compat: live Authorization header value survived"; else pass "back-compat: no-subcommand form redacts same as 'requests'"; fi

if [ "$FAIL" -ne 0 ]; then
  echo "--- FAILED ---"
  exit 1
fi
echo "--- all ab-net-redact tests passed ---"
