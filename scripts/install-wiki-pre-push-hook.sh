#!/usr/bin/env bash
# Idempotent installer for scripts/wiki-pre-push-hook.sh.
#
# Installs (or updates) the hook plus a byte-for-byte copy of
# scripts/lib/wiki-secret-patterns.sh — renamed to
# `.git/hooks/nanoclaw-secret-patterns.sh` — into every matching
# repository's `.git/hooks/`. Self-contained on purpose (see
# wiki-pre-push-hook.sh's header): an agent's container only ever sees a
# canonical repository's `.git` control paths (config, HEAD, index, hooks/,
# objects/info) bind-mounted at their exact host paths, never
# nanoclaw-v2's own scripts/ tree, so both installed files must stand
# alone.
#
# Default target: this install's wiki repos, data/repositories/*/wiki —
# the gap this script closes (nanoclaw-v2#658 item 4: agents push these
# from inside their own container over the agent's own Bash tool, and
# nothing scans that path today).
#
# Every OTHER canonical repository (data/repositories/<workgroup>/<name>,
# per src/repository-workspaces.ts:437-468's discoverCanonicalRepositories)
# shares the identical exposure — same mount mechanism, same missing hook —
# but this installer does NOT touch them by default: --glob extends the
# target explicitly, and even then this script refuses (skips, does not
# install) any repo whose `core.hooksPath` isn't the default `.git/hooks/`,
# because an installed pre-push hook there would silently never run. A
# survey of every canonical repo on this host found several with
# `core.hooksPath` already redirected — some to `/dev/null` (hooks
# deliberately disabled), one to a repo-tracked `.husky/_` — so extending
# beyond wiki repos needs a per-repo look first, not a blind --glob run.
#
# Never runs against real repos as part of a PR/CI — this changes what a
# push does in a live, agent-driven repository, which the operator gates.
# See the PR body for the exact command to run for real.
#
# Usage:
#   bash scripts/install-wiki-pre-push-hook.sh [--dry-run] [--glob=<pattern>]
#
#   --dry-run          Report what would happen; installs nothing.
#   --glob=<pattern>   Override the default target glob
#                       (data/repositories/*/wiki). Must expand to
#                       directories that are themselves git repos (contain
#                       a `.git`).
#
# Safety: never overwrites a hook this installer didn't put there without
# backing it up first (`pre-push.pre-nanoclaw-backup-<UTC stamp>`),
# detected via the `# nanoclaw-managed-hook:` marker comment
# wiki-pre-push-hook.sh carries as its second line.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
HOOK_SRC="${SCRIPT_DIR}/wiki-pre-push-hook.sh"
PATTERNS_SRC="${SCRIPT_DIR}/lib/wiki-secret-patterns.sh"
MARKER='# nanoclaw-managed-hook: wiki-pre-push-secret-scan'

DRY_RUN=0
GLOB="${NANOCLAW_DIR}/data/repositories/*/wiki"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --glob=*) GLOB="${arg#--glob=}" ;;
    -h|--help)
      sed -n '1,40p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install-wiki-pre-push-hook: unknown argument: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done

[ -f "$HOOK_SRC" ] || { echo "install-wiki-pre-push-hook: missing $HOOK_SRC" >&2; exit 1; }
[ -f "$PATTERNS_SRC" ] || { echo "install-wiki-pre-push-hook: missing $PATTERNS_SRC" >&2; exit 1; }
grep -qF "$MARKER" "$HOOK_SRC" || {
  echo "install-wiki-pre-push-hook: $HOOK_SRC is missing its own marker comment — refusing, this would break foreign-hook detection" >&2
  exit 1
}

installed=0
skipped_hookspath=0
skipped_notrepo=0
backed_up=0

shopt -s nullglob
for repo_dir in $GLOB; do
  if [ ! -d "$repo_dir/.git" ]; then
    skipped_notrepo=$((skipped_notrepo + 1))
    continue
  fi

  hooks_path=$(git -C "$repo_dir" config --get core.hooksPath 2>/dev/null || true)
  if [ -n "$hooks_path" ]; then
    echo "install-wiki-pre-push-hook: SKIP $repo_dir -- core.hooksPath=$hooks_path (not the default .git/hooks/; an installed hook there would never run)" >&2
    skipped_hookspath=$((skipped_hookspath + 1))
    continue
  fi

  hooks_dir="$repo_dir/.git/hooks"
  dest_hook="$hooks_dir/pre-push"
  dest_patterns="$hooks_dir/nanoclaw-secret-patterns.sh"
  is_foreign=0
  if [ -e "$dest_hook" ] && ! grep -qF "$MARKER" "$dest_hook" 2>/dev/null; then
    is_foreign=1
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$is_foreign" -eq 1 ]; then
      echo "install-wiki-pre-push-hook: [dry-run] $repo_dir: would BACK UP existing foreign hook, then install"
    elif [ -e "$dest_hook" ]; then
      echo "install-wiki-pre-push-hook: [dry-run] $repo_dir: would update our existing hook"
    else
      echo "install-wiki-pre-push-hook: [dry-run] $repo_dir: would install a new hook"
    fi
    installed=$((installed + 1))
    continue
  fi

  mkdir -p "$hooks_dir"
  if [ "$is_foreign" -eq 1 ]; then
    backup="$dest_hook.pre-nanoclaw-backup-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$dest_hook" "$backup"
    echo "install-wiki-pre-push-hook: backed up foreign hook $dest_hook -> $backup"
    backed_up=$((backed_up + 1))
  fi
  cp "$HOOK_SRC" "$dest_hook"
  chmod +x "$dest_hook"
  cp "$PATTERNS_SRC" "$dest_patterns"
  echo "install-wiki-pre-push-hook: installed $dest_hook"
  installed=$((installed + 1))
done

echo "install-wiki-pre-push-hook: ${installed} repo(s) processed, ${skipped_hookspath} skipped (core.hooksPath override), ${skipped_notrepo} skipped (not a git repo), ${backed_up} foreign hook(s) backed up"
