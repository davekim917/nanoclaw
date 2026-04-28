#!/bin/bash
# Monthly OneCLI gateway drift check.
#
# Run by systemd timer (.config/systemd/user/onecli-drift-check.timer).
# Logs to journalctl. If a newer gateway version is available, sends a one-line
# DM to the admin via NanoClaw's CLI socket — the wired admin agent surfaces
# the notification through Dave's preferred chat (Discord/Slack/etc.).
#
# Manual run:  bash scripts/check-onecli-drift.sh

set -euo pipefail

NANOCLAW_DIR="/home/ubuntu/nanoclaw-v2"
cd "$NANOCLAW_DIR"

CLI_SOCK="$NANOCLAW_DIR/data/cli.sock"
ADMIN_USER_ID="discord:608746260706361344"
ADMIN_DM_PLATFORM_ID="$(sqlite3 "$NANOCLAW_DIR/data/v2.db" "
  SELECT platform_id FROM messaging_groups
  WHERE id = (SELECT messaging_group_id FROM user_dms WHERE user_id = '$ADMIN_USER_ID' AND channel_type = 'discord' LIMIT 1)
")"

if [ -z "$ADMIN_DM_PLATFORM_ID" ]; then
  echo "drift-check: cannot resolve admin DM (user_dms row missing for $ADMIN_USER_ID)" >&2
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
        "channelType": "discord",
        "platformId": "$ADMIN_DM_PLATFORM_ID",
        "threadId": "$ADMIN_DM_PLATFORM_ID",
    },
}) + "\n"
sock.sendall(payload.encode("utf-8"))
time.sleep(0.5)  # give router a beat to read before we close
sock.close()
print("drift-check: notification delivered to admin DM")
EOF
