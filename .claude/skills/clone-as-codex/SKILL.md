---
name: clone-as-codex
description: Create a Codex-backed sibling agent for an existing Claude group. The sibling shares the source group's CLAUDE.md, repos, sources, conversations, and mnemon store via symlinks + scoped-env. Cross-agent collaboration happens via standard platform `@`-mentions — requires installing a second bot app for the sibling so each agent has its own real bot user. Works on Slack and Discord.
---

# Clone Group As Codex Sibling

Create `groups/<source>-codex/` from `groups/<source>/`. The codex sibling shares:

- **CLAUDE.md** — regenerated per-group by composeGroupClaudeMd on every spawn (do NOT symlink — the composer overwrites it); AGENTS.md flat-include is derived from it for Codex.
- **CLAUDE.local.md** — symlinked to the source's CLAUDE.local.md when present, so both siblings share per-group memory (consulting context, project notes, etc.).
- **Repos** — symlinked top-level dirs that contain `.git/`.
- **sources/** — mnemon inbox; both agents feed the same memory.
- **conversations/** — transcript archive; both agents see each other's archived turns.
- **mnemon store** — scoped-env override (`MNEMON_STORE_<sibling>=<source-ag-id>`) routes both writers to the same store.
- **Thread worktree** — when `NANOCLAW_THREAD_WORKTREES=1`, both siblings in the same platform thread mount the same `data/v2-threads/<thread-id>/worktrees/<repo>/` host path. Uncommitted edits flow across.

`container.json` for the new sibling gets `provider: "codex"` and `memory.enabled: true`.

**Critical architectural choice — two bot apps, not one shared bot.** Each sibling agent has its own platform bot user, installed as a separate app in the workspace/guild. This lets agents `@`-mention each other (real platform mentions, real autocomplete) and have those mentions fire the peer via standard `engage_mode='mention'`. The single-bot/text-pattern alternative was tried and abandoned — it triggered runaway agent-to-agent loops that bypassed the platform entirely.

## Prerequisites

- The source group exists in `groups/<source>/` and has a row in `agent_groups`.
- `provider: "codex"` is registered (codex provider is in trunk; nothing to install).
- `.env` exists and is writable.
- **You have admin rights in the platform workspace/guild** to create a second bot app for the sibling.

## Channel selection

This skill supports two channels for the sibling bot identity: **Slack** and **Discord**.

Pick one based on where the source agent's bot lives. The channel-agnostic core (steps 1, 4–8) runs identically for both. Steps 2, 3, 9, 10 are platform-specific — each has separate **Slack** and **Discord** subsections; follow only the one you picked.

```bash
CHANNEL=<slack|discord>           # pick one — every later branch keys off this
```

## Steps

### 1. Resolve the source group (capture `agent_groups.id`)

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select id, folder, name from agent_groups where folder='<source-folder>'"
```

Capture the `id` value — it's an `ag-...` string. Every later SQL statement that touches `messaging_group_agents.agent_group_id` uses this id, not the folder name.

```bash
SOURCE_FOLDER=<source-folder>             # e.g. illysium
SOURCE_ID=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SOURCE_FOLDER}'" | tr -d '\n')
test -n "${SOURCE_ID}" || { echo "ERROR: source group '${SOURCE_FOLDER}' not found"; exit 1; }
echo "Source folder: ${SOURCE_FOLDER}"
echo "Source ag-id:  ${SOURCE_ID}"
```

### 2. Install the sibling's bot app

#### Slack path

Follow `.claude/skills/add-slack/SKILL.md` to install a new app in the same workspace where the source agent's bot lives. **Name the bot user something distinct but discoverable** — using the source name with a suffix (e.g. `illie-codex` when source is `illie`) makes Slack's `@`-autocomplete group them together for the user.

Required bot scopes (per add-slack skill step 6): `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `reactions:read`, `users:read`.

Required bot events (step 10): `message.channels`, `message.groups`, `message.im`, `app_mention`.

Set the Request URL to the same `https://<your-domain>/webhook/slack` as the existing source app — the host's webhook router dispatches by Slack app id, not by URL path.

After installing the new app to the workspace, capture the **bot token** (`xoxb-...`) and **signing secret** from the Slack app settings.

> **Note on naming**: the Slack-side bot display name (`illie-codex`), the env-var suffix (`ILLYSIUM_CODEX`), and the resulting channelType (`slack-illysium-codex`) are independent but conventionally aligned. The adapter accepts uppercase + underscores in the suffix and maps `_` → `-` when deriving the channelType, so `SLACK_BOT_TOKEN_ILLYSIUM_CODEX` becomes `slack-illysium-codex` — symmetric with the existing `SLACK_BOT_TOKEN_ILLYSIUM` → `slack-illysium`.

#### Discord path

Create a new Discord application at [discord.com/developers/applications](https://discord.com/developers/applications) — separate from the primary bot's app. **Name the bot user something distinct but discoverable** — e.g. `Axie-Codex` when the primary is `Axie`. Discord shows the bot user name with every message, so this is what the user sees in chat.

1. From the **General Information** tab, copy the **Application ID** and **Public Key**.
2. Go to the **Bot** tab and click **Add Bot** if needed; copy the **Bot Token** (click **Reset Token** if needed — visible only once).
3. Under **Privileged Gateway Intents**, enable **Message Content Intent** (required for the bot to read mention text).
4. Go to **OAuth2** → **URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files`, `Use Slash Commands`
5. Copy the generated URL, open it, and invite the bot to the **same guild** the source bot is already in.

The Discord adapter in trunk supports multiple bots in one host process via the env-var suffix convention (mirrors Slack). The host registers a new `channelType` value `discord-<env_suffix-lowercased-with-dashes>` on the next restart.

> **Note on slash commands**: `/deploy`, `/update-container`, `/update-plugins` etc. stay bound to the primary `DISCORD_BOT_TOKEN` only. Sibling bots receive `@`-mentions but don't expose admin slash commands. This is intentional — admin surface lives on the primary identity.

### 3. Add the sibling's env vars

Pick an `ENV_SUFFIX` that mirrors the source's suffix with `_CODEX` appended (e.g. existing `ILLYSIUM` → new `ILLYSIUM_CODEX`). Uppercase alphanumeric + underscores. The host's adapter discovers it on next restart.

```bash
ENV_SUFFIX=ILLYSIUM_CODEX                 # uppercase, underscores OK
```

#### Slack path

The Slack adapter resolves `SLACK_BOT_TOKEN_<ENV_SUFFIX>` → channelType `slack-<env_suffix-lowercased-with-dashes>`.

```bash
CHANNEL_TYPE=slack-$(echo "${ENV_SUFFIX}" | tr '[:upper:]_' '[:lower:]-')

# Sibling Slack app credentials (paste your actual values).
cat >> .env <<EOF
SLACK_BOT_TOKEN_${ENV_SUFFIX}=xoxb-<paste-here>
SLACK_SIGNING_SECRET_${ENV_SUFFIX}=<paste-here>
EOF

# Verify.
grep "_${ENV_SUFFIX}=" .env
echo "Webhook URL for Slack app config: https://<your-domain>/webhook/${CHANNEL_TYPE}"
```

#### Discord path

The Discord adapter resolves `DISCORD_BOT_TOKEN_<ENV_SUFFIX>` → channelType `discord-<env_suffix-lowercased-with-dashes>`. Public key and application id are optional (only needed for slash-command interactions, which sibling bots don't expose), but harmless to include.

```bash
CHANNEL_TYPE=discord-$(echo "${ENV_SUFFIX}" | tr '[:upper:]_' '[:lower:]-')

# Sibling Discord app credentials (paste your actual values).
cat >> .env <<EOF
DISCORD_BOT_TOKEN_${ENV_SUFFIX}=<paste-here>
DISCORD_APPLICATION_ID_${ENV_SUFFIX}=<paste-here>
DISCORD_PUBLIC_KEY_${ENV_SUFFIX}=<paste-here>
EOF

# Verify.
grep "_${ENV_SUFFIX}=" .env
```

### 4. Create the sibling group directory + symlinks

```bash
SIBLING_FOLDER=${SOURCE_FOLDER}-codex
SIBLING_ID=${SIBLING_FOLDER}                # use folder name as ag-id, matching host-default groups (main, axie-dev)

mkdir -p groups/${SIBLING_FOLDER}
cd groups/${SIBLING_FOLDER}

# Per-group memory: share the source's CLAUDE.local.md so both siblings
# remember the same project context. Conditional — if the source has no
# CLAUDE.local.md, leave it absent and let composeGroupClaudeMd create an
# empty one at first spawn. Do NOT symlink CLAUDE.md here: the composer
# overwrites it with a fresh `@-imports`-only entry every spawn, so a
# symlink would be wiped on first wake.
[ -f ../${SOURCE_FOLDER}/CLAUDE.local.md ] && ln -sfn ../${SOURCE_FOLDER}/CLAUDE.local.md CLAUDE.local.md

[ -d ../${SOURCE_FOLDER}/sources ] && ln -sfn ../${SOURCE_FOLDER}/sources sources
[ -d ../${SOURCE_FOLDER}/conversations ] && ln -sfn ../${SOURCE_FOLDER}/conversations conversations

# Repo symlinks (every dir that contains .git/).
for repo in ../${SOURCE_FOLDER}/*/; do
  if [ -d "${repo}.git" ]; then
    name=$(basename "${repo%/}")
    ln -sfn "../${SOURCE_FOLDER}/${name}" "${name}"
  fi
