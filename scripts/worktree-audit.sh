#!/usr/bin/env bash
# Classify every git worktree as SAFE-to-remove or KEEP, and say why.
#
# Worktrees are never garbage-collected here (they are created by agent
# sessions and by hand), so they accumulate. On 2026-08-25 there were ~45,
# including 13 on detached HEADs from finished Codex sessions. That is not
# just disk: duplicate branch names across stale worktrees caused three
# separate "I checked, nothing was there" mistakes in one session, because
# the work existed in a worktree nobody thought to look in.
#
# A worktree is SAFE only when ALL of these hold:
#   1. It is not the main checkout.
#   2. It is not locked by a LIVE process. A lock whose pid is dead is stale.
#   3. Its working tree is clean (no modified or untracked files).
#   4. Its HEAD is an ancestor of the integration branch — i.e. every commit
#      is already merged and removing the worktree loses nothing.
#
# Anything failing one of those is KEEP, with the reason printed. Default is
# report-only; --remove acts, and even then it re-checks each worktree
# immediately before removing it.
#
# Usage:
#   scripts/worktree-audit.sh            # report only
#   scripts/worktree-audit.sh --remove   # remove everything classified SAFE
set -uo pipefail

INTEGRATION="${WORKTREE_AUDIT_BASE:-main}"
DO_REMOVE=0
[ "${1:-}" = "--remove" ] && DO_REMOVE=1

MAIN_ROOT="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(dirname "$MAIN_ROOT")"

# `git worktree list --porcelain` is the only listing that reports lock state
# machine-readably; the human format buries it in a trailing word.
mapfile -t ENTRIES < <(git worktree list --porcelain)

path=""; head=""; branch=""; locked=""; lockreason=""; detached=0
safe=(); keep=0; total=0

# True if any running process has its cwd inside this worktree. Reading
# /proc/*/cwd needs no privileges for our own processes and silently skips
# others, which is the right failure direction: a process we cannot inspect
# is not one we can prove is idle, but it is also not ours to worry about.
in_use() {
  local d="${1%/}"
  ls -l /proc/*/cwd 2>/dev/null | grep -q " -> ${d}\(/\|$\)"
}

classify() {
  [ -z "$path" ] && return
  [ "$path" = "$MAIN_ROOT" ] && return
  total=$((total + 1))

  # A lock is only meaningful if the process that took it still exists.
  # Lock reasons look like: "claude session <name> (pid 2660338 start ...)".
  if [ -n "$locked" ]; then
    lock_pid="$(grep -oE 'pid [0-9]+' <<<"$lockreason" | head -1 | awk '{print $2}')"
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      printf 'KEEP  %-70s locked by live pid %s\n' "$path" "$lock_pid"; keep=$((keep + 1)); return
    fi
    if [ -z "$lock_pid" ]; then
      printf 'KEEP  %-70s locked, no pid in reason — cannot prove idle\n' "$path"; keep=$((keep + 1)); return
    fi
    stale_lock=" (stale lock, pid $lock_pid gone)"
  else
    stale_lock=""
  fi

  if [ ! -d "$path" ]; then
    printf 'SAFE  %-70s directory is gone — prunable\n' "$path"; safe+=("$path"); return
  fi

  # Second belt: a session can sit in a worktree WITHOUT locking it, and
  # removing it then pulls the floor out from under a running shell. The lock
  # is advisory; a live cwd is not.
  if in_use "$path"; then
    printf 'KEEP  %-70s a live process has its cwd here\n' "$path"; keep=$((keep + 1)); return
  fi

  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
    printf 'KEEP  %-70s uncommitted changes\n' "$path"; keep=$((keep + 1)); return
  fi

  if ! git -C "$path" merge-base --is-ancestor HEAD "$INTEGRATION" 2>/dev/null; then
    ahead="$(git -C "$path" rev-list --count "$INTEGRATION"..HEAD 2>/dev/null || echo '?')"
    printf 'KEEP  %-70s %s commit(s) not in %s\n' "$path" "$ahead" "$INTEGRATION"; keep=$((keep + 1)); return
  fi

  printf 'SAFE  %-70s merged + clean%s\n' "$path" "$stale_lock"
  safe+=("$path")
}

for line in "${ENTRIES[@]}" ""; do
  case "$line" in
    worktree\ *) classify; path="${line#worktree }"; head=""; branch=""; locked=""; lockreason=""; detached=0 ;;
    HEAD\ *)     head="${line#HEAD }" ;;
    branch\ *)   branch="${line#branch }" ;;
    detached)    detached=1 ;;
    locked)      locked=1; lockreason="" ;;
    locked\ *)   locked=1; lockreason="${line#locked }" ;;
    "")          classify; path="" ;;
  esac
done

echo
echo "$total worktrees (excluding the main checkout): ${#safe[@]} safe, $keep keep"

if [ "$DO_REMOVE" = 1 ] && [ "${#safe[@]}" -gt 0 ]; then
  echo
  for p in "${safe[@]}"; do
    # Re-check immediately before acting: this loop can run long enough for a
    # new session to claim a worktree that was idle when we classified it.
    if [ -d "$p" ] && [ -n "$(git -C "$p" status --porcelain 2>/dev/null)" ]; then
      echo "skip   $p — became dirty since classification"; continue
    fi
    if git worktree remove --force "$p" 2>/dev/null; then echo "removed $p"; else echo "FAILED  $p"; fi
  done
  git worktree prune
  echo
  echo "Branches left behind by removed worktrees are NOT deleted — review with:"
  echo "  git branch --merged $INTEGRATION"
fi
