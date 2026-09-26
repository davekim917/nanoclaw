#!/bin/bash
# One-way publisher: workgroup deliverables in data/workgroups/ -> Google Drive.
#
# The Drive set is the UNION of two sources:
#   1. every file git TRACKS in the workgroups repo. data/workgroups/.gitignore
#      is deny-by-default and curates the durable records (boards, ledgers,
#      runbooks); this script publishes all of them, unfiltered, as before.
#   2. an optional deliverables allowlist, read from an operator-controlled JSON
#      config (docs/workgroups-drive-publish.md): include roots, allowed
#      extensions, excluded directory names, and a per-file size cap. Absent
#      config = the tracked set only, exactly as before this existed.
#
# This script never writes to the tree and never deletes on Drive; a file that
# vanished locally is logged and dropped from state instead.
#
# Usage: publish-workgroups-drive.sh [--dry-run]
#   --dry-run prints, per workgroup, how many files and bytes the allowlist adds
#   (and how many of those have never been published), then exits. It needs no
#   Drive root, makes no gws call, takes no lock and writes no state.
#
# PATH TRAP: workgroup content is read from data/workgroups/. Never from
# groups/<folder>/<shared-dir>/ — those are container-absolute compat symlinks
# into /workspace/workgroup and do not resolve on the host.
set -uo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

# DRIVE_REPO exists so the publisher can be exercised end to end against a
# throwaway repo and a throwaway Drive root. Production never sets it.
REPO="${DRIVE_REPO:-/home/ubuntu/nanoclaw-v2/data/workgroups}"
STATE="${DRIVE_STATE_FILE:-/home/ubuntu/nanoclaw-v2/data/workgroups-drive-state.tsv}"

# Logs go to STDERR, never stdout. Helpers below return ids through stdout via
# command substitution; a log line on stdout would be captured as the id. The
# only stdout writer is the --dry-run report, printed at top level.
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
# Drive `q` string literals: backslash and apostrophe must be escaped.
qesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g"; }

cd "$REPO" || exit 1
# Canonical repo path, for the per-file containment check below.
REPO_REAL="$(pwd -P)"

# --- deliverables allowlist config ---------------------------------------
# DRIVE_PUBLISH_CONFIG names the file explicitly; if it is set, the file must
# exist (a typo in the unit is a loud failure, not a silent tracked-only run).
# Otherwise the repo-root .drive-publish.json is used when present. The repo
# root is host-only: containers mount data/workgroups/<id>, never the root, so
# no agent can widen the allowlist. A malformed config is fatal — never
# "publish something anyway".
CONFIG=""
if [[ -n "${DRIVE_PUBLISH_CONFIG:-}" ]]; then
  CONFIG="$DRIVE_PUBLISH_CONFIG"
  if [[ ! -f "$CONFIG" ]]; then log "FATAL DRIVE_PUBLISH_CONFIG=$CONFIG is not a file"; exit 1; fi
elif [[ -e "$REPO_REAL/.drive-publish.json" || -L "$REPO_REAL/.drive-publish.json" ]]; then
  CONFIG="$REPO_REAL/.drive-publish.json"
fi

