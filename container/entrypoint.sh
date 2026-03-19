#!/bin/bash
set -e
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json

# Fix Chromium crashpad in containers: crashpad derives its database path from
# XDG_CONFIG_HOME. If that dir isn't writable (or gets corrupted in long-running
# containers), chromium crashes with "chrome_crashpad_handler: --database is required".
# Pointing XDG dirs to /tmp ensures a writable, ephemeral location.
# See: https://github.com/microsoft/playwright/issues/34031
export XDG_CONFIG_HOME=/tmp/.chromium
export XDG_CACHE_HOME=/tmp/.chromium
# Route browser through residential proxy for geo-fenced sites
if [ -n "$RESIDENTIAL_PROXY_URL" ]; then
  export AGENT_BROWSER_PROXY="$RESIDENTIAL_PROXY_URL"
fi
# Fix Snowflake config ownership: host stages files as UID 1001 but container
# runs as node (1000). snow CLI .deb enforces strict owner + mode 0600 checks.
# Copy to a node-owned dir and redirect via SNOWFLAKE_HOME.
if [ -d /home/node/.snowflake/keys ] || [ -f /home/node/.snowflake/connections.toml ]; then
  SF_DIR=/tmp/.snowflake
  mkdir -p "$SF_DIR/logs"
  cp -r /home/node/.snowflake/* "$SF_DIR/" 2>/dev/null || true
  chmod 600 "$SF_DIR"/*.toml 2>/dev/null || true
  find "$SF_DIR/keys" -type d -exec chmod 700 {} + 2>/dev/null || true
  find "$SF_DIR/keys" -type f -exec chmod 600 {} + 2>/dev/null || true
  # Rewrite all paths (logs, key files) from old mount to new SNOWFLAKE_HOME
  sed -i 's|/home/node/.snowflake/|/tmp/.snowflake/|g' "$SF_DIR/config.toml" "$SF_DIR/connections.toml" 2>/dev/null || true
  export SNOWFLAKE_HOME="$SF_DIR"
fi
# Configure git/gh auth if GITHUB_TOKEN is present in secrets
GH_TOKEN=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/input.json","utf8"));if(d.secrets?.GITHUB_TOKEN)process.stdout.write(d.secrets.GITHUB_TOKEN)}catch{}' 2>/dev/null)
if [ -n "$GH_TOKEN" ]; then
  git config --global credential.helper '!f() { echo username=x-access-token; echo password='"$GH_TOKEN"'; }; f'
  echo "$GH_TOKEN" | gh auth login --with-token 2>/dev/null || true
fi
node /tmp/dist/index.js < /tmp/input.json