done
cd -
```

### 5. Write container.json

Copy the source's tool list (so the sibling inherits the same MCP servers + integrations), set `provider: "codex"`, and drop `dailySummary` (no duplicate roll-ups).

```bash
# Edit values to match your source group; "tools" should mirror the source.
cat > groups/${SIBLING_FOLDER}/container.json <<EOF
{
  "provider": "codex",
  "mcpServers": {},
  "packages": { "apt": [], "npm": [] },
  "additionalMounts": [],
  "skills": "all",
  "groupName": "${SIBLING_FOLDER}",
  "assistantName": "${SIBLING_FOLDER}",
  "agentGroupId": "${SIBLING_ID}",
  "credentialFolder": "${SOURCE_FOLDER}",
  "gitnexusInjectAgentsMd": true,
  "tools": [],
  "memory": { "enabled": true },
  "codexHostAuth": true
}
EOF

# Manually copy the "tools" array (and any "additionalMounts") from
# groups/${SOURCE_FOLDER}/container.json — the operator decides which tools
# are appropriate for the codex sibling.
```

**Why `credentialFolder`**: container-runner's per-group credential lookups
(LOOKER_*, DBT_*, GITHUB_TOKEN_*, RENDER_PG_*, GIT_AUTHOR_*, Claude OAuth,
Snowflake, etc.) key on `<BASE>_<FOLDER_UPPER>`. Without this field a
sibling folder like `madison-reed-codex` would look for
`LOOKER_BASE_URL_MADISON_REED_CODEX`, which doesn't exist — leaving the
codex sibling stripped of every per-group credential. `credentialFolder`
redirects ONLY the credential lookups to the source folder; identity-bound
paths (container name, group dir mount, MNEMON_STORE override) stay on
the sibling's own folder. The Codex auth dir lookup (~/.codex-<folder>/)
also stays on the sibling's folder so per-sibling Codex accounts work
correctly.

### 6a. Per-group Codex account (optional — skip for shared account)

By default, every codex-provider container mounts the host's primary `~/.codex/` (single OpenAI/ChatGPT account shared across groups). To run this sibling on a **different OpenAI account** — e.g., a client's MR-codex account distinct from your personal one — create a scoped `~/.codex-<sibling-folder>/` dir on the host:

```bash
# Codex refuses to start if CODEX_HOME doesn't already exist, so create
# the dir first. Then login launches a browser, you authenticate against
# a SEPARATE OpenAI/ChatGPT account, and auth.json lands in the scoped
# dir. Requires browser auth — run from a host terminal, not from inside
# a container or Claude Code subshell.
mkdir -p ~/.codex-${SIBLING_FOLDER}
CODEX_HOME=~/.codex-${SIBLING_FOLDER} codex login
```

`container-runner.ts:resolveCodexAuthDir` resolves `~/.codex-${SIBLING_FOLDER}/auth.json` first; falls back to the global `~/.codex/` when the scoped dir is absent. No env var to set, no container.json field to flip — just create the dir.

Mirrors the per-group OAuth pattern Claude already uses via scoped `CLAUDE_CODE_OAUTH_TOKEN_<FOLDER>` env vars (see `resolveAnthropicAuth`).

### 6. Scoped MNEMON_STORE override

Routes the sibling's memory writes to the source group's existing store. The override value is the source's **ag-id** (not folder), because `container-runner.ts` defaults `MNEMON_STORE` to `agentGroup.id`.

```bash
ENV_KEY=MNEMON_STORE_$(echo "${SIBLING_FOLDER}" | tr 'a-z-' 'A-Z_')
if grep -q "^${ENV_KEY}=" .env; then
  sed -i.bak "s|^${ENV_KEY}=.*|${ENV_KEY}=${SOURCE_ID}|" .env
