#!/usr/bin/env bash
# Happy path, expected host absent, stale host present, bundle path
# unextractable, and the pr1142 case (backend unreachable but frontend fine).
# curl is stubbed via PATH so every scenario runs offline, same pattern as
# smoke-pr-gate.test.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/smoke-build-identity.sh"

STUB_BIN="$(mktemp -d)"
cleanup() { rm -rf "$STUB_BIN"; }
trap cleanup EXIT

cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
set -u
[ -n "${STUB_HTML+x}" ] || STUB_HTML='<html><head></head><body><script type="module" src="/assets/index-ABC123.js"></script></body></html>'
[ -n "${STUB_HTML_EXIT+x}" ] || STUB_HTML_EXIT=0
[ -n "${STUB_BUNDLE+x}" ] || STUB_BUNDLE='fetch("https://xzo-dev-backend-pr-42.onrender.com/api")'
[ -n "${STUB_BUNDLE_EXIT+x}" ] || STUB_BUNDLE_EXIT=0
[ -n "${STUB_HEALTHZ_CODE+x}" ] || STUB_HEALTHZ_CODE=200
ARGS="$*"
if printf '%s' "$ARGS" | grep -qF '/healthz'; then
  if [ "$STUB_HEALTHZ_CODE" = "200" ]; then printf '200'; exit 0; else exit 22; fi
fi
if printf '%s' "$ARGS" | grep -qE '\.js($| )'; then
  printf '%s' "$STUB_BUNDLE"; exit "$STUB_BUNDLE_EXIT"
fi
printf '%s' "$STUB_HTML"; exit "$STUB_HTML_EXIT"
STUB
chmod +x "$STUB_BIN/curl"
export PATH="$STUB_BIN:$PATH"

reset_stubs() {
  unset STUB_HTML STUB_HTML_EXIT STUB_BUNDLE STUB_BUNDLE_EXIT STUB_HEALTHZ_CODE \
        SMOKE_BUILD_ID_STALE_HOSTS SMOKE_BUILD_ID_BUNDLE_PATTERN 2>/dev/null || true
}

FRONTEND="https://xzo-dev-react-pr-42.onrender.com"
BACKEND="https://xzo-dev-backend-pr-42.onrender.com"

# --- usage: missing args ----------------------------------------------------
OUT="$(bash "$SCRIPT" 2>&1 || true)"
jq -e '.ok == false and (.error | test("usage"))' <<<"$OUT" >/dev/null

# --- 1. Happy path: expected host present, no stale hosts, backend up ------
reset_stubs
export SMOKE_BUILD_ID_STALE_HOSTS='api.legacy.example'
if bash "$SCRIPT" "$FRONTEND" "$BACKEND" > "$STUB_BIN/out1.json"; then
  RC=0
else
  RC=$?
fi
[ "$RC" -eq 0 ] || { echo "expected happy path to exit 0, got $RC: $(cat "$STUB_BIN/out1.json")" >&2; exit 1; }
jq -e '
  .ok == true and
  .expectedHost == "xzo-dev-backend-pr-42.onrender.com" and
  .expectedHostCount == 1 and
  .staleHostsFound == {} and
  .backendReachable == true and
  .backendHttpCode == "200" and
  .reason == null and
  (.bundleUrl | test("assets/index-ABC123.js$"))
' "$STUB_BIN/out1.json" >/dev/null

# --- 2. Expected host absent: bundle never mentions the assigned backend ---
reset_stubs
export STUB_BUNDLE='fetch("/api/local")'
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 1 ] || { echo "expected exit 1 for absent host, got $RC" >&2; exit 1; }
jq -e '.ok == false and .expectedHostCount == 0 and (.reason | test("does not appear"))' <<<"$OUT" >/dev/null

# --- 3. Stale host present: bundle references the wrong/shared-dev host ----
reset_stubs
export STUB_BUNDLE='fetch("https://xzo-dev-backend-pr-42.onrender.com/api"); fetch("https://api.legacy.example/legacy")'
export SMOKE_BUILD_ID_STALE_HOSTS='api.legacy.example,another.stale.example'
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 1 ] || { echo "expected exit 1 for stale host, got $RC" >&2; exit 1; }
jq -e '
  .ok == false and
  .staleHostsFound == {"api.legacy.example": 1} and
  (.reason | test("stale/wrong API host"))
' <<<"$OUT" >/dev/null

# --- 4. Bundle path unextractable: served HTML has no hashed bundle ref ----
reset_stubs
export STUB_HTML='<html><body>no module script here</body></html>'
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 1 ] || { echo "expected exit 1 for unextractable bundle, got $RC" >&2; exit 1; }
jq -e '.ok == false and .bundleUrl == null and (.reason | test("could not extract"))' <<<"$OUT" >/dev/null

# --- 5. pr1142 case: frontend build identity is correct, backend is dead ---
reset_stubs
export STUB_HEALTHZ_CODE=503
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 1 ] || { echo "expected exit 1 for unreachable backend, got $RC" >&2; exit 1; }
jq -e '
  .ok == false and
  .expectedHostCount == 1 and
  .staleHostsFound == {} and
  .backendReachable == false and
  (.reason | test("backend is not reachable"))
' <<<"$OUT" >/dev/null

echo "smoke build identity tests passed"
