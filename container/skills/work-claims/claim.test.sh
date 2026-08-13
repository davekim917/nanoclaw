#!/usr/bin/env bash
# Claim lifecycle, the two refusals that protect a sibling's live work, and the
# merged-PR exception (gh stubbed via PATH so the verify runs offline).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAIM="$SCRIPT_DIR/claim.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/workgroup/claims" "$ROOT/bin"
export CLAIMS_DIR="$ROOT/workgroup/claims"
export PATH="$ROOT/bin:$PATH"
export NANOCLAW_ASSISTANT_NAME=ava
export NANOCLAW_THREAD_ID=slack:C0AAA:1786621514.008659

# gh stub — PR number decides the state, so both branches are exercised.
cat > "$ROOT/bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$3" in
  733) echo MERGED ;;
  *)   echo OPEN ;;
esac
STUB
chmod +x "$ROOT/bin/gh" "$CLAIM"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Unclaimed reads free.
bash "$CLAIM" check acme-pr-733 | grep -q '^unclaimed' || fail "fresh slug not unclaimed"

# 2. Taking records every field, including thread_id from the environment.
bash "$CLAIM" take acme-pr-733 4 publish-gate seam >/dev/null
jq -e '
  .owner == "ava" and .ttl_hours == 4 and
  .thread_id == "slack:C0AAA:1786621514.008659" and
  .note == "publish-gate seam" and (.claimed_at | endswith("Z"))
' "$CLAIMS_DIR/acme-pr-733.json" >/dev/null || fail "claim fields wrong"

# 3. Your own live claim reads YOURS, not LIVE — you are not blocked by yourself.
bash "$CLAIM" check acme-pr-733 | grep -q '^YOURS' || fail "own claim not YOURS"

# 4. A sibling's live claim is refused with exit 3, and the file is untouched.
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" take acme-pr-733 4 stealing it >/dev/null 2>&1 \
  && fail "took a live claim off a sibling"
[ "$(NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" check acme-pr-733 >/dev/null 2>&1; echo $?)" = 3 ] \
  || fail "sibling check did not exit 3 on a live claim"
[ "$(jq -r .owner "$CLAIMS_DIR/acme-pr-733.json")" = ava ] || fail "refused take still wrote"

# 5. A sibling may not delete it either.
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" release acme-pr-733 >/dev/null 2>&1 \
  && fail "sibling deleted a live claim"
[ -f "$CLAIMS_DIR/acme-pr-733.json" ] || fail "refused release still deleted"

# 6. Past its TTL the same claim goes stale and is takeable, and the takeover
#    is recorded in the note rather than silently overwriting the history.
jq '.claimed_at = "2020-01-01T00:00:00Z"' "$CLAIMS_DIR/acme-pr-733.json" > "$ROOT/t" \
  && mv "$ROOT/t" "$CLAIMS_DIR/acme-pr-733.json"
bash "$CLAIM" check acme-pr-733 | grep -q '^STALE' || fail "expired claim not stale"
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" take acme-pr-733 4 resuming >/dev/null
jq -e '.owner == "bo" and (.note | startswith("took over stale claim from ava"))' \
  "$CLAIMS_DIR/acme-pr-733.json" >/dev/null || fail "stale takeover not recorded"

# 7. An unparseable claim is stale, never an indefinite lock on the slug.
echo '{"owner":"ghost","note":"no timestamps"}' > "$CLAIMS_DIR/broken.json"
bash "$CLAIM" check broken | grep -q '^STALE' || fail "unparseable claim wedged the slug"

# 8. The merged-PR exception verifies with gh instead of trusting the caller:
#    an OPEN pr is refused, a MERGED one clears a sibling's completed claim.
bash "$CLAIM" release acme-pr-733 --merged-pr 999 >/dev/null 2>&1 \
  && fail "cleared a sibling claim on an OPEN pr"
[ -f "$CLAIMS_DIR/acme-pr-733.json" ] || fail "OPEN-pr release still deleted"
bash "$CLAIM" release acme-pr-733 --merged-pr 733 >/dev/null || fail "MERGED release refused"
[ -f "$CLAIMS_DIR/acme-pr-733.json" ] && fail "MERGED release did not delete"

# 9. Releasing your own claim deletes it; releasing nothing is not an error.
bash "$CLAIM" take acme-seam 2 my own work >/dev/null
bash "$CLAIM" release acme-seam >/dev/null
[ -f "$CLAIMS_DIR/acme-seam.json" ] && fail "own release did not delete"
bash "$CLAIM" release never-existed >/dev/null || fail "releasing a missing claim errored"

# 10. A channel-level session (no thread) omits thread_id rather than writing "".
NANOCLAW_THREAD_ID= bash "$CLAIM" take acme-chan 4 channel level >/dev/null
jq -e 'has("thread_id") | not' "$CLAIMS_DIR/acme-chan.json" >/dev/null \
  || fail "empty thread id was written"

# 11. A note is mandatory, and a non-numeric ttl is rejected.
bash "$CLAIM" take acme-nonote 4 >/dev/null 2>&1 && fail "accepted a claim with no note"
bash "$CLAIM" take acme-badttl soon because >/dev/null 2>&1 && fail "accepted a non-numeric ttl"

# 12. No workgroup tree => skip the convention, exit 0, write nothing.
CLAIMS_DIR="$ROOT/absent/claims" bash "$CLAIM" check anything | grep -q 'does not apply' \
  || fail "missing workgroup tree did not skip"
[ -d "$ROOT/absent" ] && fail "skip path created a tree"

# 13. list renders one row per claim with its state.
bash "$CLAIM" list | grep -q 'broken' || fail "list omitted a claim"

echo "all claim.sh tests passed"
