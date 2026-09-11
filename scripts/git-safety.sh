#!/usr/bin/env bash
# Nightly git safety net for a host where many sessions share one checkout.
#
# Two phases; a failure in one does not skip the other:
#   1. snapshot — every commit that exists only on this host (on no remote),
#      every uncommitted edit and new file, and every stash, across all
#      worktrees of this repo, groups/, and $GIT_SAFETY_EXTRA_REPOS, into
#      $GIT_SAFETY_DIR/<UTC stamp>/. Read-only against the repos except for
#      refs/git-safety/* refs that pin detached-HEAD and stash commits so
#      `git gc` cannot collect them; those refs are pruned once whatever they
#      protected is gone AND the pin itself has outlived $GIT_SAFETY_KEEP_DAYS
#      (tracked via a marker file, not the ref's own timestamp, because a
#      still-live stash entry must never expire). It covers what a shared
#      tree loses silently: the /tmp sweep (tmpfiles `D /tmp ... 30d`, and all
#      of /tmp at boot), a worktree removal, a reset or checkout run in the
#      wrong session.
#   2. groups snapshot — commits pending edits to files groups/ already
#      tracks and pushes them to refs/heads/$GIT_SAFETY_SNAPSHOT_BRANCH (never
#      main, never groups' own HEAD). The host sync scripts (codex-sync,
#      claude-agent-md) and operator sessions edit its container.json and
#      instruction files in place and nothing commits them, so the config
#      every agent boots from lived only on this disk. It NEVER touches
#      groups' HEAD, index, or working tree: the tree it commits is built and
#      scanned entirely inside a scratch index (GIT_INDEX_FILE), so nothing
#      another session has staged in the real index can leak in, and nothing
#      written to disk after the scan can slip into the commit — the tree
#      that gets committed is exactly the tree that was scanned. NEW
#      untracked files are never committed here: the path allowlist in
#      groups/.gitignore has let whole source trees through (an agent audit
#      folder holding a full copy of another repository), so they stay in the
#      snapshot and are counted in its manifest. Deletions of tracked files
#      are reported, never committed — a file missing from disk stays in the
#      snapshot commit at its last known-good content. Sensitive filenames
#      (.env*, *.pem, *.p8, *.key, credentials*, profiles.yml) are never
#      staged even when tracked; they are reported instead. A secret-shaped
#      added line, or any binary change, refuses the whole commit before
#      anything is staged.
#
# Silent on success (a pending deletion still gets its own DM even on an
# otherwise clean run — see below). On FAILURE it DMs the owner via
# scripts/notify-owner.ts and exits 1. Runs before storage-gc so anything the
# GC takes is captured.
#
# Env:
#   GIT_SAFETY_DIR                snapshot root (default ~/nanoclaw-backups)
#   GIT_SAFETY_KEEP_DAYS          delete snapshots older than this (default 14)
#   GIT_SAFETY_EXTRA_REPOS        space-separated extra repo paths or globs
#   GIT_SAFETY_GROUPS_COMMIT      apply (default) | dry (report only: no fetch,
#                                 no commit, no push, no owner DM)
#   GIT_SAFETY_SNAPSHOT_BRANCH    branch groups/ snapshots push to
#                                 (default host-snapshot)
#   GIT_SAFETY_MAX_UNTRACKED_BYTES  size cap for untracked files captured in a
#                                 snapshot tarball (default 104857600 = 100MB)
#
# Manual run:  bash scripts/git-safety.sh
# Restore:     see MANIFEST.txt in the snapshot directory. groups/ config
#              lives on refs/heads/$GIT_SAFETY_SNAPSHOT_BRANCH, e.g.:
#              git -C groups fetch origin host-snapshot && \
#                git -C groups show origin/host-snapshot:<path>

set -uo pipefail

# `git status`/`git diff` opportunistically rewrite `.git/index` even when
# nothing changes (the "refresh" optimization) — across every worktree of a
# shared checkout, that collides with a concurrent deploy, pull or reset.
# This variable is respected by every git subcommand this script (and
# anything it shells out to) invokes.
export GIT_OPTIONAL_LOCKS=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
cd "$NANOCLAW_DIR" || exit 1

