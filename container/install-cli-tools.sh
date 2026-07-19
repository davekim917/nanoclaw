#!/bin/sh
# Install the global Node CLIs the agent invokes at runtime, from cli-tools.json.
#
# A skill adds a tool by appending a { "name", "version" } entry to that
# manifest (a json-merge) instead of editing the Dockerfile — the reach-in
# becomes the safest change shape, deterministic and removable.
#
# Every tool is installed via `pnpm install -g`, pinned to an exact version, so
# the pnpm supply-chain policy still applies. Tools with a native postinstall
# set "onlyBuilt": true to opt in to running build scripts (pnpm skips them by
# default). Run as root before `USER node`, so the global pnpm config is root's.
set -eu

MANIFEST="${1:-/tmp/cli-tools.json}"

# Write both approval formats: pnpm 10 global installs still read the legacy
# .npmrc keys; pnpm 11 reads the global allowBuilds YAML map.
ALLOW_BUILDS="$(node -e '
  const tools = require(process.argv[1]);
  const optIns = tools.filter((t) => t.onlyBuilt).map((t) => "only-built-dependencies[]=" + t.name);
  require("fs").writeFileSync("/root/.npmrc", optIns.join("\n") + (optIns.length ? "\n" : ""));
  console.log(JSON.stringify(Object.fromEntries(tools.filter((t) => t.onlyBuilt).map((t) => [t.name, true]))));
' "$MANIFEST")"
pnpm config set --global --json allowBuilds "$ALLOW_BUILDS"

# Install every tool, pinned. name@version specs never contain spaces, so the
# unquoted expansion word-splits cleanly into positional args.
# shellcheck disable=SC2046
set -- $(node -e 'require(process.argv[1]).forEach((t) => console.log(t.name + "@" + t.version))' "$MANIFEST")
if [ "$#" -gt 0 ]; then
  pnpm install -g "$@"
fi
