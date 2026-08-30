#!/bin/bash
# Escalate a failed systemd unit to a human.
#
# Why the outbox and not the CLI socket: data/cli.sock is served BY
# nanoclaw-v2 itself, so every alert routed through it is undeliverable in
# exactly the case worth alerting on. outbox-ship.sh POSTs to Slack every 60s
# with its own bot token and needs no host process, so it is the one alert
# path that survives nanoclaw-v2 being down.
#
# Invoked as OnFailure=nanoclaw-unit-alert@%n.service; $1 is the failed unit.
# Deliberately NOT wired onto nanoclaw-outbox-ship.service itself — an outbox
# that cannot ship cannot report that it cannot ship.
set -euo pipefail

UNIT="${1:?usage: unit-failure-alert.sh <unit-name>}"
# No baked-in default: the outbox path names a workgroup, which is
# install-private. The invoking unit carries it via a drop-in
# (nanoclaw-unit-alert@.service.d/outbox.conf, Environment=UNIT_ALERT_OUTBOX=...).
OUTBOX="${UNIT_ALERT_OUTBOX:?UNIT_ALERT_OUTBOX not set — point it at a workgroup releases/outbox dir}"

# Fail loud if the drop point is gone. `mkdir -p` on a dangling compat symlink
# (shared-dirs.ts) succeeds at creating nothing useful, so verify afterwards --
# an alert written into the void is the bug this whole script exists to fix.
mkdir -p "$OUTBOX"
[ -d "$OUTBOX" ] && [ -w "$OUTBOX" ] || { echo "unit-failure-alert: outbox unusable: $OUTBOX" >&2; exit 1; }

STAMP=$(date -u +%Y%m%dT%H%M%S)
OUT="$OUTBOX/${STAMP}-unitfail-${UNIT//[^A-Za-z0-9._-]/_}.md"

{
  printf '*systemd unit failed:* `%s`\n_host: %s · %s UTC_\n\n' \
    "$UNIT" "$(hostname)" "$(date -u '+%Y-%m-%d %H:%M')"
  printf 'Last 20 journal lines:\n\n'
  # exits 3 for an inactive unit -- the normal case here, since we are
  # invoked precisely because it is not running. Emptiness is checked below.
  { systemctl status "$UNIT" --no-pager -n 20 2>&1 || true; } | head -c 3000
} > "$OUT"

[ -s "$OUT" ] || { echo "unit-failure-alert: wrote an empty alert for $UNIT" >&2; exit 1; }
echo "unit-failure-alert: queued $OUT"
