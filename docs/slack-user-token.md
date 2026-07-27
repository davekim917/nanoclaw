# Slack user-token MCP

Lets an agent read your Slack from **your lens** — DMs, group DMs, channels you're in, threads, files — via the [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server) stdio MCP. No bot-invite-to-channel needed. The token is your personal Slack user-OAuth token (`xoxp-…`) stored in OneCLI vault and injected per-agent.

## Security model

| Where the agent runs | Default behavior | Override |
|---|---|---|
| Your 1:1 DM with the agent (primary↔you, helper↔you) | Slack MCP active — agent can search/read your Slack | n/a (already the safe path) |
| A shared channel the agent is invited to (`#engineering`, etc.) | Slack MCP **NOT** registered for that spawn | Add the channel's `messaging_groups.id` to `container.json` → `slack_user_token.also_allowed_in` |

The gate runs at spawn time, not per-tool-call. If denied, the MCP server is **never started** for that session — so the in-container LLM can't invoke its tools at all, regardless of prompt. Fail-closed by construction.

## One-time setup per workspace

### 1. Mint an `xoxp-` user-OAuth token

Slack doesn't let you generate arbitrary `xoxp-` tokens — you need a Slack App with user-token scopes installed to your workspace.

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. App name: `<your-handle>-mcp` (e.g., `operator-mcp`). Workspace: pick the workspace.
3. **OAuth & Permissions** → **User Token Scopes** → add:
   - `search:read` — workspace search (most useful)
   - `channels:history`, `channels:read` — public channels you're in
   - `groups:history`, `groups:read` — private channels you're in
   - `im:history`, `im:read` — 1:1 DMs
   - `mpim:history`, `mpim:read` — group DMs
   - `users:read` — user directory lookups
   - `files:read` — file contents in channels you're in
4. **Install to Workspace** → approve the prompts. Copy the **User OAuth Token** (`xoxp-…`).
5. **Don't** add any Bot Token Scopes — this app is user-token-only and shouldn't be a bot.

The app is for your personal use; no need to publish to the directory.

### 2. Add the token to OneCLI vault

Use the OneCLI UI at <http://127.0.0.1:10254> or the CLI:

```bash
onecli secrets create --name "Slack-User-Token-Example Labs" --value "xoxp-…"
onecli secrets create --name "Slack-User-Token-ExampleRetail" --value "xoxp-…"
# (one per workspace)
```

Name convention: `Slack-User-Token-<WorkspaceLabel>`. The label is whatever you call the workspace internally — used downstream in workgroup secret declarations.

### 3. Configure OneCLI gateway substitution for `slack.com`

The container ships with `SLACK_MCP_XOXP_TOKEN=xoxp-onecli-managed-placeholder`. The korotovsky MCP sends outbound `Authorization: Bearer xoxp-onecli-managed-placeholder` headers to `slack.com`; the OneCLI gateway must rewrite that header with the real Bearer from your vault.

In the OneCLI UI:

1. **Vault → Secrets → Slack-User-Token-Example Labs → Host patterns**: add `slack.com` and `*.slack.com`.
2. **Auth method**: `Bearer` header replacement.
3. Same for `Slack-User-Token-ExampleRetail`.

Once a workspace's secret is assigned to an agent (next step), every outbound HTTPS to `slack.com` from that agent's container gets its Authorization header replaced.

### 4. Assign secrets to workgroups

Each workspace's secret is shared across all sibling agents in that workgroup. Use the workgroup-level OneCLI secret declaration (shipped in the workgroups feature):

```bash
# Example Labs workgroup gets the Example Labs Slack token
pnpm exec tsx scripts/set-workgroup-secrets.ts example-labs \
  --secrets "Anthropic,Exa,...,Slack-User-Token-Example Labs"

# Example Retail workgroup gets the Example Retail Slack token
pnpm exec tsx scripts/set-workgroup-secrets.ts example-retail \
  --secrets "Anthropic,...,Datafold-ExampleRetail,Slack-User-Token-ExampleRetail"
```

The script validates the name against OneCLI vault before writing, fail-closed on typos.

## Per-agent enable

Edit each agent's `groups/<folder>/container.json`:

```jsonc
{
  // ... existing fields ...
  "slack_user_token": {
    "enabled": true
    // optional: "also_allowed_in": ["mg-channel-eng-leads-private"]
  }
}
```

