#!/usr/bin/env bash
# sync.sh — copy trunk agent-runner-src into one group's overlay, after
# backing up the existing overlay to data/.sync-groups-backup-<timestamp>/.
#
# Usage:
#   sync.sh <group-id> [--force]
#
# Default: refuses if any drifted file classifies as "self-mod". Pass --force
# to overwrite self-mods (backup is still created). --force is the only way
# to overwrite self-modified files; clean groups sync without it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TRUNK="$REPO_ROOT/container/agent-runner/src"
SESSIONS="$REPO_ROOT/data/v2-sessions"

GROUP="${1:-}"
FORCE=0
[ "${2:-}" = "--force" ] && FORCE=1

if [ -z "$GROUP" ]; then
  echo "usage: sync.sh <group-id> [--force]" >&2
  exit 2
fi

OVERLAY="$SESSIONS/$GROUP/agent-runner-src"
if [ ! -d "$OVERLAY" ]; then
  echo "error: overlay not found at $OVERLAY" >&2
  exit 2
fi

# Check for self-mods unless --force.
if [ $FORCE -eq 0 ]; then
  report="$("$(dirname "$0")/inspect.sh")"
  has_selfmod="$(echo "$report" | python3 -c "
import json,sys
d = json.load(sys.stdin)
g = next((g for g in d['groups'] if g['id'] == '$GROUP'), None)
if g is None:
    print('missing')
    sys.exit(0)
print('yes' if any(f['classification'] == 'self-mod' for f in g['drifted']) else 'no')
")"
  if [ "$has_selfmod" = "missing" ]; then
    echo "error: group $GROUP not found in inspect report" >&2
    exit 2
  fi
  if [ "$has_selfmod" = "yes" ]; then
    echo "refusing to sync $GROUP — self-modified files present. Re-run with --force to overwrite." >&2
    exit 3
  fi
fi

# Backup overlay, then rsync-mirror from trunk. rsync --delete removes orphan
# overlay-only files (only hit if --force on a group with self-authored new
# files). Backup preserves them regardless.
TS="$(date +%s)"
BACKUP_ROOT="$REPO_ROOT/data/.sync-groups-backup-$TS"
mkdir -p "$BACKUP_ROOT"
cp -r "$OVERLAY" "$BACKUP_ROOT/$GROUP-agent-runner-src"
echo "backup: $BACKUP_ROOT/$GROUP-agent-runner-src"

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$TRUNK/" "$OVERLAY/"
else
  # Fallback: Node fs.cpSync with force doesn't delete orphans, so emulate.
  node -e "
const fs=require('fs'),path=require('path');
const src='$TRUNK',dst='$OVERLAY';
function rmdirAll(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())rmdirAll(q);else fs.unlinkSync(q);}fs.rmdirSync(p);}
if(fs.existsSync(dst))rmdirAll(dst);
fs.cpSync(src,dst,{recursive:true});
"
fi

# Write audit log for this group. Kept OUTSIDE the overlay so inspect's
# orphan-file scan doesn't classify it as self-mod drift against trunk.
LOG="$SESSIONS/$GROUP/.sync-groups-log.json"
TRUNK_SHA="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo unknown)"
TRUNK_DIRTY="False"
[ -n "$(cd "$REPO_ROOT" && git status --porcelain -- container/agent-runner/src 2>/dev/null)" ] && TRUNK_DIRTY="True"
FORCE_PY=$([ $FORCE -eq 1 ] && echo True || echo False)
python3 -c "
import json,os,time
entry = {'ts': int(time.time()), 'trunk_sha': '$TRUNK_SHA', 'trunk_dirty': $TRUNK_DIRTY, 'force': $FORCE_PY, 'backup': '$BACKUP_ROOT/$GROUP-agent-runner-src'}
log_path = '$LOG'
log = []
if os.path.exists(log_path):
    try:
        log = json.load(open(log_path))
    except Exception:
        log = []
log.append(entry)
json.dump(log, open(log_path,'w'), indent=2)
"

echo "synced: $GROUP (trunk=$TRUNK_SHA, force=$FORCE)"
