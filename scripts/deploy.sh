#!/usr/bin/env bash
# Self-deploy: pull latest main, build host, rebuild container image if
# container/ changed, restart service.
# Spawned detached so it survives the systemctl restart.
# Writes JSON status to logs/deploy-status.json so the post-restart
# process can announce the result.

cd /home/ubuntu/nanoclaw-v2

STATUS_FILE="logs/deploy-status.json"
LOG="logs/deploy.log"

write_status() {
  local status="$1" step="$2" error="$3"
  printf '{"status":"%s","step":"%s","error":"%s","timestamp":"%s"}\n' \
    "$status" "$step" "$error" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$STATUS_FILE"
}

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Deploy started" >> "$LOG"
write_status "running" "git pull" ""

if ! git checkout dave/migration >> "$LOG" 2>&1; then
  write_status "failed" "git checkout" "checkout failed — check deploy.log"
  exit 1
fi

if ! git pull origin dave/migration >> "$LOG" 2>&1; then
  write_status "failed" "git pull" "pull failed — local changes or merge conflict"
  exit 1
fi

write_status "running" "build" ""
if ! npm run build >> "$LOG" 2>&1; then
  write_status "failed" "build" "TypeScript build failed"
  exit 1
fi

# Rebuild container image if any container/ files changed since the image
# was last built. Compare image creation time to git history for container/.
IMAGE_CREATED=$(docker inspect nanoclaw-agent:v2 --format '{{.Created}}' 2>/dev/null | cut -d. -f1 | tr 'T' ' ')
if [ -n "$IMAGE_CREATED" ]; then
  CONTAINER_CHANGES=$(git diff --name-only "$(git log -1 --before="$IMAGE_CREATED" --format=%H)" HEAD -- container/ 2>/dev/null)
else
  CONTAINER_CHANGES="no-image"
fi
if [ -n "$CONTAINER_CHANGES" ]; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Container files changed, rebuilding image..." >> "$LOG"
  write_status "running" "container build" ""
  if ! ./container/build.sh v2 >> "$LOG" 2>&1; then
    write_status "failed" "container build" "Container image build failed"
    exit 1
  fi
fi

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Build complete, restarting..." >> "$LOG"

# Write success status BEFORE restart — systemctl restart kills this script's
# process group, so lines after don't run. The new process reads this file
# on startup to announce the result.
write_status "ok" "done" ""
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Deploy complete" >> "$LOG"

sudo systemctl restart nanoclaw-v2 >> "$LOG" 2>&1
