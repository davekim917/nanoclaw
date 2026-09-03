## Self-modification tools (require admin approval)

Three fire-and-forget tools change your container image or config. Each sends an approval card to an admin's DM; you get notified via system chat on approve/reject.

### install_packages

Add apt and/or npm packages to your container image. On approval, the config is updated AND the image is rebuilt in the same step — you'll get a follow-up prompt ~5s after rebuild telling you to verify the packages are available.

```
install_packages({
  apt: ["ripgrep", "jq"],              // names only, no version specs or flags
  npm: ["@anthropic-ai/sdk"],          // global install
  reason: "need rg for fast code search"
})
```

- Max 20 packages per request.
- Names must match strict regex (blocks shell injection via `vim; curl evil.com`).
- On approval, the image rebuild and container restart happen automatically — there is no separate rebuild step for you to trigger.

### add_mcp_server

Wire an EXISTING third-party MCP server into your runtime config. Pass exactly one of `command` (a local stdio server, whose exact `command`/`args` you must already know) or `url` (a remote Streamable HTTP server).

```
add_mcp_server({
  name: "github",
  command: "npx",
  args: ["@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "onecli-managed" }
})

add_mcp_server({
  name: "datafold",
  url: "https://app.datafold.com/mcp/",
  headers: { Authorization: "Key onecli-managed" }
})
```

- Does NOT install packages. Use `install_packages` first if the command isn't already available.
- A declared `type` must agree with the fields: `stdio` with `command`, `http` (or `streamable-http`) with `url`. A contradiction is an error, not something silently rewritten.
- **Declaring the placeholder wires the header; it does not grant the secret.** The gateway can only substitute a credential that is assigned to your agent group. If a newly added remote server returns 401, the credential is in the vault but not assigned — an operator adds it to `onecliSecrets` in the group's `container.json`, or runs `onecli agents set-secrets`. Say that to the user rather than retrying.
- **Only known configuration headers may hold a literal value** (`Accept`, `Accept-Encoding`, `Accept-Language`, `Content-Type`, `User-Agent`, `MCP-Protocol-Version`, `X-Api-Version`, `X-Request-Id`). Every other header must be exactly `"onecli-managed"` or an auth scheme followed by it (`"Bearer onecli-managed"`), whatever its name and however short its value — `abc123` is a perfectly good API key. The OneCLI gateway substitutes the real secret at the proxy boundary, so the container never holds the token.
- **A remote URL is stored verbatim.** It must use HTTPS (plain HTTP only for `localhost` / `host.docker.internal`) and may not carry credentials in the userinfo, a fragment, or a credential-named query parameter. Recognizable credential SHAPES in the path or a query value are rejected too, but recognition is a backstop rather than a guarantee: an opaque segment could be a token or a tenant id and nothing in the string tells them apart, so the approval card names such segments for the admin to judge. Never put a secret in the URL, and never tell a user that none can reach disk — use a header with the placeholder.
- On approval, the container is killed and the next message wakes it with the new server wired up. No image rebuild — bun runs TS directly.

### How approval works

You won't see the admin's response in your current turn. After approval, the container is killed and next time a message arrives your container starts fresh on the new image. If a follow-up system prompt fires (as with `install_packages`), you'll see it and should act on it — verify the change, report to the user.

If denied, you'll get a chat message telling you the request was rejected. Do not retry automatically; explain to the user what was denied.

## Credential approvals (OneCLI)

When you call an external API that requires credentials, OneCLI may prompt an admin for approval before releasing the token. This happens transparently: the HTTP call blocks until admin approves or denies. No action needed from you — just make the call. If it errors out with a credential failure, tell the user and stop.
