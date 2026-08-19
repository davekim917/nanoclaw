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
#   8. graph       — Graphify not indexing: watchers degraded, scheduler stuck
#                    with pending work, index past the catastrophic ceiling, or
#                    the daemon unreachable. Transient conditions must hold on
#                    two consecutive runs, because the gap between reconcile
#                    passes looks identical to a stuck scheduler.
#
# Log windows are measured by BYTE OFFSET deltas stored in the state file —
# never by log timestamps (the log has multiple writers stamping different
# timezones, and no dates; offset deltas are the only honest window).
#
# Per-vital alert dedup: 6h cooldown, so a sustained breach nags at most 4x/day.
#
# Manual run:   bash scripts/health-sentinel.sh
# Test the DM:  TEST_ALERT=1 bash scripts/health-sentinel.sh
# Test graph:   GRAPH_FORCE_STALL=1 bash scripts/health-sentinel.sh   (twice — two-run gate)

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
# Graph staleness. Bare lag is NOT a health signal on its own: lagMs is time
# since the last completed scan, so it saw-tooths with the scan cadence on a
# perfectly healthy workgroup. Only lag *with pending work and nothing running*
# means the scheduler is stuck. The ceiling is the catastrophic backstop for
# "something is reconciling forever and never finishing".
GRAPH_LAG_MAX_MS=${GRAPH_LAG_MAX_MS:-7200000}       # 2h
GRAPH_LAG_CEILING_MS=${GRAPH_LAG_CEILING_MS:-93600000}  # 26h
GRAPH_SOCK="$NANOCLAW_DIR/data/graphify/graphify.sock"
GRAPH_WG_DIR="$NANOCLAW_DIR/data/graphify/workgroups"

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
# Transient graph conditions must hold on TWO consecutive runs before alerting.
# Both are live-observed on a healthy fleet: the gap between reconcile passes
# looks exactly like "pending work, nothing running", and a large index under
# load can close the socket with a zero-byte reply.
PREV_GRAPH_PENDING=$(get_state graph_pending "")

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

