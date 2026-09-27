# Sourced, never run: how a `static` preview provider (SMOKE_PREVIEW_PROVIDER=static)
# reports which build it serves. smoke-pr-gate.sh reads it to decide a preview is
# ready and smoke-pair-identity.sh reads it to freeze and re-check the pair, so the
# two can never disagree about a static preview's identity.
#
# A static preview's identity is the full commit it serves: $SMOKE_PREVIEW_VERSION_PATH
# (default /version) returning JSON `sha`, `commit` or `gitSha`, or else a
# `<meta name="build-sha" content="...">` tag on its root page. Anything short of
# 40 hex characters is no identity at all. A same-commit redeploy is invisible here.

served_sha() {  # <preview url> → the 40-character commit it serves, or empty
  local url="${1%/}" out sha="" path="${SMOKE_PREVIEW_VERSION_PATH:-/version}"
  if out="$(timeout 10 curl -fsS --max-time 10 "$url$path" 2>/dev/null)"; then
    sha="$(jq -r '(.sha // .commit // .gitSha // empty) | select(type == "string" and test("^[0-9a-f]{40}$"))' <<<"$out" 2>/dev/null)"
  fi
  if [ -z "$sha" ] && out="$(timeout 10 curl -fsS --max-time 10 "$url/" 2>/dev/null)"; then
    sha="$(grep -oiE '<meta[^>]+name="build-sha"[^>]*>' <<<"$out" | head -n 1 | sed -nE 's/.*content="([0-9a-f]{40})".*/\1/p')"
  fi
  printf '%s' "$sha"
}
