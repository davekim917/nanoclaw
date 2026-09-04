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
#   2. It is not locked. Explicit locks require deliberate owner recovery.
#   3. No live process has its cwd inside it.
#   4. Its working tree is clean (no modified or untracked files).
#   5. Its HEAD is an ancestor of the integration branch — i.e. every commit
#      is already merged and removing the worktree loses nothing.
#   6. It has been untouched for MIN_IDLE_HOURS.
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
# Hours a worktree must be untouched before it is eligible. Guards the case the
# lock and cwd checks cannot see: an agent session idle mid-task, holding no
# lock and running no process, that someone intends to return to. 24h is a
# deliberate over-estimate — the cost of keeping a dead worktree one more day
# is a directory; the cost of reaping a live one is someone's work.
MIN_IDLE_HOURS="${WORKTREE_AUDIT_MIN_IDLE_HOURS:-24}"
DO_REMOVE=0
[ "${1:-}" = "--remove" ] && DO_REMOVE=1

MAIN_ROOT="$(git rev-parse --path-format=absolute --git-common-dir)"
COMMON_DIR="$MAIN_ROOT"
MAIN_ROOT="$(dirname "$COMMON_DIR")"

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

# A vanished linked checkout can still hold its only staged tree and detached
# HEAD inside .git/worktrees/<id>. Resolve that exact private admin record; a
# repository-wide prune is never safe because it cannot distinguish siblings.
admin_for_path() {
  local wanted="${1%/}" admin pointer
  for admin in "$COMMON_DIR"/worktrees/*; do
    [ -d "$admin" ] || continue
    [ -f "$admin/gitdir" ] || continue
    IFS= read -r pointer < "$admin/gitdir" || continue
    [ "${pointer%/.git}" = "$wanted" ] && { printf '%s\n' "$admin"; return 0; }
  done
  return 1
}

classify() {
  [ -z "$path" ] && return
  [ "$path" = "$MAIN_ROOT" ] && return
  total=$((total + 1))

  # Locks are explicit preservation state. Even a dead pid can leave staged
  # data in the private linked index, so audit reports it but never clears it.
  if [ -n "$locked" ]; then
    lock_pid="$(grep -oE 'pid [0-9]+' <<<"$lockreason" | head -1 | awk '{print $2}')"
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then lock_state="live pid $lock_pid"
    elif [ -n "$lock_pid" ]; then lock_state="pid $lock_pid gone"
    else lock_state="no pid in reason"
    fi
    printf 'KEEP  %-70s locked (%s)\n' "$path" "$lock_state"; keep=$((keep + 1)); return
  fi

  if [ ! -d "$path" ]; then
    local admin rc age_h
    admin="$(admin_for_path "$path")" || {
      printf 'KEEP  %-70s directory gone, private admin record unprovable\n' "$path"; keep=$((keep + 1)); return
    }
    git --git-dir="$admin" diff-index --cached --quiet HEAD -- 2>/dev/null
    rc=$?
    if [ "$rc" -eq 1 ]; then
      printf 'KEEP  %-70s directory gone, staged state survives in private index\n' "$path"; keep=$((keep + 1)); return
    fi
    if [ "$rc" -ne 0 ]; then
      printf 'KEEP  %-70s directory gone, private index unprovable\n' "$path"; keep=$((keep + 1)); return
    fi
    if ! git --git-dir="$admin" merge-base --is-ancestor HEAD "$INTEGRATION" 2>/dev/null; then
      printf 'KEEP  %-70s directory gone, HEAD is not contained in %s\n' "$path" "$INTEGRATION"
      keep=$((keep + 1)); return
    fi
    age_h=$(( ( $(date +%s) - $(stat -c %Y "$admin" 2>/dev/null || echo 0) ) / 3600 ))
    if [ "$age_h" -lt "$MIN_IDLE_HOURS" ]; then
      printf 'KEEP  %-70s missing admin active %sh ago (< %sh quiet window)\n' "$path" "$age_h" "$MIN_IDLE_HOURS"
      keep=$((keep + 1)); return
    fi
    printf 'SAFE  %-70s directory gone, index clean + HEAD merged\n' "$path"; safe+=("$path"); return
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

  # Third belt: an agent session can be idle mid-task with NOTHING running --
  # waiting on a user, or between turns. It holds no lock and has no live cwd,
  # so both belts above pass, and reaping it destroys work someone is coming
  # back to. Recent activity is the only signal left, so treat anything touched
  # inside the quiet window as in use.
  #
  # Measured against .git rather than the tree: a worktree's .git file is
  # rewritten on checkout/commit/stash, whereas the tree mtime can be stale on
  # a worktree whose last action was a read.
  local age_h
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$path/.git" 2>/dev/null || echo 0) ) / 3600 ))
  if [ "$age_h" -lt "$MIN_IDLE_HOURS" ]; then
    printf 'KEEP  %-70s active %sh ago (< %sh quiet window)\n' "$path" "$age_h" "$MIN_IDLE_HOURS"
    keep=$((keep + 1)); return
  fi

  printf 'SAFE  %-70s merged + clean\n' "$path"
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
    if [ -d "$p" ]; then
      if in_use "$p" || [ -n "$(git -C "$p" status --porcelain 2>/dev/null)" ]; then
        echo "skip   $p — became active or dirty since classification"; continue
      fi
    else
      admin="$(admin_for_path "$p")" || { echo "skip   $p — private admin record vanished"; continue; }
      if ! git --git-dir="$admin" diff-index --cached --quiet HEAD -- 2>/dev/null; then
        echo "skip   $p — private index became staged or unreadable"; continue
      fi
      if ! git --git-dir="$admin" merge-base --is-ancestor HEAD "$INTEGRATION" 2>/dev/null; then
        echo "skip   $p — private HEAD is no longer contained in $INTEGRATION"; continue
      fi
    fi
    if git worktree remove --force "$p" 2>/dev/null; then echo "removed $p"; else echo "FAILED  $p"; fi
  done
  echo
  echo "Branches left behind by removed worktrees are NOT deleted — review with:"
  echo "  git branch --merged $INTEGRATION"
fi
