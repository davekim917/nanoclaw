#!/bin/bash
# Host health sentinel — the system tells the owner when it is sick, so the
# owner never has to watch a dashboard. Runs every 15 min from a systemd timer
# (nanoclaw-health-sentinel.timer); silent when healthy, DMs the owner on
# breach via the CLI socket (same delivery path as check-onecli-drift.sh).
#
# Vitals (thresholds tuned for a 6-core host; override via env):
#   1. service     — nanoclaw-v2 inactive, or >=3 restarts since last check (crash loop)
#   2. load        — 15-min load average >= 2x cores (sustained overload, not a spike)
#   3. stalls      — event-loop stalls in the window (storm precursor)
#   4. recovery    — channel recovery passes in the window (storm signature)
#   5. sweep       — any sweep tick over 120s (control-plane saturation)
#   6. disk        — data filesystem >= 90% (admission refusal imminent)
#   7. crashloop   — a session whose container repeatedly exits non-zero
#   8. qaseats     — QA seat-health artifact missing or stale (the smoke
#                    gates fail OPEN on it, so nothing else would say so)
#
# Log windows are measured by BYTE OFFSET deltas stored in the state file —
# never by log timestamps (the log has multiple writers stamping different
# timezones, and no dates; offset deltas are the only honest window).
#
# Per-vital alert dedup: 6h cooldown, so a sustained breach nags at most 4x/day.
#
# Manual run:   bash scripts/health-sentinel.sh
# Test the DM:  TEST_ALERT=1 bash scripts/health-sentinel.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
cd "$NANOCLAW_DIR"

STATE_FILE="$NANOCLAW_DIR/data/health-sentinel-state.json"
CLI_SOCK="$NANOCLAW_DIR/data/cli.sock"
LOG="$NANOCLAW_DIR/logs/nanoclaw.log"
ERRLOG="$NANOCLAW_DIR/logs/nanoclaw.error.log"

CORES=$(nproc)
LOAD15_MAX=${LOAD15_MAX:-$((CORES * 2))}
STALLS_MAX=${STALLS_MAX:-40}
RECOVERY_MAX=${RECOVERY_MAX:-200}
SWEEP_MS_MAX=${SWEEP_MS_MAX:-120000}
DISK_MAX_PCT=${DISK_MAX_PCT:-90}
RESTARTS_MAX=${RESTARTS_MAX:-3}
ALERT_COOLDOWN_S=${ALERT_COOLDOWN_S:-21600}

NOW=$(date +%s)

# ── state (previous offsets, restart count, last-alert times) ───────────────
get_state() { # key default
  python3 - "$1" "$2" <<EOF
import json, sys
try:
    with open("$STATE_FILE") as f: s = json.load(f)
except Exception: s = {}
print(s.get(sys.argv[1], sys.argv[2]))
EOF
}

PREV_LOG_OFF=$(get_state log_off 0)
PREV_ERR_OFF=$(get_state err_off 0)
PREV_RESTARTS=$(get_state restarts -1)

LOG_SIZE=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
ERR_SIZE=$(stat -c %s "$ERRLOG" 2>/dev/null || echo 0)
# Rotation/truncation: stored offset past EOF means a new file — reset window.
[ "$PREV_LOG_OFF" -gt "$LOG_SIZE" ] && PREV_LOG_OFF=$LOG_SIZE
[ "$PREV_ERR_OFF" -gt "$ERR_SIZE" ] && PREV_ERR_OFF=$ERR_SIZE

window_log() { tail -c +$((PREV_LOG_OFF + 1)) "$LOG" 2>/dev/null | head -c $((LOG_SIZE - PREV_LOG_OFF)); }
window_err() { tail -c +$((PREV_ERR_OFF + 1)) "$ERRLOG" 2>/dev/null | head -c $((ERR_SIZE - PREV_ERR_OFF)); }

# ── vitals ──────────────────────────────────────────────────────────────────
BREACHES=()

