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

if ! git checkout main >> "$LOG" 2>&1; then
  write_status "failed" "git checkout" "checkout failed — check deploy.log"
  exit 1
fi

# Rollback point for the post-restart crash guard (src/deploy-crash-guard.ts):
# the commit we are on BEFORE the pull is what a rollback restores.
PRE_COMMIT=$(git rev-parse HEAD)

if ! git pull origin main >> "$LOG" 2>&1; then
  write_status "failed" "git pull" "pull failed — local changes or merge conflict"
  exit 1
fi

# Fail fast if the pull advanced package.json past the upgrade marker.
# src/index.ts:145 runs enforceUpgradeTripwire(), which process.exit(1)s when
# data/upgrade-state.json's version != package.json's. Without this gate the
# restart crash-loops AND goes silent: write_status "ok" is written *before*
# the restart, and the "Deploy complete" announcement only fires from a
# successful boot — so Discord reports nothing at all. Catch it here, where
# the poller in the still-alive host process can still report the failure.
write_status "running" "upgrade marker" ""
CODE_VER=$(node -p "require('./package.json').version" 2>/dev/null)
MARKER_VER=$(node -p "require('./data/upgrade-state.json').version" 2>/dev/null)
if [ "$CODE_VER" != "$MARKER_VER" ]; then
  write_status "failed" "upgrade marker" \
    "code ${CODE_VER} != marker ${MARKER_VER:-none} — run /update-nanoclaw (do NOT hand-stamp unless the upgrade really completed)"
  exit 1
fi

# Hardlink snapshots for the crash guard's rollback. cp -al costs seconds and
# no meaningful disk; a rollback restores these by rename, no rebuild needed.
write_status "running" "rollback snapshot" ""
rm -rf node_modules.pre-deploy dist.pre-deploy
[ -d node_modules ] && cp -al node_modules node_modules.pre-deploy >> "$LOG" 2>&1
[ -d dist ] && cp -al dist dist.pre-deploy >> "$LOG" 2>&1

write_status "running" "install" ""
if ! pnpm install --frozen-lockfile >> "$LOG" 2>&1; then
  write_status "failed" "install" "pnpm install failed — check deploy.log"
  exit 1
fi

write_status "running" "build" ""
# `build` is bare `tsc` — it never prunes dist/. A renamed or deleted source
# file leaves an orphan .js behind that the service (ExecStart runs
# dist/index.js) still resolves at runtime. Clean first.
rm -rf dist
if ! pnpm run build >> "$LOG" 2>&1; then
  write_status "failed" "build" "TypeScript build failed"
  exit 1
fi

# Dashboard SPA is a separate Vite project — top-level `pnpm run build` is
# tsc-only. Without this step `/deploy` ships server code with stale SPA
# assets (browser keeps loading the previous bundle hash).
write_status "running" "dashboard build" ""
if ! pnpm run build:dashboard >> "$LOG" 2>&1; then
  write_status "failed" "dashboard build" "Vite SPA build failed"
  exit 1
fi

# Rebuild the container image the host spawns from if any container/ files
# changed since it was built. The host spawns from CONTAINER_IMAGE
# (src/config.ts -> getDefaultContainerImage = <install-slug-base>:latest), so
# we must inspect and rebuild *that exact tag*. The legacy `nanoclaw-agent:v2`
# name used here was wrong on both base (unslugged) and tag (`v2` vs `latest`):
# the inspect always missed -> CONTAINER_CHANGES="no-image" -> a full rebuild
# every deploy, and `build.sh v2` produced a tag nothing ever spawns from, so
# the container rebuild only ever took effect because the rebuild watcher
# (which builds the correct tag) happened to run too. Mirrors the fix already
# in src/container-rebuild-watcher.ts.
PROJECT_ROOT="$(pwd)"
# shellcheck source=setup/lib/install-slug.sh
source "setup/lib/install-slug.sh"
SPAWN_TAG="latest"
SPAWN_IMAGE="$(container_image_base):${SPAWN_TAG}"

# Compare the commit baked into the image (nanoclaw.commit LABEL, stamped by
# container/build.sh) against HEAD. Created-timestamp + `git log --before`
# heuristics are unreliable — Docker reuses an existing image's Created time on
# a full cache hit. Fall back to rebuild whenever the label is missing or its
# commit isn't in local history; never skip the rebuild on uncertainty.
IMAGE_COMMIT=$(docker inspect "$SPAWN_IMAGE" --format '{{index .Config.Labels "nanoclaw.commit"}}' 2>/dev/null)
if [ -n "$IMAGE_COMMIT" ] && git cat-file -e "${IMAGE_COMMIT}^{commit}" 2>/dev/null; then
  CONTAINER_CHANGES=$(git diff --name-only "$IMAGE_COMMIT" HEAD -- container/ 2>/dev/null)
else
  CONTAINER_CHANGES="no-image-or-unlabeled"
fi
IMAGE_SAVED_BASE=""
if [ -n "$CONTAINER_CHANGES" ]; then
  # Keep the current spawn image reachable for the crash guard's rollback:
  # the rebuild replaces :latest, so retag it first. Record that THIS deploy
  # saved it — the guard must never retag a stale tag from an older deploy.
  if docker inspect "$SPAWN_IMAGE" >/dev/null 2>&1; then
    docker tag "$SPAWN_IMAGE" "$(container_image_base):pre-deploy" >> "$LOG" 2>&1
    IMAGE_SAVED_BASE="$(container_image_base)"
  fi
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Container changed (or image unlabeled), rebuilding ${SPAWN_IMAGE}..." >> "$LOG"
  write_status "running" "container build" ""
  if ! CONTAINER_IMAGE_REF="$SPAWN_IMAGE" ./container/build.sh "$SPAWN_TAG" >> "$LOG" 2>&1; then
    write_status "failed" "container build" "Container image build failed"
    exit 1
  fi
fi

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Build complete, restarting..." >> "$LOG"

# Arm the post-restart crash guard (src/deploy-crash-guard.ts). The restart
# kills this script's process group, so nothing HERE can watch the service
# come up — the guard runs inside every boot of the new build instead, and
# this manifest is what tells it a rollback point exists and is fresh.
#
# Two deliberate limits (codex review on PR #180):
# - A deploy that ships new migrations does NOT arm the guard: migrations can
#   be destructive (dropped columns/tables), so restoring old code against the
#   migrated database is worse than the crash loop. Those deploys keep the
#   pre-guard behavior; the operator decides.
# - imageBase is recorded only when THIS deploy retagged :pre-deploy. A stale
#   tag from an earlier deploy must never be retagged over the current image.
MIGRATION_CHANGES=$(git diff --name-only "$PRE_COMMIT" HEAD -- src/db/migrations/ 2>/dev/null)
if [ -z "$MIGRATION_CHANGES" ]; then
  mkdir -p data
  printf '{"commit":"%s","imageBase":"%s","timestamp":"%s"}\n' \
    "$PRE_COMMIT" "${IMAGE_SAVED_BASE}" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > data/deploy-rollback.json
else
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Crash guard NOT armed: deploy ships migrations ($(echo "$MIGRATION_CHANGES" | head -3 | tr '\n' ' '))" >> "$LOG"
  rm -f data/deploy-rollback.json
fi

# Write success status BEFORE restart — systemctl restart kills this script's
# process group, so lines after don't run. The new process reads this file
# on startup to announce the result.
write_status "ok" "done" ""
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Deploy complete" >> "$LOG"

sudo systemctl restart nanoclaw-v2 >> "$LOG" 2>&1
