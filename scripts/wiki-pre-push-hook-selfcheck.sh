#!/usr/bin/env bash
# Self-check for scripts/wiki-pre-push-hook.sh and
# scripts/install-wiki-pre-push-hook.sh, modeled on
# scripts/wiki-autopush-selfcheck.sh / scripts/git-safety-selfcheck.sh:
# builds real fixture repos (a throwaway NANOCLAW_DIR with a wiki repo
# cloned from a local bare remote), runs the SHIPPED installer and the
# SHIPPED hook it installs, and asserts on repo/remote state afterwards —
# never a re-implementation of either script's logic. Never touches a real
# nanoclaw-v2 install or a real canonical repository.
#
#   bash scripts/wiki-pre-push-hook-selfcheck.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install-wiki-pre-push-hook.sh"
FAILED=0
ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n     %s\n' "$1" "$2"; FAILED=1; }

# ── fixture builder ──────────────────────────────────────────────────────
FIX=""
NCDIR=""   # throwaway NANOCLAW_DIR
WIKI=""    # $NCDIR/data/repositories/testwg/wiki worktree
REMOTE=""  # bare remote the wiki pushes to

new_fixture() {
  FIX=$(mktemp -d)
  NCDIR="$FIX/nanoclaw"
  REMOTE="$FIX/remote-wiki.git"
  WIKI="$NCDIR/data/repositories/testwg/wiki"

  git init --bare -q "$REMOTE"
  mkdir -p "$WIKI"
  git init -q -b main "$WIKI"
  git -C "$WIKI" config user.email test@example.com
  git -C "$WIKI" config user.name test
  echo '# test wiki' > "$WIKI/README.md"
  git -C "$WIKI" add README.md
  git -C "$WIKI" commit -qm init >/dev/null
  git -C "$WIKI" remote add origin "$REMOTE"
  git -C "$WIKI" push -q origin main
}

install_hook() { # extra installer args as "$@"
  INSTALL_OUT=$(NANOCLAW_DIR="$NCDIR" bash "$INSTALLER" "$@" 2>&1)
  INSTALL_RC=$?
}

push_main() {
  PUSH_OUT=$(git -C "$WIKI" push origin main 2>&1)
  PUSH_RC=$?
}

remote_tip() { git --git-dir="$REMOTE" rev-parse -q --verify main 2>/dev/null; }

# ═══ Installer puts the hook + patterns in place ═══════════════════════════
new_fixture
install_hook
[ "$INSTALL_RC" -eq 0 ] && ok "installer exits 0 on a fresh fixture" \
  || bad "installer failed on a fresh fixture" "$INSTALL_OUT"
[ -x "$WIKI/.git/hooks/pre-push" ] && ok "pre-push hook installed and executable" \
  || bad "pre-push hook missing or not executable" "$(ls -la "$WIKI/.git/hooks/" 2>&1)"
[ -f "$WIKI/.git/hooks/nanoclaw-secret-patterns.sh" ] && ok "pattern file installed alongside the hook" \
  || bad "nanoclaw-secret-patterns.sh missing" ""
grep -q "nanoclaw-managed-hook" "$WIKI/.git/hooks/pre-push" \
  && ok "installed hook carries the ownership marker" \
  || bad "installed hook is missing its marker" ""

# ═══ 1. A high-confidence token is BLOCKED ═════════════════════════════════
new_fixture
install_hook
BEFORE_TIP=$(remote_tip)
echo 'export SLACK_APP_TOKEN=xapp-1-A0123-4567890123-abcdefabcdefabcdefabcdefabcdef' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "add a high-confidence token"
push_main
[ "$PUSH_RC" -ne 0 ] && ok "high-confidence token: push is blocked" \
  || bad "high-confidence token: push succeeded" "$PUSH_OUT"
case "$PUSH_OUT" in
  *"BLOCKED"*) ok "high-confidence token: hook reports BLOCKED" ;;
  *) bad "high-confidence token: no BLOCKED message" "$PUSH_OUT" ;;
esac
[ "$(remote_tip)" = "$BEFORE_TIP" ] && ok "high-confidence token: remote main did not advance" \
  || bad "high-confidence token: remote advanced anyway" "before=$BEFORE_TIP after=$(remote_tip)"

# ═══ 2. A fuzzy pattern WARNS but is allowed ═══════════════════════════════
new_fixture
install_hook
BEFORE_TIP=$(remote_tip)
echo 'export DB_PASS=averylongpasswordvalue123' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "add a fuzzy password-shaped line"
push_main
[ "$PUSH_RC" -eq 0 ] && ok "fuzzy pattern: push is allowed" \
  || bad "fuzzy pattern: push was blocked" "$PUSH_OUT"
