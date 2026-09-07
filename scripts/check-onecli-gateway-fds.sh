#!/bin/bash
# OneCLI gateway file-descriptor watchdog.
#
# WHY THIS EXISTS
# ---------------
# The gateway leaks file descriptors: CONNECT tunnels whose client vanishes are
# never closed, so their sockets sit in FIN-WAIT-2/CLOSE-WAIT with no kernel
# timer (the app still holds the fd) and are never reclaimed. Known upstream and
# still open: https://github.com/onecli/onecli/issues/484
#
# When the gateway exhausts its 1024-fd soft limit it can no longer open a
# Postgres connection to resolve policy rules, so EVERY credentialed request
# fails with `resolution_failed` (502). Nothing detects this today:
#   - The container healthcheck probes /v1/health and /healthz, which keep
#     answering while the gateway is fd-starved, so it reports (healthy).
#   - `restart=unless-stopped` only fires on process exit, and the process
#     does not exit.
# On 2026-09-07 that combination degraded production for ~6 hours undetected: a
# scheduled task was skipped outright, Slack canvas refreshes failed, and every
# container MCP server lost its connection.
#
# Raising the ulimit is NOT a fix — issue #484's reporter hit the same wall with
# nofile=524288. It only changes how long you wait. This watchdog restarts the
# gateway before it reaches the wall, which is the only remedy available to us
# until upstream closes #484.
#
# Manual run:  bash scripts/check-onecli-gateway-fds.sh
#              RESTART_PCT=50 bash scripts/check-onecli-gateway-fds.sh  # tune
#              DRY_RUN=1 bash scripts/check-onecli-gateway-fds.sh     # no restart

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
cd "$NANOCLAW_DIR"

