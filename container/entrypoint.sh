#!/bin/bash
# NanoClaw v2 container entrypoint.
#
# Lean port of v1's entrypoint.sh. Drops the /tmp/input.json + stdin
# secret-injection path (obsolete — v2 uses env vars for tools, OneCLI
# proxy for API credentials). Keeps the pieces that are still structural
# requirements for the agent to function:
#
# - Chromium XDG workaround (without this, long-running sessions crash)
# - gws CLI config dir + wrapper (gws falls back to service-account creds
#   via ADC otherwise, which breaks user-OAuth)
# - GitHub credential helper setup (via gh; git needs this for push/fetch)
# - Render CLI workspace pre-configuration
# - GitNexus repo auto-registration (so code-intel MCP tools work)
#
# All steps are idempotent and best-effort. If a tool isn't installed or
# an env var isn't set, the corresponding step no-ops silently.
set -e

cd /app

# Compile the agent-runner source (mounted from the per-group overlay at
# /app/src). Errors go to stderr so the host's stderr-capture sees them.
npx tsc --outDir /tmp/dist 2>&1 >&2
ln -sf /app/node_modules /tmp/dist/node_modules

# --- Chromium crashpad workaround ---
# crashpad derives its DB path from XDG_CONFIG_HOME. If that dir isn't
# writable (or gets corrupted on long-running containers), chromium
# crashes with "--database is required". Redirect to /tmp so it's
# always writable and ephemeral.
export XDG_CONFIG_HOME=/tmp/.chromium
export XDG_CACHE_HOME=/tmp/.chromium

# --- Residential proxy for geo-fenced browser automation ---
if [ -n "$RESIDENTIAL_PROXY_URL" ]; then
  export AGENT_BROWSER_PROXY="$RESIDENTIAL_PROXY_URL"
fi

# --- GitHub git auth ---
# gh auth setup-git configures git's credential helper to return $GH_TOKEN
# for github.com. Idempotent; runs only when GH_TOKEN is set (container-
# runner sets it when the host has a GitHub token resolved for this group).
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || true
fi

# --- Render CLI workspace pre-config ---
# Render v2 CLI requires an active workspace for service-level commands.
# When RENDER_WORKSPACE_ID + RENDER_API_KEY are set in env, pre-configure
# the workspace so the agent doesn't have to learn the `render workspace
# set` flow.
if [ -n "$RENDER_WORKSPACE_ID" ] && [ -n "$RENDER_API_KEY" ] && command -v render >/dev/null 2>&1; then
  RENDER_API_KEY="$RENDER_API_KEY" render workspace set "$RENDER_WORKSPACE_ID" --confirm >/dev/null 2>&1 \
    && echo "[entrypoint] render workspace pre-configured: $RENDER_WORKSPACE_ID" >&2 \
    || echo "[entrypoint] render workspace set failed (workspace=$RENDER_WORKSPACE_ID)" >&2
fi

# --- Google Workspace CLI (gws) ---
# gws needs a writable config dir for its API discovery cache. Host mount
# at /home/node/.config/gws/accounts/ is RO (credentials) — can't use it
# as the config dir too. Point it at /tmp.
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/.gws
mkdir -p /tmp/.gws

# gws wrapper: strips GOOGLE_APPLICATION_CREDENTIALS before exec. When
# ADC is set (for gcloud/gsutil), gws picks up the service account instead
# of the user's OAuth token, breaking Gmail/Calendar with
# FAILED_PRECONDITION. This wrapper ensures gws only uses
# GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE or per-command overrides.
GWS_BIN=$(command -v gws 2>/dev/null || true)
if [ -n "$GWS_BIN" ]; then
  mkdir -p /tmp/bin
  cat > /tmp/bin/gws <<WRAPPER
#!/bin/bash
unset GOOGLE_APPLICATION_CREDENTIALS
exec "$GWS_BIN" "\$@"
WRAPPER
  chmod +x /tmp/bin/gws
  export PATH="/tmp/bin:$PATH"
fi

# --- GitNexus repo auto-registration ---
# Scan mounted workspace for git repos that already have a GitNexus index,
# and register them in the container's registry.json so the gitnexus MCP
# tools can query them. Doesn't run analysis — if a repo is stale, the
# agent runs `gitnexus analyze` itself when it needs to.
mkdir -p /home/node/.gitnexus
_gitnexus_repos=()
for gitdir in $(find /workspace -maxdepth 4 -name .git \( -type d -o -type f \) 2>/dev/null); do
  repo=$(dirname "$gitdir")
  [ -f "$repo/.gitnexus/meta.json" ] && _gitnexus_repos+=("$repo")
done
if [ ${#_gitnexus_repos[@]} -gt 0 ]; then
  node -e '
    const fs = require("fs"), p = require("path");
    const regPath = p.join(process.env.HOME, ".gitnexus", "registry.json");
    const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, "utf8")) : [];
    for (const repo of process.argv.slice(1)) {
      if (reg.some((r) => r.path === repo)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(p.join(repo, ".gitnexus", "meta.json"), "utf8"));
        reg.push({
          name: p.basename(repo), path: repo, storagePath: p.join(repo, ".gitnexus"),
          indexedAt: meta.indexedAt, lastCommit: meta.lastCommit, stats: meta.stats,
        });
      } catch {}
    }
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + "\n");
  ' "${_gitnexus_repos[@]}" 2>/dev/null \
    && echo "[entrypoint] GitNexus: registered ${#_gitnexus_repos[@]} repo(s)" >&2 || true
fi

# --- Run the agent-runner ---
# No stdin pipe (obsolete v1 pattern). Everything is messages via the
# session DBs.
exec node /tmp/dist/index.js
