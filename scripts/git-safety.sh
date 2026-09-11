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
#      staged even when tracked; they are reported instead. Any binary
#      change still refuses the WHOLE commit before anything is staged. A
#      SECRET_RE match in a file's added lines instead HOLDS ONLY THAT FILE
#      (#628 item 9: a single false positive used to refuse everything —
#      review-658 measured 32 of 430 groups commits, 7.4%, would be refused
#      whole under the old gate): the held path is reset back to HEAD's
#      content in the scratch index (never the working tree, so nothing on
#      disk is lost) and every other file's change still commits. A held
#      line's hash is recorded in $GIT_SAFETY_DIR/.git-safety-state/
#      secret-scan-held.tsv (mode 0600) so a nightly run alerts (exit
#      nonzero) only for a NEW hold, a hold whose offending line CHANGED, or
#      one that has sat unresolved and unalerted for 7+ days — an unchanged
#      pending hold exits 0 and prints one stderr line naming the held
#      paths. An operator releases a specific reviewed line via
#      scripts/secret-scan-allow.sh <path>, which prints ready-to-append,
#      MASKED lines for groups/.secret-scan-allow (a tracked TSV keyed on
#      sha256(path + line) — read only from that file's COMMITTED HEAD
#      version, never the working tree, so an uncommitted edit releases
#      nothing).
#
# Silent on success (a pending deletion still gets its own DM even on an
# otherwise clean run — see below). On FAILURE it exits 1 and does NOT DM
# the owner itself: the installed unit's OnFailure=nanoclaw-unit-alert@%n
# (groups/_ops/systemd/nanoclaw-git-safety.service — tracked in the SEPARATE
# davekim917/nanoclaw-groups repo, not this one's data/systemd/) already
# fires on any non-zero exit and DMs ONE journal line — the unit's last
# error-like line, else its plain last line, cut to 300 characters — plus
# a `journalctl` pointer, at most once per 30 minutes per unit
# (unit-alert-dm.sh:36-39, its cooldown). Before this both fired — the
# script's own DM plus OnFailure's — for every handled failure (#628 item
# 8); FAILURES are still printed to stderr (>> the unit's journal, which
# is what that one DM line is read from) so the escalation stays
# actionable. Runs before storage-gc so
# anything the GC takes is captured.
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
#   GIT_SAFETY_STATE_DIR          per-file secret-scan hold state directory
#                                 (default $GIT_SAFETY_DIR/.git-safety-state)
#
# Manual run:  bash scripts/git-safety.sh
# Restore:     see MANIFEST.txt in the snapshot directory. groups/ config
#              lives on refs/heads/$GIT_SAFETY_SNAPSHOT_BRANCH, e.g.:
#              git -C groups fetch origin host-snapshot && \
#                git -C groups show origin/host-snapshot:<path>

set -uo pipefail

# `git status` opportunistically rewrites `.git/index` even when nothing
# changes (the "refresh" optimization) — across every worktree of a shared
# checkout, that collides with a concurrent deploy, pull or reset. This
# variable stops that. It does NOT stop the equivalent rewrite from
# PORCELAIN `git diff` on a stat-dirty file (verified empirically: it
# rewrites the index with this variable set to either 0 or 1) — that's why
# every `diff` this script runs against a real repo's real index uses the
# `diff-index` plumbing command instead, which never does it.
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
STATE_DIR="${GIT_SAFETY_STATE_DIR:-$SNAP_ROOT/.git-safety-state}"
HELD_STATE_FILE="$STATE_DIR/secret-scan-held.tsv"
# #628 item 9: a hold that has sat unresolved (not allowlisted, not fixed)
# for at least this long re-alerts even with no change, so it can't be
# forgotten forever — but only if it also hasn't been ALERTED in that long,
# so a fresh hold doesn't immediately re-fire a second time at day 7 for no
# reason. 7 days MINUS 1 hour (review-683 P3-2): the nightly timer fires
# once a day at a fixed wall-clock time, so a full 7*24h threshold measured
# against the exact previous alert instant can miss its 7th-day run by
# whatever jitter that day's run started early or late by. The 1-hour
# margin absorbs ordinary timer jitter without meaningfully shortening the
# quiet period.
HOLD_REALERT_SECONDS=$(( (7 * 24 - 1) * 3600 ))
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$SNAP_ROOT/$TS"
MAN="$OUT/MANIFEST.txt"
ERR="$OUT/errors.log"
FAILURES=()
NOTICES=()
GROUPS_RESULT="skipped (no groups/ repo)"