# Resolve the gateway container the way src/config.ts:223 does — process env,
# then .env, then the default. Inventing a second variable here would leave an
# install that set the documented ONECLI_GATEWAY_CONTAINER silently monitoring
# the wrong container, which is the failure this watchdog exists to catch.
# Mirror of src/env.ts:24-36 (readEnvValue) — trim the line, split on the first
# `=`, trim the value, then unquote; an empty value means unset and the last
# assignment wins. Mirrored rather than shelling out to the real parser on
# purpose: this resolution runs on EVERY timer tick, and nested `pnpm exec tsx`
# costs ~80s of CPU. The script pays that once on the restart path, which is
# rare; paying it per tick would starve the host this watchdog protects.
# Parity is asserted against the src/env-file.test.ts vectors by
# scripts/check-onecli-gateway-fds.test.sh.
read_env_value() {
  [ -f "$2" ] || return 0
  awk -v key="$1" '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line)
      if (line == "" || line ~ /^#/) next
      eq = index(line, "="); if (eq == 0) next
      k = substr(line, 1, eq - 1); sub(/[[:space:]]+$/, "", k)
      if (k != key) next
      v = substr(line, eq + 1)
      sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v)
      q = substr(v, 1, 1)
      if (length(v) >= 2 && (q == "\"" || q == "'"'"'") && substr(v, length(v), 1) == q)
        v = substr(v, 2, length(v) - 2)
      if (v != "") out = v
    }
    END { if (out != "") print out }
  ' "$2"
}

CONTAINER="${ONECLI_GATEWAY_CONTAINER:-}"
[ -n "$CONTAINER" ] || CONTAINER="$(read_env_value ONECLI_GATEWAY_CONTAINER "$NANOCLAW_DIR/.env")"
CONTAINER="${CONTAINER:-onecli}"
RESTART_PCT="${RESTART_PCT:-70}"   # restart at/above this % of the soft limit
DRY_RUN="${DRY_RUN:-0}"
CLI_SOCK="$NANOCLAW_DIR/data/cli.sock"

fail() { echo "fd-watchdog: $1" >&2; exit 1; }

docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "container '$CONTAINER' not found"

# The gateway is a child of the container's entrypoint, not PID 1 — measure the
# process that actually holds the sockets.
#
# A zero/absent reading means the instrument failed (permissions, race, or a
# gateway that never came back), NOT a healthy gateway. This is the one place
# that decides a reading is trustworthy, so the post-restart check below gets
# the same guarantee as the pre-restart one instead of its own weaker copy.
# Prints "<pid> <fds>"; returns non-zero when anything is unreadable.
read_gateway() {
  local pid count
  pid="$(docker top "$CONTAINER" 2>/dev/null | awk '/onecli-gateway/{print $2; exit}')"
  [ -n "$pid" ] || return 1
  count="$(ls "/proc/$pid/fd" 2>/dev/null | wc -l)"
  [ "$count" -gt 0 ] 2>/dev/null || return 1
  printf '%s %s\n' "$pid" "$count"
}

GW="$(read_gateway)" || fail "onecli-gateway not running in '$CONTAINER', or its fd count is unreadable (needs root)"
GW_PID="${GW%% *}"
FDS="${GW##* }"

SOFT="$(awk '/Max open files/{print $4}' "/proc/$GW_PID/limits" 2>/dev/null)"
[ -n "$SOFT" ] && [ "$SOFT" -gt 0 ] 2>/dev/null || fail "could not read fd soft limit for pid $GW_PID"

PCT=$(( FDS * 100 / SOFT ))

# Leak signature, for the log: sockets the app holds but will never use again.
NS_PID="$(docker inspect "$CONTAINER" --format '{{.State.Pid}}')"
STUCK="$(nsenter -t "$NS_PID" -n ss -tan 2>/dev/null | awk '$1=="FIN-WAIT-2"||$1=="CLOSE-WAIT"' | wc -l || echo 0)"

echo "fd-watchdog: pid=$GW_PID fds=$FDS/$SOFT (${PCT}%) unreclaimable_sockets=$STUCK threshold=${RESTART_PCT}%"

if [ "$PCT" -lt "$RESTART_PCT" ]; then
  echo "fd-watchdog: below threshold, nothing to do"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "fd-watchdog: DRY_RUN=1, would restart '$CONTAINER'"
  exit 0
fi

echo "fd-watchdog: at/above ${RESTART_PCT}% — restarting '$CONTAINER' before rule resolution starts failing"
docker restart "$CONTAINER" >/dev/null
SETTLE_SECONDS="${SETTLE_SECONDS:-10}"
sleep "$SETTLE_SECONDS"

if NEW="$(read_gateway)"; then
  RECOVERED=1
  echo "fd-watchdog: restarted; fds now ${NEW##* }/$SOFT"
else
  RECOVERED=0
  echo "fd-watchdog: RESTART DID NOT RECOVER — no readable gateway process after ${SETTLE_SECONDS}s" >&2
fi

# Tell an owner. A silent auto-restart would hide how fast the leak is growing.
ADMIN_DM_ROW="$(pnpm exec tsx scripts/q.ts "$NANOCLAW_DIR/data/v2.db" "
  SELECT mg.platform_id, ud.channel_type
    FROM user_roles ur
    JOIN user_dms ud ON ud.user_id = ur.user_id
    JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
   WHERE ur.role = 'owner'
   ORDER BY ud.resolved_at DESC
   LIMIT 1
" 2>/dev/null | tail -1)"
ADMIN_DM_PLATFORM_ID="$(echo "$ADMIN_DM_ROW" | cut -d'|' -f1)"
ADMIN_DM_CHANNEL_TYPE="$(echo "$ADMIN_DM_ROW" | cut -d'|' -f2)"

if [ -z "$ADMIN_DM_PLATFORM_ID" ] || [ ! -S "$CLI_SOCK" ]; then
  echo "fd-watchdog: no admin DM or CLI socket; notification skipped" >&2
  exit $(( RECOVERED == 1 ? 0 : 1 ))
fi

if [ "$RECOVERED" = "1" ]; then
  NOTIFICATION="System notification (OneCLI fd watchdog): the gateway reached ${PCT}% of its ${SOFT}-fd limit (${STUCK} sockets held but unreclaimable) and was restarted automatically — credentialed calls would have started failing with \`resolution_failed\` shortly. Root cause is the upstream leak in onecli/onecli#484, still open; this watchdog is containment, not a fix."
else
  NOTIFICATION="System notification (OneCLI fd watchdog): the gateway reached ${PCT}% of its ${SOFT}-fd limit and was restarted, but NO READABLE GATEWAY PROCESS came back after ${SETTLE_SECONDS}s. Containment FAILED — credentialed calls are probably failing with \`resolution_failed\` right now and this needs a human. Root cause is the upstream leak in onecli/onecli#484."
fi

python3 <<EOF
import json, socket, time
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect("$CLI_SOCK")
payload = json.dumps({
    "text": """$NOTIFICATION""",
    "senderId": "system:onecli-fd-watchdog",
    "sender": "OneCLI FD Watchdog",
    "to": {
        "channelType": "$ADMIN_DM_CHANNEL_TYPE",
        "platformId": "$ADMIN_DM_PLATFORM_ID",
        "threadId": "$ADMIN_DM_PLATFORM_ID",
    },
}) + "\n"
sock.sendall(payload.encode("utf-8"))
time.sleep(0.5)
sock.close()
print("fd-watchdog: notification delivered to admin DM")
EOF

exit $(( RECOVERED == 1 ? 0 : 1 ))
