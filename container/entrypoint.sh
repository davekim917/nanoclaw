#!/bin/bash
# NanoClaw agent container entrypoint.
#
# Runtime: Bun. The host passes initial session parameters via stdin as a
# single JSON blob; we capture it to /tmp/input.json first so it survives
# for post-mortem inspection, then exec bun so bun becomes tini's direct
# child and receives signals cleanly. All further IO flows through the
# session DBs at /workspace/{inbound,outbound}.db — no stdin pipe during
# the poll loop.
#
# Example Labs additions on top of upstream/v2:
# - Chromium XDG workaround (long-running sessions crash without it)
# - gws (Google Workspace CLI) wrapper that unsets ADC to avoid
#   service-account override of user-OAuth
# - GitHub git auth via `gh auth setup-git` when GH_TOKEN is set
# - Render CLI workspace pre-configuration
#
# All steps are idempotent and best-effort. If a tool isn't installed or
# an env var isn't set, the corresponding step no-ops silently.

set -e

# Capture stdin JSON if any — it's used by upstream's stdin-on-spawn path.
# Host-spawned sessions in this fork don't pipe stdin (all IO is via the
# mounted session DBs), so fall through immediately when stdin isn't a pipe.
if [ ! -t 0 ] && [ -p /dev/stdin ]; then
  cat > /tmp/input.json
else
  : > /tmp/input.json
fi

# --- Chromium crashpad workaround ---
# crashpad derives its DB path from XDG_CONFIG_HOME. If that dir isn't
# writable (or gets corrupted on long-running containers), chromium
# crashes with "--database is required". Redirect to /tmp.
export XDG_CONFIG_HOME=/tmp/.chromium
export XDG_CACHE_HOME=/tmp/.chromium

# --- Residential proxy for geo-fenced browser automation ---
if [ -n "$RESIDENTIAL_PROXY_URL" ]; then
  export AGENT_BROWSER_PROXY="$RESIDENTIAL_PROXY_URL"
fi

# --- GitHub git auth ---
# When GITHUB_ALLOWED_ORGS is set, configure git's credential helper ONLY
# for the listed orgs (comma-separated). Prevents a container with a broad
# token from cloning/pushing outside the allowlisted organizations. v1's
# URL-scoped credential-helper pattern, adapted to v2's env-driven config.
#
# Without GITHUB_ALLOWED_ORGS: fall back to `gh auth setup-git`, which
# configures the helper globally for github.com. Matches v2's previous
# behavior for installs that haven't opted into org-scoping yet.
#
# gh CLI auth is skipped when org-scoping is active because gh's own auth
# store (~/.config/gh/) is independent of git credential helpers and would
# bypass the URL-scoped restriction.
#
# Implementation: the credential value is written to a standalone helper
# script that reads the token from an env var at invocation time, NOT
# interpolated into the shell/git-config literal. Prevents any injection
# path via the token value (e.g. a token containing a single quote
# breaking out of the shell string — unusual for GitHub PATs but defense
# in depth is cheap).
if [ -n "$GH_TOKEN" ]; then
  if [ -n "$GITHUB_ALLOWED_ORGS" ]; then
    mkdir -p /tmp/bin
    # Quoted heredoc — no expansion happens here; the script reads
    # NANOCLAW_GH_TOKEN from the env when git invokes it.
    cat > /tmp/bin/nanoclaw-git-creds <<'CREDS'
#!/bin/bash
echo "username=x-access-token"
echo "password=${NANOCLAW_GH_TOKEN}"
CREDS
    chmod 0700 /tmp/bin/nanoclaw-git-creds
    export NANOCLAW_GH_TOKEN="$GH_TOKEN"

    IFS=',' read -ra _gh_orgs <<< "$GITHUB_ALLOWED_ORGS"
    for _org in "${_gh_orgs[@]}"; do
      _org=$(echo "$_org" | tr -d ' ')
      [ -z "$_org" ] && continue
      git config --global "credential.https://github.com/${_org}/.helper" '!/tmp/bin/nanoclaw-git-creds'
    done
    echo "[entrypoint] GitHub credentials scoped to orgs: $GITHUB_ALLOWED_ORGS" >&2
  elif command -v gh >/dev/null 2>&1; then
    gh auth setup-git 2>/dev/null || true
  fi
fi

# --- Render CLI workspace pre-config ---
if [ -n "$RENDER_WORKSPACE_ID" ] && [ -n "$RENDER_API_KEY" ] && command -v render >/dev/null 2>&1; then
  RENDER_API_KEY="$RENDER_API_KEY" render workspace set "$RENDER_WORKSPACE_ID" --confirm >/dev/null 2>&1 \
    && echo "[entrypoint] render workspace pre-configured: $RENDER_WORKSPACE_ID" >&2 \
    || echo "[entrypoint] render workspace set failed (workspace=$RENDER_WORKSPACE_ID)" >&2
fi

# --- Google Workspace CLI (gws) ---
# gws needs a writable config dir for its API discovery cache. Host mount
# of the accounts dir is RO — can't use it as the config dir too.
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/.gws
mkdir -p /tmp/.gws

# gws wrapper: strips GOOGLE_APPLICATION_CREDENTIALS before exec. When ADC
# is set (for gcloud/gsutil), gws picks up the service account instead of
# the user's OAuth token, breaking Gmail/Calendar with FAILED_PRECONDITION.
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

# --- Run the agent-runner ---
# Bun runs TypeScript directly — no tsc build step. Host remounts source at
# /app/src via container-runner.ts so edits take effect on next spawn.
exec bun run /app/src/index.ts < /tmp/input.json
