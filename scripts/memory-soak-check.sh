#!/usr/bin/env bash
# Memory daemon 1-week post-deploy soak check.
# Run via system cron (see install instructions below). Writes a structured
# report to logs/memory-soak.log; sends a Discord DM to Dave if anomalies are
# found.
#
# Install:
#   crontab -e  →  23 9 7 5 *  /home/ubuntu/nanoclaw-v2/scripts/memory-soak-check.sh
#   (replace 7 5 with whatever date is 1 week after deploy)

set -euo pipefail

REPO=/home/ubuntu/nanoclaw-v2
LOG=$REPO/logs/memory-soak.log
INGEST_DB=$REPO/data/mnemon-ingest.db
HEALTH_JSON=$REPO/data/memory-health.json
ANOMALIES=()
TS=$(date -Iseconds)

mkdir -p "$REPO/logs"
exec >>"$LOG" 2>&1
echo "=== memory soak check $TS ==="

# 1. Daemon active?
if ! systemctl is-active --quiet nanoclaw-memory-daemon; then
  ANOMALIES+=("daemon NOT active")
fi

# 2. Recent fatal errors in journal?
fatal_count=$(journalctl -u nanoclaw-memory-daemon --since "1 week ago" 2>/dev/null \
  | grep -ciE "error|fail|fatal" || true)
if [ "$fatal_count" -gt 50 ]; then
  ANOMALIES+=("$fatal_count error/fail/fatal lines in journal — investigate")
fi

# 3. Health JSON
if [ -f "$HEALTH_JSON" ]; then
  stale_h=$(jq -r '.synthesiseStaleHours // 0' "$HEALTH_JSON")
  if (( $(echo "$stale_h > 30" | bc -l 2>/dev/null || echo 0) )); then
    ANOMALIES+=("synthesise stale ${stale_h}h (expected <30h)")
  fi
  enabled_failures=$(jq -r '.memoryEnabledCheckFailures // {} | length' "$HEALTH_JSON")
  if [ "$enabled_failures" -gt 0 ]; then
    ANOMALIES+=("$enabled_failures memoryEnabledCheckFailures entries")
  fi
else
  ANOMALIES+=("memory-health.json missing")
fi

# 4. Ingest DB
if [ -f "$INGEST_DB" ]; then
  unresolved=$(sqlite3 "$INGEST_DB" "SELECT COUNT(*) FROM dead_letters WHERE poisoned_at IS NULL")
  high_failure=$(sqlite3 "$INGEST_DB" "SELECT COUNT(*) FROM dead_letters WHERE poisoned_at IS NULL AND failure_count >= 3")
  poisoned=$(sqlite3 "$INGEST_DB" "SELECT COUNT(*) FROM dead_letters WHERE poisoned_at IS NOT NULL")
  pairs=$(sqlite3 "$INGEST_DB" "SELECT COUNT(*) FROM processed_pairs")
  idem=$(sqlite3 "$INGEST_DB" "SELECT COUNT(*) FROM idempotency_keys")
  echo "  pairs=$pairs idem_keys=$idem unresolved_dl=$unresolved high_failure_dl=$high_failure poisoned=$poisoned"
  if [ "$unresolved" -gt 50 ]; then ANOMALIES+=("$unresolved unresolved dead_letters"); fi
  if [ "$high_failure" -gt 0 ]; then ANOMALIES+=("$high_failure dead_letters with failure_count >= 3"); fi
  if [ "$poisoned" -gt 0 ]; then ANOMALIES+=("$poisoned poisoned items"); fi
else
  ANOMALIES+=("mnemon-ingest.db missing")
fi

# 5. Wiki freshness for memory-enabled groups
for grp_dir in "$REPO"/groups/*/; do
  cfg="$grp_dir/container.json"
  wiki="$grp_dir/wiki"
  [ -f "$cfg" ] || continue
  enabled=$(jq -r '.memory.enabled // false' "$cfg" 2>/dev/null || echo false)
  [ "$enabled" = "true" ] || continue
  [ -d "$wiki/.git" ] || continue
  last_sync=$(cd "$wiki" && git log -1 --format=%ct 2>/dev/null || echo 0)
  age_hours=$(( ($(date +%s) - last_sync) / 3600 ))
  group_name=$(basename "$grp_dir")
  echo "  wiki/$group_name age=${age_hours}h"
  if [ "$age_hours" -gt 48 ]; then
    ANOMALIES+=("wiki/$group_name not synced in ${age_hours}h")
  fi
done

# Decide
if [ ${#ANOMALIES[@]} -eq 0 ]; then
  echo "ALL CLEAN"
  exit 0
fi

# Anomalies — emit a digest. If a Discord webhook env var is set, post it.
DIGEST="memory daemon 1-week soak ($TS) — anomalies:"$'\n'
for a in "${ANOMALIES[@]}"; do DIGEST+="  • $a"$'\n'; done
echo "$DIGEST"

# Optional Discord notification — set MEMORY_SOAK_DISCORD_WEBHOOK in /etc/environment or wherever
if [ -n "${MEMORY_SOAK_DISCORD_WEBHOOK:-}" ]; then
  curl -sS -X POST -H 'Content-Type: application/json' \
    -d "$(jq -n --arg c "$DIGEST" '{content: $c}')" \
    "$MEMORY_SOAK_DISCORD_WEBHOOK" > /dev/null || echo "Discord post failed"
fi

exit 1