# Graphify indexing liveness. Everything below degrades rather than aborts: a
# vital that dies when the thing it watches breaks would take the other seven
# down with it, AND skip the offset persist below, double-counting the next log
# window into false stalls/recovery breaches.
GRAPH_PENDING=""
GRAPH_OUT=$(
  GRAPH_SOCK="$GRAPH_SOCK" GRAPH_WG_DIR="$GRAPH_WG_DIR" \
  GRAPH_LAG_MAX_MS="$GRAPH_LAG_MAX_MS" GRAPH_LAG_CEILING_MS="$GRAPH_LAG_CEILING_MS" \
  PREV_GRAPH_PENDING="$PREV_GRAPH_PENDING" GRAPH_FORCE_STALL="${GRAPH_FORCE_STALL:-0}" \
  python3 - <<'PYEOF' 2>/dev/null
import glob, json, os, socket

sock_path = os.environ["GRAPH_SOCK"]
lag_max = int(os.environ["GRAPH_LAG_MAX_MS"])
lag_ceiling = int(os.environ["GRAPH_LAG_CEILING_MS"])
prev_pending = set(filter(None, os.environ.get("PREV_GRAPH_PENDING", "").split(",")))
# Test knob. The stuck-scheduler clause needs pending work AND nothing
# running AND stale — a live fleet flips the middle term between runs, so a
# threshold alone cannot deterministically exercise the two-run path.
force_stall = os.environ.get("GRAPH_FORCE_STALL", "0") == "1"


def ask(workgroup):
    """(kind, freshness). kind: reachable | unknown | unreachable. Never raises."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(20)
    raw = b""
    try:
        client.connect(sock_path)
        request = {"id": "1", "workgroupId": workgroup, "command": "status", "args": {}}
        client.sendall((json.dumps(request) + "\n").encode("utf-8"))
        while not raw.endswith(b"\n"):
            chunk = client.recv(65536)
            if not chunk:
                break
            raw += chunk
    except socket.timeout:
        # The daemon is alive and busy, not gone. A large index under load can
        # take tens of seconds to answer; calling that "unreachable" would alert
        # on ordinary work. Genuine unavailability shows up as a connect error.
        return ("busy", None)
    except Exception:
        return ("unreachable", None)
    finally:
        try:
            client.close()
        except Exception:
            pass
    if not raw.strip():
        return ("unreachable", None)
    try:
        reply = json.loads(raw.decode("utf-8").splitlines()[0])
    except Exception:
        return ("unreachable", None)
    if not reply.get("ok"):
        # A stale index directory for a deleted workgroup. Skipping is load
        # bearing: there are more directories than workgroups, and treating
        # these as breaches would DM the owner every run, forever.
        if "unknown workgroup" in str(reply.get("error", "")):
            return ("unknown", None)
        return ("unreachable", None)
    try:
        return ("reachable", reply["data"]["freshness"])
    except Exception:
        return ("unreachable", None)


ids = sorted(
    os.path.basename(path.rstrip("/"))
    for path in glob.glob(os.path.join(os.environ["GRAPH_WG_DIR"], "*", ""))
)
breaches, unreachable, degraded, ceiling = [], [], [], []
served = 0
any_dirty, any_reconciling = False, False
# Two different lags. `dirty_lag` drives the stuck-scheduler clause and must be
# measured only on workgroups that actually have pending work — a clean
# workgroup sitting at 5h between scans is healthy and must not make a
# different workgroup's 10-minute backlog look stuck. `max_lag` spans
# everything, because the catastrophic ceiling is a global statement.
dirty_lag, max_lag = 0, 0

for workgroup in ids:
    kind, freshness = ask(workgroup)
    if kind in ("unknown", "busy"):
        continue
    if kind == "unreachable":
        unreachable.append(workgroup)
        continue
    served += 1
    if freshness.get("watcherDegraded"):
        degraded.append(workgroup)
    if freshness.get("dirty"):
        any_dirty = True
    if freshness.get("reconciling"):
        any_reconciling = True
    # A workgroup that has never completed a scan reports lag MAX_SAFE_INTEGER.
    # While its first index is actually running that is not staleness.
    if not freshness.get("lastCompletedAt") and freshness.get("reconciling"):
        continue
    lag = int(freshness.get("lagMs") or 0)
    max_lag = max(max_lag, lag)
    if freshness.get("dirty"):
        dirty_lag = max(dirty_lag, lag)
    if lag > lag_ceiling:
        ceiling.append(workgroup)

pending = set()
if ids and unreachable:
    pending.add("unreachable")
# A daemon that accepts connections and never answers is skipped per workgroup
# as "busy" — correct for one large index under load, but if NOTHING answers
# there is no lag data either, so no other clause can ever fire. That state is
# a hang, and it must not be silent.
if ids and served == 0:
    pending.add("unserved")
stalled = force_stall or (any_dirty and not any_reconciling and dirty_lag > lag_max)
if stalled:
    pending.add("stalled")

if not ids:
    breaches.append("graph|Graphify has no workgroup index directories — it has never indexed anything")
if "unserved" in pending and "unserved" in prev_pending:
    breaches.append(
        "graph|Graphify answered no workgroup status on two consecutive checks — daemon hung or down"
    )
if "unreachable" in pending and "unreachable" in prev_pending:
    breaches.append("graph|Graphify daemon unreachable for %d workgroup(s) on two consecutive checks" % len(unreachable))
if degraded:
    breaches.append(
        "graph-watcher|Graphify filesystem watchers degraded for %d workgroup(s) — index coverage is "
        "incomplete until the daemon is restarted" % len(degraded)
    )
if "stalled" in pending and "stalled" in prev_pending:
    breaches.append(
        "graph-stalled|Graphify has pending work and nothing is reconciling (oldest pending %.1fh) — scheduler stuck"
        % (dirty_lag / 3600000.0)
    )
if ceiling:
    breaches.append(
        "graph-ceiling|Graphify index older than %.0fh for %d workgroup(s)"
        % (lag_ceiling / 3600000.0, len(ceiling))
    )

for breach in breaches:
    print(breach)
print("GRAPH_PENDING=" + ",".join(sorted(pending)))
PYEOF
) || GRAPH_OUT="graph|Graphify health check could not run"

while IFS= read -r GRAPH_LINE; do
  case "$GRAPH_LINE" in
    GRAPH_PENDING=*) GRAPH_PENDING="${GRAPH_LINE#GRAPH_PENDING=}" ;;
    "") ;;
    *) BREACHES+=("$GRAPH_LINE") ;;
  esac
done <<< "$GRAPH_OUT"

if [ "${TEST_ALERT:-0}" = "1" ]; then
  BREACHES+=("test|test alert requested via TEST_ALERT=1 — delivery path verified, no action needed")
fi

# ── dedup + persist state ───────────────────────────────────────────────────
export STATE_FILE LOG_SIZE ERR_SIZE RESTARTS GRAPH_PENDING
ALERT_LINES=$(python3 - "$NOW" "$ALERT_COOLDOWN_S" "${BREACHES[@]+"${BREACHES[@]}"}" <<'EOF'
import json, os, sys
state_file = os.environ["STATE_FILE"]
now, cooldown = int(sys.argv[1]), int(sys.argv[2])
breaches = [b.split("|", 1) for b in sys.argv[3:]]
try:
    with open(state_file) as f: state = json.load(f)
except Exception: state = {}
last = state.get("last_alert", {})
out = []
for key, msg in breaches:
    if now - int(last.get(key, 0)) >= cooldown:
        out.append(f"- {msg}")
        last[key] = now
state["last_alert"] = last
state["log_off"] = int(os.environ["LOG_SIZE"])
state["err_off"] = int(os.environ["ERR_SIZE"])
state["restarts"] = int(os.environ["RESTARTS"])
state["graph_pending"] = os.environ.get("GRAPH_PENDING", "")
os.makedirs(os.path.dirname(state_file), exist_ok=True)
with open(state_file, "w") as f: json.dump(state, f)
print("\n".join(out))
EOF
)

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
