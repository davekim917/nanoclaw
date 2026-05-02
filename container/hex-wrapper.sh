#!/bin/sh
# Hex CLI wrapper — point the CLI at the mounted host data dir.
# Installed at /usr/local/bin/hex (symlink → this file); real binary at /usr/local/bin/hex-real.
#
# Why a wrapper: nanoclaw's container.json schema has no top-level `env` field
# (per src/container-config.ts), so we can't set XDG_DATA_HOME=/workspace/extra/.local/share
# per-group from JSON. Baking it into the Dockerfile would polute every CLI's
# env. A scoped wrapper keeps the env override local to hex calls.
#
# The CLI uses XDG_DATA_HOME (NOT XDG_CONFIG_HOME) for credentials and config.
# Verified: `path.join(env2.XDG_DATA_HOME || path.join(homedir, ".local", "share"), name)`.
exec env XDG_DATA_HOME=/workspace/extra/.local/share /usr/local/bin/hex-real "$@"