SERVICE_STATE=$(systemctl is-active nanoclaw-v2 2>/dev/null || echo unknown)
RESTARTS=$(systemctl show nanoclaw-v2 -p NRestarts --value 2>/dev/null || echo 0)
if [ "$SERVICE_STATE" != "active" ]; then
  BREACHES+=("service|nanoclaw-v2 is $SERVICE_STATE")
elif [ "$PREV_RESTARTS" -ge 0 ] && [ $((RESTARTS - PREV_RESTARTS)) -ge "$RESTARTS_MAX" ]; then
  BREACHES+=("service|nanoclaw-v2 restarted $((RESTARTS - PREV_RESTARTS))x since last check (crash loop?)")
fi

LOAD15=$(awk '{print int($3)}' /proc/loadavg)
if [ "$LOAD15" -ge "$LOAD15_MAX" ]; then
  BREACHES+=("load|15-min load $LOAD15 >= $LOAD15_MAX on $CORES cores (sustained overload)")
fi

# First run has no window — skip log-delta vitals until offsets exist.
if [ "$PREV_LOG_OFF" -gt 0 ] || [ "$PREV_ERR_OFF" -gt 0 ]; then
  STALLS=$(window_err | grep -c "stall detected" || true)
  if [ "$STALLS" -ge "$STALLS_MAX" ]; then
    BREACHES+=("stalls|$STALLS event-loop stalls in the last window (>= $STALLS_MAX)")
  fi

  RECOVERIES=$(window_log | grep -c "Channel recovery complete" || true)
  if [ "$RECOVERIES" -ge "$RECOVERY_MAX" ]; then
    BREACHES+=("recovery|$RECOVERIES channel recovery passes in the last window (>= $RECOVERY_MAX — storm signature)")
  fi

  SLOW_SWEEPS=$( (window_log | grep "Host sweep tick timing" | grep -oE 'sweepMs[^=]*=[0-9]+' | grep -oE '[0-9]+$' | awk -v m="$SWEEP_MS_MAX" '$1>=m' | wc -l) || true)
  SLOW_SWEEPS=${SLOW_SWEEPS:-0}
  if [ "$SLOW_SWEEPS" -ge 1 ]; then
    BREACHES+=("sweep|$SLOW_SWEEPS sweep tick(s) over $((SWEEP_MS_MAX / 1000))s in the last window (control-plane saturation)")
  fi

  # A session whose container repeatedly exits non-zero is an agent that
  # silently never answers (wake -> crash -> re-wake). Observed live: a
  # schema-migration gap crash-looped a channel session for weeks with user
  # mentions pending, invisible to every load/stall/disk vital.
  CRASHED=$( (window_err | grep "Container exited non-zero" | grep -oE 'sessionId[^ ]*"[a-z0-9-]+"' | sort | uniq -c | awk -v m="${CONTAINER_CRASHES_MAX:-3}" '$1>=m' | wc -l) || true)
  CRASHED=${CRASHED:-0}
  if [ "$CRASHED" -ge 1 ]; then
    BREACHES+=("crashloop|$CRASHED session(s) crash-looped ${CONTAINER_CRASHES_MAX:-3}+ times in the last window — those agents are not answering")
  fi
fi

