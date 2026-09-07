#!/bin/bash
# Monthly OneCLI gateway drift check.
#
# Run by systemd timer (.config/systemd/user/onecli-drift-check.timer).
# Logs to journalctl. If a newer gateway version is available, sends a one-line
# DM to an owner via NanoClaw's CLI socket.
#
# Manual run:  bash scripts/check-onecli-drift.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
cd "$NANOCLAW_DIR"

CLI_SOCK="$NANOCLAW_DIR/data/cli.sock"
ADMIN_DM_ROW="$(pnpm exec tsx scripts/q.ts "$NANOCLAW_DIR/data/v2.db" "
  SELECT mg.platform_id, ud.channel_type
    FROM user_roles ur
    JOIN user_dms ud ON ud.user_id = ur.user_id
    JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
   WHERE ur.role = 'owner'
   ORDER BY ud.resolved_at DESC
   LIMIT 1
")"
IFS='|' read -r ADMIN_DM_PLATFORM_ID ADMIN_DM_CHANNEL_TYPE <<< "$ADMIN_DM_ROW"

if [ -z "${ADMIN_DM_PLATFORM_ID:-}" ] || [ -z "${ADMIN_DM_CHANNEL_TYPE:-}" ]; then
  echo "drift-check: cannot resolve an owner DM from user_roles + user_dms" >&2
  exit 1
fi

# The runbook lives in the private operator repo, not here: it names this
# install's agent groups, vault entries, and private repos, so it cannot satisfy
# `pnpm run check:public-boundary`. Overridable for installs that keep it
# elsewhere.
RUNBOOK="${ONECLI_RUNBOOK:-$NANOCLAW_DIR/groups/_ops/onecli/upgrade-onecli-gateway.sh}"

# Degrade cleanly rather than hard-failing: this script is tracked in a repo held
# to the public boundary, so a clone without the private operator content must
# not crash a scheduled timer. Skip with a clear message instead.
if [ ! -f "$RUNBOOK" ]; then
  echo "drift-check: no OneCLI runbook at $RUNBOOK — skipping."
  echo "drift-check: set ONECLI_RUNBOOK to its path, or install the operator repo."
  exit 0
fi

# Run dry-run, capture output and current/latest versions
DRYRUN_OUTPUT=$(bash "$RUNBOOK" --dry-run 2>&1)
echo "drift-check: dry-run output:"
echo "$DRYRUN_OUTPUT" | sed 's/^/  /'

if echo "$DRYRUN_OUTPUT" | grep -q "Already on the latest image"; then
  echo "drift-check: gateway is current. Nothing to notify."
  exit 0
fi

CURRENT_VER=$(echo "$DRYRUN_OUTPUT" | grep -oE "Current gateway: v[0-9.]+" | awk '{print $3}' || echo "?")
LATEST_VER=$(echo "$DRYRUN_OUTPUT" | grep -oE "Latest available: v[0-9.]+" | awk '{print $3}' || echo "?")
RELEASE_COUNT=$(echo "$DRYRUN_OUTPUT" | grep -oE "\([0-9]+ releases\)" | grep -oE "[0-9]+" || echo "?")

NOTIFICATION="System notification (monthly drift check): OneCLI gateway upgrade available — currently on $CURRENT_VER, latest is $LATEST_VER ($RELEASE_COUNT releases behind). Run \`bash $RUNBOOK\` when convenient — it prompts before swapping, backs up postgres first, and auto-rolls-back if the smoke test regresses against its pre-upgrade baseline. NOTE: this dry-run already pulled the new image; nothing is swapped until you run it."

echo "drift-check: drift detected ($CURRENT_VER -> $LATEST_VER), queueing an alert"

# Deliver over the outbox, not data/cli.sock. A `to:` payload on the socket
# becomes an INBOUND event, so the router applies its unknown-sender gate:
# `system:drift-check` is not a known user and the owner DM runs
# `unknown_sender_policy = strict`, so the router DROPS it while `sendall()`
# returns success. This script's zero delivered messages read like "there has
# never been drift to report" and could not be told apart from "always
# dropped". outbox-ship.sh POSTs to Slack every 60s with its own bot token and
# needs no host process. See onecli/onecli#484 work and fork issue #538.
OUTBOX="${DRIFT_CHECK_OUTBOX:-${UNIT_ALERT_OUTBOX:-}}"
if [ -z "$OUTBOX" ]; then
  echo "drift-check: DRIFT DETECTED but no outbox configured: $NOTIFICATION" >&2
  exit 1
fi
mkdir -p "$OUTBOX"
if [ ! -d "$OUTBOX" ] || [ ! -w "$OUTBOX" ]; then
  echo "drift-check: DRIFT DETECTED but outbox unusable ($OUTBOX): $NOTIFICATION" >&2
  exit 1
fi
# O_EXCL temp then rename, same reasoning as health-sentinel.sh: a predictable
# name in an agent-writable outbox could be pre-created as a symlink.
TMP_OUT="$(mktemp "$OUTBOX/$(date -u +%Y%m%dT%H%M%S)-onecli-drift.XXXXXX")" || {
  echo "drift-check: DRIFT DETECTED but could not create an alert file: $NOTIFICATION" >&2
  exit 1
}
OUT="$TMP_OUT.md"
printf '*OneCLI gateway drift*\n_host: %s · %s UTC_\n\n%s\n' \
  "$(hostname)" "$(date -u '+%Y-%m-%d %H:%M')" "$NOTIFICATION" > "$TMP_OUT"
chmod 0644 "$TMP_OUT"
mv -f "$TMP_OUT" "$OUT"
[ -s "$OUT" ] || { echo "drift-check: wrote an empty alert to $OUT" >&2; exit 1; }
echo "drift-check: queued alert $OUT"
