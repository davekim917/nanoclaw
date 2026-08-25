#!/usr/bin/env bash
# Deterministic build-identity preflight: proves a deployed frontend build was
# actually compiled against the expected backend host, and that the backend
# is reachable — before any browser lane is allowed to start.
#
# Until now this was hand-driven browser work every campaign repeated: fetch
# the frontend HTML, find the hashed JS bundle, grep it for the expected
# backend host and for a known-wrong one (see the B5 lane of
# a run whose lane evidence records it for the technique this codifies). Burned
# as LLM browser time on every run, and its failure mode is worse than slow:
# on one 2026-08-23 run the coordinator's three
# browser lanes all ran against a preview host with NO SERVER BOUND TO IT —
# "All three of my browser lanes produced zero coverage" — and the evidence
# had to be discarded. A frontend that serves fine while its API host
# resolves to nothing looks identical to a correct build until something
# actually calls the backend, so this script makes that call explicit and
# gates on it (issue #1148).
#
# Usage: smoke-build-identity.sh <frontend-base-url> <backend-base-url>
#
# Config (env, deployment-specific — never hardcode a tenant host here):
#   SMOKE_BUILD_ID_STALE_HOSTS    comma-separated wrong/stale API hosts the
#                                 bundle must NOT reference. Unset = skip that
#                                 check (weaker; the expected-host and
#                                 backend-reachable checks still run).
#   SMOKE_BUILD_ID_BUNDLE_PATTERN extended-regex bundle-reference shape to
#                                 grep the served HTML for. Default matches
#                                 the Vite/Rollup hashed entry every sampled
#                                 run has actually used.
#   SMOKE_BUILD_ID_TIMEOUT       per-fetch curl --max-time, default 10s.
#
# One JSON line on stdout, same convention as the sibling gate scripts.
# Exit 0 on ok:true, 1 on a failed check (a caller gates a campaign start on
# this), 2 on a usage error.
set -u

die() { jq -cn --arg e "$1" '{ok:false,error:$e}'; exit 2; }

FRONTEND_URL="${1:-}"
BACKEND_URL="${2:-}"
[ -n "$FRONTEND_URL" ] && [ -n "$BACKEND_URL" ] ||
  die "usage: smoke-build-identity.sh <frontend-base-url> <backend-base-url>"
printf '%s' "$FRONTEND_URL" | grep -Eq '^https?://' ||
  die "frontend base url must start with http:// or https://"
printf '%s' "$BACKEND_URL" | grep -Eq '^https?://' ||
  die "backend base url must start with http:// or https://"

TIMEOUT="${SMOKE_BUILD_ID_TIMEOUT:-10}"
STALE_HOSTS_RAW="${SMOKE_BUILD_ID_STALE_HOSTS:-}"
BUNDLE_PATTERN="${SMOKE_BUILD_ID_BUNDLE_PATTERN:-assets/index-[A-Za-z0-9_]+\.js}"

FRONTEND_URL="${FRONTEND_URL%/}"
BACKEND_URL="${BACKEND_URL%/}"
EXPECTED_HOST="$(printf '%s' "$BACKEND_URL" | sed -E 's#^https?://##; s#/.*$##')"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
HTML_FILE="$TMP_DIR/index.html"
BUNDLE_FILE="$TMP_DIR/bundle.js"

HTML_FETCH_OK=false
if curl -fsS --max-time "$TIMEOUT" "$FRONTEND_URL/" >"$HTML_FILE" 2>/dev/null; then
  HTML_FETCH_OK=true
fi

BUNDLE_PATH=""
if [ "$HTML_FETCH_OK" = true ]; then
  BUNDLE_PATH="$(grep -oE "$BUNDLE_PATTERN" "$HTML_FILE" | head -1)"
fi

BUNDLE_URL=""
BUNDLE_FETCH_OK=false
if [ -n "$BUNDLE_PATH" ]; then
  BUNDLE_URL="$FRONTEND_URL/$BUNDLE_PATH"
  if curl -fsS --max-time "$TIMEOUT" "$BUNDLE_URL" >"$BUNDLE_FILE" 2>/dev/null; then
    BUNDLE_FETCH_OK=true
  fi
