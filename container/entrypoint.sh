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

# Configure git/gh auth if GITHUB_TOKEN is present in secrets
GH_TOKEN=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync("/tmp/input.json","utf8"));if(d.secrets?.GITHUB_TOKEN)process.stdout.write(d.secrets.GITHUB_TOKEN)}catch{}' 2>/dev/null)
if [ -n "$GH_TOKEN" ]; then
  git config --global credential.helper '!f() { echo username=x-access-token; echo password='"$GH_TOKEN"'; }; f'
  echo "$GH_TOKEN" | gh auth login --with-token 2>/dev/null || true
fi
node /tmp/dist/index.js < /tmp/input.json