else
  echo "${ENV_KEY}=${SOURCE_ID}" >> .env
fi
grep "^${ENV_KEY}=" .env
```

### 7. Insert the agent_groups row

`agent_groups.created_at` is `NOT NULL` with no default.

`agent_groups.name` should match `id` and `folder` — the workspace
convention (`<source>-codex`), NOT the Slack/Discord bot display name.
The bot display name is platform-side (configured at api.slack.com/apps
or the Discord dev portal) and is purely how chat users see the avatar;
mixing the two leaves the dashboard with inconsistent groupings (e.g.
`illie-codex` next to `axie-dev-codex` instead of `illysium-codex`). The
host-side container-config sync at `container-runner.ts:1519-1525` reads
`agent_groups.name` into `containerConfig.assistantName`, so this is also
the string the agent sees as its own self-reference in the system prompt.

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

EXISTING=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SIBLING_FOLDER}'" 2>/dev/null | tr -d '\n')
if [ -z "${EXISTING}" ]; then
  pnpm exec tsx scripts/q.ts data/v2.db \
    "insert into agent_groups (id, folder, name, agent_provider, created_at) values ('${SIBLING_ID}', '${SIBLING_FOLDER}', '${SIBLING_ID}', 'codex', '${NOW}')"
fi
```

### 8. Restart the host so the new adapter + env vars get picked up