SNAP_ROOT="${GIT_SAFETY_DIR:-$HOME/nanoclaw-backups}"
KEEP_DAYS="${GIT_SAFETY_KEEP_DAYS:-14}"
GROUPS_MODE="${GIT_SAFETY_GROUPS_COMMIT:-apply}"
GROUPS_DIR="$NANOCLAW_DIR/groups"
SNAPSHOT_BRANCH="${GIT_SAFETY_SNAPSHOT_BRANCH:-host-snapshot}"
MAX_UNTRACKED_BYTES="${GIT_SAFETY_MAX_UNTRACKED_BYTES:-104857600}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$SNAP_ROOT/$TS"
MAN="$OUT/MANIFEST.txt"
ERR="$OUT/errors.log"
FAILURES=()
NOTICES=()
GROUPS_RESULT="skipped (no groups/ repo)"

# Everything under $OUT (patches, tarballs, the manifest) holds config and,
# for untracked files, potentially secret-shaped content that slipped past
# .gitignore. New files/dirs default to owner-only from here on.
umask 077

mkdir -p "$OUT" || { echo "git-safety: cannot create $OUT" >&2; exit 1; }
say() { echo "$*" >> "$MAN"; }
slug() { # <path> -> unique, valid-ref-name-safe slug
  local raw="$1" base hash
  base=$(printf '%s' "$raw" | sed 's#^/##; s#[^A-Za-z0-9._-]#_#g' | tail -c 100)
  # A truncated slug alone can collide (two long paths sharing the same
  # tail); a checksum of the FULL untruncated path makes every slug unique
  # even when two paths collide after truncation.
  hash=$(printf '%s' "$raw" | cksum | cut -d' ' -f1)
  printf '%s-%s' "$base" "$hash"
}
check_err() { # <errfile> <failure-label> — non-silent errors from a phase-1 step
  if [ -s "$1" ]; then
    FAILURES+=("$2: $(tr '\n' ' ' < "$1" | cut -c1-300)")
  fi
  cat "$1" >> "$ERR" 2>/dev/null
  rm -f "$1"
}
excluded_snapshot_name() { # <basename> -> 0 if it must never enter a tarball
  case "$1" in
    .env|.env.*|*.pem|*.p8|*.key|credentials*|credentials.*) return 0 ;;
    *) return 1 ;;
  esac
}
verify_bundle() { # <bundle-path> <source-repo> — real integrity check
  # `git bundle verify` only checks that the bundle's prerequisite commits
  # are present in the target repo; it never inflates the pack itself, so a
  # bundle whose compressed object data is corrupted still "verifies". A
  # plain `git fetch <bundle>` is not a real check either: when the scratch
  # repo's alternates point at the very repo the bundle was just built from,
  # every OID the bundle advertises already "exists" there, so git's
  # quickfetch optimization updates refs without ever touching the pack
  # bytes -- a corrupted pack still "fetches" clean (verified empirically
  # while building this: identical rc=0 on a byte-flipped trailer). Pulling
  # the bundle's embedded pack out and feeding it straight to `index-pack`
  # forces real decompression and a trailer-checksum check no matter what
  # the scratch repo can already see; --fix-thin plus the alternate resolves
  # prerequisite base objects the same way a real restore would.
  local bundle=$1 src=$2 scratch objdir pack_off tmp_pack rc
  scratch=$(mktemp -d) || return 1
  if ! git init --bare -q "$scratch" >/dev/null 2>&1; then rm -rf "$scratch"; return 1; fi
  objdir=$(git -C "$src" rev-parse --git-path objects 2>/dev/null) || { rm -rf "$scratch"; return 1; }
  case "$objdir" in /*) : ;; *) objdir="$src/$objdir" ;; esac
  pack_off=$(grep -abo -m1 'PACK' "$bundle" 2>/dev/null | head -1 | cut -d: -f1)
  if [ -z "$pack_off" ]; then rm -rf "$scratch"; return 1; fi
  tmp_pack=$(mktemp)
  tail -c +$((pack_off + 1)) "$bundle" > "$tmp_pack"
  GIT_ALTERNATE_OBJECT_DIRECTORIES="$objdir" GIT_DIR="$scratch" \
    git index-pack --stdin --fix-thin -o "$scratch/verify.idx" < "$tmp_pack" >/dev/null 2>&1
  rc=$?
  rm -f "$tmp_pack"
  rm -rf "$scratch"
  return $rc
}

say "Snapshot $TS"
say "Restore commits:   git fetch <bundle> 'refs/*:refs/*' (verify first: see verify_bundle in this script)"
say "Restore edits:     git apply --binary <patch>   (in a worktree at the recorded HEAD)"
say "Restore new files: tar xzf <tgz> -C <worktree>"
say "Restore groups/ config: git -C groups fetch origin $SNAPSHOT_BRANCH && git -C groups show origin/$SNAPSHOT_BRANCH:<path>"

# ── phase 1: snapshot ───────────────────────────────────────────────────────
snapshot_repo() { # <repo path> <label>
  local repo=$1 label=$2 dir="$OUT/$2" h w s list r n=0
  mkdir -p "$dir"

  local mark_dir="$SNAP_ROOT/.git-safety-refs/$label"
  mkdir -p "$mark_dir"

  # Pin detached HEADs that hold commits on no remote: once their worktree
  # directory is gone, nothing but the reflog keeps them.
  local live_detached=()
  while read -r w; do
    [ -e "$w" ] || continue
    h=$(git -C "$w" rev-parse HEAD 2>/dev/null) || continue
    if [ "$(git -C "$repo" rev-list --count "$h" --not --remotes 2>/dev/null || echo 0)" -gt 0 ]; then
      local wslug; wslug=$(slug "$w")
      local e; e=$(mktemp)
      git -C "$repo" update-ref "refs/git-safety/detached/$wslug" "$h" 2>"$e"
      check_err "$e" "$label: update-ref for detached worktree at $w"
      live_detached+=("$wslug")
      rm -f "$mark_dir/detached-$wslug"
    fi
  done < <(git -C "$repo" worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /^detached/{print w}')

  # Pin every stash entry by content SHA (not list position): a bundle of
  # refs/stash carries only the newest, and a positional ref name goes stale
  # the moment an entry is popped or a new one is pushed ahead of it.
  local live_stash=()
  while read -r s; do
    local e; e=$(mktemp)
    git -C "$repo" update-ref "refs/git-safety/stash/$s" "$s" 2>"$e"
    check_err "$e" "$label: update-ref for stash entry $s"
    live_stash+=("$s")
    rm -f "$mark_dir/stash-$s"
  done < <(git -C "$repo" stash list --format=%H 2>/dev/null)

  # Expire pins whose worktree/stash entry is gone AND has been gone for at
  # least $KEEP_DAYS — tracked via a marker file's mtime, not the ref's own
  # date, because a stash entry that has sat untouched for months is still
  # live and must never expire.
  local refname suffix mfile
  while read -r refname; do
    suffix=${refname#refs/git-safety/detached/}
    printf '%s\n' "${live_detached[@]}" | grep -qxF "$suffix" && continue
    mfile="$mark_dir/detached-$suffix"
    [ -e "$mfile" ] || touch "$mfile"
    [ -n "$(find "$mfile" -mtime +"$KEEP_DAYS" 2>/dev/null)" ] && { git -C "$repo" update-ref -d "$refname" 2>/dev/null; rm -f "$mfile"; }
  done < <(git -C "$repo" for-each-ref --format='%(refname)' refs/git-safety/detached 2>/dev/null)
  while read -r refname; do
    suffix=${refname#refs/git-safety/stash/}
    printf '%s\n' "${live_stash[@]}" | grep -qxF "$suffix" && continue
    mfile="$mark_dir/stash-$suffix"
    [ -e "$mfile" ] || touch "$mfile"
    [ -n "$(find "$mfile" -mtime +"$KEEP_DAYS" 2>/dev/null)" ] && { git -C "$repo" update-ref -d "$refname" 2>/dev/null; rm -f "$mfile"; }
  done < <(git -C "$repo" for-each-ref --format='%(refname)' refs/git-safety/stash 2>/dev/null)

  while read -r r; do
    [ "$(git -C "$repo" rev-list --count "$r" --not --remotes 2>/dev/null || echo 0)" -gt 0 ] && n=$((n + 1))
  done < <(git -C "$repo" for-each-ref --format='%(refname)' refs/heads refs/git-safety)
  if [ "$n" -gt 0 ]; then
    local be; be=$(mktemp)
    if git -C "$repo" bundle create "$dir/unpushed-commits.bundle" --branches --glob='refs/git-safety/*' --not --remotes >/dev/null 2>"$be" &&
       verify_bundle "$dir/unpushed-commits.bundle" "$repo"; then
      say "$label: bundled $n refs holding commits on no remote"
    else
      FAILURES+=("$label: could not write a verified bundle of its $n refs holding unpushed commits")
    fi
    cat "$be" >> "$ERR" 2>/dev/null; rm -f "$be"
  fi

  # Per worktree: tracked edits as a binary patch, new files (under the size
  # cap, and never secret-shaped by filename) as a tarball.
  while read -r w; do
    [ -e "$w" ] || continue
    [ -n "$(git -C "$w" status --porcelain 2>/dev/null)" ] || continue
    s=$(slug "$w")
    list="$dir/$s.untracked"
    local pe; pe=$(mktemp)
    git -C "$w" diff --binary --no-color HEAD > "$dir/$s.patch" 2>"$pe"
    check_err "$pe" "$label: diff for $w"
    [ -s "$dir/$s.patch" ] || rm -f "$dir/$s.patch"
    git -C "$w" ls-files --others --exclude-standard -z 2>/dev/null |
      while IFS= read -r -d '' f; do
        [ -f "$w/$f" ] || continue
        local bn sz
        bn=$(basename -- "$f")
        if excluded_snapshot_name "$bn"; then
          say "$label: $w: excluded $f from snapshot (secret-shaped filename)"
          continue
        fi
        sz=$(stat -c %s "$w/$f" 2>/dev/null || echo 0)
        if [ "$sz" -ge "$MAX_UNTRACKED_BYTES" ]; then
          say "$label: $w: skipped $f ($sz bytes, >= $MAX_UNTRACKED_BYTES cap)"
          continue
        fi
        printf '%s\0' "$f"
      done > "$list"
    if [ -s "$list" ]; then
      local te; te=$(mktemp)
      tar --null -C "$w" -T "$list" -czf "$dir/$s-untracked.tgz" 2>"$te"
      check_err "$te" "$label: tar of untracked files for $w"
    fi
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

# ── phase 2: snapshot groups/'s pending tracked-file edits ──────────────────
# Broad, case-insensitive, and deliberately over-inclusive: refusing a
# non-secret line costs a manual `git -C groups diff` and a re-run; missing a
# real one costs a leaked credential. Covers common vendor token shapes
# (OpenAI, Stripe, GitHub PAT/OAuth/App, Slack bot/app, AWS, Google), PEM
# private keys, JWTs, connection-string credentials, env/export assignments,
# and JSON/YAML/plain "key: value" or "key=value" forms for
# password/secret/token/api_key (the bare "token" alternative also matches
# "access_token", "refresh_token", etc. as a substring — deliberately, so the
# list doesn't need every compound name spelled out).
SECRET_RE='(sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{30,}|gh[os]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9.-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+|[A-Za-z][A-Za-z0-9+.-]*://[^/@[:space:]:]+:[^/@[:space:]]+@|export[[:space:]]+[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*[[:space:]]*=|(token|api[_-]?key|password|secret)[^A-Za-z0-9]{0,3}[:=][[:space:]]*[^[:space:]])'

# Sensitive filenames are never staged even when git already tracks them —
# excluded via pathspec BEFORE `add -u` runs, so they never touch the scratch
# index in the first place.
GROUPS_SENSITIVE_EXCLUDES=(
  ':(exclude,glob)**/.env'
  ':(exclude,glob)**/.env.*'
  ':(exclude,glob)**/*.pem'
  ':(exclude,glob)**/*.p8'
  ':(exclude,glob)**/*.key'
  ':(exclude,glob)**/credentials*'
  ':(exclude,glob)**/profiles.yml'
)
GROUPS_SENSITIVE_PATHSPECS=(':(glob)**/.env' ':(glob)**/.env.*' ':(glob)**/*.pem' ':(glob)**/*.p8' ':(glob)**/*.key' ':(glob)**/credentials*' ':(glob)**/profiles.yml')

