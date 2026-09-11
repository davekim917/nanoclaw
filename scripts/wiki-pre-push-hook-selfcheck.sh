#!/usr/bin/env bash
# Self-check for scripts/wiki-pre-push-hook.sh, modeled on
# scripts/git-safety-selfcheck.sh: builds real fixture repos (a bare
# remote plus a wiki-shaped worktree), installs the SHIPPED hook + the
# SHIPPED scripts/lib/secret-scan.sh directly into `.git/hooks/` (this
# script simulates what src/managed-git-hooks.ts writes at host startup —
# there is no per-repo installer script anymore; the TS module and its
# vitest coverage are the source of truth for the real host behavior), and
# runs a real `git push` against it. Never a re-implementation of the
# hook's own logic. Never touches a real nanoclaw-v2 install or a real
# canonical repository.
#
#   bash scripts/wiki-pre-push-hook-selfcheck.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SRC="$SCRIPT_DIR/wiki-pre-push-hook.sh"
PATTERNS_SRC="$SCRIPT_DIR/lib/secret-scan.sh"
FAILED=0
ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n     %s\n' "$1" "$2"; FAILED=1; }

# ── fixture builder ──────────────────────────────────────────────────────
# P3-8 (#666 review): the OLD version of this script leaked every fixture
# dir it created — new_fixture() overwrote $FIX with a fresh `mktemp -d`
# on every call and only the LAST one was ever removed, at the very end.
# Track every one in FIXTURE_DIRS and remove them all via an EXIT trap, so
# an interrupted run (or the ~15 fixtures a full run creates) never leaves
# planted fake-secret content on disk.
FIXTURE_DIRS=()
cleanup_fixtures() {
  local dir
  for dir in "${FIXTURE_DIRS[@]}"; do
    rm -rf "$dir"
  done
}
trap cleanup_fixtures EXIT INT TERM

WIKI=""    # <fixture>/wiki worktree, shaped like data/repositories/<wg>/wiki
REMOTE=""  # bare remote the wiki pushes to

new_fixture() {
  local fix
  fix=$(mktemp -d)
  FIXTURE_DIRS+=("$fix")
  REMOTE="$fix/remote-wiki.git"
  WIKI="$fix/repositories/testwg/wiki"

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
  install_hook_files "$HOOK_SRC" "$PATTERNS_SRC"
}

# install_hook_files <hook-source> <patterns-source>
# Simulates a host startup refresh: copies the given hook + patterns files
# into $WIKI/.git/hooks/ verbatim, executable bit on the hook only.
install_hook_files() {
  mkdir -p "$WIKI/.git/hooks"
  cp "$1" "$WIKI/.git/hooks/pre-push"
  chmod +x "$WIKI/.git/hooks/pre-push"
  cp "$2" "$WIKI/.git/hooks/nanoclaw-secret-patterns.sh"
}

push_ref() { # <local-ref> <remote-ref (defaults to local-ref)>
  local local_ref="$1" remote_ref="${2:-$1}"
  PUSH_OUT=$(git -C "$WIKI" push origin "${local_ref}:${remote_ref}" 2>&1)
  PUSH_RC=$?
}

push_main() { push_ref main main; }

remote_tip() { git --git-dir="$REMOTE" rev-parse -q --verify main 2>/dev/null; }

# ═══ 1. A high-confidence token is BLOCKED ═════════════════════════════════
new_fixture
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
case "$PUSH_OUT" in
  *"--no-verify"*) ok "high-confidence token: block message tells the agent not to bypass it" ;;
  *) bad "high-confidence token: block message doesn't mention --no-verify" "$PUSH_OUT" ;;
esac
[ "$(remote_tip)" = "$BEFORE_TIP" ] && ok "high-confidence token: remote main did not advance" \
  || bad "high-confidence token: remote advanced anyway" "before=$BEFORE_TIP after=$(remote_tip)"

# ═══ 2. A fuzzy pattern WARNS but is allowed ═══════════════════════════════
new_fixture
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
# binary content anyway: the shape review-666 (and #658 before it) measured
# a single broad pattern false-positiving on (base64 fonts, "Hide password"
# UI strings) that motivated the two-tier split in the first place.
new_fixture
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
# Per-commit patch scanning (git log -p) walks every commit in the range,
# not just the diff between two end-states.
new_fixture
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

