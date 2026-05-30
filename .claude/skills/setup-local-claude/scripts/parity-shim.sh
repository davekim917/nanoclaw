#!/usr/bin/env bash
# parity-shim.sh — runs INSIDE `onecli run`, which has already exported:
#   HTTPS_PROXY/HTTP_PROXY -> the OneCLI gateway
#   NODE_EXTRA_CA_CERTS/SSL_CERT_FILE/REQUESTS_CA_BUNDLE/CURL_CA_BUNDLE/
#     GIT_SSL_CAINFO/DENO_CERT -> the OneCLI CA
#   AOC_AGENT/AOC_ACCESS_TOKEN -> the workstream's vault identity
#   CLAUDE_CODE_OAUTH_TOKEN -> the vault Anthropic credential
#   NO_PROXY=localhost,127.0.0.1
#
# We reconcile this to match what NanoClaw's container-runner.ts does AND to keep
# Claude's model auth on your local subscription login, then exec Claude Code.
# Source of truth: src/container-runner.ts (~L2444-2521).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP="$SELF_DIR/mcp.json"

# --- Anthropic auth: use your LOCAL subscription login, not the vault cred -----
# onecli run injects CLAUDE_CODE_OAUTH_TOKEN (and the proxy would otherwise
# inject the vault "Anthropic" secret for api.anthropic.com). Both would override
# your interactive login. Unset the env creds AND bypass api.anthropic.com so
# Claude Code falls back to its stored OAuth account (`claude` -> /login).
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL 2>/dev/null || true

# --- CA bundle for clients onecli run doesn't already cover --------------------
# onecli run sets NODE_EXTRA_CA_CERTS/SSL_CERT_FILE/REQUESTS_CA_BUNDLE/
# CURL_CA_BUNDLE/GIT_SSL_CAINFO/DENO_CERT. It does NOT set PIP_CERT/AWS_CA_BUNDLE
# (container-runner.ts does). Mirror them from the CA onecli already chose.
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "${NODE_EXTRA_CA_CERTS}" ]; then
  export PIP_CERT="$NODE_EXTRA_CA_CERTS" AWS_CA_BUNDLE="$NODE_EXTRA_CA_CERTS"
fi

# --- NO_PROXY: extend with the container's bypass set -------------------------
# api.anthropic.com is load-bearing (see above). The rest mirror container-runner
# bypasses for clients whose own CA/auth the gateway breaks (github smart-HTTP,
# snowflake/aws certifi, pip certifi, codex websocket).
BASE_NP="${NO_PROXY:-localhost,127.0.0.1}"
export NO_PROXY="${BASE_NP},api.anthropic.com,github.com,snowflakecomputing.com,amazonaws.com,chatgpt.com,pypi.org,pythonhosted.org"
export no_proxy="$NO_PROXY"

# --mcp-config MERGES with your existing user/project MCP config (no --strict),
# so gitnexus etc. stay. HTTP servers auth via the gateway using the AOC_AGENT
# identity; a server whose secret this identity lacks just 401s and its tools are
# unavailable for that workstream. If mcp.json is absent, run plain claude.
if [ -f "$MCP" ]; then
  exec claude --mcp-config "$MCP" "$@"
else
  exec claude "$@"
fi
