#!/bin/bash
# One-way publisher: git-TRACKED files in data/workgroups/ -> Google Drive.
#
# The tracked set IS the definition of "deliverable" — data/workgroups/.gitignore
# is deny-by-default and the curation decision lives there, not here. This script
# never invents its own filter, never writes to the tree, and never deletes on
# Drive; a file that vanished locally is logged and dropped from state instead.
#
# PATH TRAP: workgroup content is read from data/workgroups/. Never from
# groups/<folder>/<shared-dir>/ — those are container-absolute compat symlinks
# into /workspace/workgroup and do not resolve on the host.
set -uo pipefail

# No default: trunk carries no install-specific folder name. Set it in the
# unit's Environment=. Unset is a loud failure, not a silent publish to a
# wrong or newly-created folder.
ROOT_NAME="${DRIVE_ROOT_NAME:?DRIVE_ROOT_NAME must be set (the Drive root folder name)}"
# DRIVE_REPO exists so the publisher can be exercised end to end against a
# throwaway repo and a throwaway Drive root. Production never sets it.
REPO="${DRIVE_REPO:-/home/ubuntu/nanoclaw-v2/data/workgroups}"
STATE="${DRIVE_STATE_FILE:-/home/ubuntu/nanoclaw-v2/data/workgroups-drive-state.tsv}"
# Explicit named account on every call. The bare default slot
# (~/.config/gws/credentials.enc) is deliberately NOT used.
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE="${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:-/home/ubuntu/.config/gws/accounts/primary.json}"

cd "$REPO" || exit 1
# Canonical repo path, for the per-file containment check below.
REPO_REAL="$(pwd -P)"
# Host-private staging dir: every upload is a snapshot taken here, never a
# path inside the agent-writable tree. gws refuses `--upload` for any path
# outside the current directory, so uploads run from here with a RELATIVE
# name. Not optional — an absolute path fails with a 400 "outside the current
# directory".
STAGE="$(mktemp -d)" && mkdir "$STAGE/f" || exit 1

TMP="$STATE.tmp.$$"
ERRF="$STATE.err.$$"
: > "$TMP"
# Persist progress even on a crash: a partial state is still correct, just
# smaller — a missing row falls back to the name-in-parent lookup below.
trap 'mv -f "$TMP" "$STATE" 2>/dev/null; rm -f "$ERRF"; rm -rf "$STAGE"' EXIT

# Logs go to STDERR, never stdout. Helpers below return ids through stdout via
# command substitution; a log line on stdout would be captured as the id.
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
# Drive `q` string literals: backslash and apostrophe must be escaped.
qesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g"; }

declare -A FOLDER OLD_SHA OLD_ID
# --- load previous state -------------------------------------------------
if [[ -f "$STATE" ]]; then
  while IFS=$'\t' read -r kind path a b; do
    case "$kind" in
      # Re-emit immediately: a cached folder is never re-resolved below, so
      # without this the next state file would carry zero D rows and the run
      # after it would re-query every folder from Drive (state oscillation).
      # The empty-check also de-duplicates a state file written by an older,
      # buggier version of this script instead of carrying its rows forever.
      D) if [[ -z "${FOLDER[$path]:-}" ]]; then
           FOLDER["$path"]="$a"
           printf 'D\t%s\t%s\n' "$path" "$a" >> "$TMP"
         fi ;;
      F) OLD_SHA["$path"]="$a"; OLD_ID["$path"]="$b" ;;
    esac
  done < "$STATE"
fi

added=0 updated=0 skipped=0 failed=0 refused=0 folders_made=0

refuse() {
  log "ERROR REFUSED $1: not a regular file inside the tree (resolves to ${2:-nothing})"
  refused=$((refused+1))
}

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
  fi
  FOLDER["$rel"]="$id"
  printf 'D\t%s\t%s\n' "$rel" "$id" >> "$TMP"
}