# ═══ 6. Added, then removed, within the SAME push is still BLOCKED ════════
# #666 review P1-1: the old design diffed only the two push end-states, so
# a token added in one commit and deleted (or redacted) in a later commit
# of the same push never appeared in that diff at all. Per-commit patch
# scanning catches the commit that introduced it regardless of what a
# later commit in the same push does.
new_fixture
BEFORE_TIP=$(remote_tip)
echo 'export GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4aXYZ123' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "commit A: adds the secret"
git -C "$WIKI" checkout -q HEAD~1 -- README.md
git -C "$WIKI" commit -qam "commit B: removes it again"
push_main
[ "$PUSH_RC" -ne 0 ] && ok "added-then-removed within one push: still blocked" \
  || bad "added-then-removed within one push: push succeeded" "$PUSH_OUT"
[ "$(remote_tip)" = "$BEFORE_TIP" ] && ok "added-then-removed within one push: remote unchanged" \
  || bad "added-then-removed within one push: remote advanced" ""

# ═══ 7. A brand-new local branch is still scanned ══════════════════════════
new_fixture
git -C "$WIKI" checkout -qb feature-new
echo 'export GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4aXYZ123' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "new branch with a token"
push_ref feature-new
[ "$PUSH_RC" -ne 0 ] && ok "brand-new branch with a token: blocked" \
  || bad "brand-new branch with a token: push succeeded" "$PUSH_OUT"
git --git-dir="$REMOTE" rev-parse -q --verify feature-new >/dev/null 2>&1 \
  && bad "brand-new branch: pushed anyway" "$(git --git-dir="$REMOTE" log --oneline feature-new)" \
  || ok "brand-new branch: nothing landed on the remote"

# ═══ 8. A secret typed ONLY in a commit message is BLOCKED ════════════════
# #666 review P3-1: git log -p's --output-indicator-new marks diff/patch
# content only — a commit's own message body carries no marker at all, so
# a secret typed directly into a commit message (never as file content)
# would otherwise be silently dropped by the extraction step.
new_fixture
BEFORE_TIP=$(remote_tip)
echo 'unrelated content change' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "here's a token for reference: xapp-1-A0123-4567890123-abcdefabcdefabcdefabcdefabcdef"
push_main
[ "$PUSH_RC" -ne 0 ] && ok "secret only in a commit message: blocked" \
  || bad "secret only in a commit message: push succeeded" "$PUSH_OUT"
[ "$(remote_tip)" = "$BEFORE_TIP" ] && ok "secret only in a commit message: remote unchanged" \
  || bad "secret only in a commit message: remote advanced" ""

# ═══ 9. A secret in an ANNOTATED TAG's own message is BLOCKED ═════════════
# git log never renders a tag object's own message (it only ever walks the
# peeled commit) — the hook fetches it separately via `git cat-file -p`.
new_fixture
git -C "$WIKI" tag -a v1.0-test -m "release notes: token=xapp-1-A0123-4567890123-abcdefabcdefabcdefabcdefabcdef"
push_ref v1.0-test
[ "$PUSH_RC" -ne 0 ] && ok "secret in an annotated tag message: blocked" \
  || bad "secret in an annotated tag message: push succeeded" "$PUSH_OUT"
git --git-dir="$REMOTE" rev-parse -q --verify v1.0-test >/dev/null 2>&1 \
  && bad "annotated tag: pushed anyway" "" \
  || ok "annotated tag: nothing landed on the remote"

# ═══ 10. BLOCK is case-SENSITIVE; a lowercase near-miss falls to WARN ══════
# #666 review P2-2: a case-insensitive BLOCK measured 3 false positives
# over 327 real wiki commits, all from a lowercase "akia" plus 16
# characters matching random data. Case-sensitive BLOCK gives 0 there;
# the near-miss still isn't silently dropped — it falls into WARN, which
# stays case-insensitive over the whole (broader) SECRET_RE.
new_fixture
BEFORE_TIP=$(remote_tip)
echo 'aws_key = akiaiosfodnn7abcdefg' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "lowercase akia-shaped, not a real key"
push_main
[ "$PUSH_RC" -eq 0 ] && ok "lowercase akia-shaped line: not blocked (BLOCK is case-sensitive)" \
  || bad "lowercase akia-shaped line: blocked" "$PUSH_OUT"
