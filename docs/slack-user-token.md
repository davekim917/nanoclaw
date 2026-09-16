# Slack user token

Lets an agent read (and, when you ask, write) your Slack from **your lens** — DMs, group DMs, channels you're in, threads, files — by calling the Slack Web API directly: `curl https://slack.com/api/<method>` from inside the container. No bot-invite-to-channel needed. The token is your personal Slack user-OAuth token (`xoxp-…`) stored in the OneCLI vault; the OneCLI gateway injects it at the proxy boundary, so the agent sends no auth header and never sees the token.

There is no Slack MCP. The korotovsky `slack-mcp-server` that used to sit on top of this was removed: it failed to connect on every spawn, no agent ever called it, and its "failed to connect" notice led an agent to conclude Slack was unavailable when curl worked.

## Security model

| Where the agent runs | Default behavior | Override |
|---|---|---|
| Your 1:1 DM with the agent (primary↔you, helper↔you) | Token injected — agent can search/read your Slack | n/a (already the safe path) |
| A shared channel the agent is invited to (`#engineering`, etc.) | Token **withheld** for that spawn | Add the channel's `messaging_groups.id` to `container.json` → `slack_user_token.also_allowed_in` |
| A scheduled task | Judged by where the task delivers (`src/modules/permissions/task-slack-subject.ts`) | Same allow-list |

The gate runs at spawn time. A session that is not owner-safe spawns under a second OneCLI identity, `<group>-noslack`, whose secret set excludes the Slack user token, so the gateway has nothing to inject and every Slack call from that container fails auth — curl, a script, or anything else. Fail-closed by construction: the boundary is the credential, not a tool registration.

The capabilities snapshot tells the agent which case it is in (`src/capabilities.ts`, the `Slack` entry): live access with the method and permalink recipe in an owner-safe session, an explicit WITHHELD notice everywhere else.

## One-time setup per workspace

### 1. Mint an `xoxp-` user-OAuth token

Slack doesn't let you generate arbitrary `xoxp-` tokens — you need a Slack App with user-token scopes installed to your workspace.

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. App name: `<your-handle>-agent` (e.g., `operator-agent`). Workspace: pick the workspace.
3. **OAuth & Permissions** → **User Token Scopes** → add:
   - `search:read` — workspace search (most useful)
   - `channels:history`, `channels:read` — public channels you're in
   - `groups:history`, `groups:read` — private channels you're in
   - `im:history`, `im:read` — 1:1 DMs
   - `mpim:history`, `mpim:read` — group DMs
   - `users:read` — user directory lookups
   - `files:read` — file contents in channels you're in
   - `chat:write` — only if you want the agent able to post as you when asked
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

Name convention: `Slack-User-Token-<WorkspaceLabel>`. The host identifies which secrets to withhold by that convention — a name containing both `slack` and `user`, case-insensitive (`slackUserTokenSecrets`, `src/onecli-secrets.ts`). If a secret doesn't follow it, list it explicitly in `slack_user_token.onecli_secret_names`, or it will be injected in every session.

### 3. Configure OneCLI gateway injection for `slack.com`

In the OneCLI UI:

1. **Vault → Secrets → Slack-User-Token-Example Labs → Host patterns**: add `slack.com`.
2. **Auth method**: `Bearer` header.
3. Same for `Slack-User-Token-ExampleRetail`.

File bytes (`url_private`) live on `files.slack.com`, which the gateway matches separately. To let the agent download attachments, add a second vault entry with the same token, host `files.slack.com`, path `*`, and `slack` and `user` in its name so it is withheld in the same sessions.

### 4. Assign secrets to workgroups

Each workspace's secret is shared across all sibling agents in that workgroup. Use the workgroup-level OneCLI secret declaration:

```bash
# Example Labs workgroup gets the Example Labs Slack token
pnpm exec tsx scripts/set-workgroup-secrets.ts example-labs \
  --secrets "Anthropic,Exa,...,Slack-User-Token-Example Labs"

# Example Retail workgroup gets the Example Retail Slack token
pnpm exec tsx scripts/set-workgroup-secrets.ts example-retail \
  --secrets "Anthropic,...,Datafold-ExampleRetail,Slack-User-Token-ExampleRetail"
```

The script validates the name against OneCLI vault before writing, fail-closed on typos. Once assigned, the owner-safe scoping above applies to every agent in the workgroup automatically — there is nothing to enable per agent.

## Per-agent config

`groups/<folder>/container.json` only needs a `slack_user_token` block when you want to widen or pin the defaults:

```jsonc
{
  // ... existing fields ...
  "slack_user_token": {
    // optional: extra owner-safe contexts
    "also_allowed_in": ["mg-channel-eng-leads-private"],
    // optional: name the withheld secrets instead of relying on the convention
    "onecli_secret_names": ["Slack-User-Token-ExampleRetail"]
  }
}
```

`enabled` is **retired**: it used to register the Slack MCP, and no spawn or capability path reads it now. Existing files that set `"enabled": true` keep working unchanged; setting or removing it changes nothing. Sibling-parity checks still compare it so a pair's configs stay identical.

