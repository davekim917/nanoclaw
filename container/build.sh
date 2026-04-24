#!/bin/bash
# Build the NanoClaw agent container image.
#
# Reads one optional build flag from ../.env:
#   INSTALL_CJK_FONTS=true   — add Chinese/Japanese/Korean fonts (~200MB)
# setup/container.ts reads the same file, so both build paths stay in sync.
# Callers can also override by exporting INSTALL_CJK_FONTS directly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Derive the image name from the project root so two NanoClaw installs on the
# same host don't overwrite each other's `nanoclaw-agent:latest` tag. Matches
# setup/lib/install-slug.sh + src/install-slug.ts.
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE_NAME="$(container_image_base)"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Full image ref. When the rebuild watcher invokes us it passes
# CONTAINER_IMAGE_REF so the image we build matches the one container-runner
# spawns from (src/config.ts::CONTAINER_IMAGE). Without that, build.sh would
# derive its own `<base>:<tag>` and drift if CONTAINER_IMAGE is overridden.
# Standalone CLI callers (no env var) fall back to derived $IMAGE_NAME:$TAG.
IMAGE_REF="${CONTAINER_IMAGE_REF:-${IMAGE_NAME}:${TAG}}"

# Caller's env takes precedence; fall back to .env.
if [ -z "${INSTALL_CJK_FONTS:-}" ] && [ -f "../.env" ]; then
    INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi

BUILD_ARGS=()
if [ "${INSTALL_CJK_FONTS:-false}" = "true" ]; then
    echo "CJK fonts: enabled (adds ~200MB)"
    BUILD_ARGS+=(--build-arg INSTALL_CJK_FONTS=true)
fi

# Stamp the repo's current commit SHA into the image as a LABEL driven by
# ARG. Lets the rebuild watcher compare the running image against origin/main
# via `docker inspect ... Labels.nanoclaw.commit`. Must be ARG+LABEL (a real
# Dockerfile layer) rather than a bare `docker build --label`, because when
# all previous layers are cache-hits Docker skips applying `--label` to the
# resulting image — trapping the watcher in an infinite rebuild loop on any
# runtime-mounted source edit (container/agent-runner/src/**).
NANOCLAW_COMMIT="$(cd "$PROJECT_ROOT" && git rev-parse HEAD 2>/dev/null || echo unknown)"
BUILD_ARGS+=(--build-arg "NANOCLAW_COMMIT=${NANOCLAW_COMMIT}")

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_REF} (commit ${NANOCLAW_COMMIT})"

${CONTAINER_RUNTIME} build "${BUILD_ARGS[@]}" -t "${IMAGE_REF}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_REF}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_REF}"