DISK_PCT=$(df --output=pcent "$NANOCLAW_DIR/data" 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$DISK_PCT" ] && [ "$DISK_PCT" -ge "$DISK_MAX_PCT" ]; then
  BREACHES+=("disk|data filesystem at ${DISK_PCT}% (>= ${DISK_MAX_PCT}% — container admission refusal at 90%)")
fi

# QA seat health. Where configured, the smoke gates read a seat-health artifact
# instead of probing every seat inline, and a MISSING or STALE artifact makes
# them fail OPEN — deliberately, because an unreachable health lookup must not
# wedge every campaign in the fleet. Fail-open is only safe if somebody is told,
# and this is the telling: the gate has no way to alert and allow in the same
# poll, and this sentinel is also the path that still works when the seat-health
# timer is the thing that died.
#
# Skipped entirely when unconfigured, so this is a no-op on any install that
# does not gate campaigns on seat health.
# Opt-in: unset means this install has no seat-gated smoke campaigns. Trunk
# carries no install-specific path — set it in the sentinel unit's Environment=.
QA_SEAT_HEALTH_FILE="${QA_SEAT_HEALTH_FILE:-}"
QA_SEAT_HEALTH_MAX_AGE_S="${QA_SEAT_HEALTH_MAX_AGE_S:-3600}"
if [ -n "$QA_SEAT_HEALTH_FILE" ]; then
  if [ ! -s "$QA_SEAT_HEALTH_FILE" ]; then
    BREACHES+=("qaseats|QA seat-health artifact missing at $QA_SEAT_HEALTH_FILE — the smoke gates are opening campaigns with NO seat verification; check qa-seat-health.timer")
  else
    # Oldest lastDefiniteAt across seats, in seconds. A null (never got a
    # definite answer) counts as infinitely old — a timer that fires but only
    # ever collects 429s is exactly as blind as a timer that is not running.
    # Epoch integers, not parsed ISO — jq 1.6 (the agent container's jq) reads
    # these strings an hour off, and the artifact's writer records the epoch
    # beside the ISO for exactly that reason. A seat with no epoch counts as
    # never-answered rather than being parsed by a method known to be wrong.
    QA_AGE=$( (jq -r --argjson now "$NOW" '
      def epoch: if type == "number" then . else null end;
      [ .seats[]? | (.lastDefiniteAtEpoch | epoch) ] as $t
      | if ($t | length) == 0 then 999999999
        elif ($t | any(. == null)) then 999999999
        else ($now - ($t | min)) end' "$QA_SEAT_HEALTH_FILE" 2>/dev/null) || echo 999999999)
    case "$QA_AGE" in ''|*[!0-9]*) QA_AGE=999999999 ;; esac
    if [ "$QA_AGE" -ge 999999999 ]; then
      BREACHES+=("qaseats|QA seat health has NO definite answer for at least one seat — the job is running but only ever collecting throttles/timeouts, which is as blind as not running. The smoke gates are opening campaigns unverified; check qa-seat-health.service in journalctl")
    elif [ "$QA_AGE" -ge "$QA_SEAT_HEALTH_MAX_AGE_S" ]; then
      BREACHES+=("qaseats|QA seat health is stale — no definite answer for at least one seat in $((QA_AGE / 60))m (bound $((QA_SEAT_HEALTH_MAX_AGE_S / 60))m); the smoke gates are opening campaigns unverified. Check qa-seat-health.timer")
    fi
  fi
fi

if [ "${TEST_ALERT:-0}" = "1" ]; then
  BREACHES+=("test|test alert requested via TEST_ALERT=1 — delivery path verified, no action needed")
fi

# ── dedup + persist window cursors ──────────────────────────────────────────
# TWO separate writes, and the split is the whole point.
#
# `log_off`/`err_off`/`restarts` are a window CURSOR: persist them on every run
# or the next run re-scans the same bytes and re-alerts forever.
#
# `last_alert` is a RECEIPT of a DM that actually went out, so it is stamped
# only after the socket send returns (bottom of this file). Stamping it here
# burned the 6h cooldown on undelivered alerts — worst precisely when it
# matters, because cli.sock is served BY nanoclaw-v2 itself: the
# `service|nanoclaw-v2 is <state>` breach is undeliverable exactly when it
# fires, and the old code then sat silent for 6h having "already alerted".
export STATE_FILE LOG_SIZE ERR_SIZE RESTARTS
ALERT_FILE=$(mktemp)
trap 'rm -f "$ALERT_FILE"' EXIT
export ALERT_FILE
ALERT_KEYS=$(python3 - "$NOW" "$ALERT_COOLDOWN_S" "${BREACHES[@]+"${BREACHES[@]}"}" <<'EOF'
import json, os, sys
state_file = os.environ["STATE_FILE"]
now, cooldown = int(sys.argv[1]), int(sys.argv[2])
breaches = [b.split("|", 1) for b in sys.argv[3:]]
try:
    with open(state_file) as f: state = json.load(f)
except Exception: state = {}
last = state.get("last_alert", {})
lines, keys = [], []
for key, msg in breaches:
    if now - int(last.get(key, 0)) >= cooldown and key not in keys:
        lines.append(f"- {msg}")
        keys.append(key)
state["log_off"] = int(os.environ["LOG_SIZE"])
state["err_off"] = int(os.environ["ERR_SIZE"])
state["restarts"] = int(os.environ["RESTARTS"])
os.makedirs(os.path.dirname(state_file), exist_ok=True)
with open(state_file, "w") as f: json.dump(state, f)
with open(os.environ["ALERT_FILE"], "w") as f: f.write("\n".join(lines))
print(" ".join(keys))
EOF
)
ALERT_LINES=$(cat "$ALERT_FILE")

# Stamp the cooldown for the keys we just delivered. Called ONLY on the success
# path; every early exit above and the send failing under `set -e` leave
# `last_alert` untouched, so the next run re-alerts instead of going quiet.
stamp_alert_cooldown() {
  [ -n "$ALERT_KEYS" ] || return 0
  python3 - "$NOW" $ALERT_KEYS <<'EOF'
import json, os, sys
state_file = os.environ["STATE_FILE"]
now, keys = int(sys.argv[1]), sys.argv[2:]
try:
    with open(state_file) as f: state = json.load(f)
except Exception: state = {}
last = state.get("last_alert", {})
for key in keys: last[key] = now
state["last_alert"] = last
with open(state_file, "w") as f: json.dump(state, f)
EOF
}

if [ ${#BREACHES[@]} -eq 0 ]; then
  echo "health-sentinel: all vitals OK (load15=$LOAD15 disk=${DISK_PCT:-?}% service=$SERVICE_STATE)"
  exit 0
fi
if [ -z "$ALERT_LINES" ]; then
  echo "health-sentinel: breach(es) present but within alert cooldown — not re-notifying"
  exit 0
fi

# ── resolve owner DM and send (same protocol as check-onecli-drift.sh) ──────
ADMIN_DM_ROW="$(node_modules/.bin/tsx scripts/q.ts "$NANOCLAW_DIR/data/v2.db" "
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
  echo "health-sentinel: BREACH but cannot resolve owner DM:" >&2
  echo "$ALERT_LINES" >&2
  exit 1
fi

NOTIFICATION="⚠️ Host health alert ($(date '+%H:%M %Z')):
$ALERT_LINES

Triage: logs/nanoclaw.error.log first, then \`pnpm exec tsx scripts/host-health.ts\`. Recovery-storm playbook: memory project_recovery_storm_architecture_fix."

export NOTIFICATION ADMIN_DM_CHANNEL_TYPE ADMIN_DM_PLATFORM_ID CLI_SOCK
python3 <<'EOF'
import json, os, socket, time
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["CLI_SOCK"])
payload = json.dumps({
    "text": os.environ["NOTIFICATION"],
    "senderId": "system:health-sentinel",
    "sender": "Host Health Sentinel",
    "to": {
        "channelType": os.environ["ADMIN_DM_CHANNEL_TYPE"],
        "platformId": os.environ["ADMIN_DM_PLATFORM_ID"],
        "threadId": os.environ["ADMIN_DM_PLATFORM_ID"],
    },
}) + "\n"
sock.sendall(payload.encode("utf-8"))
time.sleep(0.5)
sock.close()
print("health-sentinel: alert delivered to owner DM")
EOF
stamp_alert_cooldown