fi

EXPECTED_HOST_COUNT=0
STALE_FOUND='{}'
if [ "$BUNDLE_FETCH_OK" = true ]; then
  EXPECTED_HOST_COUNT="$(grep -cF -- "$EXPECTED_HOST" "$BUNDLE_FILE" || true)"
  if [ -n "$STALE_HOSTS_RAW" ]; then
    IFS=',' read -ra STALE_HOSTS <<<"$STALE_HOSTS_RAW"
    for h in "${STALE_HOSTS[@]}"; do
      h="$(printf '%s' "$h" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
      [ -n "$h" ] || continue
      c="$(grep -cF -- "$h" "$BUNDLE_FILE" || true)"
      if [ "$c" -gt 0 ]; then
        STALE_FOUND="$(jq -c --arg h "$h" --argjson c "$c" '. + {($h): $c}' <<<"$STALE_FOUND")"
      fi
    done
  fi
fi

# Verify the backend is actually reachable and bound — the pr1142 failure. A
# frontend that serves fine while its API host resolves to nothing must fail
# here, loudly, independent of whether the bundle checks above passed.
BACKEND_REACHABLE=false
BACKEND_HTTP_CODE=""
CODE="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "${BACKEND_URL}/healthz" 2>/dev/null)"
if [ $? -eq 0 ] && [ "$CODE" = "200" ]; then
  BACKEND_REACHABLE=true
  BACKEND_HTTP_CODE="$CODE"
elif [ -n "$CODE" ]; then
  BACKEND_HTTP_CODE="$CODE"
fi

OK=true
REASON=""
if [ "$HTML_FETCH_OK" != true ]; then
  OK=false
  REASON="failed to fetch frontend HTML from $FRONTEND_URL/"
elif [ -z "$BUNDLE_PATH" ]; then
  OK=false
  REASON="could not extract a JS bundle path matching /$BUNDLE_PATTERN/ from the served HTML"
elif [ "$BUNDLE_FETCH_OK" != true ]; then
  OK=false
  REASON="failed to fetch JS bundle from $BUNDLE_URL"
elif [ "$EXPECTED_HOST_COUNT" -eq 0 ]; then
  OK=false
  REASON="expected backend host $EXPECTED_HOST does not appear anywhere in the bundle — frontend was not built against this backend"
elif [ "$STALE_FOUND" != '{}' ]; then
  OK=false
  REASON="bundle references a stale/wrong API host: $(jq -c 'keys' <<<"$STALE_FOUND")"
elif [ "$BACKEND_REACHABLE" != true ]; then
  OK=false
  REASON="backend ${BACKEND_URL}/healthz did not return 200 (frontend build identity is correct, but the backend is not reachable/bound) — got ${BACKEND_HTTP_CODE:-no response}"
fi

jq -cn \
  --argjson ok "$OK" \
  --arg frontendUrl "$FRONTEND_URL" \
  --arg backendUrl "$BACKEND_URL" \
  --arg bundleUrl "$BUNDLE_URL" \
  --arg expectedHost "$EXPECTED_HOST" \
  --argjson expectedHostCount "$EXPECTED_HOST_COUNT" \
  --argjson staleHostsFound "$STALE_FOUND" \
  --argjson backendReachable "$BACKEND_REACHABLE" \
  --arg backendHttpCode "$BACKEND_HTTP_CODE" \
  --arg reason "$REASON" \
  '{ok:$ok,
    frontendUrl:$frontendUrl, backendUrl:$backendUrl,
    bundleUrl:(if $bundleUrl == "" then null else $bundleUrl end),
    expectedHost:$expectedHost, expectedHostCount:$expectedHostCount,
    staleHostsFound:$staleHostsFound,
    backendReachable:$backendReachable,
    backendHttpCode:(if $backendHttpCode == "" then null else $backendHttpCode end),
    reason:(if $reason == "" then null else $reason end)}'

[ "$OK" = true ] && exit 0 || exit 1
