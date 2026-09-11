#!/usr/bin/env bash
# Self-check for scripts/wiki-autopush.sh, modeled on
# scripts/git-safety-selfcheck.sh: builds a real fixture wiki repo + bare
# remote, runs the SHIPPED script against it with only notify-owner.ts
# stubbed, and asserts on the repo/remote state afterwards — never a
# re-implementation of the script's logic.
#
#   bash scripts/wiki-autopush-selfcheck.sh

set -uo pipefail

REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wiki-autopush.sh"
FAILED=0
ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n     %s\n' "$1" "$2"; FAILED=1; }

# ── fixture builder ──────────────────────────────────────────────────────
# Throwaway NANOCLAW_DIR with a groups/<group>/wiki repo cloned from a local
# bare remote, plus a stubbed notify-owner.ts / tsx so no real DM is ever
# attempted.
FIX=""
WIKI=""    # groups/<group>/wiki worktree
REMOTE=""  # bare remote the wiki pushes to
NCDIR=""
DM_LOG=""

new_fixture() {
  FIX=$(mktemp -d)
  NCDIR="$FIX/nanoclaw"
  REMOTE="$FIX/remote-wiki.git"

  git init --bare -q "$REMOTE"

  mkdir -p "$NCDIR/groups/acme/wiki"
  git clone -q "$REMOTE" "$NCDIR/groups/acme/wiki" 2>/dev/null
  WIKI="$NCDIR/groups/acme/wiki"
  git -C "$WIKI" config user.email test@example.com
  git -C "$WIKI" config user.name test
  echo '# acme wiki' > "$WIKI/README.md"
  git -C "$WIKI" add README.md
  git -C "$WIKI" commit -qm init >/dev/null
  git -C "$WIKI" push -q origin HEAD:main
  git -C "$WIKI" checkout -q -B main

  mkdir -p "$NCDIR/scripts/lib" "$NCDIR/node_modules/.bin"
  cp "$(dirname "$REAL")/lib/secret-scan.sh" "$NCDIR/scripts/lib/secret-scan.sh"
  echo 'console.log("stub")' > "$NCDIR/scripts/notify-owner.ts"
  DM_LOG="$FIX/dm.log"
  : > "$DM_LOG"
  cat > "$NCDIR/node_modules/.bin/tsx" <<EOF
#!/bin/bash
echo "\$*" >> "$DM_LOG"
exit 0
EOF
  chmod +x "$NCDIR/node_modules/.bin/tsx"
}

run_autopush() {
  OUT=$(NANOCLAW_DIR="$NCDIR" bash "$REAL" 2>&1)
  RC=$?
}

remote_tip() { git --git-dir="$REMOTE" rev-parse -q --verify main 2>/dev/null; }

# ═══ 1. Secret-shaped content: refused, not pushed, not committed ═════════
new_fixture
BEFORE_TIP=$(remote_tip)
echo 'export SLACK_APP_TOKEN=xapp-1-A0123-4567890123-abcdefabcdefabcdefabcdefabcdef' >> "$WIKI/README.md"
run_autopush

case "$OUT" in
  *"refused"*"look like a secret"*) ok "wiki secret gate fires on a planted token" ;;
  *) bad "wiki secret gate did not fire" "out=$OUT" ;;
esac

AFTER_TIP=$(remote_tip)
[ "$BEFORE_TIP" = "$AFTER_TIP" ] \
  && ok "secret-shaped change was not pushed to the remote" \
  || bad "secret-shaped change reached the remote anyway" "before=$BEFORE_TIP after=$AFTER_TIP"

git -C "$WIKI" rev-parse HEAD | grep -qx "$BEFORE_TIP" \
  && ok "secret-shaped change was not committed locally either" \
  || bad "secret-shaped change was committed locally" "$(git -C "$WIKI" log --oneline -1)"

[ -z "$(git -C "$WIKI" diff --cached --name-only)" ] \
  && ok "index was unstaged back to HEAD after the refusal" \
  || bad "index still has staged content after the refusal" "$(git -C "$WIKI" diff --cached --name-only)"

grep -q "acme's wiki" "$DM_LOG" \
  && ok "owner was DMed about the secret-shaped refusal" \
  || bad "no DM was sent for the secret-shaped refusal" "$(cat "$DM_LOG")"

# ═══ 2. Ordinary content: committed and pushed, no DM ═════════════════════
new_fixture
BEFORE_TIP=$(remote_tip)
echo 'nothing sensitive here, just prose about the roadmap' >> "$WIKI/README.md"
run_autopush

case "$OUT" in
  *"acme: pushed"*) ok "ordinary change was pushed" ;;
  *) bad "ordinary change was not pushed" "out=$OUT" ;;
esac

AFTER_TIP=$(remote_tip)
[ -n "$AFTER_TIP" ] && [ "$BEFORE_TIP" != "$AFTER_TIP" ] \
  && ok "remote main advanced for the ordinary change" \
  || bad "remote main did not advance" "before=$BEFORE_TIP after=$AFTER_TIP"

[ ! -s "$DM_LOG" ] \
  && ok "no DM sent for an ordinary (non-secret) push" \
  || bad "a DM was sent even though nothing was secret-shaped" "$(cat "$DM_LOG")"

# ═══ 3. No-op: a wiki with nothing pending sends no DM and pushes nothing ══
new_fixture
BEFORE_TIP=$(remote_tip)
run_autopush
AFTER_TIP=$(remote_tip)
[ "$BEFORE_TIP" = "$AFTER_TIP" ] && [ ! -s "$DM_LOG" ] \
  && ok "clean wiki (no pending changes) is a true no-op" \
  || bad "clean wiki was not a no-op" "before=$BEFORE_TIP after=$AFTER_TIP dm=$(cat "$DM_LOG")"

rm -rf "$FIX"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "wiki-autopush-selfcheck: all checks passed"
else
  echo "wiki-autopush-selfcheck: FAILURES ABOVE"
fi
exit "$FAILED"
