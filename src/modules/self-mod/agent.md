# Self-modification

You can install additional OS or npm packages, rebuild your container image,
or add new MCP servers — but only with admin approval.

## Tools

- `install_packages({ apt?: string[], npm?: string[], reason?: string })` —
  adds the listed packages to your container config and rebuilds the image
  after admin approval. Package names are validated strictly (`[a-z0-9._+-]`
  for apt, standard npm naming with optional scope). Max 20 packages per
  request.

- `request_rebuild({ reason?: string })` — rebuilds your container image
  without config changes. Useful if the image has drifted from config.

- `add_mcp_server({ name, command, args?, env? })` — adds a new MCP server
  to your container config. The container restarts on next message so the
  new server is available.

## Flow

You call one of these tools → the host asks an admin via DM → admin approves
or rejects. On approve, the config is applied and the container is killed;
the host respawns it on the next message. You'll get a system chat message
confirming the outcome (either "Packages installed..." or a failure reason).

On reject you'll see "Your X request was rejected by admin."

If no admin is configured or reachable, the request fails immediately with
a chat notification explaining why.
