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

# No owner-DM lookup and no CLI socket: delivery is the outbox. The old lookup
# gated the whole run, so a transient central-DB failure — or an install with
# no resolved owner DM — silently suppressed drift reports even when a
# perfectly good outbox was configured.

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

# DM by default; the outbox is an opt-in fallback via DRIFT_CHECK_OUTBOX. The
# owner's user id is the sender, never a synthetic `system:<name>` — the router
# drops that as an unknown user against a strict owner DM while sendall()
# returns success (#538). This script's zero delivered messages could not be
# told apart from "there has never been drift".
DELIVERED=0
ADMIN_ROW="$(pnpm exec tsx scripts/q.ts "$NANOCLAW_DIR/data/v2.db" "
  SELECT mg.platform_id, ud.channel_type, ur.user_id
    FROM user_roles ur
    JOIN user_dms ud ON ud.user_id = ur.user_id
    JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
   WHERE ur.role = 'owner'
   ORDER BY ud.resolved_at DESC
   LIMIT 1
" 2>/dev/null | tail -1)" || ADMIN_ROW=''
DM_PLATFORM_ID="$(echo "$ADMIN_ROW" | cut -d'|' -f1)"
DM_CHANNEL_TYPE="$(echo "$ADMIN_ROW" | cut -d'|' -f2)"
DM_USER_ID="$(echo "$ADMIN_ROW" | cut -d'|' -f3)"
CLI_SOCK="$NANOCLAW_DIR/data/cli.sock"

if [ -n "$DM_PLATFORM_ID" ] && [ -n "$DM_USER_ID" ] && [ -S "$CLI_SOCK" ]; then
  export NOTIFICATION DM_CHANNEL_TYPE DM_PLATFORM_ID DM_USER_ID CLI_SOCK
  if python3 <<'PYEOF'
import json, os, socket, sys, time
try:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect(os.environ["CLI_SOCK"])
    sock.sendall((json.dumps({
        "text": os.environ["NOTIFICATION"],
        "senderId": os.environ["DM_USER_ID"],
        "sender": "OneCLI Drift Check",
        "to": {
            "channelType": os.environ["DM_CHANNEL_TYPE"],
            "platformId": os.environ["DM_PLATFORM_ID"],
            "threadId": os.environ["DM_PLATFORM_ID"],
        },
    }) + "\n").encode("utf-8"))
    time.sleep(0.5)
    sock.close()
except Exception as e:
    print(f"dm send failed: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
  then
    DELIVERED=1
    echo "drift-check: notification sent to the owner DM"
  fi
fi

OUTBOX="${DRIFT_CHECK_OUTBOX:-}"
if [ "$DELIVERED" = "0" ] && [ -n "$OUTBOX" ] && [ -d "$OUTBOX" ] && [ -w "$OUTBOX" ]; then
  RAND="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  OUT="$OUTBOX/$(date -u +%Y%m%dT%H%M%S)-onecli-drift.${RAND:-$$}.md"
  umask 022
  set -C
  printf '*OneCLI gateway drift*\n\n%s\n' "$NOTIFICATION" > "$OUT" && DELIVERED=1
  set +C
  [ "$DELIVERED" = "1" ] && echo "drift-check: queued alert $OUT"
fi

if [ "$DELIVERED" = "0" ]; then
  echo "drift-check: DRIFT DETECTED BUT NOBODY WAS TOLD: $NOTIFICATION" >&2
  exit 1
fi
