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
# matching pair of single OR double quotes. The host reads process env THEN
# .env for these settings, so a shell expansion that only sees exported
# variables silently disagrees with the host about which container and which
# timezone are in use. Takes the file as an argument so it is testable —
# scripts/check-onecli-gateway-fds.test.sh asserts it against the same vectors
# src/env-file.test.ts uses on the real parser, because a mirror that drifts is
# worse than no mirror.
# Args: <key> <env-file>
read_env_value() {
  [ -r "${2:-}" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$2" | tr -d '\r' | awk '
    { gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if (length($0) >= 2 && ((substr($0,1,1)=="\"" && substr($0,length($0),1)=="\"") || (substr($0,1,1)=="'"'"'" && substr($0,length($0),1)=="'"'"'")))
        $0 = substr($0, 2, length($0)-2)
      if (length($0) > 0) last = $0 }
    END { if (length(last) > 0) print last }'
}

# Resolution order mirrors the host: the CANONICAL key from process env, then
# the canonical key from .env, and only then the legacy alias. The host reads
# ONECLI_GATEWAY_CONTAINER alone (src/config.ts), so letting an exported legacy
# alias win over a canonical .env setting would point the watchdog at a
# different container than the one the host actually runs.
CONTAINER="${ONECLI_GATEWAY_CONTAINER:-}"
[ -n "$CONTAINER" ] || CONTAINER="$(read_env_value ONECLI_GATEWAY_CONTAINER "$NANOCLAW_DIR/.env")"
[ -n "$CONTAINER" ] || CONTAINER="${ONECLI_CONTAINER:-}"
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
# One gate for every numeric knob. An empty value is NOT invalid — `${X:-default}`
# already treated it as unset, matching src/env.ts, where `if (value)` means an
# empty assignment is no assignment. Rejecting zero matters: RESTART_PCT=0 would
# restart the gateway on every tick, and RECOVER_WAIT_S=0 makes `seq 1 0` yield
# no iterations, so the recovery poll never runs and a healthy restart is
# reported as a failed one.
require_range() {  # <name> <value> <min> <max>
  case "$2" in
    ''|*[!0-9]*) fail "$1 must be an integer $3-$4, got '$2'" ;;
  esac
  if [ "$2" -lt "$3" ] || [ "$2" -gt "$4" ]; then
    fail "$1 must be $3-$4, got '$2'"
  fi
}
require_range RESTART_PCT "$RESTART_PCT" 1 100
require_range RECOVER_WAIT_S "$RECOVER_WAIT_S" 1 300

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

# Tell a human. DM by default, because these are host-ops alerts for one
# operator and do not belong in a shared channel.
#
# scripts/notify-owner.ts, NOT data/cli.sock. That socket is served BY
# nanoclaw-v2 and is only the CLI *channel adapter* (src/channels/cli.ts): a
# `to:` payload becomes an INBOUND event and queues work for an agent, which
# must then spawn a container and compose a reply before anyone sees
# anything — and spawn is REFUSED while the OneCLI gateway is unreachable
# (src/container-runner.ts), which is exactly the condition this watchdog
# exists to report. There is also no ack frame on that path, so a successful
# `sendall()` proved nothing was delivered — that muted host alerting for
# three days once already (fork #538). notify-owner.ts posts to Slack
# directly and only reports success on a verified `ok: true` response.
#
# The outbox stays available as an explicit fallback for the case
# notify-owner.ts cannot deliver — but it is OPT-IN via FD_WATCHDOG_OUTBOX,
# because the workgroup outbox ships to a shared channel and these alerts are
# not for one.
TITLE="OneCLI gateway fd watchdog"
NOTIFICATION="reached ${PCT}% of the ${SOFT}-fd limit (${STUCK} sockets held but unreclaimable) and ${OUTCOME}. Root cause is the upstream leak in onecli/onecli#484, still open; this watchdog is containment, not a fix."

DELIVERED=0
if node_modules/.bin/tsx scripts/notify-owner.ts --title "$TITLE" --body "$NOTIFICATION"; then
  DELIVERED=1
  echo "fd-watchdog: alert sent to the owner DM"
fi

if [ "$DELIVERED" = "0" ] && [ -n "${FD_WATCHDOG_OUTBOX:-}" ]; then
  if [ -d "$FD_WATCHDOG_OUTBOX" ] && [ -w "$FD_WATCHDOG_OUTBOX" ]; then
    RAND="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
    OUT="$FD_WATCHDOG_OUTBOX/$(date -u +%Y%m%dT%H%M%S)-onecli-fd-watchdog.${RAND:-$$}.md"
    umask 022
    set -C
    printf '*%s*\n\nThe owner DM could not be delivered; queuing to the shared outbox instead.\n\n%s\n' \
      "$TITLE" "$NOTIFICATION" > "$OUT" && DELIVERED=1
    set +C
    [ "$DELIVERED" = "1" ] && echo "fd-watchdog: alert queued $OUT"
  fi
fi

if [ "$DELIVERED" = "0" ]; then
  echo "fd-watchdog: THE GATEWAY WAS HANDLED BUT NOBODY WAS TOLD — $TITLE: $NOTIFICATION" >&2
  exit 1
fi
