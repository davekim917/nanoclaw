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

CONTAINER="${ONECLI_CONTAINER:-onecli}"
RESTART_PCT="${RESTART_PCT:-70}"   # restart at/above this % of the soft limit
DRY_RUN="${DRY_RUN:-0}"
RECOVER_WAIT_S="${RECOVER_WAIT_S:-60}"   # bound on waiting for the gateway to return
CLI_SOCK="$NANOCLAW_DIR/data/cli.sock"

fail() { echo "fd-watchdog: $1" >&2; exit 1; }

# Validate the threshold HERE, not at the comparison. `[ "$PCT" -lt "70%" ]`
# exits 2 with "integer expression expected", and because that comparison is an
# `if` condition, `set -e` does not stop the script — a non-integer threshold
# reads as "not below" and falls straight through to `docker restart`. On a
# 2-minute timer a single typo in the unit's Environment= would restart the
# gateway forever, which is a continuous credential outage caused by the thing
# meant to prevent one. Refuse the value instead.
case "$RESTART_PCT" in
  ''|*[!0-9]*) fail "RESTART_PCT must be an integer 0-100, got '$RESTART_PCT'" ;;
esac
[ "$RESTART_PCT" -le 100 ] || fail "RESTART_PCT must be an integer 0-100, got '$RESTART_PCT'"

docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "container '$CONTAINER' not found"

# EVERY measurement below is captured with `if ! VAR=$(...)`, never as a bare
# `VAR=$(...)` assignment. Under `set -e` a bare assignment is not a tested
# context: a nonzero exit from the command (or, under pipefail, from any stage)
# kills the script AT THAT LINE, before the `|| fail` guard on the next line can
# run. The guards then read as protection while being dead code on exactly the
# paths they were written for — a failed measurement exiting silently instead of
# saying why, which is the failure this script exists to prevent.

# The gateway is a child of the container's entrypoint, not PID 1 — measure the
# process that actually holds the sockets. Match the command field rather than
# the whole row, so a wrapper whose args merely mention the binary cannot be
# selected instead.
if ! GW_PID="$(docker top "$CONTAINER" 2>/dev/null | awk '$8=="onecli-gateway"{print $2; exit}')"; then
  fail "could not list processes in '$CONTAINER' (container stopped or restarting?)"
fi
[ -n "$GW_PID" ] || fail "onecli-gateway process not running inside '$CONTAINER'"

if ! FDS="$(ls "/proc/$GW_PID/fd" 2>/dev/null | wc -l)"; then
  fail "could not read open fds for pid $GW_PID (process gone?)"
fi
if ! SOFT="$(awk '/Max open files/{print $4}' "/proc/$GW_PID/limits" 2>/dev/null)"; then
  fail "could not read limits for pid $GW_PID (process gone since it was found?)"
fi

# A zero/absent reading means the instrument failed (permissions, race), NOT a
# healthy gateway. Never let a failed measurement read as an all-clear.
[ -n "$SOFT" ] && [ "$SOFT" -gt 0 ] 2>/dev/null || fail "could not read fd soft limit for pid $GW_PID"
[ "$FDS" -gt 0 ] 2>/dev/null || fail "could not read open fds for pid $GW_PID (got '$FDS')"

PCT=$(( FDS * 100 / SOFT ))

# Leak signature, for the log: sockets the app holds but will never use again.
# Reported as '?' rather than 0 when it cannot be measured — a failed count and
# a genuine zero must not print the same thing, for the same reason as above.
if ! NS_PID="$(docker inspect "$CONTAINER" --format '{{.State.Pid}}' 2>/dev/null)"; then
  fail "could not read the container pid for '$CONTAINER'"
fi
if ! STUCK="$(nsenter -t "$NS_PID" -n ss -tan 2>/dev/null | awk '$1=="FIN-WAIT-2"||$1=="CLOSE-WAIT"' | wc -l)"; then
  STUCK='?'
fi

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

# Wait for the gateway to actually come back, rather than sleeping a fixed
# interval and assuming it did. A restart that leaves no gateway process is a
# WORSE outage than the one being prevented, and reporting it as a success is
# the same defect as letting a failed measurement read as an all-clear.
RECOVERED=0
for _ in $(seq 1 "$RECOVER_WAIT_S"); do
  NEW_PID="$(docker top "$CONTAINER" 2>/dev/null | awk '$8=="onecli-gateway"{print $2; exit}')" || NEW_PID=''
  if [ -n "$NEW_PID" ] && [ "$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)" = "healthy" ]; then
    RECOVERED=1
    break
  fi
  sleep 1
