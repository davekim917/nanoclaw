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

# The running service passes its absolute Node executable. Check that exact path,
# not whichever `node` an interactive shell happens to resolve, before changing
# the checkout or dependency tree. A missing path fails closed rather than
# validating a different runtime by accident.
NODE_BIN="${NANOCLAW_NODE_BIN:-}"
write_status "running" "node runtime" ""
if [ -z "$NODE_BIN" ]; then
  ERROR="service Node runtime path not supplied; deploy must be launched by NanoClaw"
  write_status "failed" "node runtime" "$ERROR"
  echo "$ERROR" >&2
  exit 1
fi
NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || true)"
if [ ! -x "$NODE_BIN" ] || ! "$NODE_BIN" scripts/check-node-version.mjs "$NODE_VERSION" >> "$LOG" 2>&1; then
  ERROR="unsupported Node service runtime at ${NODE_BIN} (${NODE_VERSION:-not found}); requires >=22.19.0"
  write_status "failed" "node runtime" "$ERROR"
  echo "$ERROR" >&2
  exit 1
fi

write_status "running" "git pull" ""

if ! git checkout main >> "$LOG" 2>&1; then
  write_status "failed" "git checkout" "checkout failed — check deploy.log"
  exit 1
fi

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
if [ -n "$CONTAINER_CHANGES" ]; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Container changed (or image unlabeled), rebuilding ${SPAWN_IMAGE}..." >> "$LOG"
  write_status "running" "container build" ""
  if ! CONTAINER_IMAGE_REF="$SPAWN_IMAGE" ./container/build.sh "$SPAWN_TAG" >> "$LOG" 2>&1; then
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