# Scratch files/dirs (the phase-2 index, verify_bundle's scratch repo and
# extracted pack) are removed on every normal return path already; this trap
# is the backstop for a SIGTERM/SIGINT mid-run, which would otherwise leave
# them in $TMPDIR indefinitely.
CLEANUP_PATHS=()
cleanup_scratch() { local p; for p in ${CLEANUP_PATHS[@]+"${CLEANUP_PATHS[@]}"}; do [ -n "$p" ] && rm -rf "$p" 2>/dev/null; done; }
# review-683 P3-5: a bare `trap cleanup_scratch EXIT INT TERM` runs the
# handler on a caught INT/TERM but does NOT stop the script — bash resumes
# the very next line after a signal trap returns, unless the trap itself
# exits. Observed in practice: a TERM mid-phase-2 ran cleanup, then kept
# going and pushed an empty-tree snapshot commit built from whatever
# partial state the scratch index was left in. Each signal now gets its
# own trap that cleans up AND exits with the conventional 128+signal code;
# EXIT stays separate since it must fire on every ordinary return too, not
# just a caught signal (and would otherwise run cleanup_scratch a second,
# harmless time after an INT/TERM trap's own `exit` — rm -rf on already-
# removed paths is a no-op).
trap cleanup_scratch EXIT
trap 'cleanup_scratch; exit 130' INT
trap 'cleanup_scratch; exit 143' TERM

# Everything under $OUT (patches, tarballs, the manifest) holds config and,
# for untracked files, potentially secret-shaped content that slipped past
# .gitignore. New files/dirs default to owner-only from here on.
umask 077

