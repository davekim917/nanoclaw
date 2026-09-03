---
name: clone-as-codex
description: Create a Codex-backed sibling agent for an existing Claude group. The sibling joins the source workgroup and shares its CLAUDE.md, repos, sources, and conversations. Cross-agent collaboration happens via standard platform `@`-mentions — requires installing a second bot app for the sibling so each agent has its own real bot user. Works on Slack and Discord.
---

# Clone Group As Codex Sibling

Create `groups/<source>-codex/` from `groups/<source>/`. The codex sibling shares:

- **CLAUDE.md** — regenerated per-group by composeGroupClaudeMd on every spawn (do NOT symlink — the composer overwrites it); AGENTS.md flat-include is derived from it for Codex.
- **Workgroup memory canon** — `data/workgroups/<workgroup-id>/memory` on the
  host and `/workspace/workgroup/memory` in every sibling container.
  `/workspace/agent/memory` is only the compatibility link.
- **CLAUDE.local.md** — symlinked to the source file when present so its
  standing instruction state is preserved byte-for-byte. It is not a memory
  root and never becomes part of the workgroup memory canon.
- **Repos** — symlinked top-level dirs that contain `.git/`.
- **sources/** — ordinary knowledge files, shared across the workgroup.
- **conversations/** — transcript archive; both agents see each other's archived turns.
- **Thread worktree** — when `NANOCLAW_THREAD_WORKTREES=1`, both siblings in the same platform thread mount the same `data/v2-threads/<thread-id>/worktrees/<repo>/` host path. Uncommitted edits flow across.

> Under workgroup shared-FS (`data/workgroups/<wg>/.migrated` present), the **Repos / sources / conversations** links point at the container-absolute `/workspace/workgroup/<name>` mount instead of `../<source>/` — Step 4 detects the mode and reproduces exactly what `reconcileWorkgroupSharedDirs` already did for the existing siblings. **CLAUDE.local.md** stays a relative link in both modes because it is group/provider instruction state, not memory.

`container.json` for the new sibling gets `provider: "codex"` and `memory.enabled: true`.

**One-memory invariant.** Every current and future sibling — Claude, Codex,
OpenCode, or another provider — joins the source workgroup. Workgroup membership
therefore makes it inherit the one workgroup memory canon; cloning never creates
a provider-owned copy. Once the workgroup canon is active, no memory migration
is part of cloning or a later provider-role change.

**Capability parity invariant for new siblings.** A Codex sibling must inherit
the source group's NanoClaw capability surface unless a provider/runtime
architecture block is named explicitly. That means Step 5 preserves
`mcpServers`, `tools`, `onecliSecrets`, mounts, skills, and other
non-sibling-bound fields by construction. It also means no Codex-specific MCP
downgrade: stdio MCPs stay stdio, Streamable HTTP MCPs stay native HTTP,
deprecated SSE is invalid, and `remote-mcp-bridge` is only an explicitly
documented compatibility exception. Browser automation is part of that baseline:
the shared agent image exposes `agent-browser` to login shells, so a newly
spawned Codex sibling should have the same `agent-browser open/snapshot/click`
workflow as Claude and OpenCode, not just ad hoc Puppeteer.

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
SOURCE_FOLDER=<source-folder>             # e.g. example-labs
SOURCE_ID=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SOURCE_FOLDER}'" | tr -d '\n')
test -n "${SOURCE_ID}" || { echo "ERROR: source group '${SOURCE_FOLDER}' not found"; exit 1; }
# Workgroup the sibling must JOIN — the SOURCE's workgroup, not the sibling's
# own folder. This is what grants shared chat-archive and
# workgroup-level OneCLI secrets. For a primary source it equals the folder;
# clone from another sibling and it still resolves to the shared workgroup.
SOURCE_WORKGROUP=$(pnpm exec tsx scripts/q.ts data/v2.db "select coalesce(workgroup_id, folder) from agent_groups where folder='${SOURCE_FOLDER}'" | tr -d '\n')
test -n "${SOURCE_WORKGROUP}" || { echo "ERROR: could not resolve workgroup for '${SOURCE_FOLDER}'"; exit 1; }
echo "Source folder:    ${SOURCE_FOLDER}"
echo "Source ag-id:     ${SOURCE_ID}"
echo "Source workgroup: ${SOURCE_WORKGROUP}"
```

### 2. Install the sibling's bot app

#### Slack path

Follow `.claude/skills/add-slack/SKILL.md` to install a new app in the same workspace where the source agent's bot lives. **Name the bot user something distinct but discoverable** — using the source name with a suffix (e.g. `helper-codex` when source is `helper`) makes Slack's `@`-autocomplete group them together for the user.

Required bot scopes (per add-slack skill step 6): `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `reactions:read`, `users:read`.

Required bot events (step 10): `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_mention`.

Set the Request URL to the same `https://<your-domain>/webhook/slack` as the existing source app — the host's webhook router dispatches by Slack app id, not by URL path.

After installing the new app to the workspace, capture the **bot token** (`xoxb-...`) and **signing secret** from the Slack app settings.

> **Note on naming**: the Slack-side bot display name (`helper-codex`), the env-var suffix (`EXAMPLE_LABS_CODEX`), and the resulting channelType (`slack-example-labs-codex`) are independent but conventionally aligned. The adapter accepts uppercase + underscores in the suffix and maps `_` → `-` when deriving the channelType, so `SLACK_BOT_TOKEN_EXAMPLE_LABS_CODEX` becomes `slack-example-labs-codex` — symmetric with the existing `SLACK_BOT_TOKEN_EXAMPLE_LABS` → `slack-example-labs`.

#### Discord path

Create a new Discord application at [discord.com/developers/applications](https://discord.com/developers/applications) — separate from the primary bot's app. **Name the bot user something distinct but discoverable** — e.g. `Example Agent-Codex` when the primary is `Example Agent`. Discord shows the bot user name with every message, so this is what the user sees in chat.

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

Pick an `ENV_SUFFIX` that mirrors the source's suffix with `_CODEX` appended (e.g. existing `EXAMPLE_LABS` → new `EXAMPLE_LABS_CODEX`). Uppercase alphanumeric + underscores. The host's adapter discovers it on next restart.

```bash
ENV_SUFFIX=EXAMPLE_LABS_CODEX                 # uppercase, underscores OK
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
SIBLING_ID=${SIBLING_FOLDER}                # use folder name as ag-id, matching host-default groups (main, example-dev)

# Has the source's workgroup been consolidated by the shared-FS migration
# (reconcileWorkgroupSharedDirs)? The `.migrated` marker is the same signal
# container-runner keys off to mount data/workgroups/<wg> at /workspace/workgroup,
# so testing it keeps the sibling consistent with the host even if the
# WORKGROUP_SHARED_FS flag is later toggled. Resolve to an absolute path now —
# we cd into the sibling dir below.
WG_DIR_ABS="$(pwd)/data/workgroups/${SOURCE_WORKGROUP}"

mkdir -p groups/${SIBLING_FOLDER}
cd groups/${SIBLING_FOLDER}

# Shared standing instructions: preserve the source's CLAUDE.local.md
# byte-for-byte. This is group/provider instruction state, not memory. It is a
# loose FILE, so a RELATIVE symlink is correct in BOTH shared-FS modes and
# container-runner realpath-overlays it into the sibling container. Conditional
# — if the source has none, leave it absent and let composeGroupClaudeMd create
# an empty one at first spawn. Do NOT symlink CLAUDE.md: the composer overwrites
# it every spawn.
[ -f ../${SOURCE_FOLDER}/CLAUDE.local.md ] && ln -sfn ../${SOURCE_FOLDER}/CLAUDE.local.md CLAUDE.local.md

if [ -f "${WG_DIR_ABS}/.migrated" ]; then
  # Shared-FS live: the source's repos + sources + conversations have moved to
  # data/workgroups/<wg>/ and are referenced via the CONTAINER-ABSOLUTE compat
  # symlink `<name> -> /workspace/workgroup/<name>`. Emit the SAME symlink for
  # this sibling — a relative `../${SOURCE_FOLDER}/<name>` would dangle in the
  # sibling's container (the source dir isn't mounted there), and the repo probe
  # below can't see `.git/` through the source's now-dangling compat symlinks
  # anyway. These dangle on the host (container-runner's symlink-overlay skips
  # them) and resolve via the /workspace/workgroup mount in-container — identical
  # to what reconcileWorkgroupSharedDirs produces for the already-migrated siblings.
  for entry in "${WG_DIR_ABS}"/*/; do
    [ -d "${entry}" ] || continue          # dirs only; skips the `.migrated` file + an empty glob
    name=$(basename "${entry%/}")
    ln -sfn "/workspace/workgroup/${name}" "${name}"
  done