case "$PUSH_OUT" in
  *"WARNING"*) ok "fuzzy pattern: hook reports WARNING" ;;
  *) bad "fuzzy pattern: no WARNING message" "$PUSH_OUT" ;;
esac
AFTER_TIP=$(remote_tip)
[ -n "$AFTER_TIP" ] && [ "$AFTER_TIP" != "$BEFORE_TIP" ] && ok "fuzzy pattern: remote main advanced" \
  || bad "fuzzy pattern: remote main did not advance" "before=$BEFORE_TIP after=$AFTER_TIP"

# ═══ 3. An ordinary clean push is allowed, no warning at all ═══════════════
new_fixture
install_hook
BEFORE_TIP=$(remote_tip)
echo 'nothing sensitive here, just prose about the roadmap' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "ordinary content change"
push_main
[ "$PUSH_RC" -eq 0 ] && ok "clean push: allowed" \
  || bad "clean push: was blocked" "$PUSH_OUT"
case "$PUSH_OUT" in
  *"BLOCKED"*|*"WARNING"*) bad "clean push: hook said something anyway" "$PUSH_OUT" ;;
  *) ok "clean push: no BLOCKED/WARNING output" ;;
esac
[ "$(remote_tip)" != "$BEFORE_TIP" ] && ok "clean push: remote main advanced" \
  || bad "clean push: remote main did not advance" ""

# ═══ 4. A binary/font blob with a "password" substring isn't blocked ═══════
# BLOCK_RE has no bare "password" alternative at all (only vendor token
# shapes) — this is what actually guarantees it, but exercise it with real
# binary content anyway: this is exactly the shape #658's review measured
# git-safety's single broad SECRET_RE false-positiving on (base64 fonts,
# "Hide password" UI strings) that motivated the two-tier split.
new_fixture
install_hook
BEFORE_TIP=$(remote_tip)
python3 -c "
import random
random.seed(1)
noise = bytes(random.randint(0, 255) for _ in range(2000))
data = noise + b'the word password appears here as a coincidence' + noise
open('$WIKI/font.bin', 'wb').write(data)
"
git -C "$WIKI" add font.bin
git -C "$WIKI" commit -qam "add a binary blob containing the word password"
push_main
[ "$PUSH_RC" -eq 0 ] && ok "binary blob with 'password' substring: not blocked" \
  || bad "binary blob with 'password' substring: was blocked" "$PUSH_OUT"
case "$PUSH_OUT" in
  *"BLOCKED"*) bad "binary blob: hook reported BLOCKED" "$PUSH_OUT" ;;
  *) ok "binary blob: hook did not report BLOCKED" ;;
esac
[ "$(remote_tip)" != "$BEFORE_TIP" ] && ok "binary blob: remote main advanced" \
  || bad "binary blob: remote main did not advance" ""

# ═══ 5. A secret buried in an EARLIER (non-tip) unpushed commit is BLOCKED ═
# Proves the hook diffs the whole remote_sha..local_sha range, not just the
# tip commit — a per-commit-only scan would miss this.
new_fixture
install_hook
BEFORE_TIP=$(remote_tip)
echo 'export GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4aXYZ123' > "$WIKI/secret-mid.txt"
git -C "$WIKI" add secret-mid.txt
git -C "$WIKI" commit -qm "commit 1: has the secret"
echo 'totally fine content' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "commit 2: clean, this is the tip"
push_main
[ "$PUSH_RC" -ne 0 ] && ok "secret in an earlier unpushed commit: blocked" \
  || bad "secret in an earlier unpushed commit: push succeeded" "$PUSH_OUT"
[ "$(remote_tip)" = "$BEFORE_TIP" ] && ok "secret in an earlier unpushed commit: remote unchanged" \
  || bad "secret in an earlier unpushed commit: remote advanced" ""

# ═══ 6. A brand-new local branch (remote_sha all-zero) is still scanned ════
new_fixture
install_hook
git -C "$WIKI" checkout -qb feature-new
echo 'export GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4aXYZ123' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "new branch with a token"
PUSH_OUT=$(git -C "$WIKI" push origin feature-new 2>&1)
PUSH_RC=$?
[ "$PUSH_RC" -ne 0 ] && ok "brand-new branch with a token: blocked" \
  || bad "brand-new branch with a token: push succeeded" "$PUSH_OUT"
git --git-dir="$REMOTE" rev-parse -q --verify feature-new >/dev/null 2>&1 \
  && bad "brand-new branch: pushed anyway" "$(git --git-dir="$REMOTE" log --oneline feature-new)" \
  || ok "brand-new branch: nothing landed on the remote"

