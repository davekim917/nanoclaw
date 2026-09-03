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
- Remote URLs must use HTTPS (plain HTTP only for `localhost` / `host.docker.internal`) and may not carry credentials, fragments, or credential-looking query parameters. A token in the URL path or a query value is rejected too — the URL is written to disk verbatim, so a secret there is an on-disk secret.
- Credential headers must use the `"onecli-managed"` placeholder — the OneCLI gateway substitutes the real secret at the proxy boundary, so the container never holds the token.
- On approval, the container is killed and the next message wakes it with the new server wired up. No image rebuild — bun runs TS directly.

### How approval works

You won't see the admin's response in your current turn. After approval, the container is killed and next time a message arrives your container starts fresh on the new image. If a follow-up system prompt fires (as with `install_packages`), you'll see it and should act on it — verify the change, report to the user.

If denied, you'll get a chat message telling you the request was rejected. Do not retry automatically; explain to the user what was denied.

## Credential approvals (OneCLI)

When you call an external API that requires credentials, OneCLI may prompt an admin for approval before releasing the token. This happens transparently: the HTTP call blocks until admin approves or denies. No action needed from you — just make the call. If it errors out with a credential failure, tell the user and stop.
