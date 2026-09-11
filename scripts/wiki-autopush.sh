#!/usr/bin/env bash
# Auto-commit + push every group's wiki that has been initialized as a git repo.
# Idempotent: no-op for groups whose wiki/ is not a git repo, no-op when wiki has no changes.
# Pulls before pushing so device-side commits land cleanly via rebase.
#
# Before staging is pushed, its added lines are scanned for secret-shaped
# content with the same SECRET_RE scripts/git-safety.sh uses on groups/'s
# snapshot (lib/secret-scan.sh, shared so the pattern set has one copy). A
# hit FAILS CLOSED for that wiki: nothing is committed or pushed, the index
# is unstaged back to HEAD (the edit stays pending on disk for the next
# run), and the owner is DMed the same way git-safety.sh alerts on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
GROUPS_DIR="${NANOCLAW_DIR}/groups"
# shellcheck source=lib/secret-scan.sh
source "${SCRIPT_DIR}/lib/secret-scan.sh"
# Workgroup shared-FS (NANOCLAW_WORKGROUP_SHARED_FS): a migrated workgroup's wiki
# repo lives at data/workgroups/<wg>/wiki, and groups/<wg>/wiki is a container-
# absolute symlink that DANGLES on the host. Iterate both roots so the shared
# wikis AND any non-workgroup group wikis are pushed; dangling seed symlinks are
# skipped by the `-d "$wiki_dir/.git"` test below (resolves false off-host).
WORKGROUPS_DIR="${NANOCLAW_DIR}/data/workgroups"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

shopt -s nullglob
for wiki_dir in "$GROUPS_DIR"/*/wiki "$WORKGROUPS_DIR"/*/wiki; do
  [[ -d "$wiki_dir/.git" ]] || continue
  group_name=$(basename "$(dirname "$wiki_dir")")

  cd "$wiki_dir"

  # Pull first to absorb any device-side commits without conflict.
  if ! git pull --rebase --autostash origin main 2>&1; then
    echo "[wiki-autopush ${TS}] ${group_name}: pull failed, skipping push" >&2
    continue
  fi

  # Stage and commit only if there are local changes.
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A

    staged_diff=$(git diff --cached --no-color --text HEAD)
    hits=$(secret_scan_hits "$staged_diff")
    if [ "${hits:-0}" -gt 0 ]; then
      echo "[wiki-autopush ${TS}] ${group_name}: refused — $hits added line(s) look like a secret; not committing or pushing" >&2
      git reset -q
      BODY="wiki-autopush refused ${group_name}'s wiki: $hits added line(s) look like a secret.
Nothing was committed or pushed; the edit stays pending on disk.
Review: git -C ${wiki_dir} diff"
      "${NANOCLAW_DIR}/node_modules/.bin/tsx" "${NANOCLAW_DIR}/scripts/notify-owner.ts" \
        --title "Wiki autopush refused a secret-shaped change" --body "$BODY" ||
        echo "[wiki-autopush ${TS}] ${group_name}: secret-refusal DM failed (non-fatal)" >&2
      continue
    fi

    git -c user.email='nanoclaw-host@users.noreply.github.com' -c user.name='nanoclaw-host' \
      commit -m "auto: wiki sync ${TS}"
    if git push origin main 2>&1; then
      echo "[wiki-autopush ${TS}] ${group_name}: pushed"
    else
      echo "[wiki-autopush ${TS}] ${group_name}: push failed (will retry next run)" >&2
    fi
  fi
done