_commit_groups_impl() { # <scratch index file>
  local TMPIDX=$1
  local G=$GROUPS_DIR
  local groups_head

  groups_head=$(git -C "$G" rev-parse HEAD 2>>"$ERR") || {
    FAILURES+=("groups: could not resolve HEAD"); GROUPS_RESULT="failed (no HEAD)"; return; }

  # Everything from here builds and inspects ONLY the scratch index — never
  # groups' real .git/index, HEAD, or working tree files.
  GIT_INDEX_FILE="$TMPIDX" git -C "$G" read-tree HEAD 2>>"$ERR" || {
    FAILURES+=("groups: read-tree HEAD into scratch index failed"); GROUPS_RESULT="failed (read-tree)"; return; }

  # Deletions are staged by `add -u` like any other tracked change; excluding
  # them here means the scratch index (and the commit built from it) keeps
  # HEAD's last-known-good content for that path — reported, never committed.
  local deleted=() f
  while IFS= read -r f; do [ -n "$f" ] && deleted+=("$f"); done < <(git -C "$G" ls-files --deleted)
  local excludes=("${GROUPS_SENSITIVE_EXCLUDES[@]}")
  for f in "${deleted[@]}"; do excludes+=(":(exclude)$f"); done

  GIT_INDEX_FILE="$TMPIDX" git -C "$G" add -u -- . "${excludes[@]}" 2>>"$ERR" || {
    FAILURES+=("groups: staging tracked changes into the scratch index failed"); GROUPS_RESULT="failed (add -u)"; return; }

  local sensitive
  sensitive=$(git -C "$G" diff --name-only HEAD -- "${GROUPS_SENSITIVE_PATHSPECS[@]}" 2>/dev/null)
  [ -n "$sensitive" ] && say "groups: left uncommitted on purpose (secret-shaped path): $(tr '\n' ' ' <<<"$sensitive")"
  if [ "${#deleted[@]}" -gt 0 ]; then
    local dlist; dlist=$(printf '%s, ' "${deleted[@]}")
    say "groups: deleted tracked file(s) NOT committed (kept at last known content; report only): ${dlist%, }"
    NOTICES+=("groups: ${#deleted[@]} tracked file(s) deleted on disk were reported, not committed: ${dlist%, }")
  fi

  local numstat binfiles
  numstat=$(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --numstat HEAD 2>>"$ERR")
  binfiles=$(awk -F'\t' '$1=="-" && $2=="-" {print $3}' <<<"$numstat")
  if [ -n "$binfiles" ]; then
    FAILURES+=("groups: refused — binary change(s) in: $(tr '\n' ' ' <<<"$binfiles")")
    GROUPS_RESULT="refused (binary change)"; return
  fi

  local diff_text
  diff_text=$(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --no-color --text HEAD 2>>"$ERR")
  if [ -z "$diff_text" ]; then
    GROUPS_RESULT="nothing pending"; return
  fi

  local hits
  hits=$(grep -E '^\+' <<<"$diff_text" | grep -vE '^\+\+\+ ' | grep -icE "$SECRET_RE" || true)
  if [ "${hits:-0}" -gt 0 ]; then
    printf '%s\n' "$diff_text" > "$OUT/groups-refused.patch" 2>/dev/null
    FAILURES+=("groups: $hits added line(s) look like a secret — refused to commit any pending change; scanned diff saved to $OUT/groups-refused.patch")
    GROUPS_RESULT="refused (secret-shaped content)"; return
  fi

  local n folders
  n=$(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --name-only HEAD | wc -l)
  folders=$(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --name-only HEAD | awk -F/ '{print $1}' | sort -u | tr '\n' ' ')

  if [ "$GROUPS_MODE" = "dry" ]; then
    GROUPS_RESULT="dry run: would commit $n tracked change(s) in: $folders"
    return
  fi

  local tree
  tree=$(GIT_INDEX_FILE="$TMPIDX" git -C "$G" write-tree 2>>"$ERR") || {
    FAILURES+=("groups: write-tree failed"); GROUPS_RESULT="failed (write-tree)"; return; }

  local commit_msg
  commit_msg="chore(groups): nightly snapshot of $n pending config change(s)

Folders: $folders

Committed by scripts/git-safety.sh onto refs/heads/$SNAPSHOT_BRANCH (never
main, never groups' own HEAD). Host sync scripts and operator sessions edit
these files in place and nothing else commits them."

  local attempt commit_hash snap_parent rc
  for attempt in 1 2; do
    git -C "$G" fetch --quiet origin "refs/heads/$SNAPSHOT_BRANCH:refs/remotes/origin/$SNAPSHOT_BRANCH" 2>>"$ERR" || true
    snap_parent=$(git -C "$G" rev-parse -q --verify "refs/remotes/origin/$SNAPSHOT_BRANCH" 2>/dev/null || true)
    # Parents: the previous snapshot-branch tip (so the push fast-forwards)
    # and groups' current HEAD (so the snapshot's relation to main stays
    # recorded in the commit graph).
    if [ -n "$snap_parent" ]; then
      commit_hash=$(printf '%s\n' "$commit_msg" | git -C "$G" commit-tree "$tree" -p "$snap_parent" -p "$groups_head" 2>>"$ERR")
    else
      commit_hash=$(printf '%s\n' "$commit_msg" | git -C "$G" commit-tree "$tree" -p "$groups_head" 2>>"$ERR")
    fi
    [ -n "$commit_hash" ] || { FAILURES+=("groups: commit-tree failed"); GROUPS_RESULT="failed (commit-tree)"; return; }

    git -C "$G" push --quiet origin "$commit_hash:refs/heads/$SNAPSHOT_BRANCH" 2>>"$ERR"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      say "groups: snapshot $commit_hash built from HEAD=$groups_head, pushed to $SNAPSHOT_BRANCH"
      GROUPS_RESULT="committed $n tracked change(s) in: $folders; pushed to $SNAPSHOT_BRANCH"
      return
    fi
    [ "$attempt" -eq 1 ] || break
  done
  # Never jams: nothing here holds a lock or a stuck ref, so tomorrow's run
  # starts clean and rebuilds the commit from whatever is pending then.
  FAILURES+=("groups: push to refs/heads/$SNAPSHOT_BRANCH failed after one retry — the change is not lost, it stays pending on disk and the next run rebuilds it")
  GROUPS_RESULT="commit built but push FAILED"
}
commit_groups() {
  local TMPIDX
  TMPIDX=$(mktemp) && rm -f "$TMPIDX"
  _commit_groups_impl "$TMPIDX"
  rm -f "$TMPIDX"
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
if [ ${#NOTICES[@]} -gt 0 ] && [ "$GROUPS_MODE" != "dry" ]; then
  NOTICE_BODY="$(printf -- '- %s\n' "${NOTICES[@]}")

Full snapshot: $OUT ($SIZE)."
  node_modules/.bin/tsx scripts/notify-owner.ts --title "Git safety net: review pending" --body "$NOTICE_BODY" ||
    echo "git-safety: notice DM failed (non-fatal)" >&2
fi
echo "git-safety: ok — snapshot $OUT ($SIZE); groups: $GROUPS_RESULT"
