#!/bin/bash
# Daily wiki-synth pipeline health check (the tripwire).
#
# The daily wiki-synth task reads mnemon memories and writes wiki pages, which
# scripts/wiki-autopush.sh then commits+pushes to GitHub. If any link in that
# pipeline stalls — a dead synth schedule, a broken pusher, a failing agent —
# wiki entries silently stop being recorded. That happened on 2026-05-10 and
# went undetected for 16 days because nothing watched it. This is the tripwire:
# if NO workgroup wiki has committed within the staleness threshold, DM the
# admin. The end-to-end signal (last commit across ALL wikis) catches every
# failure mode, not just the one that caused the 05-10 incident.
#
# Independent of the host's recurrence engine on purpose: a systemd timer fires
# this even if the host scheduler is the thing that's broken.
#
# Run by systemd timer (/etc/systemd/system/wiki-synth-healthcheck.timer).
# Manual run:        bash scripts/check-wiki-synth-staleness.sh
# Dry (no DM) check: WIKI_SYNTH_STALE_HOURS=100000 bash scripts/check-wiki-synth-staleness.sh
set -euo pipefail

NANOCLAW_DIR="/home/ubuntu/nanoclaw-v2"
cd "$NANOCLAW_DIR"

# Daily synth; commits multiple times/day under normal load. 48h tolerates a
# quiet weekend while still catching a real stall within ~2 days (vs 16). Tune
# via the WIKI_SYNTH_STALE_HOURS env var.
STALE_HOURS="${WIKI_SYNTH_STALE_HOURS:-48}"
CLI_SOCK="$NANOCLAW_DIR/data/cli.sock"
ADMIN_USER_ID="discord:608746260706361344"

now_epoch=$(date -u +%s)
threshold=$(( STALE_HOURS * 3600 ))

# Newest commit (epoch) across every workgroup + group wiki git repo. Covers the
# post-shared-FS layout (data/workgroups/<wg>/wiki) and any non-workgroup group
# wiki; dangling seed symlinks are skipped by the `-d .git` test.
newest=0
newest_repo=""
shopt -s nullglob
for wiki_dir in "$NANOCLAW_DIR"/data/workgroups/*/wiki "$NANOCLAW_DIR"/groups/*/wiki; do
  [[ -d "$wiki_dir/.git" ]] || continue
  ct=$(git -C "$wiki_dir" log -1 --format=%ct 2>/dev/null || echo 0)
  if [[ "$ct" -gt "$newest" ]]; then
    newest="$ct"
    newest_repo="$(basename "$(dirname "$wiki_dir")")"
  fi
done

if [[ "$newest" -eq 0 ]]; then
  echo "wiki-synth-healthcheck: no wiki git repos found — nothing to check" >&2
  exit 0
fi

age_h=$(( (now_epoch - newest) / 3600 ))
echo "wiki-synth-healthcheck: newest wiki commit ${age_h}h ago (repo: ${newest_repo}, threshold ${STALE_HOURS}h)"

if (( now_epoch - newest <= threshold )); then
  echo "wiki-synth-healthcheck: pipeline healthy. Nothing to notify."
  exit 0
fi

# Stale → resolve the admin's Discord DM and notify via the CLI socket.
# Protocol matches scripts/check-onecli-drift.sh / init-first-agent.ts.
ADMIN_DM_PLATFORM_ID="$(sqlite3 "$NANOCLAW_DIR/data/v2.db" "
  SELECT platform_id FROM messaging_groups
  WHERE id = (SELECT messaging_group_id FROM user_dms WHERE user_id = '$ADMIN_USER_ID' AND channel_type = 'discord' LIMIT 1)
")"

if [ -z "$ADMIN_DM_PLATFORM_ID" ]; then
  echo "wiki-synth-healthcheck: STALE (${age_h}h) but cannot resolve admin DM ($ADMIN_USER_ID)" >&2
  exit 1
fi

NOTIFICATION="⚠️ System notification (daily wiki-synth health check): no wiki entries have synced in ${age_h}h — newest commit across all workgroups is ${newest_repo} (alert threshold ${STALE_HOURS}h). The daily synth → wiki pipeline may have stalled. Check the recurring synth tasks (messages_in) and logs/wiki-autopush.log."

echo "wiki-synth-healthcheck: STALE (${age_h}h) — notifying admin via CLI socket"

python3 <<EOF
import json, socket, time
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect("$CLI_SOCK")
payload = json.dumps({
    "text": """$NOTIFICATION""",
    "senderId": "system:wiki-synth-healthcheck",
    "sender": "Wiki Synth Health Check",
    "to": {
        "channelType": "discord",
        "platformId": "$ADMIN_DM_PLATFORM_ID",
        "threadId": "$ADMIN_DM_PLATFORM_ID",
    },
}) + "\n"
sock.sendall(payload.encode("utf-8"))
time.sleep(0.5)  # give the router a beat to read before close
sock.close()
print("wiki-synth-healthcheck: notification delivered to admin DM")
EOF