INCLUDE_ROOTS=() EXTS=() EXCLUDES=()
MAX_BYTES=0
if [[ -n "$CONFIG" ]]; then
  verdict="$(jq -r '
    def strs: type == "array" and all(.[]; type == "string");
    if type != "object" then "top level must be a JSON object"
    elif ((keys - ["include_roots","extensions","exclude_dirs","max_file_mb"]) | length) > 0
      then "unknown key(s): \(keys - ["include_roots","extensions","exclude_dirs","max_file_mb"] | join(", "))"
    elif ((.include_roots | strs) and (.include_roots | length) > 0) | not
      then "include_roots must be a non-empty array of strings"
    elif ((.extensions | strs) and (.extensions | length) > 0) | not
      then "extensions must be a non-empty array of strings"
    elif (.exclude_dirs | strs) | not then "exclude_dirs must be an array of strings"
    elif (.max_file_mb | type) != "number" or .max_file_mb <= 0 or (.max_file_mb | floor) != .max_file_mb
      then "max_file_mb must be a positive integer"
    else "ok" end' "$CONFIG" 2>&1)"
  if [[ "$verdict" != ok ]]; then log "FATAL invalid config $CONFIG: $verdict"; exit 1; fi
  mapfile -t INCLUDE_ROOTS < <(jq -r '.include_roots[]' "$CONFIG")
  mapfile -t EXTS < <(jq -r '.extensions[] | ascii_downcase' "$CONFIG")
  mapfile -t EXCLUDES < <(jq -r '.exclude_dirs[]' "$CONFIG")
  MAX_BYTES="$(jq -r '.max_file_mb * 1048576 | floor' "$CONFIG")"
  for r in "${INCLUDE_ROOTS[@]}"; do
    # Relative, no empty/./.. or hidden component, no control characters: a
    # root can only name a directory inside some data/workgroups/<workgroup>.
    bad=""
    [[ "$r" == /* || "$r" == */ || "$r" == *$'\n'* || "$r" == *$'\t'* ]] && bad=1
    IFS=/ read -r -a comps <<< "$r"
    for c in "${comps[@]}"; do [[ -z "$c" || "$c" == .* ]] && bad=1; done
    if [[ -n "$bad" ]]; then log "FATAL invalid include root in $CONFIG: '$r'"; exit 1; fi
  done
  for e in "${EXTS[@]}"; do
    if [[ ! "$e" =~ ^[a-z0-9]+$ ]]; then log "FATAL invalid extension in $CONFIG: '$e'"; exit 1; fi
  done
  for x in "${EXCLUDES[@]}"; do
    if [[ -z "$x" || "$x" == */* ]]; then log "FATAL invalid exclude_dirs entry in $CONFIG: '$x'"; exit 1; fi
  done
fi

declare -A FOLDER OLD_SHA OLD_ID NEWDIR LIVE DONE IN_SET IS_ALLOW
DORDER=()
# --- load previous state (read-only here; rewritten only by a real run) ---
if [[ -f "$STATE" ]]; then
  while IFS=$'\t' read -r kind path a b; do
    case "$kind" in
      # The empty-check de-duplicates a state file written by an older, buggier
      # version of this script instead of carrying its rows forever.
      D) if [[ -z "${FOLDER[$path]:-}" ]]; then FOLDER["$path"]="$a"; DORDER+=("$path"); fi ;;
      F) OLD_SHA["$path"]="$a"; OLD_ID["$path"]="$b" ;;
    esac
  done < "$STATE"
fi

added=0 updated=0 skipped=0 failed=0 refused=0 folders_made=0
oversize=0 excluded=0

refuse() {
  log "ERROR REFUSED $1: not a regular file inside the tree (resolves to ${2:-nothing})"
  refused=$((refused+1))
}

mapfile -t TRACKED < <(git -C "$REPO" ls-files | grep '/')
if [[ ${#TRACKED[@]} -eq 0 ]]; then log "no tracked files; aborting"; exit 1; fi
for p in "${TRACKED[@]}"; do IN_SET["$p"]=1; done

# --- allowlist enumeration -------------------------------------------------
# One pruned `find` per include root: hidden and excluded directories are cut
# off before they are walked, so a root sitting on tens of GB of repo clones
# and scratch costs only the directories that can hold a deliverable. find's
# default -P never follows a symlink — not below the root, and not the root
# itself — so a symlinked directory is never descended. Symlinked FILES are
# printed only so they can be logged and skipped; they are never candidates.
#
# Secret-looking names are refused regardless of extension, on EVERY path
# component, and the config cannot loosen this.
is_secret_name() {
  local c="${1,,}"
  case "$c" in
    .env*|*.pem|*.key|*.p12|*.pfx|*credential*|*token*|*secret*|*password*|id_rsa*|id_dsa*|id_ecdsa*|id_ed25519*) return 0 ;;
  esac
  return 1
}

ALLOW=()
declare -A A_FILES A_BYTES A_NEW A_NEW_BYTES T_FILES WGS
for p in "${TRACKED[@]}"; do w="${p%%/*}"; WGS["$w"]=1; T_FILES["$w"]=$(( ${T_FILES[$w]:-0} + 1 )); done

enumerate_root() {
  local root="$1" wg real ftype fsize fpath bad c i
  wg="${root%%/*}"
  if [[ ! -e "$root" && ! -L "$root" ]]; then log "WARN include root $root does not exist; skipped"; return 0; fi
  real="$(realpath -e -- "$root" 2>/dev/null)"
  if [[ -L "$root" || ! -d "$root" || "$real" != "$REPO_REAL/$root" ]]; then
    log "ERROR REFUSED include root $root: not a directory inside the tree (resolves to ${real:-nothing})"
    refused=$((refused+1)); return 0
  fi
  local -a prune=( -name '.*' ) match=()
  for x in "${EXCLUDES[@]}"; do prune+=( -o -name "$x" ); done
  for i in "${!EXTS[@]}"; do
    [[ $i -gt 0 ]] && match+=( -o )
    match+=( -iname "*.${EXTS[$i]}" )
  done
  # Path LAST, so a tab inside a name cannot shift the type/size fields; the
  # sort keys on it so runs are deterministic.
  while IFS=$'\t' read -r -d '' ftype fsize fpath; do
    [[ -n "${IN_SET[$fpath]:-}" ]] && continue
    if [[ "$fpath" == *$'\n'* || "$fpath" == *$'\t'* ]]; then
      log "SKIP unsafe-name $(printf '%q' "$fpath")"; excluded=$((excluded+1)); continue
    fi
    bad=""
    IFS=/ read -r -a comps <<< "$fpath"
    for c in "${comps[@]}"; do
      if [[ "$c" == .* ]]; then bad=dotfile; break; fi
      if is_secret_name "$c"; then bad=secret-pattern; break; fi
    done
    if [[ -n "$bad" ]]; then log "SKIP $bad $fpath"; excluded=$((excluded+1)); continue; fi
    if [[ "$ftype" != f ]]; then log "SKIP symlink $fpath"; excluded=$((excluded+1)); continue; fi
    if [[ "$fsize" -gt "$MAX_BYTES" ]]; then
      log "SKIP oversize $fpath ($fsize bytes > $MAX_BYTES)"; oversize=$((oversize+1)); continue
    fi
    IN_SET["$fpath"]=1
    IS_ALLOW["$fpath"]=1
    ALLOW+=("$fpath")
    WGS["$wg"]=1
    A_FILES["$wg"]=$(( ${A_FILES[$wg]:-0} + 1 ))
    A_BYTES["$wg"]=$(( ${A_BYTES[$wg]:-0} + fsize ))
    if [[ -z "${OLD_ID[$fpath]:-}" ]]; then
      A_NEW["$wg"]=$(( ${A_NEW[$wg]:-0} + 1 ))
      A_NEW_BYTES["$wg"]=$(( ${A_NEW_BYTES[$wg]:-0} + fsize ))
    fi
  done < <(find "$root" -mindepth 1 \
             \( -type d \( "${prune[@]}" \) -prune \) \
             -o \( \( -type f -o -type l \) \( "${match[@]}" \) -printf '%y\t%s\t%p\0' \) | sort -z -t $'\t' -k3)
}

for r in "${INCLUDE_ROOTS[@]}"; do enumerate_root "$r"; done

if [[ $DRY_RUN -eq 1 ]]; then
  printf 'DRY RUN: no uploads, no state writes. config: %s\n' "${CONFIG:-none (tracked set only)}"
  printf 'workgroup\ttracked\tallowlist_files\tallowlist_bytes\tunpublished_files\tunpublished_bytes\n'
  tt=0 tf=0 tb=0 tn=0 tnb=0
  while IFS= read -r w; do
    [[ -z "$w" ]] && continue
    printf '%s\t%d\t%d\t%d\t%d\t%d\n' "$w" "${T_FILES[$w]:-0}" "${A_FILES[$w]:-0}" "${A_BYTES[$w]:-0}" \
      "${A_NEW[$w]:-0}" "${A_NEW_BYTES[$w]:-0}"
    tt=$((tt + ${T_FILES[$w]:-0})); tf=$((tf + ${A_FILES[$w]:-0})); tb=$((tb + ${A_BYTES[$w]:-0}))
    tn=$((tn + ${A_NEW[$w]:-0})); tnb=$((tnb + ${A_NEW_BYTES[$w]:-0}))
  done < <(printf '%s\n' "${!WGS[@]}" | sort)
  printf 'TOTAL\t%d\t%d\t%d\t%d\t%d\n' "$tt" "$tf" "$tb" "$tn" "$tnb"
  printf 'skipped: oversize=%d excluded=%d refused=%d\n' "$oversize" "$excluded" "$refused"
  [[ $refused -gt 0 ]] && exit 1
  exit 0
fi

# No default: trunk carries no install-specific folder name. Set it in the
# unit's Environment=. Unset is a loud failure, not a silent publish to a
# wrong or newly-created folder.
ROOT_NAME="${DRIVE_ROOT_NAME:?DRIVE_ROOT_NAME must be set (the Drive root folder name)}"
# Explicit named account on every call. The bare default credential slot
# (~/.config/gws/credentials.enc) is deliberately NOT used.
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE="${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:-/home/ubuntu/.config/gws/accounts/primary.json}"

# --- run lock ---------------------------------------------------------------
# A cold run over a large allowlist can take hours; a second run must never
# overlap it (two writers would race on the state file and on folder creation,
# and duplicate files on Drive). flock is released by the kernel when the
# process dies, so a crash never leaves a stale lock.
exec 9>>"$STATE.lock" || { log "FATAL cannot open lock $STATE.lock"; exit 1; }
if ! flock -n 9; then log "SKIP another publisher run holds $STATE.lock; not overlapping it"; exit 0; fi

# Host-private staging dir: every upload is a snapshot taken here, never a
# path inside the agent-writable tree. gws refuses `--upload` for any path
# outside the current directory, so uploads run from here with a RELATIVE
# name. Not optional — an absolute path fails with a 400 "outside the current
# directory".
STAGE="$(mktemp -d)" && mkdir "$STAGE/f" || exit 1

TMP="$STATE.tmp.$$"
ERRF="$STATE.err.$$"
: > "$TMP"
# Re-emit cached folders: a cached folder is never re-resolved below, so
# without this the next state file would carry zero D rows and the run after
# it would re-query every folder from Drive (state oscillation).
for d in "${DORDER[@]}"; do printf 'D\t%s\t%s\n' "$d" "${FOLDER[$d]}" >> "$TMP"; done

# persist: the rows written this run, plus every previous row for a live path
# this run has not reached (or failed on). An interrupted run — crash, SIGTERM
# from the unit's start timeout — therefore resumes exactly where it stopped:
# finished files hash-match and skip, unreached ones keep their Drive id. Bash
# runs the EXIT trap on an untrapped SIGTERM too. A SIGKILL skips the trap, so
# progress is also checkpointed every CHECKPOINT_EVERY uploads.
LIVE_READY=0
persist() {
  local new="$STATE.new.$$" p
  cp -f "$TMP" "$new" 2>/dev/null || return 1
  for p in "${!OLD_ID[@]}"; do
    [[ -n "${DONE[$p]:-}" ]] && continue
    [[ $LIVE_READY -eq 1 && -z "${LIVE[$p]:-}" ]] && continue
    printf 'F\t%s\t%s\t%s\n' "$p" "${OLD_SHA[$p]}" "${OLD_ID[$p]}" >> "$new"
  done
  mv -f "$new" "$STATE"
}
CHECKPOINT_EVERY="${DRIVE_CHECKPOINT_EVERY:-25}"
[[ "$CHECKPOINT_EVERY" =~ ^[1-9][0-9]*$ ]] || CHECKPOINT_EVERY=25
trap 'persist; rm -f "$TMP" "$ERRF"; rm -rf "$STAGE"' EXIT

# find_child <name> <parentId> <folders|files> -> prints id or empty
find_child() {
  local name esc q extra
  name="$1"; esc="$(qesc "$name")"
  if [[ "$3" == folders ]]; then extra="and mimeType = 'application/vnd.google-apps.folder'"
  else extra="and mimeType != 'application/vnd.google-apps.folder'"; fi
  q="name = '$esc' $extra and '$2' in parents and trashed = false"
  gws drive files list --params "$(jq -cn --arg q "$q" '{q:$q,fields:"files(id)",pageSize:1}')" \
    2>/dev/null | jq -r '.files[0].id // empty'
}

# resolve_dir <relpath|.> — sets FOLDER[$1]. Runs in the MAIN shell (never a
# command substitution) so the cache and the counters actually survive.
# "." is the Drive root folder. The caller must resolve ancestors first.
resolve_dir() {
  local rel="$1" parent name id
  [[ -n "${FOLDER[$rel]:-}" ]] && return 0
  if [[ "$rel" == "." ]]; then
    parent=root; name="$ROOT_NAME"
  else
    parent="${FOLDER[$(dirname "$rel")]:-}"; name="$(basename "$rel")"
  fi
  if [[ -z "$parent" ]]; then log "ERROR no parent id for $rel"; return 1; fi
  id="$(find_child "$name" "$parent" folders)"
  if [[ -z "$id" ]]; then
    id="$(gws drive files create --params '{"fields":"id"}' \
          --json "$(jq -cn --arg n "$name" --arg p "$parent" \
            '{name:$n,mimeType:"application/vnd.google-apps.folder",parents:[$p]}')" \
          2>/dev/null | jq -r '.id // empty')"
    if [[ -z "$id" ]]; then log "ERROR could not create folder $rel"; return 1; fi
    folders_made=$((folders_made+1)); log "MKDIR $rel -> $id"
    # Created by THIS run, so it holds nothing this run did not put there:
    # a file lookup inside it can be skipped (one API call saved per file on
    # a cold run).
    NEWDIR["$rel"]=1
  fi
  FOLDER["$rel"]="$id"
  printf 'D\t%s\t%s\n' "$rel" "$id" >> "$TMP"
}

SET=("${TRACKED[@]}" "${ALLOW[@]}")

# --- one-way deletion policy: log, never delete -------------------------
for p in "${SET[@]}"; do LIVE["$p"]=1; done
LIVE_READY=1
for p in "${!OLD_ID[@]}"; do
  if [[ -z "${LIVE[$p]:-}" ]]; then
    log "WOULD-REMOVE $p (Drive id ${OLD_ID[$p]}) — left in place by policy"
  fi
done

# Every directory that holds a published file, plus all its ancestors,
# shortest first so a parent is always resolved before its children. awk over
# the newline-delimited list — no xargs, so filenames with spaces are safe.
mapfile -t DIRS < <(printf '%s\n' "${SET[@]}" |
  awk -F/ '{p="";for(i=1;i<NF;i++){p=(i==1?$i:p"/"$i);print p}}' | sort -u)

resolve_dir . || { log "FATAL cannot create/find $ROOT_NAME"; exit 1; }
for d in "${DIRS[@]}"; do
  resolve_dir "$d" || { log "FATAL cannot resolve folder $d"; exit 1; }
done

since_checkpoint=0
for rel in "${SET[@]}"; do
  src="$rel"
  # A missing file is handled, not unreached: its old row must not be carried
  # forward (one-way policy — log it, drop it from state, leave Drive alone).
  if [[ ! -e "$src" && ! -L "$src" ]]; then log "SKIP missing $rel"; DONE["$rel"]=1; continue; fi
  # The tree is writable from agent containers, and any open by pathname
  # follows symlinks: a path (or any directory above it) swapped for a
  # symlink would publish whatever host file it points at, and a pathname
  # check goes stale the moment it returns. So open once, confirm the
  # descriptor is a regular file whose canonical path is exactly this
  # repo-relative path — which for an allowlisted file also pins it inside
  # its own data/workgroups/<workgroup> — and hash and upload a snapshot read
  # from that descriptor. The -L/-f pre-check keeps a FIFO or device from
  # ever being opened.
  if [[ -L "$src" || ! -f "$src" ]]; then refuse "$rel" "$(realpath -e -- "$src" 2>/dev/null)"; continue; fi
  if ! exec 3<"$src"; then log "SKIP missing $rel"; DONE["$rel"]=1; continue; fi
  opened="$(readlink -- /proc/self/fd/3)"
  if [[ ! -f /proc/self/fd/3 || "$opened" != "$REPO_REAL/$rel" ]]; then
    exec 3<&-; refuse "$rel" "$opened"; continue
  fi
  snap="f/$(basename "$rel")"
  # An allowlisted file can grow between enumeration and this open, so its
  # cap is enforced on the snapshot itself — copied one byte past the cap,
  # which also bounds what a runaway file can put in the staging dir.
  if [[ -n "${IS_ALLOW[$rel]:-}" ]]; then
    head -c "$((MAX_BYTES + 1))" <&3 > "$STAGE/$snap"; rc=$?
  else
    cat <&3 > "$STAGE/$snap"; rc=$?
  fi
  exec 3<&-
  if [[ $rc -ne 0 ]]; then log "ERROR snapshot $rel"; failed=$((failed+1)); rm -f "$STAGE/$snap"; continue; fi
  if [[ -n "${IS_ALLOW[$rel]:-}" && "$(stat -c %s "$STAGE/$snap")" -gt "$MAX_BYTES" ]]; then
    log "SKIP oversize $rel (grew past $MAX_BYTES bytes after enumeration)"
    oversize=$((oversize+1)); DONE["$rel"]=1; rm -f "$STAGE/$snap"; continue
  fi
  sha="$(sha256sum "$STAGE/$snap" | cut -d' ' -f1)"
  if [[ "${OLD_SHA[$rel]:-}" == "$sha" && -n "${OLD_ID[$rel]:-}" ]]; then
    printf 'F\t%s\t%s\t%s\n' "$rel" "$sha" "${OLD_ID[$rel]}" >> "$TMP"
    DONE["$rel"]=1
    rm -f "$STAGE/$snap"
    skipped=$((skipped+1)); continue
  fi
  pdir="$(dirname "$rel")"
  parent="${FOLDER[$pdir]}"
  name="$(basename "$rel")"
  # A state miss is not proof of absence — a lost state file must not duplicate
  # every file, so look the name up inside THIS parent id before creating,
  # unless this run created that folder itself.
  id="${OLD_ID[$rel]:-}"
  if [[ -z "$id" && -z "${NEWDIR[$pdir]:-}" ]]; then id="$(find_child "$name" "$parent" files)"; fi
  # stderr goes to its own file, never merged into the parsed stdout: under
  # systemd (no keyring session) gws prints "Using keyring backend: keyring" to
  # stderr on every call, and a 2>&1 capture makes every successful upload look
  # like unparseable JSON. That failed 10 real uploads silently.
  if [[ -n "$id" ]]; then
    out="$(cd "$STAGE" && gws drive files update --params "$(jq -cn --arg f "$id" '{fileId:$f,fields:"id"}')" \
           --upload "$snap" 2>"$ERRF")"
    rm -f "$STAGE/$snap"
    if [[ -z "$(printf '%s' "$out" | jq -r '.id // empty' 2>/dev/null)" ]]; then
      log "ERROR update $rel: $(head -c 200 "$ERRF") | $(printf '%s' "$out" | head -c 200)"
      failed=$((failed+1)); continue
    fi
    updated=$((updated+1)); log "UPDATE $rel -> $id"
  else
    out="$(cd "$STAGE" && gws drive files create --params '{"fields":"id"}' \
           --json "$(jq -cn --arg n "$name" --arg p "$parent" '{name:$n,parents:[$p]}')" \
           --upload "$snap" 2>"$ERRF")"
    rm -f "$STAGE/$snap"
    id="$(printf '%s' "$out" | jq -r '.id // empty' 2>/dev/null)"
    if [[ -z "$id" ]]; then
      log "ERROR create $rel: $(head -c 200 "$ERRF") | $(printf '%s' "$out" | head -c 200)"
      failed=$((failed+1)); continue
    fi
    added=$((added+1)); log "ADD $rel -> $id"
  fi
  printf 'F\t%s\t%s\t%s\n' "$rel" "$sha" "$id" >> "$TMP"
  DONE["$rel"]=1
  since_checkpoint=$((since_checkpoint+1))
  if [[ $since_checkpoint -ge $CHECKPOINT_EVERY ]]; then persist; since_checkpoint=0; fi
done

summary="done: added=$added updated=$updated skipped=$skipped failed=$failed refused=$refused folders_created=$folders_made tracked=${#TRACKED[@]}"
if [[ -n "$CONFIG" ]]; then summary+=" allowlisted=${#ALLOW[@]} oversize=$oversize excluded=$excluded"; fi
log "$summary"
if [[ $failed -gt 0 || $refused -gt 0 ]]; then exit 1; fi
exit 0