mapfile -t TRACKED < <(git -C "$REPO" ls-files | grep '/')
if [[ ${#TRACKED[@]} -eq 0 ]]; then log "no tracked files; aborting"; exit 1; fi

# --- one-way deletion policy: log, never delete -------------------------
declare -A LIVE
for p in "${TRACKED[@]}"; do LIVE["$p"]=1; done
for p in "${!OLD_ID[@]}"; do
  if [[ -z "${LIVE[$p]:-}" ]]; then
    log "WOULD-REMOVE $p (Drive id ${OLD_ID[$p]}) — left in place by policy"
  fi
done

# Every directory that holds a tracked file, plus all its ancestors, shortest
# first so a parent is always resolved before its children. awk over the
# newline-delimited list — no xargs, so filenames with spaces are safe.
mapfile -t DIRS < <(printf '%s\n' "${TRACKED[@]}" |
  awk -F/ '{p="";for(i=1;i<NF;i++){p=(i==1?$i:p"/"$i);print p}}' | sort -u)

resolve_dir . || { log "FATAL cannot create/find $ROOT_NAME"; exit 1; }
for d in "${DIRS[@]}"; do
  resolve_dir "$d" || { log "FATAL cannot resolve folder $d"; exit 1; }
done

for rel in "${TRACKED[@]}"; do
  src="$rel"
  if [[ ! -e "$src" && ! -L "$src" ]]; then log "SKIP missing $rel"; continue; fi
  # The tree is writable from agent containers, and any open by pathname
  # follows symlinks: a tracked path (or any directory above it) swapped for a
  # symlink would publish whatever host file it points at, and a pathname
  # check goes stale the moment it returns. So open once, confirm the
  # descriptor is a regular file whose canonical path is exactly this tracked
  # path, and hash and upload a snapshot read from that descriptor.
  # The -L/-f pre-check keeps a FIFO or device from ever being opened.
  if [[ -L "$src" || ! -f "$src" ]]; then refuse "$rel" "$(realpath -e -- "$src" 2>/dev/null)"; continue; fi
  if ! exec 3<"$src"; then log "SKIP missing $rel"; continue; fi
  opened="$(readlink -- /proc/self/fd/3)"
  if [[ ! -f /proc/self/fd/3 || "$opened" != "$REPO_REAL/$rel" ]]; then
    exec 3<&-; refuse "$rel" "$opened"; continue
  fi
  snap="f/$(basename "$rel")"
  cat <&3 > "$STAGE/$snap"; rc=$?; exec 3<&-
  if [[ $rc -ne 0 ]]; then log "ERROR snapshot $rel"; failed=$((failed+1)); continue; fi
  sha="$(sha256sum "$STAGE/$snap" | cut -d' ' -f1)"
  if [[ "${OLD_SHA[$rel]:-}" == "$sha" && -n "${OLD_ID[$rel]:-}" ]]; then
    printf 'F\t%s\t%s\t%s\n' "$rel" "$sha" "${OLD_ID[$rel]}" >> "$TMP"
    skipped=$((skipped+1)); continue
  fi
  parent="${FOLDER[$(dirname "$rel")]}"
  name="$(basename "$rel")"
  # A state miss is not proof of absence — a lost state file must not duplicate
  # every file, so look the name up inside THIS parent id before creating.
  id="${OLD_ID[$rel]:-}"
  if [[ -z "$id" ]]; then id="$(find_child "$name" "$parent" files)"; fi
  # stderr goes to its own file, never merged into the parsed stdout: under
  # systemd (no keyring session) gws prints "Using keyring backend: keyring" to
  # stderr on every call, and a 2>&1 capture makes every successful upload look
  # like unparseable JSON. That failed 10 real uploads silently.
  if [[ -n "$id" ]]; then
    out="$(cd "$STAGE" && gws drive files update --params "$(jq -cn --arg f "$id" '{fileId:$f,fields:"id"}')" \
           --upload "$snap" 2>"$ERRF")"
    if [[ -z "$(printf '%s' "$out" | jq -r '.id // empty' 2>/dev/null)" ]]; then
      log "ERROR update $rel: $(head -c 200 "$ERRF") | $(printf '%s' "$out" | head -c 200)"
      failed=$((failed+1)); continue
    fi
    updated=$((updated+1)); log "UPDATE $rel -> $id"
  else
    out="$(cd "$STAGE" && gws drive files create --params '{"fields":"id"}' \
           --json "$(jq -cn --arg n "$name" --arg p "$parent" '{name:$n,parents:[$p]}')" \
           --upload "$snap" 2>"$ERRF")"
    id="$(printf '%s' "$out" | jq -r '.id // empty' 2>/dev/null)"
    if [[ -z "$id" ]]; then
      log "ERROR create $rel: $(head -c 200 "$ERRF") | $(printf '%s' "$out" | head -c 200)"
      failed=$((failed+1)); continue
    fi
    added=$((added+1)); log "ADD $rel -> $id"
  fi
  printf 'F\t%s\t%s\t%s\n' "$rel" "$sha" "$id" >> "$TMP"
done

log "done: added=$added updated=$updated skipped=$skipped failed=$failed refused=$refused folders_created=$folders_made tracked=${#TRACKED[@]}"
if [[ $failed -gt 0 || $refused -gt 0 ]]; then exit 1; fi
exit 0
