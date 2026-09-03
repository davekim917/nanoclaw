# Self-modification

You can install additional OS or npm packages or add new MCP servers — but
only with admin approval.

## Tools

- `install_packages({ apt?: string[], npm?: string[], reason?: string })` —
  adds the listed packages to your container config, rebuilds the image,
  and restarts your container, all in a single admin approval step.
  Package names are validated strictly (`[a-z0-9._+-]` for apt, standard
  npm naming with optional scope). Max 20 packages per request.

- `add_mcp_server({ name, command, args?, env? })` or
  `add_mcp_server({ name, url, headers? })` — adds a new MCP server to your
  container config and restarts the container so the new server is wired up
  on the next message. No image rebuild is required (bun runs TS directly).
  Pass exactly one of `command` (a local stdio server) or `url` (a remote
  Streamable HTTP server). Remote URLs must use HTTPS — plain HTTP is
  allowed only for `localhost` and `host.docker.internal` — and may not
  carry credentials, fragments, credential-looking query parameters, or a
  token anywhere in the path or a query value: the URL is persisted
  verbatim, so a secret in it is a secret on disk.
  Credential headers must use the `"onecli-managed"` placeholder; the
  OneCLI gateway substitutes the real secret at the proxy boundary.

## Flow

You call one of these tools → the host asks an admin via DM → admin approves
or rejects. On approve, the config is applied, the image is rebuilt if
needed, and the container is killed; the host respawns it on the next
message. You'll get a system chat message confirming the outcome (either
"Packages installed..." or a failure reason).

On reject you'll see "Your X request was rejected by admin."

If no admin is configured or reachable, the request fails immediately with
a chat notification explaining why.