```bash
sudo systemctl restart nanoclaw-v2
```

Wait ~5 seconds. On restart, the chat adapter sees `<PLATFORM>_BOT_TOKEN_${ENV_SUFFIX}` and registers a new channelType (`slack-${env_suffix-lowercased}` or `discord-${env_suffix-lowercased}`).

### 9. Wire the sibling to the desired channels

The `register` step in `setup/index.ts` is channel-agnostic and creates the
`messaging_groups`, `messaging_group_agents`, and `agent_destinations` rows
in the right shape. Use it for both platforms — don't hand-insert.

#### Slack path

The sibling needs to be added to the relevant Slack channels FROM SLACK first — invite the new bot user (e.g. `@illie-codex`) to `#agents-xzo` and any other channels you want it to operate in.

The source bot keeps its own `messaging_group_agents` row in the existing `slack-<source>` channelType — untouched by this skill. Both bots share the channel physically; their NanoClaw routing is separate.

Wire each desired physical Slack channel through the host `register` step, not by raw-inserting `messaging_group_agents`. The register path calls `createMessagingGroupAgent()`, which also creates the companion `agent_destinations` row the container needs for `<message to="...">` routing and origin-fallback.

```bash
SLACK_CHANNEL_ID=C0AJA89MN2E                  # Slack channel id for #agents-xzo
SLACK_CHANNEL_NAME=agents-xzo

pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "slack:${SLACK_CHANNEL_ID}" \
  --name "#${SLACK_CHANNEL_NAME}" \
  --folder "${SIBLING_FOLDER}" \
  --channel "${CHANNEL_TYPE}" \
  --session-mode "per-thread" \
  --assistant-name "${DISPLAY_NAME}"
```

If a `messaging_group_agents` row was already hand-inserted and the sibling fires but cannot send, repair the missing destination row explicitly. Use this only as a repair; new wiring should go through `register`.

```bash
DESTINATION_NAME=${SLACK_CHANNEL_NAME}
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

pnpm exec tsx scripts/q.ts data/v2.db "
insert into agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
select '${SIBLING_ID}', '${DESTINATION_NAME}', 'channel', mg.id, coalesce(mga.created_at, '${NOW}')
from messaging_groups mg
join messaging_group_agents mga
  on mga.messaging_group_id = mg.id
 and mga.agent_group_id = '${SIBLING_ID}'
where mg.channel_type = '${CHANNEL_TYPE}'
  and mg.platform_id = 'slack:${SLACK_CHANNEL_ID}'
  and not exists (
    select 1
    from agent_destinations ad
    where ad.agent_group_id = '${SIBLING_ID}'
      and ad.target_type = 'channel'
      and ad.target_id = mg.id
  )
  and not exists (
    select 1
    from agent_destinations ad
    where ad.agent_group_id = '${SIBLING_ID}'
      and ad.local_name = '${DESTINATION_NAME}'
  )
"
```

