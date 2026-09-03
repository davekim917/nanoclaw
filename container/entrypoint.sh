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
# - GitHub git auth from a read-only mounted token file (GITHUB_TOKEN_FILE),
#   with the legacy GH_TOKEN env path kept as a fallback
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
# Without GITHUB_ALLOWED_ORGS: configure the same helper globally for
# github.com (file mode), or fall back to `gh auth setup-git` (legacy env
# mode). Matches v2's previous behavior for installs that haven't opted into
# org-scoping yet.
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
#
# CREDENTIAL DELIVERY (2026-09): the token normally arrives BY REFERENCE.
# GITHUB_TOKEN_FILE names a read-only mounted file that the host rewrites in
# place, so the container spec carries no credential value AND the file is
# live — a container that outlives its ~1h GitHub App installation token picks
# up the host's re-mint on its next git/gh call instead of being stuck with an
# env frozen at spawn. GH_TOKEN in the env is still honoured (host rollback
# flag GITHUB_TOKEN_IN_ENV=1); the helper prefers the file when both are set.
if [ -n "$GITHUB_TOKEN_FILE" ] || [ -n "$GH_TOKEN" ]; then
  mkdir -p /tmp/bin

  # Token reader, shared by the git credential helper and the gh shim below.
  # The host writes `<token>\n` with truncate+write, so a read can land in the
  # window where the file is empty or holds only a prefix. `read -r` succeeds
  # only when it consumed a newline terminator — exactly the "fully written"
  # signal — so a torn read is detectable and worth a brief retry rather than
  # handing git half a credential.
  #
  # The `-r` test gates the retry loop on the file being READABLE. Retrying is
  # only meaningful against a write in progress; an absent or unreadable file
  # will still be absent 250ms later, and looping on it would print five
  # redirection errors into git's own stderr on every single call and delay the
  # env fallback for nothing.
  cat > /tmp/bin/nanoclaw-gh-token <<'READER'
#!/bin/bash
if [ -n "$GITHUB_TOKEN_FILE" ] && [ -r "$GITHUB_TOKEN_FILE" ]; then
  for _i in 1 2 3 4 5; do
    if IFS= read -r _tok < "$GITHUB_TOKEN_FILE" 2>/dev/null && [ -n "$_tok" ]; then
      printf '%s' "$_tok"
      exit 0
    fi
    sleep 0.05
  done
fi
[ -n "$NANOCLAW_GH_TOKEN" ] || exit 1
printf '%s' "$NANOCLAW_GH_TOKEN"
READER
  chmod 0700 /tmp/bin/nanoclaw-gh-token

  # Quoted heredoc — no expansion happens here; the helper resolves the token
  # at invocation time, never interpolated into a shell or git-config literal.
  cat > /tmp/bin/nanoclaw-git-creds <<'CREDS'
#!/bin/bash
_tok=$(/tmp/bin/nanoclaw-gh-token) || exit 1
echo "username=x-access-token"
echo "password=${_tok}"
CREDS
  chmod 0700 /tmp/bin/nanoclaw-git-creds
  if [ -n "$GH_TOKEN" ]; then
    export NANOCLAW_GH_TOKEN="$GH_TOKEN"
  fi

  # gh reads GH_TOKEN from its own environment, so in file mode there is
  # nothing for it to find. Shim it: resolve the token from the mounted file
  # for the duration of one invocation, then exec the real binary. Reach is
  # deliberately NOT narrowed by GITHUB_ALLOWED_ORGS — that setting has only
  # ever scoped git, because the old env forwarding authenticated gh in scoped
  # mode too. Narrowing it here would be a behavior change, not a port.
  if [ -n "$GITHUB_TOKEN_FILE" ]; then
    GH_BIN=$(command -v gh 2>/dev/null || true)
    if [ -n "$GH_BIN" ] && [ "$GH_BIN" != "/tmp/bin/gh" ]; then
      cat > /tmp/bin/gh <<WRAPPER
#!/bin/bash
_tok=\$(/tmp/bin/nanoclaw-gh-token) && export GH_TOKEN="\$_tok" GITHUB_TOKEN="\$_tok"
exec "$GH_BIN" "\$@"
WRAPPER
      chmod 0755 /tmp/bin/gh
    fi
  fi

  if [ -n "$GITHUB_ALLOWED_ORGS" ]; then
    IFS=',' read -ra _gh_orgs <<< "$GITHUB_ALLOWED_ORGS"
    for _org in "${_gh_orgs[@]}"; do
      _org=$(echo "$_org" | tr -d ' ')
      [ -z "$_org" ] && continue
      git config --global "credential.https://github.com/${_org}/.helper" '!/tmp/bin/nanoclaw-git-creds'
    done
    echo "[entrypoint] GitHub credentials scoped to orgs: $GITHUB_ALLOWED_ORGS" >&2
  elif [ -n "$GITHUB_TOKEN_FILE" ]; then
    # File mode, no org scope. `gh auth setup-git` would point git at
    # `gh auth git-credential`, which reads gh's own env — empty here. Wire git
    # to the same file-reading helper instead, for the hosts gh would have
    # configured.
    git config --global 'credential.https://github.com.helper' '!/tmp/bin/nanoclaw-git-creds'
    git config --global 'credential.https://gist.github.com.helper' '!/tmp/bin/nanoclaw-git-creds'
    echo "[entrypoint] GitHub credentials read from $GITHUB_TOKEN_FILE" >&2
  elif command -v gh >/dev/null 2>&1; then
    gh auth setup-git 2>/dev/null || true
  fi

  # /tmp/bin holds the gh shim and the credential helpers. The gws block below
  # also prepends it; doing it here as well keeps the shim reachable in installs
  # where gws is not present.
  export PATH="/tmp/bin:$PATH"
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
