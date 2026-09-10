#!/usr/bin/env bash
# Nightly git safety net for a host where many sessions share one checkout.
#
# Two phases; a failure in one does not skip the other:
#   1. snapshot — every commit that exists only on this host (on no remote),
#      every uncommitted edit and new file, and every stash, across all
#      worktrees of this repo, groups/, and $GIT_SAFETY_EXTRA_REPOS, into
#      $GIT_SAFETY_DIR/<UTC stamp>/. Read-only against the repos except for
#      refs/backup/* refs that pin detached-HEAD and stash commits so `git gc`
#      cannot collect them. It covers what a shared tree loses silently: the
#      /tmp sweep (tmpfiles `D /tmp ... 30d`, and all of /tmp at boot), a
#      worktree removal, a reset or checkout run in the wrong session.
#   2. groups commit — commits and pushes pending edits to files groups/
#      already tracks. The host sync scripts (codex-sync, claude-agent-md) and
#      operator sessions edit its container.json and instruction files in place
#      and nothing commits them, so the config every agent boots from lived
#      only on this disk. NEW untracked files are never committed here: the
#      path allowlist in groups/.gitignore has let whole source trees through
#      (an agent audit folder holding a full copy of another repository), so
#      they stay in the snapshot and are counted in its manifest. A
#      secret-shaped added line refuses the whole commit, before anything is
#      staged.
#
# Silent on success. On failure it DMs the owner via scripts/notify-owner.ts
# and exits 1. Runs before storage-gc so anything the GC takes is captured.
#
# Env:
#   GIT_SAFETY_DIR            snapshot root (default ~/nanoclaw-backups)
#   GIT_SAFETY_KEEP_DAYS      delete snapshots older than this (default 14)
#   GIT_SAFETY_EXTRA_REPOS    space-separated extra repo paths or globs
#   GIT_SAFETY_GROUPS_COMMIT  apply (default) | dry (snapshot only; report the
#                             groups commit without making it, and no owner DM)
#
# Manual run:  bash scripts/git-safety.sh
# Restore:     see MANIFEST.txt in the snapshot directory

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
cd "$NANOCLAW_DIR" || exit 1

SNAP_ROOT="${GIT_SAFETY_DIR:-$HOME/nanoclaw-backups}"
KEEP_DAYS="${GIT_SAFETY_KEEP_DAYS:-14}"
GROUPS_MODE="${GIT_SAFETY_GROUPS_COMMIT:-apply}"
GROUPS_DIR="$NANOCLAW_DIR/groups"
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$SNAP_ROOT/$TS"
MAN="$OUT/MANIFEST.txt"
ERR="$OUT/errors.log"
FAILURES=()
GROUPS_RESULT="skipped (no groups/ repo)"

mkdir -p "$OUT" || { echo "git-safety: cannot create $OUT" >&2; exit 1; }
say() { echo "$*" >> "$MAN"; }
slug() { printf '%s' "$1" | sed 's#^/##; s#[^A-Za-z0-9._-]#_#g' | tail -c 150; }

say "Snapshot $TS"
say "Restore commits:   git fetch <bundle> 'refs/*:refs/restored/*'"
say "Restore edits:     git apply --binary <patch>   (in a worktree at the recorded HEAD)"
say "Restore new files: tar xzf <tgz> -C <worktree>"