After repairing an already-active session, send a new mention or restart the host/container so `writeDestinations()` refreshes the session-local `destinations` projection. The central `agent_destinations` table is the source of truth, but running containers read the projection in their `inbound.db`.

#### Discord path

The sibling bot must already be in the guild (you invited it in Step 2). Discord doesn't have per-channel invite — once the bot has the right guild-level permissions, it sees every channel its role can access.

Wire each Discord channel where you want the codex twin to fire. Discord's `platform_id` format is `discord:{guildId}:{channelId}` — both ids are required. Enable Developer Mode in Discord client to copy them via right-click.

```bash
DISCORD_GUILD_ID=1479489865702703155          # right-click server → Copy Server ID
DISCORD_CHANNEL_ID=1479516831168593974        # right-click channel → Copy Channel ID
DISCORD_CHANNEL_NAME=illysium                 # for the agent_destinations.local_name

pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}" \
  --name "#${DISCORD_CHANNEL_NAME}" \
  --folder "${SIBLING_FOLDER}" \
  --channel "${CHANNEL_TYPE}" \
  --session-mode "per-thread" \
  --assistant-name "${DISPLAY_NAME}"
```

The `register` step defaults `engage_mode='mention'` for group channels — sibling-safe (only fires on explicit `@`-mention, no sticky lurking). This is what you want for siblings; sticky combined with two bots in the same thread risks runaway loops where each bot wakes on the other's reply via session existence.

> **Important — owner role under the new channelType namespace.** When the host receives an inbound from the sibling bot, the sender's user-id is namespaced by the new channel_type (e.g. `discord-axie-codex:608746260706361344` instead of `discord:608746260706361344`). Existing `user_roles` rows are scoped to the OLD namespace, so the new bot sees the sender as an unknown user. For channels with `unknown_sender_policy='strict'` (channel-root DMs, denied channels), this drops the message silently with no agent reply.
>
> Mirror your existing global owner roles under the new namespace as a one-shot SQL:

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GRANTER=$(pnpm exec tsx scripts/q.ts data/v2.db "select user_id from user_roles where role='owner' and agent_group_id is null order by granted_at desc limit 1" | tr -d '\n')

# Mirror every global owner under 'discord:' into the new sibling namespace.
# Idempotent — INSERT OR IGNORE skips rows that already exist.
pnpm exec tsx scripts/q.ts data/v2.db "
INSERT OR IGNORE INTO users (id, kind, display_name)
SELECT replace(u.id, 'discord:', '${CHANNEL_TYPE}:'), '${CHANNEL_TYPE}', u.display_name
FROM users u
JOIN user_roles ur ON ur.user_id = u.id
WHERE ur.role = 'owner' AND ur.agent_group_id IS NULL
  AND u.id LIKE 'discord:%'
"

pnpm exec tsx scripts/q.ts data/v2.db "
INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
SELECT replace(ur.user_id, 'discord:', '${CHANNEL_TYPE}:'), 'owner', NULL, '${GRANTER}', '${NOW}'
FROM user_roles ur
WHERE ur.role = 'owner' AND ur.agent_group_id IS NULL
  AND ur.user_id LIKE 'discord:%'
"
```

This is unique to Discord because Discord's primary channelType is bare `discord` — so adding a Discord sibling introduces a new namespace (`discord-<suffix>`) that existing owner roles don't cover. Slack's primary channelType is already workspace-scoped (`slack-<workspace>`), so adding a Slack sibling under `slack-<workspace>-codex` inherits owner roles correctly through the existing per-workspace user_roles rows; no mirror needed.

### 10. Verify

#### Slack path

In a Slack channel where both bots have been invited, post a message:

- `@<source> hello` → source agent fires (the existing illie bot).
- `@<sibling-slack-name> hello` → sibling agent fires (the new codex bot).
- `@<source> can you @<sibling-slack-name> help with this?` → both fire (each on its own real mention).

If the sibling fires once but never picks up a follow-up `@`-mention from the source agent, check that:
- The sibling bot user is invited to that Slack channel.
- The source bot user is *also* invited (same channel).
- Both apps subscribe to `message.channels` (per the add-slack skill).

#### Discord path

In a Discord channel where both bots are in the guild, post a message:

- `@<source-bot-name> hello` → source agent fires.
- `@<sibling-bot-name> hello` → sibling agent fires.
- `@<source-bot-name> can you @<sibling-bot-name> help with this?` → both fire (each on its own real mention).

If the sibling responds but the back-and-forth handoff doesn't continue, check:
- Both bots are in the guild (member list) with permission to read messages in the channel.
- The bot was given `Message Content Intent` in the Discord developer portal.
- `groups/${SIBLING_FOLDER}/AGENTS.md` was composed cleanly (no `agents-md-flatten: failed` markers). If it was, the sibling-handoff guidance may be truncated; redeploy and respawn the container.

> **Mention syntax**: agents write bare `@<bot-username>` in their reply. The Discord adapter's outbound rewriter (`resolveDiscordMentions` in `src/channels/discord.ts`) converts that to a real `<@SNOWFLAKE_ID>` mention before posting. Agents do not need to know the snowflake. The rewriter also tolerates the bracketed-by-name form `<@<bot-username>>` as a safety net, so both `@Axie-codex` and `<@Axie-codex>` resolve correctly.

## Reverting

Assumes you still have `SOURCE_FOLDER`, `SOURCE_ID`, `SIBLING_FOLDER`, `SIBLING_ID`, `ENV_SUFFIX`, `CHANNEL_TYPE` from the install.

```bash
sudo systemctl stop nanoclaw-v2

