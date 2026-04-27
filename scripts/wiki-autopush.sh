#!/usr/bin/env bash
# Auto-commit + push every group's wiki that has been initialized as a git repo.
# Idempotent: no-op for groups whose wiki/ is not a git repo, no-op when wiki has no changes.
# Pulls before pushing so device-side commits land cleanly via rebase.

set -euo pipefail

GROUPS_DIR="/home/ubuntu/nanoclaw-v2/groups"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

shopt -s nullglob
for wiki_dir in "$GROUPS_DIR"/*/wiki; do
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
    git -c user.email='nanoclaw-host@illysium.ai' -c user.name='nanoclaw-host' \
      commit -m "auto: wiki sync ${TS}"
    if git push origin main 2>&1; then
      echo "[wiki-autopush ${TS}] ${group_name}: pushed"
    else
      echo "[wiki-autopush ${TS}] ${group_name}: push failed (will retry next run)" >&2
    fi
  fi
done
