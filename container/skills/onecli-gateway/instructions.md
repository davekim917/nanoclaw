# Credentials & External Services

Your HTTP requests go through the OneCLI proxy, which injects real credentials automatically. Just call any API directly (GitHub, Slack, Linear, etc.) — the proxy adds auth before it reaches the service.

Exception: services with a mounted credential file use their own CLI, not the proxy — check `get_capabilities` first. Google Workspace (Gmail/Calendar/Drive) is the main one: use `gws` with the account file and env var shown there. A OneCLI `app_not_connected` for such a service does not mean you lack access.

Use any method: curl, Python, a CLI tool, whatever fits. If a tool checks for credentials locally, pass any placeholder value — the proxy replaces it with real credentials at request time.

If you get a `401`/`403`/`app_not_connected`, the error response contains a `connect_url` — you MUST show it to the user as a bare URL on its own line (no angle brackets, no markdown link syntax) so they can click to connect. Run `/onecli-gateway` for the full error-handling flow. Never ask the user for API keys or tokens.
