#!/usr/bin/env bash
# inspect.sh — diff every agent group's agent-runner-src overlay against trunk,
# classify each drifted file as "stale-trunk" (safe to sync) or "self-mod"
# (needs review), and emit a JSON report on stdout.
#
# Self-mod detection: compute the overlay file's git blob hash, then walk
# every past blob for the same path in git history. If the overlay hash
# matches any past trunk blob → the operator never touched it, it's just
# outdated. If no past blob matches → someone edited it out-of-band.
#
# Output shape:
#   { "groups": [ {
#       "id": "ag-...",
#       "drifted": [ { "path": "...", "classification": "stale-trunk"|"self-mod" } ],
#       "in_sync": N,
#       "total": N
#     }, ... ] }

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TRUNK="$REPO_ROOT/container/agent-runner/src"
SESSIONS="$REPO_ROOT/data/v2-sessions"

cd "$REPO_ROOT"

# Collect every historical blob hash that has ever appeared at a given path in
# git history. Returns one hash per line. Empty if the path never existed.
hist_blobs_for_path() {
  local path="$1"
  git log --all --pretty=format:%H -- "$path" 2>/dev/null | while read -r commit; do
    git rev-parse "$commit:$path" 2>/dev/null || true
  done | sort -u
}

# Classify one overlay file. Args: <trunk-relative-path> <overlay-abs-path>
# Prints: "stale-trunk" or "self-mod"
classify_file() {
  local rel="$1"
  local overlay_abs="$2"
  local trunk_rel="container/agent-runner/src/$rel"
  local overlay_hash
  overlay_hash="$(git hash-object "$overlay_abs")"
  if hist_blobs_for_path "$trunk_rel" | grep -qx "$overlay_hash"; then
    echo "stale-trunk"
  else
    echo "self-mod"
  fi
}

printf '{"groups":['
first_group=1
for overlay in "$SESSIONS"/*/agent-runner-src; do
  [ -d "$overlay" ] || continue
  group="$(basename "$(dirname "$overlay")")"
  [ $first_group -eq 0 ] && printf ','
  first_group=0

  drifted_entries=""
  in_sync=0
  total=0

  while IFS= read -r -d '' overlay_file; do
    rel="${overlay_file#$overlay/}"
    trunk_file="$TRUNK/$rel"
    total=$((total + 1))
    if [ ! -f "$trunk_file" ]; then
      # Overlay has a file trunk no longer has — treat as self-mod (new file)
      entry="{\"path\":\"$rel\",\"classification\":\"self-mod\",\"reason\":\"orphan\"}"
    elif cmp -s "$overlay_file" "$trunk_file"; then
      in_sync=$((in_sync + 1))
      continue
    else
      cls="$(classify_file "$rel" "$overlay_file")"
      entry="{\"path\":\"$rel\",\"classification\":\"$cls\"}"
    fi
    if [ -z "$drifted_entries" ]; then
      drifted_entries="$entry"
    else
      drifted_entries="$drifted_entries,$entry"
    fi
  done < <(find "$overlay" -type f -print0)

  # Also flag trunk-only files (new files trunk added that overlay is missing)
  while IFS= read -r -d '' trunk_file; do
    rel="${trunk_file#$TRUNK/}"
    if [ ! -f "$overlay/$rel" ]; then
      entry="{\"path\":\"$rel\",\"classification\":\"stale-trunk\",\"reason\":\"missing-in-overlay\"}"
      if [ -z "$drifted_entries" ]; then
        drifted_entries="$entry"
      else
        drifted_entries="$drifted_entries,$entry"
      fi
    fi
  done < <(find "$TRUNK" -type f -print0)

  printf '{"id":"%s","drifted":[%s],"in_sync":%d,"total":%d}' "$group" "$drifted_entries" "$in_sync" "$total"
done
printf ']}'
echo