done

# `wc -l` exits 0 on a failed `ls`, so a `|| echo '?'` here would be dead code —
# test for the pid instead.
if [ -n "${NEW_PID:-}" ] && NEW_FDS="$(ls "/proc/$NEW_PID/fd" 2>/dev/null | wc -l)"; then :; else NEW_FDS='?'; fi

if [ "$RECOVERED" = "1" ]; then
  echo "fd-watchdog: restarted and healthy; fds now $NEW_FDS/$SOFT"
  OUTCOME="was restarted automatically and came back healthy (fds now ${NEW_FDS}/${SOFT})"
else
  echo "fd-watchdog: RESTARTED BUT NOT HEALTHY after ${RECOVER_WAIT_S}s — credentialed calls are still failing" >&2
  OUTCOME="was restarted automatically but did NOT come back healthy within ${RECOVER_WAIT_S}s — credentialed calls are still failing and this needs a human"
fi

# Tell an owner. A silent auto-restart would hide how fast the leak is growing.
# Select the owner's real user_id and send AS them. A synthetic `system:<name>`
# sender is treated as an unknown user, and an owner DM under the `strict`
# unknown-sender policy DROPS it — observed: `MESSAGE DROPPED — unknown sender
# (strict policy) userId="system:onecli-fd-watchdog"` — while this script still
# printed that the notification was delivered. That is the failure this whole
# script exists to prevent, in its own alert path. `scripts/init-first-agent.ts`
# sends as the resolved user for the same reason.
ADMIN_DM_ROW="$(pnpm exec tsx scripts/q.ts "$NANOCLAW_DIR/data/v2.db" "
  SELECT mg.platform_id, ud.channel_type, ur.user_id
    FROM user_roles ur
    JOIN user_dms ud ON ud.user_id = ur.user_id
    JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
   WHERE ur.role = 'owner'
   ORDER BY ud.resolved_at DESC
   LIMIT 1
" 2>/dev/null | tail -1)"
ADMIN_DM_PLATFORM_ID="$(echo "$ADMIN_DM_ROW" | cut -d'|' -f1)"
ADMIN_DM_CHANNEL_TYPE="$(echo "$ADMIN_DM_ROW" | cut -d'|' -f2)"
ADMIN_USER_ID="$(echo "$ADMIN_DM_ROW" | cut -d'|' -f3)"

if [ -z "$ADMIN_DM_PLATFORM_ID" ] || [ -z "$ADMIN_USER_ID" ] || [ ! -S "$CLI_SOCK" ]; then
  echo "fd-watchdog: could not resolve an owner DM or the CLI socket — the gateway was handled but NOBODY WAS TOLD" >&2
  exit 1
fi

NOTIFICATION="System notification (OneCLI fd watchdog): the gateway reached ${PCT}% of its ${SOFT}-fd limit (${STUCK} sockets held but unreclaimable) and ${OUTCOME}. Root cause is the upstream leak in onecli/onecli#484, still open; this watchdog is containment, not a fix."

# Pass values through the environment and read them with os.environ inside a
# QUOTED heredoc, matching scripts/health-sentinel.sh:376-390. An unquoted
# heredoc substitutes them into Python source text, so a future edit to the
# message template that introduces a quote or backslash would break the script
# rather than the string. Same protocol, the version that cannot be broken by
# editing the text.
export NOTIFICATION ADMIN_DM_CHANNEL_TYPE ADMIN_DM_PLATFORM_ID ADMIN_USER_ID CLI_SOCK
python3 <<'EOF'
import json, os, socket, time
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["CLI_SOCK"])
payload = json.dumps({
    "text": os.environ["NOTIFICATION"],
    "senderId": os.environ["ADMIN_USER_ID"],
    "sender": "OneCLI FD Watchdog",
    "to": {
        "channelType": os.environ["ADMIN_DM_CHANNEL_TYPE"],
        "platformId": os.environ["ADMIN_DM_PLATFORM_ID"],
        "threadId": os.environ["ADMIN_DM_PLATFORM_ID"],
    },
}) + "\n"
sock.sendall(payload.encode("utf-8"))
time.sleep(0.5)
sock.close()
print("fd-watchdog: notification delivered to admin DM")
EOF