# ── phase 1: snapshot ───────────────────────────────────────────────────────
snapshot_repo() { # <repo path> <label>
  local repo=$1 label=$2 dir="$OUT/$2" h w s list r n=0 i=0
  mkdir -p "$dir"

  # Pin detached HEADs that hold commits on no remote: once their worktree
  # directory is gone, nothing but the reflog keeps them.
  while read -r w; do
    [ -e "$w" ] || continue
    h=$(git -C "$w" rev-parse HEAD 2>/dev/null) || continue
    if [ "$(git -C "$repo" rev-list --count "$h" --not --remotes 2>/dev/null || echo 0)" -gt 0 ]; then
      git -C "$repo" update-ref "refs/backup/detached/$(slug "$w")" "$h" 2>>"$ERR"
    fi
  done < <(git -C "$repo" worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /^detached/{print w}')

  # Pin every stash entry; a bundle of refs/stash carries only the newest.
  while read -r s; do
    git -C "$repo" update-ref "refs/backup/stash/$i" "$s" 2>>"$ERR"
    i=$((i + 1))
  done < <(git -C "$repo" stash list --format=%H 2>/dev/null)

  while read -r r; do
    [ "$(git -C "$repo" rev-list --count "$r" --not --remotes 2>/dev/null || echo 0)" -gt 0 ] && n=$((n + 1))
  done < <(git -C "$repo" for-each-ref --format='%(refname)' refs/heads refs/backup)
  if [ "$n" -gt 0 ]; then
    if git -C "$repo" bundle create "$dir/unpushed-commits.bundle" --branches --glob='refs/backup/*' --not --remotes >/dev/null 2>>"$ERR" &&
       git -C "$repo" bundle verify "$dir/unpushed-commits.bundle" >/dev/null 2>&1; then
      say "$label: bundled $n refs holding commits on no remote"
    else
      FAILURES+=("$label: could not write a verified bundle of its $n refs holding unpushed commits")
    fi
  fi

  # Per worktree: tracked edits as a binary patch, new files (<100MB) as a tarball.
  while read -r w; do
    [ -e "$w" ] || continue
    [ -n "$(git -C "$w" status --porcelain 2>/dev/null)" ] || continue
    s=$(slug "$w")
    list="$dir/$s.untracked"
    git -C "$w" diff --binary HEAD > "$dir/$s.patch" 2>>"$ERR"
    [ -s "$dir/$s.patch" ] || rm -f "$dir/$s.patch"
    git -C "$w" ls-files --others --exclude-standard -z 2>/dev/null |
      while IFS= read -r -d '' f; do
        [ -f "$w/$f" ] && [ "$(stat -c %s "$w/$f")" -lt 104857600 ] && printf '%s\0' "$f"
      done > "$list"
    [ -s "$list" ] && tar --null -C "$w" -T "$list" -czf "$dir/$s-untracked.tgz" 2>>"$ERR"
    rm -f "$list"
    say "$label: $w  HEAD=$(git -C "$w" rev-parse --short HEAD) branch=$(git -C "$w" rev-parse --abbrev-ref HEAD) uncommitted=$(git -C "$w" status --porcelain | wc -l)"
  done < <(git -C "$repo" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')
}

snapshot_repo "$NANOCLAW_DIR" nanoclaw
[ -d "$GROUPS_DIR/.git" ] && snapshot_repo "$GROUPS_DIR" groups
for spec in ${GIT_SAFETY_EXTRA_REPOS:-}; do
  for r in $spec; do
    r=${r%/}
    git -C "$r" rev-parse --git-dir >/dev/null 2>&1 || continue
    [ -n "$(git -C "$r" status --porcelain 2>/dev/null)$(git -C "$r" log --oneline --branches --not --remotes 2>/dev/null | head -c1)$(git -C "$r" stash list 2>/dev/null | head -c1)" ] || continue
    snapshot_repo "$r" "extra-$(slug "$r")"
  done
done
find "$OUT" -mindepth 1 -type d -empty -delete 2>/dev/null

# ── phase 2: commit + push tracked edits in groups/ ─────────────────────────
SECRET_RE='(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"(password|secret|api[_-]?key|token)"[[:space:]]*:[[:space:]]*"[^"]{12,}")'
commit_groups() {
  local G=$GROUPS_DIR pending n folders hits untracked
  if [ -e "$G/.git/index.lock" ]; then
    FAILURES+=("groups: another session holds groups/.git/index.lock — nothing committed tonight; it retries tomorrow")
    GROUPS_RESULT="skipped (index locked)"; return
  fi
  timeout 60 git -C "$G" fetch --quiet origin 2>>"$ERR" || true
  if [ "$(git -C "$G" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)" -gt 0 ]; then
    if ! git -C "$G" merge --ff-only --quiet origin/main 2>>"$ERR"; then
      FAILURES+=("groups: behind origin/main and a pending edit collides with the incoming change — nothing committed; the snapshot holds the edits")
      GROUPS_RESULT="skipped (cannot fast-forward)"; return
    fi
  fi
  untracked=$(git -C "$G" ls-files --others --exclude-standard | wc -l)
  [ "$untracked" -gt 0 ] && say "groups: $untracked new untracked file(s) left uncommitted on purpose (saved in this snapshot) — commit them by hand if they are config"
  pending=$(git -C "$G" status --porcelain --untracked-files=no)
  if [ -n "$pending" ]; then
    n=$(printf '%s\n' "$pending" | wc -l)
    folders=$(printf '%s\n' "$pending" | awk '{p=substr($0,4); split(p,a,"/"); print a[1]}' | sort -u | tr '\n' ' ')
    # Checked before staging, so a refusal never touches another session's index.
    hits=$( { git -C "$G" diff HEAD | grep -E '^\+' | grep -cE "$SECRET_RE"; } 2>/dev/null || true)
    if [ "${hits:-0}" -gt 0 ]; then
      FAILURES+=("groups: $hits added line(s) in tracked files look like a secret — refused to commit any of the $n; review them with: git -C groups diff")
      GROUPS_RESULT="refused (secret-shaped content)"; return
    fi
    if [ "$GROUPS_MODE" = "dry" ]; then
      GROUPS_RESULT="dry run: would commit $n tracked change(s) in: $folders"; return
    fi
    if ! { git -C "$G" add -u 2>>"$ERR" &&
           git -C "$G" commit -q -m "chore(groups): nightly snapshot of $n pending config change(s)" \
             -m "Folders: $folders" \
             -m "Committed by scripts/git-safety.sh. Host sync scripts and operator sessions edit these files in place and nothing else commits them." 2>>"$ERR"; }; then
      FAILURES+=("groups: commit of $n pending change(s) failed — see $ERR")
      GROUPS_RESULT="commit failed"; return
    fi
    GROUPS_RESULT="committed $n tracked change(s) in: $folders"
  else
    GROUPS_RESULT="nothing pending"
  fi
  if [ "$(git -C "$G" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)" -gt 0 ]; then
    if [ "$GROUPS_MODE" = "dry" ]; then GROUPS_RESULT="$GROUPS_RESULT; dry run: would push"; return; fi
    if timeout 120 git -C "$G" push --quiet origin HEAD:main 2>>"$ERR"; then
      GROUPS_RESULT="$GROUPS_RESULT; pushed"
    else
      FAILURES+=("groups: push to origin failed — the commit is safe locally and the next run retries")
      GROUPS_RESULT="$GROUPS_RESULT; push FAILED"
    fi
  fi
}
[ -d "$GROUPS_DIR/.git" ] && commit_groups
say "groups: $GROUPS_RESULT"

# ── retention ───────────────────────────────────────────────────────────────
find "$SNAP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime +"$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null

SIZE=$(du -sh "$OUT" 2>/dev/null | cut -f1)
if [ ${#FAILURES[@]} -gt 0 ]; then
  BODY="$(printf -- '- %s\n' "${FAILURES[@]}")

Whatever did succeed is in $OUT ($SIZE)."
  printf '%s\n' "${FAILURES[@]}" >&2
  if [ "$GROUPS_MODE" = "dry" ]; then
    echo "git-safety: dry run — owner not notified" >&2
  else
    node_modules/.bin/tsx scripts/notify-owner.ts --title "Git safety net needs attention" --body "$BODY" ||
      echo "git-safety: FAILURE AND NOBODY WAS TOLD" >&2
  fi
  exit 1
fi
echo "git-safety: ok — snapshot $OUT ($SIZE); groups: $GROUPS_RESULT"
