#!/usr/bin/env bash
# scripts/mnemon-restore.sh — restore a mnemon store from a dated backup.
# Usage: mnemon-restore.sh <YYYY-MM-DD> <store>
# The live DB is moved aside (not deleted), then the backup is restored via sqlite3 .backup
# (NOT plain `cp`) so concurrent readers see a consistent snapshot if any container is still
# mid-write while the operator is restoring. Operators should still stop the service first;
# this is defense in depth against the case where a container respawns mid-restore.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: mnemon-restore.sh <YYYY-MM-DD> <store>"
  exit 1
fi

DATE=$1
STORE=$2
BACKUP_PATH="${HOME}/backups/.mnemon-${DATE}/${STORE}.db"
LIVE_PATH="${HOME}/.mnemon/data/${STORE}/mnemon.db"
LOCK_PATH="${HOME}/.mnemon/data/${STORE}/.write.lock"
FLOCK_TIMEOUT=30

if [[ ! -f "$BACKUP_PATH" ]]; then
  echo "No backup at $BACKUP_PATH" >&2
  exit 1
fi

# Move the live DB aside (preserves it as a sidecar) before restoring.
mkdir -p "$(dirname "$LIVE_PATH")"
SIDECAR=""
if [[ -f "$LIVE_PATH" ]]; then
  SIDECAR="${LIVE_PATH}.pre-restore-$(date +%s)"
  mv "$LIVE_PATH" "$SIDECAR"
  echo "Live store moved to: $SIDECAR"
fi

# Restore using sqlite3's online backup API. Even if a container respawns during the restore
# and starts writing, sqlite3 .backup tolerates concurrent readers; plain `cp` does not and
# can corrupt the live DB.
if ! flock -w "$FLOCK_TIMEOUT" "$LOCK_PATH" sqlite3 "$BACKUP_PATH" ".timeout 5000" ".backup ${LIVE_PATH}"; then
  echo "Restore failed (flock timeout or sqlite3 error). Live DB may be missing — sidecar at: ${SIDECAR}" >&2
  exit 1
fi

echo "Restored ${STORE} from ${DATE} backup."
echo "Live store: ${LIVE_PATH}"
[[ -n "$SIDECAR" ]] && echo "Pre-restore store: ${SIDECAR}"
