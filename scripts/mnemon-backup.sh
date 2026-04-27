#!/usr/bin/env bash
# scripts/mnemon-backup.sh — nightly host cron
# Uses sqlite3 .backup (not cp/rsync) for consistent online backups.
# Retention: 7 daily + 4 weekly (Sunday) snapshots = 11 max per store.
set -euo pipefail

DATE=$(date -u +%Y-%m-%d)
SOURCE_ROOT="${HOME}/.mnemon/data"
BACKUP_ROOT="${HOME}/backups/.mnemon-${DATE}"
FLOCK_TIMEOUT=30

mkdir -p "$BACKUP_ROOT"

if [[ ! -d "$SOURCE_ROOT" ]]; then
  echo "No mnemon data dir at $SOURCE_ROOT — nothing to back up."
  exit 0
fi

for STORE_DIR in "$SOURCE_ROOT"/*/; do
  [[ -d "$STORE_DIR" ]] || continue
  STORE=$(basename "$STORE_DIR")
  DB="${STORE_DIR}/mnemon.db"
  [[ -f "$DB" ]] || continue
  OUT="${BACKUP_ROOT}/${STORE}.db"
  LOCK="${STORE_DIR}/.write.lock"
  # Acquire the per-store write flock before reading the DB. Without this, an in-flight
  # `mnemon remember` writer can hold a SQLite lock that times out our `.timeout 5000` and
  # produces a partial backup. With the flock the backup waits for the writer (bounded by
  # FLOCK_TIMEOUT) and then runs against a quiet DB.
  if ! flock -w "$FLOCK_TIMEOUT" "$LOCK" sqlite3 "$DB" ".timeout 5000" ".backup ${OUT}"; then
    echo "Backup of store '${STORE}' failed (flock timeout or sqlite3 error)" >&2
    exit 1
  fi
  echo "Backed up store '${STORE}' to ${OUT}"
done

# Retention: keep last 7 daily + 4 weekly (Sunday) snapshots.
# Daily: delete daily snapshots older than 7 days unless they fall on a Sunday.
# Weekly: keep Sunday snapshots up to 4 weeks back; delete older ones.
find "${HOME}/backups" -maxdepth 1 -type d -name '.mnemon-*' | while read -r OLD; do
  OLD_DATE=$(basename "$OLD" | sed 's/^\.mnemon-//')
  # Validate date format before parsing.
  if ! echo "$OLD_DATE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
    continue
  fi
  OLD_EPOCH=$(date -u -d "$OLD_DATE" +%s 2>/dev/null) || continue
  NOW_EPOCH=$(date -u +%s)
  OLD_AGE_DAYS=$(( (NOW_EPOCH - OLD_EPOCH) / 86400 ))
  OLD_DOW=$(date -u -d "$OLD_DATE" +%w 2>/dev/null) || continue  # 0=Sunday

  # Keep if it's within 7 days.
  if [[ "$OLD_AGE_DAYS" -le 7 ]]; then
    continue
  fi

  # Keep if it's a Sunday snapshot within 4 weeks (28 days).
  if [[ "$OLD_DOW" == "0" && "$OLD_AGE_DAYS" -le 28 ]]; then
    continue
  fi

  echo "Pruning old snapshot: $OLD (age: ${OLD_AGE_DAYS}d, dow: ${OLD_DOW})"
  rm -rf "$OLD"
done

echo "Backup complete: ${BACKUP_ROOT}"