mkdir -p "$OUT" || { echo "git-safety: cannot create $OUT" >&2; exit 1; }
say() { echo "$*" >> "$MAN"; }
slug() { # <path> -> unique, valid-ref-name-safe slug
  local raw="$1" base hash
  # `..` anywhere in a ref name is invalid (git-check-ref-format), and the
  # character-class substitution below leaves a literal ".." untouched
  # (both chars are in the allowed set) whenever the path has one — a
  # worktree under a path like /a/../b would otherwise produce an unusable
  # ref name and its commits would silently never get pinned.
  base=$(printf '%s' "$raw" | sed 's#^/##; s#[^A-Za-z0-9._-]#_#g; s#\.\.\+#_#g' | tail -c 100)
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
# Kept in sync with GROUPS_SENSITIVE_EXCLUDES/PATHSPECS below (phase 2) —
# an untracked secret-shaped file is exactly as sensitive as a tracked one,
# and #628 found this list narrower than that one (.netrc, id_rsa* and
# friends, prod.env-style names, secrets.yaml were still tarred here).
excluded_snapshot_name() { # <basename> -> 0 if it must never enter a tarball
  case "$1" in
    .env|.env.*|*.env|*.pem|*.p8|*.key|credentials*|credentials.*|\
    .netrc|id_rsa*|id_ed25519*|id_ecdsa*|profiles.yml|secrets.yaml|secrets.yml) return 0 ;;
    *) return 1 ;;
  esac
}
# ── #628 item 9: per-file hold / alert-once / line-hash allowlist ──────────
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
epoch_of() { # <ISO 8601 UTC timestamp> -> epoch seconds, or empty on a bad value
  date -u -d "$1" +%s 2>/dev/null
}
# line_hash <path> <line-text> — sha256(path + TAB + line), exactly the key
# groups/.secret-scan-allow and secret-scan-held.tsv both use. Including
# the path in the hashed input means the identical line text in a
# different file is never accidentally exempt.
line_hash() {
  printf '%s\t%s' "$1" "$2" | sha256sum | cut -d' ' -f1
}
# parse_allowlist_line <line> -> on a well-formed line (exactly 3 tab-
# separated fields, none empty, the hash field exactly 64 lowercase hex
# characters), sets PARSED_PATH/PARSED_HASH/PARSED_REASON and returns 0.
# On anything else, clears all three and returns 1. The ONE parsing
# routine both read_secret_scan_allowlist (validates the whole file) and
# is_allowlisted (matches one entry) use (review-683 P3-3: they used to
# parse differently — an `awk NF` field count in one, an `IFS=$'\t' read`
# split in the other — which could disagree on what counts as malformed).
parse_allowlist_line() {
  PARSED_PATH="" PARSED_HASH="" PARSED_REASON=""
  local line=$1 extra
  IFS=$'\t' read -r PARSED_PATH PARSED_HASH PARSED_REASON extra <<<"$line"
  if [ -z "$PARSED_PATH" ] || [ -z "$PARSED_HASH" ] || [ -z "$PARSED_REASON" ] || [ -n "$extra" ]; then
    PARSED_PATH="" PARSED_HASH="" PARSED_REASON=""
    return 1
  fi
  if ! [[ "$PARSED_HASH" =~ ^[0-9a-f]{64}$ ]]; then
    PARSED_PATH="" PARSED_HASH="" PARSED_REASON=""
    return 1
  fi
  return 0
}
# read_secret_scan_allowlist <groups-repo> -> the TSV content of
# groups/.secret-scan-allow at groups' own committed HEAD (never the
# working tree — an uncommitted edit must not release a hold), or empty on
# a missing file. Malformed content (any non-comment, non-blank line that
# parse_allowlist_line rejects) is ALSO reported as empty, printing one
# stderr line — a parse error fails closed (existing holds stay held)
# rather than silently exempting nothing, or worse, everything.
read_secret_scan_allowlist() {
  local g=$1 raw
  raw=$(git -C "$g" show HEAD:.secret-scan-allow 2>/dev/null) || return 0
  local line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in '#'*) continue ;; esac
    if ! parse_allowlist_line "$line"; then
      echo "git-safety: groups/.secret-scan-allow is malformed at HEAD (want path<TAB>sha256<TAB>reason, no field empty, sha256 = 64 lowercase hex chars) — treating as empty, holds stay (fail closed)" >&2
      return 0
    fi
  done <<<"$raw"
  printf '%s' "$raw"
}
# is_allowlisted <path> <hash> <allowlist-tsv-content>
is_allowlisted() {
  local path=$1 hash=$2 tsv=$3 line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in '#'*) continue ;; esac
    parse_allowlist_line "$line" || continue
    if [ "$PARSED_PATH" = "$path" ] && [ "$PARSED_HASH" = "$hash" ]; then
      return 0
    fi
  done <<<"$tsv"
  return 1
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
  local bundle=$1 src=$2 scratch objdir blank_off pack_off tmp_pack rc
  scratch=$(mktemp -d) || return 1
  CLEANUP_PATHS+=("$scratch")
  if ! git init --bare -q "$scratch" >/dev/null 2>&1; then rm -rf "$scratch"; return 1; fi
  objdir=$(git -C "$src" rev-parse --git-path objects 2>/dev/null) || { rm -rf "$scratch"; return 1; }
  case "$objdir" in /*) : ;; *) objdir="$src/$objdir" ;; esac
  # The bundle header (signature line, then one ref/prerequisite line per
  # ref) ends at the first blank line, and the raw pack — which happens to
  # start with the literal 4 bytes "PACK" — follows immediately after. A
  # prerequisite line embeds that commit's SUBJECT as a trailing comment
  # ("-<sha> <subject>"), so searching the whole file for the first literal
  # "PACK" is wrong whenever a boundary commit's subject contains that word
  # (reproduced: a subject "...PACK format details..." matched 95 bytes
  # before the real pack, corrupting the offset). Anchoring on the blank
  # line instead is unambiguous: ref names and commit subjects are single
  # lines and can't contain one.
  # No `-o`: GNU grep prints nothing for a zero-length match under `-o`
  # (verified empirically — rc=0 but empty stdout, on grep 3.11, even on a
  # trivial "a\n\nb\n" file), while `-b`/`-n` alone still report the
  # line:byte prefix for it. The match text is empty either way, so `-o`
  # was never needed.
  blank_off=$(grep -abn -m1 '^$' "$bundle" 2>/dev/null | head -1 | cut -d: -f2)
  if [ -z "$blank_off" ]; then rm -rf "$scratch"; return 1; fi
  pack_off=$((blank_off + 1))
  tmp_pack=$(mktemp)
  CLEANUP_PATHS+=("$tmp_pack")
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
    # `diff-index` (not porcelain `diff`): GIT_OPTIONAL_LOCKS=0 does NOT stop
    # `git diff HEAD` from rewriting .git/index when a tracked file is
    # stat-dirty (mtime changed, content identical) — verified empirically
    # while building this fix, on both settings of the variable. `diff-index`
    # never does that rewrite, with or without the variable.
    git -C "$w" diff-index --no-color -p --binary HEAD > "$dir/$s.patch" 2>"$pe"
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
# SECRET_RE and secret_scan_hits() live in lib/secret-scan.sh. Guarded: there
# is no `-e` in this script (many commands below are deliberately allowed to
# fail and get recorded in FAILURES/NOTICES instead of killing the run), so
# an unguarded `source` of a missing/unreadable file would just continue with
# secret_scan_hits undefined — the later `hits=$(secret_scan_hits "$diff")`
# call would itself fail silently (command not found), `hits` would end up
# empty, `${hits:-0}` reads that as 0, and the secret gate would pass every
# pending change through unchecked. Fail closed instead: refuse to build any
# groups/ snapshot at all rather than build one with a gate that never ran.
source "${SCRIPT_DIR}/lib/secret-scan.sh" || {
  echo "git-safety: cannot load ${SCRIPT_DIR}/lib/secret-scan.sh — refusing to build a groups/ snapshot without a working secret gate" >&2
  exit 1
}
# A missing file is one failure mode; a PRESENT but corrupt one (a
# zero-byte file, one truncated mid-function, one with an unbalanced
# regex, or one where SECRET_RE ends up unset) is another — `source`
# returns 0 for all of those too. secret_scan_selftest validates the
# functions exist and the patterns actually compile; #666 review found 4
# of 6 corrupt-file variants fail OPEN without this check (the eventual
# `${hits:-0}` silently reads a scan failure as "no secrets found").
if ! secret_scan_selftest; then
  echo "git-safety: ${SCRIPT_DIR}/lib/secret-scan.sh failed its self-test — refusing to build a groups/ snapshot without a validated secret gate" >&2
  exit 1
fi

# Sensitive filenames are never staged even when git already tracks them —
# excluded via pathspec BEFORE `add -u` runs, so they never touch the scratch
# index in the first place.
# Kept in sync with excluded_snapshot_name() above (phase 1) — see its
# comment. Additions here also need the plain (non-exclude) form mirrored
# into GROUPS_SENSITIVE_PATHSPECS just below, for the "report what was left
# uncommitted" query.
GROUPS_SENSITIVE_EXCLUDES=(
  ':(exclude,glob)**/.env'
  ':(exclude,glob)**/.env.*'
  ':(exclude,glob)**/*.env'
  ':(exclude,glob)**/*.pem'
  ':(exclude,glob)**/*.p8'
  ':(exclude,glob)**/*.key'
  ':(exclude,glob)**/credentials*'
  ':(exclude,glob)**/profiles.yml'
  ':(exclude,glob)**/.netrc'
  ':(exclude,glob)**/id_rsa*'
  ':(exclude,glob)**/id_ed25519*'
  ':(exclude,glob)**/id_ecdsa*'
  ':(exclude,glob)**/secrets.yaml'
  ':(exclude,glob)**/secrets.yml'
)
GROUPS_SENSITIVE_PATHSPECS=(':(glob)**/.env' ':(glob)**/.env.*' ':(glob)**/*.env' ':(glob)**/*.pem' ':(glob)**/*.p8' ':(glob)**/*.key' ':(glob)**/credentials*' ':(glob)**/profiles.yml' ':(glob)**/.netrc' ':(glob)**/id_rsa*' ':(glob)**/id_ed25519*' ':(glob)**/id_ecdsa*' ':(glob)**/secrets.yaml' ':(glob)**/secrets.yml')

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
  # Read against the SCRATCH index (== HEAD, just loaded above), not the
  # real one: another session may have `git add`ed or `git rm --cached`ed
  # something in groups' real index without committing, which would make
  # `ls-files --deleted` (real index) disagree with what `add -u` is about
  # to stage into the scratch index moments later — silently letting a
  # `git rm`/`git mv` deletion reach host-snapshot unreported.
  local deleted=() f
  while IFS= read -r f; do [ -n "$f" ] && deleted+=("$f"); done < <(GIT_INDEX_FILE="$TMPIDX" git -C "$G" ls-files --deleted)
  local excludes=("${GROUPS_SENSITIVE_EXCLUDES[@]}")
  for f in "${deleted[@]}"; do excludes+=(":(exclude)$f"); done

  GIT_INDEX_FILE="$TMPIDX" git -C "$G" add -u -- . "${excludes[@]}" 2>>"$ERR" || {
    FAILURES+=("groups: staging tracked changes into the scratch index failed"); GROUPS_RESULT="failed (add -u)"; return; }

  # diff-index, not diff: see the comment on the phase-1 patch call above —
  # this reads groups' REAL index/working tree and must not rewrite it.
  local sensitive
  sensitive=$(git -C "$G" diff-index --name-only HEAD -- "${GROUPS_SENSITIVE_PATHSPECS[@]}" 2>/dev/null)
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

  # ── #628 item 9: per-file secret-shaped-content hold ──────────────────────
  # A SECRET_RE match in a file's own added lines holds ONLY that file
  # (reset back to HEAD's content in the scratch index) instead of refusing
  # the whole commit — every other changed file still commits. Scanned per
  # file (not as one combined diff) because a hold is a per-FILE decision:
  # committing everything else requires knowing exactly which files to
  # leave staged and which to reset.
  local allow_tsv
  allow_tsv=$(read_secret_scan_allowlist "$G")

  # review-683 P1-1: `diff --cached --name-only HEAD` (no `-z`) quotes any
  # path with a special byte per core.quotePath (default true) — e.g.
  # café.md prints as "caf\303\251.md", a literal backslash-escaped STRING,
  # not the real path. Splitting that output on newlines and using it
  # DIRECTLY as a pathspec (both for the per-file diff below and the reset
  # that implements containment) matched NOTHING: the file was never
  # scanned, never held, yet `add -u` had already staged it — a real
  # regression this rewrite must not reintroduce. `-z` emits raw,
  # unquoted, NUL-terminated paths; `read -r -d ''` splits on NUL only, so
  # even a path containing a literal newline or tab survives intact.
  local changed_paths=() path
  while IFS= read -r -d '' path; do
    [ -n "$path" ] && changed_paths+=("$path")
  done < <(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --name-only -z HEAD 2>>"$ERR")
  # No early return here even when $changed_paths is empty (review-683
  # P2-1): the loop below is simply a no-op in that case, but the state
  # rewrite after it must still run — an early return here would skip it,
  # and a stale hold from a PREVIOUS run (recorded, then its offending
  # edit reverted with nothing else pending that night) would sit in
  # secret-scan-held.tsv forever. If that exact line is re-added later,
  # the stale entry makes it look already-known and the run would exit 0
  # instead of alerting on what is, from the state file's perspective, a
  # brand-new hold.

  local held_paths=() held_diffs="" new_state_rows=() poisoned_paths=()
  for path in "${changed_paths[@]}"; do
    # A path containing a TAB, LF or CR cannot be stored as one field of
    # the held-state or allowlist TSVs without corrupting either — rather
    # than encode or escape it (a new parsing surface of its own), such a
    # path is ALWAYS held and ALWAYS alerts, on every run, regardless of
    # its actual content: it never gets a state row (so no first-seen/
    # last-alerted bookkeeping applies to it) and the line-hash allowlist
    # can never release it. The operator's only path forward is to rename
    # the file. Ordinary non-ASCII names (café.md) are unaffected — UTF-8
    # bytes are fine in a TSV field; only these three specific control
    # bytes are refused.
    case "$path" in
      *$'\t'*|*$'\n'*|*$'\r'*)
        poisoned_paths+=("$path")
        held_paths+=("$path")
        if ! GIT_INDEX_FILE="$TMPIDX" git -C "$G" reset -q HEAD -- ":(literal)$path" 2>>"$ERR"; then
          FAILURES+=("groups: could not reset a TAB/LF/CR-named held path back to HEAD in the scratch index — refused to commit any pending change")
          GROUPS_RESULT="failed (hold reset)"; return
        fi
        continue
        ;;
    esac

    local file_diff added extract_rc matches scan_rc
    # Same options as the old combined diff (comment preserved below this
    # loop, at the write-tree call, for why each one is pinned) — just
    # scoped to one path via a pathspec. `:(literal)` (review-683 P1-1)
    # turns off ALL pathspec magic — glob wildcards, a leading `:`, a
    # leading `-` that `git diff` would otherwise try to parse as another
    # option — so the path matches byte-for-byte and nothing else, exactly
    # like the fixed name-listing above requires. Piped through
    # `LC_ALL=C tr '\000' ' '` (review-683 P3-4) for the same reason #666
    # applied it to wiki-pre-push-hook.sh: `$(...)` command substitution
    # silently drops NUL bytes, which can fuse a token with a neighboring
    # byte and defeat SECRET_RE's boundary anchors; `pipefail` (set at the
    # top of this file) keeps the `2>>"$ERR"` redirect on git's own
    # process, and preserves git's own exit status through the pipe.
    file_diff=$(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --no-color --text --src-prefix=a/ --dst-prefix=b/ \
      --output-indicator-new="$SECRET_SCAN_NEW_INDICATOR" --output-indicator-old=- --output-indicator-context=' ' \
      HEAD -- ":(literal)$path" 2>>"$ERR" | LC_ALL=C tr '\000' ' ')
    added=$(secret_scan_extract_added "$file_diff")
    extract_rc=$?
    if [ "$extract_rc" -ge 2 ]; then
      FAILURES+=("groups: secret scan extraction itself failed on $path — refused to commit any pending change"); GROUPS_RESULT="failed (secret scan)"; return
    fi
    matches=$(secret_scan_matching_lines "$added" "$SECRET_RE" insensitive)
    scan_rc=$?
    if [ "$scan_rc" -ne 0 ]; then
      # Same fail-closed contract as the old single-tier gate: a genuine
      # scan failure (grep exit >=2 — not a match, an actual tool failure)
      # refuses the WHOLE commit, never just holds one file. A false
      # positive (the scan RAN and found something) is the only case that
      # gets the new per-file treatment below.
      FAILURES+=("groups: secret scan itself failed on $path — refused to commit any pending change"); GROUPS_RESULT="failed (secret scan)"; return
    fi
    [ -z "$matches" ] && continue

    local offending=0 line hash
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      hash=$(line_hash "$path" "$line")
      is_allowlisted "$path" "$hash" "$allow_tsv" && continue
      offending=1
      new_state_rows+=("$path"$'\t'"$hash")
    done <<<"$matches"

    if [ "$offending" -eq 1 ]; then
      held_paths+=("$path")
      held_diffs+="$file_diff"$'\n'
      # Reset ONLY this path back to HEAD in the SCRATCH index — never the
      # working tree (git reset's default; no --hard, no path in the
      # working-tree arguments). Nothing on disk is touched or lost.
      # review-683 P1-1: the exit status used to go unchecked — a failed
      # reset would silently leave the offending edit staged, so a
      # "held" file could still reach the commit. Fail the whole groups
      # snapshot instead of ever risking that.
      if ! GIT_INDEX_FILE="$TMPIDX" git -C "$G" reset -q HEAD -- ":(literal)$path" 2>>"$ERR"; then
        FAILURES+=("groups: could not reset a held path back to HEAD in the scratch index: $path — refused to commit any pending change")
        GROUPS_RESULT="failed (hold reset)"; return
      fi
    fi
  done

  if [ "${#poisoned_paths[@]}" -gt 0 ]; then
    local poisoned_list; poisoned_list=$(printf '%s, ' "${poisoned_paths[@]}"); poisoned_list=${poisoned_list%, }
    say "groups: ${#poisoned_paths[@]} path(s) with a TAB/LF/CR byte held EVERY run and cannot be allowlisted — rename to resolve: $poisoned_list"
    if [ "$GROUPS_MODE" != "dry" ]; then
      FAILURES+=("groups: ${#poisoned_paths[@]} path(s) with a TAB/LF/CR byte in the name held every run (never allowlistable) — rename: $poisoned_list")
    fi
  fi

  if [ "${#held_paths[@]}" -gt 0 ]; then
    printf '%s' "$held_diffs" > "$OUT/groups-held.patch" 2>/dev/null
    local held_list; held_list=$(printf '%s, ' "${held_paths[@]}"); held_list=${held_list%, }
    say "groups: ${#held_paths[@]} file(s) held for secret-shaped content: $held_list — diff saved to $OUT/groups-held.patch; release a reviewed line via scripts/secret-scan-allow.sh <path>"
    # Always one stderr line naming the held paths, whether or not this run
    # alerts for them — an unchanged, still-pending hold must still be
    # visible in the journal even when it doesn't escalate.
    echo "git-safety: ${#held_paths[@]} file(s) held for secret-shaped content: $held_list" >&2
  fi

  # State is rewritten every run (not just when something is currently
  # held): $new_state_rows is exactly this run's live offending set, so an
  # entry from a PREVIOUS run that isn't in it anymore — its line changed,
  # was removed, or the allowlist released it — is simply not written back
  # here, which IS how it drops out of the state (#628 item 9 §2). Skipped
  # entirely in dry mode, which must not mutate anything persistent.
  if [ "$GROUPS_MODE" != "dry" ]; then
    local now_iso now_epoch
    now_iso=$(iso_now)
    now_epoch=$(epoch_of "$now_iso")
    declare -A OLD_FIRST_SEEN=() OLD_LAST_ALERTED=()
    if [ -s "$HELD_STATE_FILE" ]; then
      local sp sh sfirst slast
      while IFS=$'\t' read -r sp sh sfirst slast; do
        [ -n "$sp" ] || continue
        OLD_FIRST_SEEN["$sp"$'\t'"$sh"]="$sfirst"
        OLD_LAST_ALERTED["$sp"$'\t'"$sh"]="$slast"
      done < "$HELD_STATE_FILE"
    fi

    local alert_worthy=0 new_state_lines=() key
    if [ "${#new_state_rows[@]}" -gt 0 ]; then
      while IFS= read -r key; do
        [ -n "$key" ] || continue
        local row_path row_hash first_seen last_alerted
        row_path=${key%%$'\t'*}
        row_hash=${key#*$'\t'}
        first_seen="${OLD_FIRST_SEEN[$key]:-}"
        last_alerted="${OLD_LAST_ALERTED[$key]:-}"
        if [ -z "$first_seen" ]; then
          # A brand-new (path, line-hash) pair: either a genuinely new
          # hold, or the same file's offending line CHANGED (a changed
          # line hashes differently, so it looks new here too) — both
          # cases alert, per spec.
          first_seen="$now_iso"; last_alerted="$now_iso"; alert_worthy=1
        else
          # review-683 P3-1: an unparseable timestamp (a state file hand-
          # edited or corrupted) defaults to epoch 0 — ancient, not "now"
          # — so the 7-day-unresolved check below reads it as overdue and
          # re-alerts, rather than silently treating garbage as freshly
          # seen and going quiet on a hold nobody can actually account for.
          local first_epoch last_epoch
          first_epoch=$(epoch_of "$first_seen"); first_epoch=${first_epoch:-0}
          last_epoch=$(epoch_of "${last_alerted:-$first_seen}"); last_epoch=${last_epoch:-0}
          if [ $((now_epoch - first_epoch)) -ge "$HOLD_REALERT_SECONDS" ] && [ $((now_epoch - last_epoch)) -ge "$HOLD_REALERT_SECONDS" ]; then
            last_alerted="$now_iso"; alert_worthy=1
          fi
        fi
        new_state_lines+=("$row_path"$'\t'"$row_hash"$'\t'"$first_seen"$'\t'"$last_alerted")
      done < <(printf '%s\n' "${new_state_rows[@]}" | sort -u)
    fi

    mkdir -p "$STATE_DIR"
    local state_tmp; state_tmp=$(mktemp "$STATE_DIR/.secret-scan-held.XXXXXX")
    CLEANUP_PATHS+=("$state_tmp")
    if [ "${#new_state_lines[@]}" -gt 0 ]; then
      printf '%s\n' "${new_state_lines[@]}" > "$state_tmp"
    else
      : > "$state_tmp"
    fi
    chmod 600 "$state_tmp"
    mv -f "$state_tmp" "$HELD_STATE_FILE"

    if [ "$alert_worthy" -eq 1 ]; then
      FAILURES+=("groups: a secret-shaped hold is new, changed, or unresolved 7+ days — see $OUT/groups-held.patch, or release a reviewed line via scripts/secret-scan-allow.sh <path>")
    fi
  fi

  local n folders
  n=$(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --name-only HEAD | wc -l)
  folders=$(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --name-only HEAD | awk -F/ '{print $1}' | sort -u | tr '\n' ' ')

  if [ "$n" -eq 0 ]; then
    # Either every changed path was held (nothing else pending — never
    # write a no-op commit identical to HEAD just because a hold consumed
    # everything that was staged) or there was genuinely nothing pending
    # at all (review-683 P2-1: this branch is what the removed early
    # return above used to short-circuit to, skipping the state rewrite
    # above it — that rewrite now always runs first, so this return is
    # safe either way).
    if [ "${#held_paths[@]}" -gt 0 ]; then
      GROUPS_RESULT="nothing committed — all ${#held_paths[@]} pending change(s) held for secret-shaped content"
    else
      GROUPS_RESULT="nothing pending"
    fi
    return
  fi

  if [ "$GROUPS_MODE" = "dry" ]; then
    if [ "${#held_paths[@]}" -gt 0 ]; then
      GROUPS_RESULT="dry run: would hold ${#held_paths[@]} file(s) for secret-shaped content; would commit $n other tracked change(s) in: $folders"
    else
      GROUPS_RESULT="dry run: would commit $n tracked change(s) in: $folders"
    fi
    return
  fi

  local tree
  tree=$(GIT_INDEX_FILE="$TMPIDX" git -C "$G" write-tree 2>>"$ERR") || {
    FAILURES+=("groups: write-tree failed"); GROUPS_RESULT="failed (write-tree)"; return; }

  # The leading "+" forces the tracking ref to update even on a
  # non-fast-forward change upstream (a force-reset of host-snapshot, which
  # is otherwise never expected but not impossible). Without it a stale
  # refs/remotes/origin/$SNAPSHOT_BRANCH silently wins every night after
  # such a reset: this fetch reports success (nothing to reject), the
  # tracking ref just never advances, so the next commit-tree keeps using
  # the old, now-diverged parent and every subsequent push fails.
  git -C "$G" fetch --quiet origin "+refs/heads/$SNAPSHOT_BRANCH:refs/remotes/origin/$SNAPSHOT_BRANCH" 2>>"$ERR" || true
  local snap_parent prev_tree
  snap_parent=$(git -C "$G" rev-parse -q --verify "refs/remotes/origin/$SNAPSHOT_BRANCH" 2>/dev/null || true)
  if [ -n "$snap_parent" ]; then
    prev_tree=$(git -C "$G" rev-parse -q --verify "$snap_parent^{tree}" 2>/dev/null || true)
    if [ -n "$prev_tree" ] && [ "$prev_tree" = "$tree" ]; then
      # Same persistent uncommitted drift as the last snapshot (nobody has
      # committed it to main): pushing an identical tree again would just
      # grow host-snapshot with no-op commits forever.
      GROUPS_RESULT="unchanged since last snapshot ($snap_parent already has this tree)"
      return
    fi
  fi

  local commit_msg
  commit_msg="chore(groups): nightly snapshot of $n pending config change(s)

Folders: $folders

Committed by scripts/git-safety.sh onto refs/heads/$SNAPSHOT_BRANCH (never
main, never groups' own HEAD). Host sync scripts and operator sessions edit
these files in place and nothing else commits them."

  local attempt commit_hash rc
  for attempt in 1 2; do
    if [ "$attempt" -gt 1 ]; then
      # Retrying after a rejected push: re-fetch so the new parent reflects
      # whoever won the race, then rebuild the commit on top of them.
      git -C "$G" fetch --quiet origin "+refs/heads/$SNAPSHOT_BRANCH:refs/remotes/origin/$SNAPSHOT_BRANCH" 2>>"$ERR" || true
      snap_parent=$(git -C "$G" rev-parse -q --verify "refs/remotes/origin/$SNAPSHOT_BRANCH" 2>/dev/null || true)
    fi
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
      if [ "${#held_paths[@]}" -gt 0 ]; then
        GROUPS_RESULT="committed $n tracked change(s) in: $folders; pushed to $SNAPSHOT_BRANCH; ${#held_paths[@]} file(s) held for secret-shaped content"
      else
        GROUPS_RESULT="committed $n tracked change(s) in: $folders; pushed to $SNAPSHOT_BRANCH"
      fi
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
  CLEANUP_PATHS+=("$TMPIDX")
  _commit_groups_impl "$TMPIDX"
  rm -f "$TMPIDX"
}
[ -d "$GROUPS_DIR/.git" ] && commit_groups
say "groups: $GROUPS_RESULT"

# ── retention ───────────────────────────────────────────────────────────────
find "$SNAP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime +"$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null

SIZE=$(du -sh "$OUT" 2>/dev/null | cut -f1)
if [ ${#FAILURES[@]} -gt 0 ]; then
  # Own-DM removed deliberately (#628 item 8): the unit's OnFailure=
  # already DMs the owner on this exit code, so a second DM here would just
  # double-alert every handled failure. Printing to stderr is what makes
  # that OnFailure DM actionable — unit-alert-dm.sh reads the journal tail.
  #
  # Order matters: unit-alert-dm.sh's keyword grep misses most FAILURES
  # wording ("failed" alone isn't one of its keywords), so it falls back to
  # the LAST line of the unit's last 30 minutes of output. The context line
  # goes first and the failure list last, so that fallback lands on an
  # actual reason instead of "whatever did succeed."
  echo "Whatever did succeed is in $OUT ($SIZE)." >&2
  printf -- '- %s\n' "${FAILURES[@]}" >&2
  exit 1
fi
if [ ${#NOTICES[@]} -gt 0 ] && [ "$GROUPS_MODE" != "dry" ]; then
  NOTICE_BODY="$(printf -- '- %s\n' "${NOTICES[@]}")

Full snapshot: $OUT ($SIZE)."
  node_modules/.bin/tsx scripts/notify-owner.ts --title "Git safety net: review pending" --body "$NOTICE_BODY" ||
    echo "git-safety: notice DM failed (non-fatal)" >&2
fi
echo "git-safety: ok — snapshot $OUT ($SIZE); groups: $GROUPS_RESULT"