Wire to the agents you want to grant this capability:

- `groups/example-labs/container.json`
- `groups/example-labs-codex/container.json`
- `groups/example-retail/container.json`
- `groups/example-retail-codex/container.json`

Sibling pairs share the workgroup's assigned token via the workgroup-level secret declaration — both `helper` and `helper-codex` route through `Slack-User-Token-Example Labs`.

### Adding a trusted channel to the override list

If you have a private channel that's just you + a vetted collaborator, you can let the agent use Slack-user-token there too:

```bash
# Find the messaging_group_id
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id, name, channel_type FROM messaging_groups WHERE name LIKE '%eng-leads%'"
```

Add the id to `also_allowed_in`:

```jsonc
"slack_user_token": {
  "enabled": true,
  "also_allowed_in": ["mg-1779…-private-channel-id"]
}
```

**Don't add public/team channels** — anyone in those channels can ask the agent questions, and your Slack lens covers DMs they shouldn't see.

## Smoke test

Once configured, from your 1:1 DM with the agent:

> "Search my Slack for messages about the workgroup deploy from last week."

You should see results from channels and DMs you're in. If you get an empty result or a clear error, check the troubleshooting section.

## Tools available

Via [korotovsky/slack-mcp-server v1.3.0](https://github.com/korotovsky/slack-mcp-server):

- `conversations_history` — fetch channel/DM messages
- `conversations_replies` — thread messages
- `conversations_search_messages` — workspace-wide search (your most powerful tool)
- `channels_list` — list channels you're in
- `conversations_unreads` — your unread mentions / DMs
- `users_search` — lookup users by name or email
- `saved_list` — your Slack saved items
- Plus emoji reactions and user-group operations (off by default; opt in via env vars in the MCP entry)

**Write operations** (`conversations_add_message`, `reactions_add`) are disabled by default. Enable them by adding `SLACK_MCP_ADD_MESSAGE_TOOL=true` to the MCP server's env block in `container-runner.ts` if you want bidirectional Slack from the agent.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Credentialed CLI reports "unauthorized" from Slack | OneCLI substitution not configured for `slack.com` | Step 3 above |
| MCP not appearing in the agent's tool list at all | `slack_user_token.enabled` not set, OR session is in a non-allowlisted channel | Check `container.json` + host log for `slack-user-token MCP gated off for this session` |
| `xoxp-onecli-managed-placeholder` reaches Slack and gets rejected | OneCLI vault doesn't have the matching secret assigned to this agent | Step 4 above; verify `onecli agents get-secrets --id <agent-id>` shows the Slack secret |
| Search returns nothing for known content | Token scopes missing (e.g., `search:read` not added) | Step 1 — regenerate the Slack app's user-token after adding the scope |
| Performance feels slow on first call | korotovsky's users/channels caches are disabled by default | Future optimization: mount a writable cache path (see `container-runner.ts`'s MCP env block — `SLACK_MCP_USERS_CACHE`) |

## What you'd miss vs. the official Slack MCP

We picked the community server over Slack's official `https://mcp.slack.com/mcp` because the official one requires OAuth confidential-app flow and workspace admin approval. You lose:

- **Slack Canvas** read/write/export
- **Channel creation** from the agent

The capabilities you use day-to-day — search, DM reads, channel history, threads, files — are equivalent. If Canvas becomes important, the official server can be added as a second MCP (different name, same per-agent gating); they're not mutually exclusive.

## Where the bits live

| File | Role |
|---|---|
| `src/container-config.ts` (`SlackUserTokenConfig`) | Schema for `slack_user_token` in container.json |
| `src/modules/permissions/slack-user-token-gate.ts` | Per-spawn permission gate (default: owner DM only) |
| `src/container-runner.ts` (search `slack-user-token`) | MCP registration site — runs the gate, adds the entry if allowed |
| `container/Dockerfile` (`SLACK_MCP_VERSION`) | Pins korotovsky binary version baked into the agent-runner image |
| `groups/<folder>/container.json` (`slack_user_token`) | Per-agent enable + override allow-list |
| OneCLI vault | Stores the actual `xoxp-` token |
| OneCLI gateway rules | Substitutes the placeholder Bearer for outbound `slack.com` calls |
