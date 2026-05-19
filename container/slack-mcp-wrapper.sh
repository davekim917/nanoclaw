#!/bin/sh
# Wrapper around korotovsky/slack-mcp-server (installed at
# /usr/local/bin/slack-mcp-server.real). Sole purpose: copy HTTPS_PROXY into
# SLACK_MCP_PROXY so the real binary routes outbound slack.com calls through
# OneCLI's gateway. korotovsky's HTTP client honors only its custom
# SLACK_MCP_PROXY env var, not the standard HTTPS_PROXY — without this wrapper,
# the Authorization header substitution at the gateway never fires and the
# placeholder xoxp- token reaches Slack unchanged (401).
#
# We do NOT override an explicit SLACK_MCP_PROXY if the operator already set
# one (e.g., for debugging through a different proxy).
set -eu
if [ -z "${SLACK_MCP_PROXY:-}" ] && [ -n "${HTTPS_PROXY:-}" ]; then
  export SLACK_MCP_PROXY="$HTTPS_PROXY"
fi
exec /usr/local/bin/slack-mcp-server.real "$@"