else
  # Pre-shared-FS: RELATIVE symlinks into the source dir; container-runner
  # realpath-overlays each one into the sibling container as a bind mount.
  [ -d ../${SOURCE_FOLDER}/sources ] && ln -sfn ../${SOURCE_FOLDER}/sources sources
  [ -d ../${SOURCE_FOLDER}/conversations ] && ln -sfn ../${SOURCE_FOLDER}/conversations conversations
  # Repo symlinks (every dir that contains .git/).
  for repo in ../${SOURCE_FOLDER}/*/; do
    if [ -d "${repo}.git" ]; then
      name=$(basename "${repo%/}")
      ln -sfn "../${SOURCE_FOLDER}/${name}" "${name}"
    fi
  done
fi
cd -
```

### 5. Write container.json

Construct the sibling's container.json from the source capability surface, then
replace identity/provider-bound fields. Preserve the source resource budget as
the safe clone-time baseline; resources are operator-tunable afterward and are
not a capability-parity invariant. Preserve `slack_user_token.enabled`, but
remove `also_allowed_in` because those exact messaging-group IDs belong to the
source adapter and must never be copied to a sibling. The sibling-bound set and
semantic comparison live in `src/sibling-parity.ts`.

This is also the MCP parity step. Do not rewrite `mcpServers` while cloning:
the runtime now supports the native matrix across all three providers
(stdio -> stdio, `type: "http"` -> native Streamable HTTP, `type: "sse"` ->
hard reject). If the source still contains an old `remote-mcp-bridge` entry,
carry it only as a named architecture-block exception and prefer converting the
source to `type: "http"` before cloning when the server supports Streamable
HTTP.

```bash
# Preserve shared capabilities and resource baseline; replace sibling identity/provider state.
jq --arg folder "${SIBLING_FOLDER}" --arg src "${SOURCE_FOLDER}" '
  del(.groupName, .assistantName, .agentGroupId, .credentialFolder, .provider,
      .codexHostAuth, .codexAuthFallbacks, .model, .effort, .imageTag,
      .defaultModel, .defaultEffort, .maxMessagesPerPrompt, .memory, .dailySummary)
  | if (.slack_user_token | type) == "object" then
      .slack_user_token |= del(.also_allowed_in)
    else . end
  | { provider: "codex" } + .
  | .groupName = $folder
  | .assistantName = $folder
  | .agentGroupId = $folder
  | .credentialFolder = $src
  | .memory = { "enabled": true }
  | .codexHostAuth = true
' groups/${SOURCE_FOLDER}/container.json > /tmp/cj-sibling.json && \
  mv /tmp/cj-sibling.json groups/${SIBLING_FOLDER}/container.json

# Verify parity — only sibling-bound fields may differ (clean by construction).
DEL='del(.groupName,.assistantName,.agentGroupId,.credentialFolder,.provider,.codexHostAuth,.codexAuthFallbacks,.model,.effort,.imageTag,.defaultModel,.defaultEffort,.maxMessagesPerPrompt,.resources,.memory,.dailySummary,.workgroup_id) | if (.slack_user_token | type) == "object" then .slack_user_token |= del(.also_allowed_in) else . end'
diff <(jq -S "$DEL" groups/${SOURCE_FOLDER}/container.json) \
     <(jq -S "$DEL" groups/${SIBLING_FOLDER}/container.json) && echo "  ✅ parity clean" || true
```

**Why `credentialFolder`**: container-runner's per-group credential lookups
(LOOKER_*, DBT_*, GITHUB_TOKEN_*, RENDER_PG_*, GIT_AUTHOR_*, Claude OAuth,
Snowflake, etc.) key on `<BASE>_<FOLDER_UPPER>`. Without this field a
sibling folder like `example-retail-codex` would look for
`LOOKER_BASE_URL_EXAMPLE_RETAIL_CODEX`, which doesn't exist — leaving the
codex sibling stripped of every per-group credential. `credentialFolder`
redirects ONLY the credential lookups to the source folder; identity-bound
paths (container name and group dir mount) stay on
the sibling's own folder. The Codex auth dir lookup (~/.codex-<folder>/)
also stays on the sibling's folder so per-sibling Codex accounts work
correctly.

### 6. Per-group Codex account (optional — skip for shared account)

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

### 7. Insert the agent_groups row

`agent_groups.created_at` is `NOT NULL` with no default.

**`workgroup_id` is the load-bearing field.** It places the sibling in the SAME workgroup as its source, granting the same memory canon, shared chat-archive visibility plus workgroup-level OneCLI-secret inheritance. It lives on the `agent_groups` row, NOT in `container.json` (`reconcileWorkgroupAtSpawn` reads the DB value; putting it in container.json would trip the parity-check since `workgroup_id` is not a sibling-bound field). Migration 036 auto-paired the codex siblings that pre-dated it — but it has already run and won't re-run, so a codex sibling created TODAY without this column is isolated in its own workgroup-of-one.

`agent_groups.name` should match `id` and `folder` — the workspace
convention (`<source>-codex`), NOT the Slack/Discord bot display name.
The bot display name is platform-side (configured at api.slack.com/apps
or the Discord dev portal) and is purely how chat users see the avatar;
mixing the two leaves the dashboard with inconsistent groupings (e.g.
`helper-codex` next to `example-dev-codex` instead of `example-labs-codex`). The
host-side container-config sync at `container-runner.ts:1519-1525` reads
`agent_groups.name` into `containerConfig.assistantName`, so this is also
the string the agent sees as its own self-reference in the system prompt.

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

EXISTING=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SIBLING_FOLDER}'" 2>/dev/null | tr -d '\n')
if [ -z "${EXISTING}" ]; then
  pnpm exec tsx scripts/q.ts data/v2.db \
    "insert into agent_groups (id, folder, name, agent_provider, workgroup_id, created_at) values ('${SIBLING_ID}', '${SIBLING_FOLDER}', '${SIBLING_ID}', 'codex', '${SOURCE_WORKGROUP}', '${NOW}')"
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

The sibling needs to be added to the relevant Slack channels FROM SLACK first — invite the new bot user (e.g. `@helper-codex`) to `#agents-example` and any other channels you want it to operate in.

The source bot keeps its own `messaging_group_agents` row in the existing `slack-<source>` channelType — untouched by this skill. Both bots share the channel physically; their NanoClaw routing is separate.

Wire each desired physical Slack channel through the host `register` step, not by raw-inserting `messaging_group_agents`. The register path calls `createMessagingGroupAgent()`, which also creates the companion `agent_destinations` row the container needs for `<message to="...">` routing and origin-fallback.

```bash
SLACK_CHANNEL_ID=CTEST00004                  # Slack channel id for #agents-example
SLACK_CHANNEL_NAME=agents-example

pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "slack:${SLACK_CHANNEL_ID}" \
  --name "#${SLACK_CHANNEL_NAME}" \
  --folder "${SIBLING_FOLDER}" \
  --channel "${CHANNEL_TYPE}" \
  --session-mode "per-thread" \
  --assistant-name "${SIBLING_ID}"
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
DISCORD_GUILD_ID=123456789000000002          # right-click server → Copy Server ID
DISCORD_CHANNEL_ID=123456789000000004        # right-click channel → Copy Channel ID
DISCORD_CHANNEL_NAME=example-labs                 # for the agent_destinations.local_name

pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}" \
  --name "#${DISCORD_CHANNEL_NAME}" \
  --folder "${SIBLING_FOLDER}" \
  --channel "${CHANNEL_TYPE}" \
  --session-mode "per-thread" \
  --assistant-name "${SIBLING_ID}"
```

The `register` step defaults `engage_mode='mention'` for group channels — sibling-safe (only fires on explicit `@`-mention, no sticky lurking). This is what you want for siblings; sticky combined with two bots in the same thread risks runaway loops where each bot wakes on the other's reply via session existence.

> **Important — owner role under the new channelType namespace.** When the host receives an inbound from the sibling bot, the sender's user-id is namespaced by the new channel_type (e.g. `discord-example-agent-codex:123456789000000019` instead of `discord:123456789000000019`). Existing `user_roles` rows are scoped to the OLD namespace, so the new bot sees the sender as an unknown user. For channels with `unknown_sender_policy='strict'` (channel-root DMs, denied channels), this drops the message silently with no agent reply.
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

> **Functional checks first — the parity audit (step 11) is structural and will
> NOT catch the two runtime failures siblings can hit:**
> 1. **Double-prefixed `platform_id`** → delivery fails with `Invalid
>    Discord/Slack thread ID`. The register step prepends the channel_type even
>    when the adapter already base-prefixed the id. (Direct-inserting the
>    messaging group avoids it; the `setup register` path does not.)
> 2. **Auth not wired** → the agent replies with an auth/`Error:` message instead
>    of content. Only a real agent turn reproduces it.

**Check A — `platform_id` is not double-prefixed (deterministic, no spawn):**

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
SELECT CASE WHEN mg.platform_id LIKE mg.channel_type || ':%'
            THEN '❌ DOUBLE-PREFIXED: ' || mg.platform_id || '  → strip the channel_type prefix (UPDATE messaging_groups SET platform_id=...)'
            ELSE '✅ platform_id ok: ' || mg.platform_id END
FROM messaging_groups mg
JOIN messaging_group_agents mga ON mga.messaging_group_id=mg.id
WHERE mga.agent_group_id='${SIBLING_FOLDER}'"
```

**Check B — live round-trip (the only check that exercises model + auth + delivery):**

Send a test @-mention in the sibling's channel: `@<sibling-bot-name> reply with the single word OK`. Then assert the response was not an error:

```bash
SDIR=$(ls -dt data/v2-sessions/${SIBLING_FOLDER}/sess-* 2>/dev/null | head -1)
pnpm exec tsx scripts/q.ts "$SDIR/outbound.db" "SELECT content FROM messages_out ORDER BY rowid DESC LIMIT 1" \
  | grep -qiE "not authenticated|Invalid API key|401|Error:" \
  && echo "❌ sibling returned an error — check codex auth (codexHostAuth) then 'ncl groups restart --id ${SIBLING_ID}'" \
  || echo "✅ sibling produced a clean response — round-trip verified"
```

Check A is deterministic and should be ✅ before you announce the sibling. Check B is the end-to-end seal.

**Check C - running sibling has the shared global CLI surface:**

This catches custom `imageTag` drift and the historical `agent-browser` PATH
miss. Run it after Check B has caused a sibling container to spawn.

```bash
CNAME=$(docker ps --filter "name=nanoclaw-v2-${SIBLING_FOLDER}-" --format '{{.Names}}' | head -1)
test -n "$CNAME" || { echo "ERROR: no running sibling container - send the live round-trip first"; exit 1; }
docker exec "$CNAME" bash -lc 'command -v agent-browser && agent-browser --version'
```

Expected: a path under `/pnpm` or `/usr/local/bin`, followed by an
`agent-browser` version. Failure means the sibling is not at capability parity;
rebuild/fix the image or remove the custom `imageTag` before shipping.

> **Note on rebuilds:** an agent-runner *source* change does **not** need
> `./container/build.sh` — `container/agent-runner/src` is bind-mounted read-only
> into the container, so a respawn (`ncl groups restart` or host restart) reloads
> it. Only dep / Dockerfile changes need an image rebuild.

#### Interaction checks

#### Slack path

In a Slack channel where both bots have been invited, post a message:

- `@<source> hello` → source agent fires (the existing helper bot).
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

> **Mention syntax**: agents write bare `@<bot-username>` in their reply. The Discord adapter's outbound rewriter (`resolveDiscordMentions` in `src/channels/discord.ts`) converts that to a real `<@SNOWFLAKE_ID>` mention before posting. Agents do not need to know the snowflake. The rewriter also tolerates the bracketed-by-name form `<@<bot-username>>` as a safety net, so both `@Example Agent-codex` and `<@Example Agent-codex>` resolve correctly.

### 11. Parity audit

The sibling-parity invariant protects shared capabilities while allowing
identity, provider auth, model/runtime tuning, resource budgets, and exact
Slack allowlist IDs to differ. This step prints unexpected drift before ship.

```bash
SIBLING_FOLDER=${SIBLING_FOLDER}
SOURCE_FOLDER=${SOURCE_FOLDER}

bash <(cat <<'AUDIT'
SF="$1"; SR="$2"
echo "=== container.json capability diff (identity/provider/runtime fields may differ) ==="
PARITY_FILTER='del(.groupName,.assistantName,.agentGroupId,.credentialFolder,.provider,.codexHostAuth,.codexAuthFallbacks,.model,.effort,.imageTag,.defaultModel,.defaultEffort,.maxMessagesPerPrompt,.resources,.memory,.dailySummary) | if (.slack_user_token | type) == "object" then .slack_user_token |= del(.also_allowed_in) else . end'
diff <(jq -S "$PARITY_FILTER" groups/${SF}/container.json) \
     <(jq -S "$PARITY_FILTER" groups/${SR}/container.json) \
  && echo "  ✅ structural parity"
echo
echo "=== OneCLI secret name list parity ==="
diff <(jq -S '.onecliSecrets // [] | sort' groups/${SF}/container.json) \
     <(jq -S '.onecliSecrets // [] | sort' groups/${SR}/container.json) \
  && echo "  ✅ onecliSecrets identical"
echo
echo "=== tools list parity ==="
diff <(jq -S '.tools // [] | sort' groups/${SF}/container.json) \
     <(jq -S '.tools // [] | sort' groups/${SR}/container.json) \
  && echo "  ✅ tools identical"
echo
echo "=== MCP native transport parity ==="
SSE=$(jq -r '(.mcpServers // {}) | to_entries[] | select(.value.type == "sse") | .key' groups/${SR}/container.json)
if [ -n "$SSE" ]; then
  echo "  ERROR: deprecated SSE MCP(s):"
  echo "$SSE"
  exit 1
fi
BRIDGED=$(jq -r '(.mcpServers // {}) | to_entries[] | select((.value.command? == "bun") and (((.value.args // []) | index("/app/src/remote-mcp-bridge.ts")) != null)) | .key' groups/${SR}/container.json)
if [ -n "$BRIDGED" ]; then
  echo "  WARNING: compatibility bridge MCP(s) require an explicit architecture-block note:"
  echo "$BRIDGED"
else
  echo "  ✅ no deprecated SSE or compatibility bridge MCPs"
fi
echo
echo "=== messaging-group wiring (channels) ==="
pnpm exec tsx scripts/q.ts data/v2.db "
SELECT mg.channel_type, mg.platform_id, mg.name, mga.engage_mode, mga.session_mode
FROM messaging_groups mg
JOIN messaging_group_agents mga ON mga.messaging_group_id=mg.id
WHERE mga.agent_group_id='${SR}'
"
echo
echo "Note: runtime parity (actual OneCLI secret assignment) requires a warm-up spawn — send any message to the sibling, then verify with: docker exec <container> env | grep -E 'ANTHROPIC_API_KEY|GITHUB_TOKEN'"
AUDIT
) "$SOURCE_FOLDER" "$SIBLING_FOLDER"
```

A clean audit shows ✅ on the three diff checks. Any drift means the inheritance step didn't run or was hand-edited — fix and re-run.

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

# Slack sibling:
sed -i.bak \
  -e "/^SLACK_BOT_TOKEN_${ENV_SUFFIX}=/d" \
  -e "/^SLACK_SIGNING_SECRET_${ENV_SUFFIX}=/d" .env

# Discord sibling (alternative — drop these lines instead of the SLACK_* ones):
sed -i.bak \
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
- Concurrent git operations across siblings: the shared worktree has standard git internal locks (`.git/index.lock`). Turn-taking via the `@`-mention pattern mitigates by design — only one sibling is active per turn after a hand-off. If both fire on the same user message (`@helper @helper-codex collab`), git ops can race; failures are loud (`fatal: Unable to create '.git/index.lock'`) and the agent retries.
- **Joint mentions and race conditions**: when a user `@`-mentions both siblings in one message, both wake in parallel. Whichever finishes generating first posts first; the second-to-finish sees the first's reply via session inbound and (per CLAUDE.md guidance) accommodates by picking a different slice. This accommodation depends on the second container being slower than the first's complete reply — typically true since Codex's reasoning phase adds latency vs Claude's faster time-to-first-token. If both happen to finish near-simultaneously, you can see both claim the same slice. The mitigation is in the prompt — explicit framing like "helper you start" forces ordering — not in the router.

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

## Guard parity contract

The three providers (Claude, Codex, OpenCode) are **one team that must be at command-guard parity by construction** — same guards, same fail-closed behavior, enforced by a shared guard core plus a machine-checked conformance/dispatch test suite. Cloning a group as Codex is not "done" when the bot replies; it's done when the Codex sibling's guard wiring satisfies the contract below. This generalizes — see `.claude/skills/clone-as-provider-template/SKILL.md` for the provider-agnostic form.

### The contract — what "done" means for a Codex sibling

1. **Every command guard routes through the shared core — no inline policy copies.** The guard set is: **self-approval**, **snowflake-connector**, **email-gate**, **git-clone destination**, **destructive bash/SQL**, and **file-protection** (edits to `.env` / lockfiles / `.git` / terraform). The decision logic lives in the shared cores, one place per concern: `block-destructive-core.ts` (`evaluateBashCommand`, `evaluateGitCloneDestination`, `evaluateSelfApproval`, `evaluateSnowflakeConnector`, `consumeGateApproval`, `runNanoclawGate`, `IS_NANOCLAW`) owns destructive / git-clone / self-approval / snowflake; `email-gate-core.ts` owns the email-gate verdict; `file-protection-core.ts` (`EDIT_TOOLS`, `checkEditProtection`) owns file-protection. An adapter owns only its own I/O surface (how it reads the tool call, how it emits a deny); it must never re-implement a verdict. The Codex sibling has **two** adapter surfaces, both of which route to the same cores:
   - **Host / interactive `codex`** — `workflow-agents/hooks/codex-guard.ts`, wired via `~/.codex/hooks.json`, emits a stdout-JSON `permissionDecision: 'deny'`.
   - **Container / `codex app-server`** — the agent-runner's `container/agent-runner/src/codex-hooks/runner.ts` (`runPreToolUseChain`), which imports the vendored cores via `loadGuardCore` + `loadFileProtectionCore`. This is wired into the codex hook surface that **provably fires** in-container — the same path the email-gate, self-approval, snowflake, git-clone, and sanitize hooks ride.

2. **Fail closed when the guard core is absent or malformed.** A sibling is only at parity when, for **both** container-side loaders (`loadGuardCore` and `loadFileProtectionCore`), an absent or malformed core denies rather than silently allows: validate that the imported module actually exposes the expected exports (don't bare-cast the dynamic `import()` to the core type), and wrap each evaluator call so an exception maps to **deny**, not a thrown-through crash that the outer try/catch turns into an allow. The gate path already fails closed when there is no session-DB approval surface (`IS_NANOCLAW === false` → deny); the absent/malformed-core case must follow the same posture.

3. **Pass the machine-checked suite — that gate IS the definition of done.** Two layers:
   - **Cross-surface conformance** — `conformance.test.ts` is the single readable manifest of expected verdicts for the canonical destructive / git-clone / file-protection set. If it holds, every surface that imports the same cores agrees by construction.
   - **Per-adapter dispatch coverage** — each adapter has a co-located test that confirms it maps the core verdict faithfully to its own I/O. For the Codex container adapter that is `runner.test.ts` (`runPreToolUseChain` blocks/denies the canonical set, fails closed on the no-session gate path, passes non-Bash tools through). A Codex sibling is shipped only when conformance **and** the Codex dispatch-coverage test are green.

### C6 caveat — `codex exec` sub-delegation fires no hooks

`codex exec` sub-delegations run with **no** PreToolUse hooks at all — neither the plugin hook system nor `~/.codex/hooks.json` fire on that path (verified empirically: a plugin-declared PreToolUse never ran; `eval` executed unblocked; zero hook artifacts across container sessions). So on the `codex exec` path the guard set is **instruction-only** (the rule is stated in `container/CLAUDE.md` and followed by convention), and there is **no hook-parity claim** to make there. This is a property of Codex's runtime, not a wiring bug — do not file it as drift. Hook-enforced parity covers interactive `codex` (host) and `codex app-server` (container); the `exec` sub-agent path is convention-enforced only.

## Future work — captured for later, not in scope today

### 1. Flip primary provider (Claude-nerf resilience)

The Claude-as-canonical / Codex-as-sibling split is just symlink direction + `messaging_group_agents` rows. Three escape hatches if the Claude Max subscription gets squeezed:

- **Drop Claude side**: delete the source's `messaging_group_agents` rows; the codex sibling stays wired to the same channels. `@<source>` just stops responding; `@<sibling-name>` continues. The shared workgroup graph + repos stay put. ~30 seconds of SQL.
- **Flip canonical**: `mv groups/<source> groups/<source>.tmp && mv groups/<source>-codex groups/<source> && ...` — relink symlinks the other way. ~10 min of mechanical work.
- **Inverse skill**: a `clone-as-claude` skill that takes a codex-backed source group and creates a Claude-backed sibling. Currently a copy of `/clone-as-codex` with provider strings flipped.

Decision criteria for picking the right path when the time comes: cost trajectory of each provider, parity quality of the codex-side guardrails (Stage 2 should hold up), whether you want to keep both for redundancy or commit to one. Don't pre-build any of this — flipping is cheaper than the abstraction.

### 2. Generalize this skill → `/clone-agent-as-provider <source> <provider>`

Today `/clone-as-codex` hardcodes `provider: "codex"`. A generalized version would take the provider as an argument:

```
/clone-agent-as-provider helper opencode    # creates helper-opencode
/clone-agent-as-provider helper claude      # for codex-canonical → claude sibling
```

Implementation when it's worth doing:
- Parameterize the sibling folder suffix (default to `-<provider>`).
- Parameterize `container.json` `provider` value.
- Wrap the existing steps in a single skill that takes `(source, provider)`.
- Migrate the existing `/clone-as-codex` to be a thin alias.

Punt until there's a second non-Claude provider in production.