case "$PUSH_OUT" in
  *"WARNING"*) ok "lowercase akia-shaped line: still caught, as WARN" ;;
  *) bad "lowercase akia-shaped line: not caught at all" "$PUSH_OUT" ;;
esac
[ "$(remote_tip)" != "$BEFORE_TIP" ] && ok "lowercase akia-shaped line: remote advanced" \
  || bad "lowercase akia-shaped line: remote did not advance" ""

# ═══ 11. AWS's own documentation example key is allowlisted, exactly ═══════
new_fixture
BEFORE_TIP=$(remote_tip)
echo 'aws_key = AKIAIOSFODNN7EXAMPLE' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "aws docs example key"
push_main
[ "$PUSH_RC" -eq 0 ] && ok "AWS docs example key: not blocked" \
  || bad "AWS docs example key: blocked" "$PUSH_OUT"
case "$PUSH_OUT" in
  *"BLOCKED"*|*"WARNING"*) bad "AWS docs example key: hook said something anyway" "$PUSH_OUT" ;;
  *) ok "AWS docs example key: no BLOCKED/WARNING at all" ;;
esac
[ "$(remote_tip)" != "$BEFORE_TIP" ] && ok "AWS docs example key: remote advanced" \
  || bad "AWS docs example key: remote did not advance" ""

# ═══ 12. A PGP private-key block header is BLOCKED ═════════════════════════
new_fixture
BEFORE_TIP=$(remote_tip)
echo '-----BEGIN PGP PRIVATE KEY BLOCK-----' >> "$WIKI/README.md"
git -C "$WIKI" commit -qam "add a pgp private key header"
push_main
[ "$PUSH_RC" -ne 0 ] && ok "PGP private-key header: blocked" \
  || bad "PGP private-key header: push succeeded" "$PUSH_OUT"
[ "$(remote_tip)" = "$BEFORE_TIP" ] && ok "PGP private-key header: remote unchanged" \
  || bad "PGP private-key header: remote advanced" ""

# ═══ 13. BLOCK's ghp_ length matches SECRET_RE's (#666 review P2-item2) ════
# A 20-29 character ghp_ token used to match a merged gh[pousr]_{20,}
# BLOCK alternative while missing SECRET_RE's own separate ghp_{30,}
# requirement — BLOCK matching something SECRET_RE itself wouldn't. Below
# 30 characters it must not BLOCK (still may WARN via the generic
# identifier alternative, which it does here).
new_fixture
BEFORE_TIP=$(remote_tip)
echo 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstu' >> "$WIKI/README.md" # 25 chars after ghp_
git -C "$WIKI" commit -qam "25-char ghp_ token, below the 30-char threshold"
push_main
[ "$PUSH_RC" -eq 0 ] && ok "25-char ghp_ token: not blocked (below SECRET_RE's own 30-char ghp_ threshold)" \
  || bad "25-char ghp_ token: blocked" "$PUSH_OUT"
[ "$(remote_tip)" != "$BEFORE_TIP" ] && ok "25-char ghp_ token: remote advanced" \
  || bad "25-char ghp_ token: remote did not advance" ""

# ═══ 14. Every SECRET_BLOCK_RE fixture used above also matches SECRET_RE ═══
# #666 review addendum 2: BLOCK must be a literal subset of SECRET_RE, so
# git-safety.sh (single-tier, over SECRET_RE) never passes something this
# hook would BLOCK. Reuses the actual planted BLOCK-tier lines above.
BLOCK_FIXTURE_LINES=(
  'export SLACK_APP_TOKEN=xapp-1-A0123-4567890123-abcdefabcdefabcdefabcdefabcdef'
  'export GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4aXYZ123'
  '-----BEGIN PGP PRIVATE KEY BLOCK-----'
)
new_fixture
# shellcheck source=lib/secret-scan.sh
source "$PATTERNS_SRC"
for line in "${BLOCK_FIXTURE_LINES[@]}"; do
  if LC_ALL=C grep -qE "$SECRET_BLOCK_RE" <<<"$line" && ! LC_ALL=C grep -qiE "$SECRET_RE" <<<"$line"; then
    bad "BLOCK-subset: '$line' matches SECRET_BLOCK_RE but not SECRET_RE" ""
  else
    ok "BLOCK-subset: '$line' — SECRET_BLOCK_RE match implies a SECRET_RE match too"
  fi
