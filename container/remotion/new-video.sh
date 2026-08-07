#!/bin/bash
# Scaffold a Remotion project from the shared runtime baked at /opt/remotion.
#
# node_modules is SYMLINKED, not copied — the tree is ~300MB and copying it per
# video would cost more than the render. That also means the runtime is shared
# and read-only: add project-specific packages by installing into your own
# project dir, never by writing into /opt/remotion.
#
# Usage: new-video.sh <target-dir>
#   new-video.sh /workspace/agent/product-demo
set -euo pipefail

RUNTIME="${REMOTION_RUNTIME:-/opt/remotion}"
TARGET="${1:-}"

if [ -z "$TARGET" ]; then
    echo "usage: new-video.sh <target-dir>" >&2
    exit 1
fi
if [ ! -d "$RUNTIME/node_modules" ]; then
    echo "Remotion runtime not found at $RUNTIME — is this the agent image?" >&2
    exit 1
fi
if [ -e "$TARGET" ]; then
    echo "refusing to overwrite existing path: $TARGET" >&2
    exit 1
fi

mkdir -p "$TARGET"
cp -r "$RUNTIME/src" "$TARGET/src"
cp -r "$RUNTIME/public" "$TARGET/public"
cp "$RUNTIME/package.json" "$RUNTIME/tsconfig.json" "$RUNTIME/remotion.config.ts" "$TARGET/"

# node_modules is a REAL directory of symlinks, not one symlink to the shared
# tree. The packages stay shared (no ~300MB copy), but the directory itself is
# writable — which webpack needs, because it writes its build cache to
# node_modules/.cache. A single symlink into the root-owned runtime makes that
# mkdir fail with EACCES, and the render then silently rebuilds from scratch
# every time.
mkdir -p "$TARGET/node_modules"
find "$RUNTIME/node_modules" -maxdepth 1 -mindepth 1 -exec ln -s {} "$TARGET/node_modules/" \;

cat <<EOF
Scaffolded $TARGET

Two compositions are registered:

  Demo       runtime smoke test — render this FIRST
  DemoVideo  data-driven product demo, driven by src/demo/timeline.json

  cd $TARGET
  npx remotion render src/index.ts Demo out.mp4        # proves the toolchain
  npx remotion render src/index.ts DemoVideo demo.mp4  # renders the timeline

If the smoke test produces an mp4, the runtime is fine and any later failure is
your composition or your timeline.

To build a real demo: put full-resolution screenshots in public/shots/, describe
them in src/demo/timeline.json (one entry per step, with the element rect from
\`agent-browser get box <sel> --json\`), then render DemoVideo. Duration follows
the timeline — you do not edit Root.tsx.
EOF