### Adding a trusted channel to the override list

If you have a private channel that's just you + a vetted collaborator, you can let the agent use your Slack token there too:

```bash
# Find the messaging_group_id
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id, name, channel_type FROM messaging_groups WHERE name LIKE '%eng-leads%'"
```

Add the id to `also_allowed_in`. `also_allowed_in` holds exact messaging-group ids, which belong to one adapter, so each sibling lists its own.

**Don't add public/team channels** — anyone in those channels can ask the agent questions, and your Slack lens covers DMs they shouldn't see.

## How the agent uses it

- Identity: `curl https://slack.com/api/auth.test`
- A permalink `https://<ws>.slack.com/archives/C0123/p1789080120758779` is channel `C0123`, ts `1789080120.758779` (a dot before the last six digits); a `thread_ts` query parameter names the thread parent. Read it with `conversations.replies?channel=C0123&ts=<thread_ts, else that ts>`.
- `conversations.history`, `search.messages`, `users.info`, `conversations.list` for everything else.
- `chat.postMessage` (POST JSON with `channel`, `text`, optional `thread_ts`) posts **as you**, so the agent is told to use it only when asked.

## Smoke test

From your 1:1 DM with the agent:

> "Read this thread: <a Slack permalink>"

The agent should answer from the thread's content. In a channel that is not allow-listed the agent should say Slack is withheld in that session rather than attempt it.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `not_authed` / `invalid_auth` in an owner DM | Gateway injection not configured for `slack.com`, or the secret isn't assigned | Steps 3–4; verify `onecli agents get-secrets --id <agent-id>` shows the Slack secret |
| `not_authed` in a shared channel | Working as designed — the session is not owner-safe | Add the channel to `also_allowed_in` only if it is genuinely private |
| Host log `Slack user-token secret withheld for non-owner-safe session` for a session you expected to be owner-safe | Session isn't your 1:1 DM, or the channel id isn't in `also_allowed_in` | Check the logged `slackSafetyMessagingGroupId` against `container.json` |
| Downloaded file is Slack's HTML login page | `files.slack.com` not wired | Second vault entry, step 3 |
| Search returns nothing for known content | Token scopes missing (e.g., `search:read` not added) | Step 1 — reinstall the Slack app after adding the scope |

## Migrating off the Slack MCP

**Detect.** An install is affected if any group set `slack_user_token.enabled`, declared a `slack-user-token` entry under `mcpServers` itself, or has any instruction an agent reads that names the MCP's tools:

```bash
for f in groups/*/container.json; do jq -r --arg f "$f" 'select(.slack_user_token.enabled == true or (.mcpServers // {} | has("slack-user-token"))) | $f' "$f"; done
grep -rl 'mcp__slack-user-token__' groups/ container/skills/ 2>/dev/null
```

**Why.** The MCP was a convenience layer over the same token the proxy already injects. It failed to connect on every spawn (`failedMcpServers: slack-user-token`), no agent transcript ever called it, and the failure notice was read as "Slack is down". The credential boundary never depended on it.

**Fix.** Nothing in `container.json` has to change for the spawn to be clean — `enabled` is accepted and ignored, `also_allowed_in` / `onecli_secret_names` keep their meaning, and a leftover `mcpServers["slack-user-token"]` entry is dropped by the agent-runner with an `Ignored MCP server slack-user-token: retired` log line (`container/agent-runner/src/retired-mcp-servers.ts`) rather than failing to connect. Remove such an entry anyway so the config says what runs. Rewrite any instruction the detect step found to use `curl https://slack.com/api/<method>` (see *How the agent uses it*). Deploying needs an agent image rebuild (the binary and wrapper are gone from `container/Dockerfile`) and a host restart (the MCP registration is host code).

**Verify.** After the restart, in an owner-safe session: the session's SDK init no longer lists `slack-user-token` under `failedMcpServers`, `curl https://slack.com/api/auth.test` returns `"ok":true`, and the agent reads a pasted permalink. In a shared channel the host still logs `Slack user-token secret withheld for non-owner-safe session`.

**Rollback.** Revert the change and rebuild the image with the previous `container/Dockerfile`, then restart. No data or config was rewritten, so there is nothing else to restore.

## Where the bits live

| File | Role |
|---|---|
| `src/container-config.ts` (`SlackUserTokenConfig`) | Schema for `slack_user_token` in container.json |
| `src/modules/permissions/slack-user-token-gate.ts` | `isOwnerSafeSlackSession` — the owner-safe predicate (default: owner DM only) |
| `src/onecli-secrets.ts` (`slackUserTokenSecrets`) | Which merged secrets are the Slack user token |
| `src/container-runner.ts` (search `-noslack`) | Two-tier OneCLI identity — withholds the secret in non-owner-safe sessions |
| `src/capabilities.ts` (the `Slack` entry) | What the agent is told about Slack in this session |
| `groups/<folder>/container.json` (`slack_user_token`) | Override allow-list and explicit secret names |
| OneCLI vault | Stores the actual `xoxp-` token |
