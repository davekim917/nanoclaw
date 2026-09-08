#!/bin/bash
# Monthly OneCLI gateway drift check.
#
# Run by systemd timer (.config/systemd/user/onecli-drift-check.timer).
# Logs to journalctl. If a newer gateway version is available, sends a one-line
# DM to the owner via scripts/notify-owner.ts (posts to Slack directly; no
# dependency on nanoclaw-v2 or the CLI socket — see the comment above the
# delivery block below).
#
# Manual run:  bash scripts/check-onecli-drift.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
cd "$NANOCLAW_DIR"

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

TITLE="OneCLI gateway drift"
NOTIFICATION="OneCLI gateway upgrade available — currently on $CURRENT_VER, latest is $LATEST_VER ($RELEASE_COUNT releases behind). Run \`bash $RUNBOOK\` when convenient — it prompts before swapping, backs up postgres first, and auto-rolls-back if the smoke test regresses against its pre-upgrade baseline. NOTE: this dry-run already pulled the new image; nothing is swapped until you run it."

echo "drift-check: drift detected ($CURRENT_VER -> $LATEST_VER), queueing an alert"

# scripts/notify-owner.ts, NOT data/cli.sock. That socket is served BY
# nanoclaw-v2 and is only the CLI *channel adapter* (src/channels/cli.ts): a
# `to:` payload becomes an INBOUND event with no ack frame, so a successful
# `sendall()` proved nothing was delivered — this script's zero delivered
# messages could not be told apart from "there has never been drift" (#538).
# notify-owner.ts posts to Slack directly and only reports success on a
# verified `ok: true` response. DM by default; the outbox is an opt-in
# fallback via DRIFT_CHECK_OUTBOX.
DELIVERED=0
if node_modules/.bin/tsx scripts/notify-owner.ts --title "$TITLE" --body "$NOTIFICATION"; then
  DELIVERED=1
  echo "drift-check: notification sent to the owner DM"
fi

OUTBOX="${DRIFT_CHECK_OUTBOX:-}"
if [ "$DELIVERED" = "0" ] && [ -n "$OUTBOX" ] && [ -d "$OUTBOX" ] && [ -w "$OUTBOX" ]; then
  RAND="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  OUT="$OUTBOX/$(date -u +%Y%m%dT%H%M%S)-onecli-drift.${RAND:-$$}.md"
  umask 022
  set -C
  printf '*%s*\n\nThe owner DM could not be delivered; queuing to the shared outbox instead.\n\n%s\n' \
    "$TITLE" "$NOTIFICATION" > "$OUT" && DELIVERED=1
  set +C
  [ "$DELIVERED" = "1" ] && echo "drift-check: queued alert $OUT"
fi

if [ "$DELIVERED" = "0" ]; then
  echo "drift-check: DRIFT DETECTED BUT NOBODY WAS TOLD: $TITLE: $NOTIFICATION" >&2
  exit 1
fi
