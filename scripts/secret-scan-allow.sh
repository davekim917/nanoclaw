#!/usr/bin/env bash
# Prints ready-to-append groups/.secret-scan-allow lines for ONE path's
# currently-held secret-shaped lines (#628 item 9). WRITES NOTHING ON ITS
# OWN — every line it prints is MASKED to its offending line's first 8
# characters, so the operator reviews and (if they judge it a false
# positive) appends the printed line to groups/.secret-scan-allow and
# commits it themselves. This script never touches that file.
#
# The held-state TSV (scripts/git-safety.sh's $HELD_STATE_FILE) never
# stores the offending line's own text — only its hash — precisely so a
# secret never sits twice-persisted on disk. This script re-derives the
# CURRENT live line for the given path from groups' own working tree (the
# same per-file diff-against-HEAD scripts/git-safety.sh's next run would
# see), matches it against the held state by hash, and only THEN masks and
# prints it — never printing anything that isn't independently confirmed
# to be an actual currently-held line for this exact path.
#
# Usage: bash scripts/secret-scan-allow.sh <path-within-groups>

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
GROUPS_DIR="$NANOCLAW_DIR/groups"
SNAP_ROOT="${GIT_SAFETY_DIR:-$HOME/nanoclaw-backups}"
STATE_DIR="${GIT_SAFETY_STATE_DIR:-$SNAP_ROOT/.git-safety-state}"
HELD_STATE_FILE="$STATE_DIR/secret-scan-held.tsv"

TARGET_PATH="${1:-}"
if [ -z "$TARGET_PATH" ]; then
  echo "usage: bash scripts/secret-scan-allow.sh <path-within-groups>" >&2
  exit 1
fi

# shellcheck source=lib/secret-scan.sh
source "${SCRIPT_DIR}/lib/secret-scan.sh" || {
  echo "secret-scan-allow: cannot load ${SCRIPT_DIR}/lib/secret-scan.sh" >&2
  exit 1
}
if ! secret_scan_selftest; then
  echo "secret-scan-allow: ${SCRIPT_DIR}/lib/secret-scan.sh failed its self-test — refusing to run without a validated secret gate" >&2
  exit 1
fi

if [ ! -d "$GROUPS_DIR/.git" ]; then
  echo "secret-scan-allow: no groups/ repo at $GROUPS_DIR" >&2
  exit 1
fi

line_hash() { # <path> <line-text> — same key as git-safety.sh and groups/.secret-scan-allow
  printf '%s\t%s' "$1" "$2" | sha256sum | cut -d' ' -f1
}
mask_line() { # <line-text> -> first 8 characters, "..." appended if longer
  local l="$1"
  if [ "${#l}" -gt 8 ]; then
    printf '%s...' "${l:0:8}"
  else
    printf '%s' "$l"
  fi
}

held_hashes=()
if [ -s "$HELD_STATE_FILE" ]; then
  hp=""; hh=""
  while IFS=$'\t' read -r hp hh _; do
    [ "$hp" = "$TARGET_PATH" ] || continue
    held_hashes+=("$hh")
  done < "$HELD_STATE_FILE"
fi
if [ "${#held_hashes[@]}" -eq 0 ]; then
  echo "secret-scan-allow: no held entries recorded for $TARGET_PATH in $HELD_STATE_FILE" >&2
  exit 0
fi

# Re-derive the CURRENT live diff for this one path against groups' HEAD —
# diff-index, not porcelain diff, so this read-only helper never rewrites
# groups' real .git/index (same reasoning as scripts/git-safety.sh's own
# phase-1 patch call).
FILE_DIFF=$(git -C "$GROUPS_DIR" diff-index --no-color -p --text HEAD -- "$TARGET_PATH" \
  --src-prefix=a/ --dst-prefix=b/ \
  --output-indicator-new="$SECRET_SCAN_NEW_INDICATOR" --output-indicator-old=- --output-indicator-context=' ' 2>/dev/null)
ADDED=$(secret_scan_extract_added "$FILE_DIFF")
MATCHES=$(secret_scan_matching_lines "$ADDED" "$SECRET_RE" insensitive)

PRINTED=0
if [ -n "$MATCHES" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    hash=$(line_hash "$TARGET_PATH" "$line")
    for held in "${held_hashes[@]}"; do
      if [ "$held" = "$hash" ]; then
        masked=$(mask_line "$line")
        printf '%s\t%s\tALLOW: reviewed, starts "%s" — fill in why this is not a real secret before committing\n' \
          "$TARGET_PATH" "$hash" "$masked"
        PRINTED=$((PRINTED + 1))
        break
      fi
    done
  done <<<"$MATCHES"
fi

if [ "$PRINTED" -eq 0 ]; then
  echo "secret-scan-allow: $TARGET_PATH has ${#held_hashes[@]} recorded hold(s), but none matched its CURRENT working-tree diff — already resolved, or the working tree has since changed" >&2
  exit 0
fi

echo "# Review each line above, then append the ones you approve to groups/.secret-scan-allow and commit them yourself." >&2
echo "# This script wrote nothing." >&2