# Drop wiring + agent_groups row (both platforms — uses CHANNEL_TYPE).
pnpm exec tsx scripts/q.ts data/v2.db "delete from agent_destinations where agent_group_id='${SIBLING_ID}' or (target_type='channel' and target_id in (select id from messaging_groups where channel_type='${CHANNEL_TYPE}'))"
pnpm exec tsx scripts/q.ts data/v2.db "delete from messaging_group_agents where agent_group_id='${SIBLING_ID}'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from messaging_groups where channel_type='${CHANNEL_TYPE}'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from agent_groups where id='${SIBLING_ID}'"

# Drop the symlink tree.
rm -rf groups/${SIBLING_FOLDER}

# Drop env entries — run ONE of these blocks depending on your channel.
ENV_KEY=MNEMON_STORE_$(echo "${SIBLING_FOLDER}" | tr 'a-z-' 'A-Z_')

# Slack sibling:
sed -i.bak \
  -e "/^${ENV_KEY}=/d" \
  -e "/^SLACK_BOT_TOKEN_${ENV_SUFFIX}=/d" \
  -e "/^SLACK_SIGNING_SECRET_${ENV_SUFFIX}=/d" .env

# Discord sibling (alternative — drop these lines instead of the SLACK_* ones):
sed -i.bak \
  -e "/^${ENV_KEY}=/d" \
  -e "/^DISCORD_BOT_TOKEN_${ENV_SUFFIX}=/d" \
  -e "/^DISCORD_APPLICATION_ID_${ENV_SUFFIX}=/d" \
  -e "/^DISCORD_PUBLIC_KEY_${ENV_SUFFIX}=/d" .env

# Discord-only — drop mirrored owner roles (harmless to leave; this is for full cleanup).
pnpm exec tsx scripts/q.ts data/v2.db "delete from user_roles where user_id like '${CHANNEL_TYPE}:%'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from users where id like '${CHANNEL_TYPE}:%'"

