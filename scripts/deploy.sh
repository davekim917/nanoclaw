#!/usr/bin/env bash
# Self-deploy: pull latest main, build host, rebuild container image if
# container/ changed, restart service.
# Spawned detached so it survives the systemctl restart.
# Writes JSON status to logs/deploy-status.json so the post-restart
# process can announce the result.

REPO_ROOT="${NANOCLAW_DEPLOY_ROOT:-/home/ubuntu/nanoclaw-v2}"
cd "$REPO_ROOT" || exit 1

STATUS_FILE="logs/deploy-status.json"
LOG="logs/deploy.log"
POST_PULL="${NANOCLAW_DEPLOY_POST_PULL:-0}"
PRE_COMMIT="${NANOCLAW_DEPLOY_PRE_COMMIT:-}"
ROLLBACK_READY=0
DEPLOY_HANDOFF=0
IMAGE_SAVED_BASE=""

write_status() {
  local status="$1" step="$2" error="$3"
  printf '{"status":"%s","step":"%s","error":"%s","timestamp":"%s"}\n' \
    "$status" "$step" "$error" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$STATUS_FILE"
}

tracked_changes() {
  [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]
}

snapshot_dir() {
  local name="$1" tmp="${1}.pre-deploy.tmp"
  [ -d "$name" ] || return 1
  rm -rf "$tmp" || return 1
  cp -al "$name" "$tmp" >> "$LOG" 2>&1 || {
    rm -rf "$tmp"
    return 1
  }
  rm -rf "${name}.pre-deploy" || {
    rm -rf "$tmp"
    return 1
  }
  mv "$tmp" "${name}.pre-deploy"
}

restore_before_restart() {
  local exit_code="$?" restored=""
  trap - EXIT HUP INT TERM

  if [ "$ROLLBACK_READY" != "1" ] || [ "$DEPLOY_HANDOFF" = "1" ]; then
    exit "$exit_code"
  fi

  # The service is still running the old build. Put its on-disk artifacts back
  # immediately so an unrelated restart cannot turn a failed deploy into an
  # outage, and so a retry snapshots the last healthy build rather than debris.
  for name in dist node_modules; do
    if [ -d "${name}.pre-deploy" ]; then
      rm -rf "${name}.failed-deploy"
      if [ -d "$name" ] && ! mv "$name" "${name}.failed-deploy"; then
        echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Could not move failed ${name}; healthy snapshot left intact" >> "$LOG"
        continue
      fi
      if mv "${name}.pre-deploy" "$name"; then
        restored="${restored}${name} "
        rm -rf "${name}.failed-deploy"
      else
        # Do not leave the live path absent if the snapshot rename fails.
        [ -d "${name}.failed-deploy" ] && mv "${name}.failed-deploy" "$name"
      fi
    fi
  done

  # Never erase provider/channel customizations or another concurrent edit.
  # The restored dist is sufficient to boot the healthy service; source reset
  # is only safe when the tracked checkout is still clean.
  if tracked_changes; then
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Pre-restart rollback preserved tracked source changes; commit reset skipped" >> "$LOG"
  elif git reset --hard "$PRE_COMMIT" >> "$LOG" 2>&1; then
    restored="${restored}commit ${PRE_COMMIT:0:8} "
  fi

  if [ -n "$IMAGE_SAVED_BASE" ]; then
    docker tag "${IMAGE_SAVED_BASE}:pre-deploy" "${IMAGE_SAVED_BASE}:latest" >> "$LOG" 2>&1 || true
  fi
  rm -f data/deploy-rollback.json data/deploy-boot-attempts.json
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Pre-restart rollback restored ${restored:-nothing}" >> "$LOG"
  exit "$exit_code"
}

trap restore_before_restart EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$POST_PULL" != "1" ]; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Deploy started" >> "$LOG"
  write_status "running" "preflight" ""

  # Automatic rollback uses git reset. Refuse before mutating anything when
  # tracked customizations exist; silently deleting them is never an option.
  if tracked_changes; then
    write_status "failed" "preflight" "tracked source changes present — commit or stash them before /deploy"
    exit 1
  fi

  if ! git checkout main >> "$LOG" 2>&1; then
    write_status "failed" "git checkout" "checkout failed — check deploy.log"
    exit 1
  fi

  # Capture and verify the last healthy on-disk build BEFORE git pull or pnpm
  # touches it. A failed pre-restart deploy restores these snapshots immediately.
  PRE_COMMIT="${PRE_COMMIT:-$(git rev-parse HEAD)}"
  write_status "running" "rollback snapshot" ""
  if ! snapshot_dir node_modules || ! snapshot_dir dist; then
    rm -rf node_modules.pre-deploy.tmp dist.pre-deploy.tmp
    write_status "failed" "rollback snapshot" "could not snapshot dist and node_modules — live artifacts were not changed"
    exit 1
  fi
  ROLLBACK_READY=1

  write_status "running" "git pull" ""
  if ! git pull --ff-only origin main >> "$LOG" 2>&1; then
    write_status "failed" "git pull" "fast-forward pull failed — check deploy.log"
    exit 1
  fi

  # Bash keeps reading the already-open script after git replaces it. Re-exec
  # the freshly pulled copy so the deployment always uses the code it installs.
  exec env \
    NANOCLAW_DEPLOY_POST_PULL=1 \
    NANOCLAW_DEPLOY_PRE_COMMIT="$PRE_COMMIT" \
    NANOCLAW_DEPLOY_ROOT="$REPO_ROOT" \
    bash scripts/deploy.sh
fi

if ! [[ "$PRE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || [ ! -d node_modules.pre-deploy ] || [ ! -d dist.pre-deploy ]; then
  write_status "failed" "rollback snapshot" "post-pull deploy is missing a valid rollback commit or snapshots"
  exit 1
fi
ROLLBACK_READY=1

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
  # Keep the current spawn image reachable for the crash guard's rollback:
  # the rebuild replaces :latest, so retag it first. Record that THIS deploy
  # saved it — the guard must never retag a stale tag from an older deploy.
  if docker inspect "$SPAWN_IMAGE" >/dev/null 2>&1; then
    if ! docker tag "$SPAWN_IMAGE" "$(container_image_base):pre-deploy" >> "$LOG" 2>&1; then
      write_status "failed" "container snapshot" "could not preserve the current agent image — build not started"
      exit 1
    fi
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
if tracked_changes; then
  write_status "failed" "pre-restart" "tracked source changed during deploy — restart refused to preserve customizations"
  exit 1
fi
if [ -z "$MIGRATION_CHANGES" ]; then
  mkdir -p data
  printf '{"commit":"%s","imageBase":"%s","timestamp":"%s","node":"%s"}\n' \
    "$PRE_COMMIT" "${IMAGE_SAVED_BASE}" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$(node --version 2>/dev/null)" > data/deploy-rollback.json
else
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Crash guard NOT armed: deploy ships migrations ($(echo "$MIGRATION_CHANGES" | head -3 | tr '\n' ' '))" >> "$LOG"
  rm -f data/deploy-rollback.json
fi

# Write success status BEFORE restart — systemctl restart kills this script's
# process group, so lines after don't run. The new process reads this file
# on startup to announce the result.
write_status "ok" "done" ""
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Deploy complete" >> "$LOG"

DEPLOY_HANDOFF=1
if ! sudo systemctl restart nanoclaw-v2 >> "$LOG" 2>&1; then
  DEPLOY_HANDOFF=0
  write_status "failed" "restart" "systemctl restart failed — restored the previous build"
  exit 1
fi
