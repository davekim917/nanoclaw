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

# Run dry-run, capture output and current/latest versions
DRYRUN_OUTPUT=$(bash "$NANOCLAW_DIR/.migrations/upgrade-onecli-gateway.sh" --dry-run 2>&1)
echo "drift-check: dry-run output:"
echo "$DRYRUN_OUTPUT" | sed 's/^/  /'

if echo "$DRYRUN_OUTPUT" | grep -q "Already on the latest image"; then
  echo "drift-check: gateway is current. Nothing to notify."
  exit 0
fi

CURRENT_VER=$(echo "$DRYRUN_OUTPUT" | grep -oE "Current gateway: v[0-9.]+" | awk '{print $3}' || echo "?")
LATEST_VER=$(echo "$DRYRUN_OUTPUT" | grep -oE "Latest available: v[0-9.]+" | awk '{print $3}' || echo "?")
RELEASE_COUNT=$(echo "$DRYRUN_OUTPUT" | grep -oE "\([0-9]+ releases\)" | grep -oE "[0-9]+" || echo "?")

NOTIFICATION="System notification (monthly drift check): OneCLI gateway upgrade available — currently on $CURRENT_VER, latest is $LATEST_VER ($RELEASE_COUNT releases behind). Run \`bash .migrations/upgrade-onecli-gateway.sh\` from $NANOCLAW_DIR when convenient. Auto-rollback is built in if smoke tests fail."

echo "drift-check: drift detected ($CURRENT_VER -> $LATEST_VER), notifying admin via CLI socket"

# Inject as a CLI-channel inbound message routed to admin's Discord DM.
# Protocol matches scripts/init-first-agent.ts:sendWelcomeViaCliSocket.
python3 <<EOF
import json, socket, sys, time
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect("$CLI_SOCK")
payload = json.dumps({
    "text": """$NOTIFICATION""",
    "senderId": "system:drift-check",
    "sender": "OneCLI Drift Check",
    "to": {
        "channelType": "$ADMIN_DM_CHANNEL_TYPE",
        "platformId": "$ADMIN_DM_PLATFORM_ID",
        "threadId": "$ADMIN_DM_PLATFORM_ID",
    },
}) + "\n"
sock.sendall(payload.encode("utf-8"))
time.sleep(0.5)  # give router a beat to read before we close
sock.close()
print("drift-check: notification delivered to admin DM")
EOF
