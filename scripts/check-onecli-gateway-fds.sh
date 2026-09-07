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


# Read a key from NanoClaw's .env the way src/env.ts does: trim, then strip one
# matching pair of single OR double quotes. The host honours .env for these
# settings, so a shell expansion that only sees exported variables silently
# disagrees with the host about which container and which timezone are in use.
env_get() {  # <key>
  [ -r "$NANOCLAW_DIR/.env" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$NANOCLAW_DIR/.env" | tail -1 | tr -d '\r' | awk '
    { gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if (length($0) >= 2 && ((substr($0,1,1)=="\"" && substr($0,length($0),1)=="\"") || (substr($0,1,1)=="'"'"'" && substr($0,length($0),1)=="'"'"'"))) 
        $0 = substr($0, 2, length($0)-2)
      print }'
}

# Same key and the same sources the host uses (src/config.ts reads process env
# THEN .env); ONECLI_CONTAINER stays accepted so existing drop-ins keep working.
CONTAINER="${ONECLI_GATEWAY_CONTAINER:-${ONECLI_CONTAINER:-}}"
[ -n "$CONTAINER" ] || CONTAINER="$(env_get ONECLI_GATEWAY_CONTAINER)"
CONTAINER="${CONTAINER:-onecli}"
RESTART_PCT="${RESTART_PCT:-70}"   # restart at/above this % of the soft limit
DRY_RUN="${DRY_RUN:-0}"
RECOVER_WAIT_S="${RECOVER_WAIT_S:-60}"   # bound on waiting for the gateway to return

fail() { echo "fd-watchdog: $1" >&2; exit 1; }

# Validate EVERY numeric knob here, before anything can act on one. A bad value
# does not fail loudly on its own: `[ "$PCT" -lt "70%" ]` exits 2, and because
# that comparison is an `if` condition `set -e` does not stop the script, so the
# threshold reads as "not below" and falls through to `docker restart` — on a
# 2-minute timer, one typo in the unit's Environment= is a permanent restart
# loop. `seq 1 "$RECOVER_WAIT_S"` with a zero, negative or mistyped value yields
# no iterations, so the recovery poll never runs and a healthy restart is
# reported as a failed one. Same root cause, so one gate rather than a guard per
# variable: the first version of this validated only RESTART_PCT and review
# found the identical defect at RECOVER_WAIT_S one round later.
require_int() {  # <name> <value> [max]
  case "$2" in
    ''|*[!0-9]*) fail "$1 must be a non-negative integer, got '$2'" ;;
  esac
  if [ -n "${3:-}" ] && [ "$2" -gt "$3" ]; then
    fail "$1 must be <= $3, got '$2'"
  fi
}
require_int RESTART_PCT "$RESTART_PCT" 100
require_int RECOVER_WAIT_S "$RECOVER_WAIT_S"
[ "$RECOVER_WAIT_S" -gt 0 ] || fail "RECOVER_WAIT_S must be > 0, got '$RECOVER_WAIT_S'"

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

# Tell a human, over a path that does not depend on what just broke.
#
# NOT data/cli.sock. That socket is served BY nanoclaw-v2, and a `to:` payload
# on it becomes an INBOUND event (src/channels/cli.ts) — it queues work for an
# agent, which must then spawn a container and call its provider before anyone
# sees anything. Every one of those steps needs the OneCLI gateway: the spawn
# path refuses containers outright while the gateway is unreachable
# (src/onecli-preflight.ts). So the agent path is undeliverable in exactly the
# case this script exists to report, and it would print "delivered" anyway.
# scripts/unit-failure-alert.sh already carries this conclusion in its header.
#
# The outbox is shipped to Slack every 60s by outbox-ship.sh using its own bot
# token and no host process, so it survives both nanoclaw-v2 and the gateway
# being down. It also removes this script's dependency on the central DB and on
# sender attribution entirely — there is no router gate to be dropped by.
OUTBOX="${FD_WATCHDOG_OUTBOX:-${UNIT_ALERT_OUTBOX:-}}"
if [ -z "$OUTBOX" ]; then
  echo "fd-watchdog: FD_WATCHDOG_OUTBOX/UNIT_ALERT_OUTBOX unset — the gateway was handled but NOBODY WAS TOLD" >&2
  exit 1
fi
mkdir -p "$OUTBOX"
# `mkdir -p` on a dangling compat symlink succeeds at creating nothing usable,
# so verify afterwards — an alert written into the void is this script's own
# failure mode.
[ -d "$OUTBOX" ] && [ -w "$OUTBOX" ] || {
  echo "fd-watchdog: outbox unusable: $OUTBOX — the gateway was handled but NOBODY WAS TOLD" >&2
  exit 1
}

# The filename stamp stays UTC so files sort globally; the human-visible time
# renders in the INSTALL timezone, like every other user-facing NanoClaw
# output. A bare `date` is NOT that: this host's system zone is Etc/UTC while
# the install runs TZ=America/New_York, set in the nanoclaw-v2 unit — so the
# install zone has to be read from there, not inherited.
# The unit name is install-specific — src/install-slug.ts generates
# nanoclaw-v2-<slug>, and setup can install it under `systemctl --user` — so
# NANOCLAW_SERVICE_UNIT overrides it, and .env's TZ is tried before giving up.
# Every branch is tolerant: this runs AFTER the restart, so an unknown timezone
# must never cost the alert.
INSTALL_TZ="${TZ:-}"
if [ -z "$INSTALL_TZ" ]; then
  INSTALL_TZ="$(systemctl show "${NANOCLAW_SERVICE_UNIT:-nanoclaw-v2}" -p Environment --value 2>/dev/null \
    | tr ' ' '\n' | sed -n 's/^TZ=//p' | head -1)" || INSTALL_TZ=''
fi
[ -n "$INSTALL_TZ" ] || INSTALL_TZ="$(env_get TZ)"
INSTALL_TZ="${INSTALL_TZ:-UTC}"

# One atomic create-and-write. `set -C` makes `>` use O_CREAT|O_EXCL, which
# REFUSES an existing path — a symlink included — rather than following it. That
# closes the window a mktemp-then-reopen sequence leaves open, where an agent
# sharing this directory could unlink the created file and drop a symlink at the
# name before the redirect reopens it. The name also carries randomness so there
# is nothing to pre-create, and `>` respects umask, so the shipper (running as
# the install user) can read what root wrote — mktemp's 0600 could not be.
RAND="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
OUT="$OUTBOX/$(date -u +%Y%m%dT%H%M%S)-onecli-fd-watchdog.${RAND:-$$}.md"
umask 022
set -C
{
  printf '*OneCLI gateway fd watchdog*\n_host: %s · %s_\n\n' "$(hostname)" "$(TZ="$INSTALL_TZ" date '+%Y-%m-%d %H:%M %Z')"
  printf 'The gateway reached %s%% of its %s-fd limit (%s sockets held but unreclaimable) and %s.\n\n' \
    "$PCT" "$SOFT" "$STUCK" "$OUTCOME"
  printf 'Root cause is the upstream leak in onecli/onecli#484, still open. This watchdog is containment, not a fix.\n'
} > "$OUT" || {
  set +C
  echo "fd-watchdog: could not create $OUT (pre-existing path?) — NOBODY WAS TOLD" >&2
  exit 1
}
set +C

[ -s "$OUT" ] || {
  echo "fd-watchdog: wrote an empty alert to $OUT" >&2
  exit 1
}
echo "fd-watchdog: queued alert $OUT"