done

# ═══ Missing/corrupt pattern file: 6 variants, all fail CLOSED ═════════════
# #666 review P2-1: 4 of 6 corrupt-file variants failed OPEN before
# secret_scan_selftest existed (source returns 0 for all of these; only
# the eventual `${hits:-0}` stood between that and every secret passing).
corrupt_variant_case() { # <label> <writer-function-name>
  new_fixture
  "$2" "$WIKI/.git/hooks/nanoclaw-secret-patterns.sh"
  BEFORE_TIP=$(remote_tip)
  echo 'export SLACK_APP_TOKEN=xapp-1-A0123-4567890123-abcdefabcdefabcdefabcdefabcdef' >> "$WIKI/README.md"
  git -C "$WIKI" commit -qam "would-be secret, but the pattern file is corrupt: $1"
  push_main
  [ "$PUSH_RC" -ne 0 ] && ok "corrupt pattern file ($1): push fails closed" \
    || bad "corrupt pattern file ($1): push succeeded (fail-OPEN)" "$PUSH_OUT"
  [ "$(remote_tip)" = "$BEFORE_TIP" ] && ok "corrupt pattern file ($1): remote unchanged" \
    || bad "corrupt pattern file ($1): remote advanced" ""
}
write_missing() { rm -f "$1"; }
write_zero_byte() { : > "$1"; }
write_unbalanced_regex() { printf 'SECRET_RE="(unbalanced"\nSECRET_BLOCK_RE="(unbalanced"\n%s\n' "$(cat "$PATTERNS_SRC")" > "$1"; }
write_truncated_before_functions() { sed -n '1,/^SECRET_BLOCK_RE=/p' "$PATTERNS_SRC" > "$1"; }
write_block_re_unset() { sed '/^SECRET_BLOCK_RE=/d' "$PATTERNS_SRC" > "$1"; }
write_missing_extract_fn() { grep -v '^secret_scan_extract_added()' "$PATTERNS_SRC" | sed '/^secret_scan_extract_added/,/^}/d' > "$1"; }
corrupt_variant_case "missing file" write_missing
corrupt_variant_case "zero-byte file" write_zero_byte
corrupt_variant_case "unbalanced regex" write_unbalanced_regex
corrupt_variant_case "truncated before the functions" write_truncated_before_functions
corrupt_variant_case "SECRET_BLOCK_RE unset" write_block_re_unset
corrupt_variant_case "missing secret_scan_extract_added" write_missing_extract_fn

# ═══ Any git error while building the scan range fails CLOSED ═════════════
# #666 review P1-2: a `push -f` retried after an earlier rejection can
# pass a remote_sha this repo no longer has locally; simulate any git
# failure the same way by feeding the hook a local_sha that doesn't exist.
new_fixture
BEFORE_TIP=$(remote_tip)
BOGUS_SHA='0123456789abcdef0123456789abcdef01234567'
PUSH_OUT=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$BOGUS_SHA" "$(git -C "$WIKI" rev-parse origin/main)" \
  | (cd "$WIKI" && bash .git/hooks/pre-push origin "$REMOTE") 2>&1)
PUSH_RC=$?
[ "$PUSH_RC" -ne 0 ] && ok "unresolvable local_sha (simulated git error): fails closed" \
  || bad "unresolvable local_sha (simulated git error): exited 0" "$PUSH_OUT"
case "$PUSH_OUT" in
  *"BLOCKED"*) ok "unresolvable local_sha: hook reports BLOCKED" ;;
  *) bad "unresolvable local_sha: no BLOCKED message" "$PUSH_OUT" ;;
esac

echo
if [ "$FAILED" -eq 0 ]; then
  echo "wiki-pre-push-hook-selfcheck: all checks passed"
else
  echo "wiki-pre-push-hook-selfcheck: FAILURES ABOVE"
fi
exit "$FAILED"
