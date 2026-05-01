#!/bin/bash
# One-shot post-merge soak verification, fired by systemd timer
# merge-soak-check.timer on 2026-05-15.
#
# Inspects bytes appended to logs/nanoclaw.error.log + logs/nanoclaw.log since
# the merge baseline (data/soak-check-baseline-2026-05-01.txt). Counts hits for
# four signal sets tied to upstream/main features the merge introduced, then
# DMs Dave a one-paragraph verdict via the CLI socket (same path as
# scripts/check-onecli-drift.sh). Disables its own timer at the end.
#
# Manual run:  sudo bash scripts/check-merge-soak.sh
set -euo pipefail

NANOCLAW_DIR="/home/ubuntu/nanoclaw-v2"
cd "$NANOCLAW_DIR"

BASELINE_FILE="$NANOCLAW_DIR/data/soak-check-baseline-2026-05-01.txt"
ERROR_LOG="$NANOCLAW_DIR/logs/nanoclaw.error.log"
INFO_LOG="$NANOCLAW_DIR/logs/nanoclaw.log"
CLI_SOCK="$NANOCLAW_DIR/data/cli.sock"
ADMIN_USER_ID="discord:608746260706361344"

# ── Resolve admin DM ──
ADMIN_DM_PLATFORM_ID="$(sqlite3 "$NANOCLAW_DIR/data/v2.db" "
  SELECT platform_id FROM messaging_groups
  WHERE id = (SELECT messaging_group_id FROM user_dms WHERE user_id = '$ADMIN_USER_ID' AND channel_type = 'discord' LIMIT 1)
")"
if [ -z "$ADMIN_DM_PLATFORM_ID" ]; then
  echo "soak-check: cannot resolve admin DM (user_dms row missing for $ADMIN_USER_ID)" >&2
  exit 1
fi

# ── Load baseline offsets ──
if [ ! -f "$BASELINE_FILE" ]; then
  echo "soak-check: baseline file missing at $BASELINE_FILE — cannot compute since-merge slice" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$BASELINE_FILE"

# ── Slice each log to bytes since baseline ──
slice_log() {
  local file="$1"
  local offset="$2"
  if [ ! -f "$file" ]; then
    return
  fi
  local size
  size=$(stat -c '%s' "$file")
  if [ "$size" -lt "$offset" ]; then
    # Rotation or truncation since baseline — fall back to whole file
    echo "WARN: $file shrunk since baseline (size=$size offset=$offset); reading entire file" >&2
    cat "$file"
  else
    tail -c "+$((offset + 1))" "$file"
  fi
}

ERROR_SLICE="$(slice_log "$ERROR_LOG" "$ERROR_LOG_OFFSET")"
INFO_SLICE="$(slice_log "$INFO_LOG" "$INFO_LOG_OFFSET")"

# ── Signal-set greps ──
count() {
  local pattern="$1"
  local body="$2"
  if [ -z "$body" ]; then
    echo 0
    return
  fi
  echo "$body" | grep -ciE "$pattern" || true
}

# (a) channel-approval interactive flow
A_PAT='requestChannelApproval|buildAgentSelectionOptions|createNewAgentGroup|CHOOSE_EXISTING_VALUE|NEW_AGENT_VALUE|CONNECT_PREFIX|Channel registration'
# (b) upstream openInboundDb fresh-open path
B_PAT='Cannot use a closed database|unable to open database file|inbound\.db'
# (c) upstream attachment-safety path
C_PAT='Refused unsafe attachment filename|Rejecting unsafe inbound message id|isSafeAttachmentName'
# (d) circuit-breaker startup gate
D_PAT='circuit breaker|enforceStartupBackoff|resetCircuitBreaker'

A_ERR=$(count "$A_PAT" "$ERROR_SLICE")
B_ERR=$(count "$B_PAT" "$ERROR_SLICE")
C_ERR=$(count "$C_PAT" "$ERROR_SLICE")
D_ERR=$(count "$D_PAT" "$ERROR_SLICE")

# Generic error/warn counts in the slice
TOTAL_ERR_LINES=$(printf '%s\n' "$ERROR_SLICE" | grep -c . || true)
INFO_WARN_COUNT=$(printf '%s\n' "$INFO_SLICE" | grep -ciE 'WARN|ERROR' || true)

# ── Pull up to 6 representative excerpts (any signal hit > 0) ──
EXCERPTS=""
if [ "$((A_ERR + B_ERR + C_ERR + D_ERR))" -gt 0 ]; then
  EXCERPTS=$(printf '%s\n' "$ERROR_SLICE" \
    | grep -iE "$A_PAT|$B_PAT|$C_PAT|$D_PAT" \
    | head -6 \
    | sed 's/^/    /' || true)
fi

# ── Verdict ──
TOTAL_HITS=$((A_ERR + B_ERR + C_ERR + D_ERR))
if [ "$TOTAL_HITS" -eq 0 ]; then
  VERDICT="✅ Clean — 2-week soak after upstream/main merge (b407a10) shows zero errors in the four merge-tied signal sets across $TOTAL_ERR_LINES error-log lines and $INFO_WARN_COUNT WARN/ERROR lines in nanoclaw.log."
else
  VERDICT="⚠ Soak after upstream/main merge (b407a10) found $TOTAL_HITS merge-tied errors over 2 weeks: (a) channel-approval=$A_ERR, (b) inbound.db fresh-open=$B_ERR, (c) attachment-safety=$C_ERR, (d) circuit-breaker=$D_ERR. Total error-log lines since merge: $TOTAL_ERR_LINES."
fi

NOTIFICATION="System notification (post-merge soak check, 2026-05-15): $VERDICT"
if [ -n "$EXCERPTS" ]; then
  NOTIFICATION="$NOTIFICATION

Sample matches:
\`\`\`
$EXCERPTS
\`\`\`"
fi

echo "soak-check: verdict computed"
echo "  A (channel-approval):  $A_ERR"
echo "  B (inbound.db open):   $B_ERR"
echo "  C (attachment-safety): $C_ERR"
echo "  D (circuit-breaker):   $D_ERR"
echo "  Total err-log lines:   $TOTAL_ERR_LINES"
echo "  Info-log WARN/ERROR:   $INFO_WARN_COUNT"

# ── Deliver via CLI socket (same protocol as drift-check) ──
NOTIFICATION="$NOTIFICATION" ADMIN_DM_PLATFORM_ID="$ADMIN_DM_PLATFORM_ID" \
CLI_SOCK="$CLI_SOCK" python3 - <<'PYEOF'
import json, os, socket, time
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["CLI_SOCK"])
payload = json.dumps({
    "text": os.environ["NOTIFICATION"],
    "senderId": "system:merge-soak-check",
    "sender": "Merge Soak Check",
    "to": {
        "channelType": "discord",
        "platformId": os.environ["ADMIN_DM_PLATFORM_ID"],
        "threadId": os.environ["ADMIN_DM_PLATFORM_ID"],
    },
}) + "\n"
sock.sendall(payload.encode("utf-8"))
time.sleep(0.5)
sock.close()
print("soak-check: notification delivered to admin DM")
PYEOF

# ── Self-disable: this timer is one-shot, no point keeping it armed ──
sudo systemctl disable merge-soak-check.timer 2>&1 || true
echo "soak-check: timer disabled, work complete"
