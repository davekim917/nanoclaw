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
  carry credentials in the userinfo, a fragment, a credential-named query
  parameter, or a recognizable credential shape anywhere in the path or a
  query value. Recognition is a backstop, not a guarantee: an opaque path
  segment cannot be told apart from a tenant id, so it is shown to the
  approving admin rather than refused. **The URL is persisted verbatim**, so
  never put a secret in one — say that plainly rather than assuring anyone
  no credential can reach disk.
  Only known configuration headers may hold a literal value (`Accept`,
  `Accept-Encoding`, `Accept-Language`, `Content-Type`, `User-Agent`,
  `MCP-Protocol-Version`, `X-Api-Version`, `X-Request-Id`); every other header
  must be exactly `"onecli-managed"` or an auth scheme followed by it
  (`"Bearer onecli-managed"`), whatever its name and however short its value.
  The OneCLI gateway substitutes the real secret at the proxy boundary, but
  only for a secret ASSIGNED to your group: a 401 from a newly added remote
  server can mean the credential is in the vault but not assigned, which an
  operator fixes via `onecliSecrets` in container.json or
  `onecli agents set-secrets` — but a 401 can also mean an expired or
  incorrect secret, a missing gateway rule, or an unsupported auth scheme, so
  say it as one possibility, not the diagnosis. A declared `type` must agree with the fields —
  `stdio` with `command`, `http` with `url`. A remote URL is stored verbatim, so
  never put a secret in it — recognizable credential shapes are rejected, but
  an opaque path segment cannot be told apart from a tenant id and is only
  flagged for the approving admin.

## Flow

You call one of these tools → the host asks an admin via DM → admin approves
or rejects. On approve, the config is applied, the image is rebuilt if
needed, and the container is killed; the host respawns it on the next
message. You'll get a system chat message confirming the outcome (either
"Packages installed..." or a failure reason).

On reject you'll see "Your X request was rejected by admin."

If no admin is configured or reachable, the request fails immediately with
a chat notification explaining why.