# ═══ Missing/unreadable pattern file fails CLOSED, not open ════════════════
new_fixture
install_hook
rm -f "$WIKI/.git/hooks/nanoclaw-secret-patterns.sh"
echo 'export SLACK_APP_TOKEN=xapp-1-A0123-4567890123-abcdefabcdefabcdefabcdefabcdef' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "would-be secret, but the pattern file is gone"
push_main
[ "$PUSH_RC" -ne 0 ] && ok "missing pattern file: push fails closed" \
  || bad "missing pattern file: push succeeded (fail-OPEN)" "$PUSH_OUT"
case "$PUSH_OUT" in
  *"cannot load"*) ok "missing pattern file: hook explains itself" ;;
  *) bad "missing pattern file: no explanation printed" "$PUSH_OUT" ;;
esac

# ═══ Installer: idempotent re-run ═══════════════════════════════════════════
new_fixture
install_hook
FIRST_HOOK_SUM=$(sha256sum "$WIKI/.git/hooks/pre-push" | cut -d' ' -f1)
install_hook
SECOND_HOOK_SUM=$(sha256sum "$WIKI/.git/hooks/pre-push" | cut -d' ' -f1)
[ "$INSTALL_RC" -eq 0 ] && ok "installer: second run exits 0" \
  || bad "installer: second run failed" "$INSTALL_OUT"
[ "$FIRST_HOOK_SUM" = "$SECOND_HOOK_SUM" ] && ok "installer: re-run reinstalls the identical hook (idempotent)" \
  || bad "installer: re-run produced a different hook" "first=$FIRST_HOOK_SUM second=$SECOND_HOOK_SUM"
NO_BACKUPS=$(find "$WIKI/.git/hooks" -name 'pre-push.pre-nanoclaw-backup-*' | wc -l)
[ "$NO_BACKUPS" -eq 0 ] && ok "installer: re-run over its own hook creates no backup" \
  || bad "installer: re-run over its own hook created a backup" "$(find "$WIKI/.git/hooks" -name 'pre-push.pre-nanoclaw-backup-*')"

# ═══ Installer: never overwrites a foreign hook without backing it up ══════
new_fixture
cat > "$WIKI/.git/hooks/pre-push" <<'FOREIGN'
#!/bin/bash
echo "some other team's hook" >&2
exit 0
FOREIGN
chmod +x "$WIKI/.git/hooks/pre-push"
install_hook
[ "$INSTALL_RC" -eq 0 ] && ok "installer over a foreign hook: exits 0" \
  || bad "installer over a foreign hook: failed" "$INSTALL_OUT"
BACKUP=$(find "$WIKI/.git/hooks" -name 'pre-push.pre-nanoclaw-backup-*' | head -1)
[ -n "$BACKUP" ] && ok "installer over a foreign hook: a backup file exists" \
  || bad "installer over a foreign hook: no backup was made" "$(ls "$WIKI/.git/hooks")"
if [ -n "$BACKUP" ]; then
  grep -q "some other team's hook" "$BACKUP" \
    && ok "installer over a foreign hook: the backup holds the original content" \
    || bad "installer over a foreign hook: the backup is not the original content" "$(cat "$BACKUP")"
fi
grep -q "nanoclaw-managed-hook" "$WIKI/.git/hooks/pre-push" \
  && ok "installer over a foreign hook: our hook is now installed" \
  || bad "installer over a foreign hook: our hook was not installed" ""

# ═══ Installer: skips a repo whose core.hooksPath is overridden ═══════════
new_fixture
git -C "$WIKI" config core.hooksPath /dev/null
install_hook
case "$INSTALL_OUT" in
  *"SKIP"*"core.hooksPath"*) ok "installer: reports SKIP for a core.hooksPath override" ;;
  *) bad "installer: did not report the hooksPath skip" "$INSTALL_OUT" ;;
esac
[ -e "$WIKI/.git/hooks/nanoclaw-secret-patterns.sh" ] \
  && bad "installer: installed into a repo with core.hooksPath overridden anyway" "" \
  || ok "installer: nothing installed into a repo with core.hooksPath overridden"

# ═══ Installer: --dry-run changes nothing ══════════════════════════════════
new_fixture
install_hook --dry-run
[ ! -e "$WIKI/.git/hooks/pre-push" ] && ok "installer --dry-run: no hook installed" \
  || bad "installer --dry-run: installed a hook anyway" ""
[ ! -e "$WIKI/.git/hooks/nanoclaw-secret-patterns.sh" ] && ok "installer --dry-run: no pattern file installed" \
  || bad "installer --dry-run: installed the pattern file anyway" ""
case "$INSTALL_OUT" in
  *"[dry-run]"*) ok "installer --dry-run: reports intent" ;;
  *) bad "installer --dry-run: silent" "$INSTALL_OUT" ;;
esac

rm -rf "$FIX"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "wiki-pre-push-hook-selfcheck: all checks passed"
else
  echo "wiki-pre-push-hook-selfcheck: FAILURES ABOVE"
fi
exit "$FAILED"