sudo systemctl start nanoclaw-v2
```

Optionally, uninstall the sibling's bot app from the platform — `api.slack.com/apps` for Slack, `discord.com/developers/applications` for Discord.

## Notes

- `composeGroupClaudeMd` (host-side, runs every container spawn) regenerates `groups/${SIBLING_FOLDER}/AGENTS.md` from the same CLAUDE.md the source group uses, with `@-includes` resolved inline for Codex. No manual AGENTS.md authoring.
- The codex container reads MCP server config from `~/.codex/config.toml` (regenerated each session by `writeCodexMcpConfigToml`) and hook config from `~/.codex/hooks.json` (regenerated each session by `writeCodexHooksJson`).
- Worktrees are thread-scoped when `NANOCLAW_THREAD_WORKTREES=1` is in `.env`. The mount key is platform-derived (`<base>/<thread-id-or-dm-platform>/worktrees/`), so both bots' MGs in the same platform thread resolve to the same path. Uncommitted edits from one sibling are visible to the other via `git status`.
- Concurrent git operations across siblings: the shared worktree has standard git internal locks (`.git/index.lock`). Turn-taking via the `@`-mention pattern mitigates by design — only one sibling is active per turn after a hand-off. If both fire on the same user message (`@illie @illie-codex collab`), git ops can race; failures are loud (`fatal: Unable to create '.git/index.lock'`) and the agent retries.
- **Joint mentions and race conditions**: when a user `@`-mentions both siblings in one message, both wake in parallel. Whichever finishes generating first posts first; the second-to-finish sees the first's reply via session inbound and (per CLAUDE.md guidance) accommodates by picking a different slice. This accommodation depends on the second container being slower than the first's complete reply — typically true since Codex's reasoning phase adds latency vs Claude's faster time-to-first-token. If both happen to finish near-simultaneously, you can see both claim the same slice. The mitigation is in the prompt — explicit framing like "illie you start" forces ordering — not in the router.

### Known limitation: Codex Bash secret sanitization is a no-op

The Claude provider's `createSanitizeBashHook` returns `hookSpecificOutput.updatedInput` with an `unset ANTHROPIC_API_KEY ...` prefix before every Bash command. Per the Codex hooks docs (developers.openai.com/codex/hooks), Codex parses `updatedInput` but does **not** apply it — the hook fails open. So a Codex container can `printenv` and see the OAuth tokens / API keys passed to it.

Mitigations in place that do work for Codex:
- Host-side `scrubSecrets` on outbound delivery filters registered secret values out of chat replies.
- OneCLI proxy intercepts most HTTPS egress; secrets in headers/URLs that route through it get logged + gated.
- The container is single-tenant — only the operator's own agents run in it, no adversarial workloads.

Not mitigated: an agent that bypasses the proxy (NO_PROXY) and exfiltrates via direct HTTP to a remote it controls. Proper fix is to rewrite the Codex container's env before launch — out of scope for the pilot.

### Discord-specific: bot filter relaxation

Trunk ships a `pnpm patch` on `@chat-adapter/discord` (`patches/@chat-adapter__discord@4.26.0.patch`) that relaxes the upstream "drop all bot-authored messages" filter to "drop only self-echoes, or non-sibling bots." The sibling-allowlist is populated by `src/channels/discord.ts` via a process-wide `globalThis.__nanoclawDiscordSiblings` Set, one entry per bot identity fetched at adapter init via `GET /users/@me`.

For sibling collab to work in Discord, both bots must be loaded in the same host process (which is the default — both `DISCORD_BOT_TOKEN` and `DISCORD_BOT_TOKEN_<SUFFIX>` are read at startup). A third-party Discord bot in the same guild (e.g. MEE6, a webhook bot) is NOT in the allowlist, so its messages do not wake any NanoClaw agent. Operators with chatty third-party bots may want a custom allowlist; today the boundary is "bots my host loaded = trusted."

## Future work — captured for later, not in scope today

### 1. Flip primary provider (Claude-nerf resilience)

The Claude-as-canonical / Codex-as-sibling split is just symlink direction + `messaging_group_agents` rows. Three escape hatches if the Claude Max subscription gets squeezed:

- **Drop Claude side**: delete the source's `messaging_group_agents` rows; the codex sibling stays wired to the same channels. `@<source>` just stops responding; `@<sibling-name>` continues. Shared store + repos stay put. ~30 seconds of SQL.
- **Flip canonical**: `mv groups/<source> groups/<source>.tmp && mv groups/<source>-codex groups/<source> && ...` — relink symlinks the other way. ~10 min of mechanical work.
- **Inverse skill**: a `clone-as-claude` skill that takes a codex-backed source group and creates a Claude-backed sibling. Currently a copy of `/clone-as-codex` with provider strings flipped.

Decision criteria for picking the right path when the time comes: cost trajectory of each provider, parity quality of the codex-side guardrails (Stage 2 should hold up), whether you want to keep both for redundancy or commit to one. Don't pre-build any of this — flipping is cheaper than the abstraction.

### 2. Generalize this skill → `/clone-agent-as-provider <source> <provider>`

Today `/clone-as-codex` hardcodes `provider: "codex"`. A generalized version would take the provider as an argument:

```
/clone-agent-as-provider illie opencode    # creates illie-opencode
/clone-agent-as-provider illie claude      # for codex-canonical → claude sibling
```

Implementation when it's worth doing:
- Parameterize the sibling folder suffix (default to `-<provider>`).
- Parameterize `container.json` `provider` value.
- Wrap the existing steps in a single skill that takes `(source, provider)`.
- Migrate the existing `/clone-as-codex` to be a thin alias.

Punt until there's a second non-Claude provider in production.
