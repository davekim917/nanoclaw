---
name: clone-as-opencode
description: Create an OpenCode-backed sibling agent for an existing Claude or Codex group. The sibling shares the source group's CLAUDE.md, repos, sources, conversations, and mnemon store via symlinks + scoped-env. Cross-agent collaboration happens via standard platform `@`-mentions — requires installing a second bot app for the sibling so each agent has its own real bot user. Works on Slack and Discord. Targets OpenCode Go / Zen via OAuth-issued API key.
---

# Clone Group As OpenCode Sibling

Create `groups/<source>-opencode/` from `groups/<source>/`. The opencode sibling shares:

- **CLAUDE.md** — regenerated per-group by composeGroupClaudeMd on every spawn (do NOT symlink — the composer overwrites it).
- **CLAUDE.local.md** — symlinked to the source's CLAUDE.local.md when present, so both siblings share per-group memory.
- **Repos** — symlinked top-level dirs that contain `.git/`.
- **sources/** — mnemon inbox; both agents feed the same memory.
- **conversations/** — transcript archive; both agents see each other's archived turns.
- **mnemon store** — scoped-env override (`MNEMON_STORE_<SIBLING>=<source-ag-id>`) routes both writers to the same store.
- **Thread worktree** — when `NANOCLAW_THREAD_WORKTREES=1`, both siblings in the same platform thread mount the same `data/v2-threads/<thread-id>/worktrees/<repo>/` host path. Uncommitted edits flow across.

`container.json` for the new sibling gets `provider: "opencode"` and `memory.enabled: true`.

**Critical architectural choice — two bot apps, not one shared bot.** Each sibling agent has its own platform bot user, installed as a separate app in the workspace/guild. This lets agents `@`-mention each other (real platform mentions, real autocomplete) and have those mentions fire the peer via standard `engage_mode='mention'`.

## Prerequisites

- The source group exists in `groups/<source>/` and has a row in `agent_groups`.
- `provider: "opencode"` is registered. If `src/providers/opencode.ts` is missing, run `/add-opencode` first.
- `.env` exists and is writable.
- **You have admin rights in the platform workspace/guild** to create a second bot app for the sibling.
- **An OpenCode account with a Go or Zen subscription.** Free-tier models work but cap out fast — Go ($5 first month, $10/mo after) is the recommended floor.

## Channel selection

This skill supports two channels for the sibling bot identity: **Slack** and **Discord**.

```bash
CHANNEL=<slack|discord>           # pick one — every later branch keys off this
```

## Steps

### 1. Resolve the source group (capture `agent_groups.id`)

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select id, folder, name from agent_groups where folder='<source-folder>'"
```

Capture the `id` value — it's an `ag-...` string (or the folder name itself for host-default groups). Every later SQL statement that touches `messaging_group_agents.agent_group_id` uses this id, not the folder name.

```bash
SOURCE_FOLDER=<source-folder>             # e.g. illysium
SOURCE_ID=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SOURCE_FOLDER}'" | tr -d '\n')
test -n "${SOURCE_ID}" || { echo "ERROR: source group '${SOURCE_FOLDER}' not found"; exit 1; }
# Workgroup the sibling must JOIN — the SOURCE's workgroup, not the sibling's
# own folder. This is what grants shared chat-archive, mnemon store, and
# workgroup-level OneCLI secrets. For a primary source it equals the folder;
# clone from a codex sibling and it still resolves to the shared workgroup.
SOURCE_WORKGROUP=$(pnpm exec tsx scripts/q.ts data/v2.db "select coalesce(workgroup_id, folder) from agent_groups where folder='${SOURCE_FOLDER}'" | tr -d '\n')
test -n "${SOURCE_WORKGROUP}" || { echo "ERROR: could not resolve workgroup for '${SOURCE_FOLDER}'"; exit 1; }
echo "Source folder:    ${SOURCE_FOLDER}"
echo "Source ag-id:     ${SOURCE_ID}"
echo "Source workgroup: ${SOURCE_WORKGROUP}"
```

### 2. Install the sibling's bot app

#### Slack path

Follow `.claude/skills/add-slack/SKILL.md` to install a new app in the same workspace where the source agent's bot lives. **Name the bot user something distinct but discoverable** — using the source name with a suffix (e.g. `illie-opencode` when source is `illie`) makes Slack's `@`-autocomplete group them together for the user.

Required bot scopes (per add-slack skill step 6): `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `reactions:read`, `users:read`.

Required bot events (step 10): `message.channels`, `message.groups`, `message.im`, `app_mention`.

Set the Request URL to the same `https://<your-domain>/webhook/slack` as the existing source app — the host's webhook router dispatches by Slack app id, not by URL path.

After installing the new app to the workspace, capture the **bot token** (`xoxb-...`) and **signing secret** from the Slack app settings.

#### Discord path

Create a new Discord application at [discord.com/developers/applications](https://discord.com/developers/applications) — separate from the primary bot's app. Name the bot user something distinct but discoverable (e.g. `Axie-OpenCode`).

1. From the **General Information** tab, copy the **Application ID** and **Public Key**.
2. Go to the **Bot** tab and click **Add Bot** if needed; copy the **Bot Token** (click **Reset Token** if needed — visible only once).
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. Go to **OAuth2** → **URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files`, `Use Slash Commands`
5. Copy the generated URL, open it, and invite the bot to the **same guild** the source bot is already in.

> **Note on slash commands**: `/deploy`, `/update-container`, `/update-plugins` etc. stay bound to the primary `DISCORD_BOT_TOKEN` only. Sibling bots receive `@`-mentions but don't expose admin slash commands.

### 3. Add the sibling's env vars

Pick an `ENV_SUFFIX` that mirrors the source's suffix with `_OPENCODE` appended (e.g. existing `ILLYSIUM` → new `ILLYSIUM_OPENCODE`). Uppercase alphanumeric + underscores. The host's adapter discovers it on next restart.

```bash
ENV_SUFFIX=ILLYSIUM_OPENCODE              # uppercase, underscores OK
```

#### Slack path

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
SIBLING_FOLDER=${SOURCE_FOLDER}-opencode
SIBLING_ID=${SIBLING_FOLDER}                # use folder name as ag-id, matching host-default groups (main, axie-dev)

mkdir -p groups/${SIBLING_FOLDER}
cd groups/${SIBLING_FOLDER}

# Per-group memory: share the source's CLAUDE.local.md so both siblings
# remember the same project context. Conditional — if the source has no
# CLAUDE.local.md, leave it absent. Do NOT symlink CLAUDE.md here: the
# composer overwrites it with a fresh `@-imports`-only entry every spawn,
# so a symlink would be wiped on first wake.
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

Construct the sibling's container.json as **the source's, minus every sibling-bound field, plus this sibling's own identity + provider + memory**. Inheriting "everything except sibling-bound" (rather than a hand-picked subset like `onecliSecrets`/`tools`/`mcpServers`) is what guarantees a clean `ncl groups parity-check` *by construction* and carries over operator fields a fixed list would silently drop (e.g. `slack_user_token`). The sibling-bound set is the source of truth in `src/sibling-parity.ts` (`SIBLING_BOUND_FIELDS`) — keep this `del(...)` list in sync with it.

```bash
# Source MINUS every sibling-bound field, PLUS this sibling's identity/provider/memory.
jq --arg folder "${SIBLING_FOLDER}" --arg src "${SOURCE_FOLDER}" '
  del(.groupName, .assistantName, .agentGroupId, .credentialFolder, .provider,
      .codexHostAuth, .model, .effort, .imageTag, .defaultModel, .defaultEffort,
      .maxMessagesPerPrompt, .memory, .dailySummary, .gitnexusInjectAgentsMd)
  | { provider: "opencode" } + .
  | .groupName = $folder
  | .assistantName = $folder
  | .agentGroupId = $folder
  | .credentialFolder = $src
  | .gitnexusInjectAgentsMd = true
  | .memory = { "enabled": true }
' groups/${SOURCE_FOLDER}/container.json > /tmp/cj-sibling.json && \
  mv /tmp/cj-sibling.json groups/${SIBLING_FOLDER}/container.json

# Verify parity — only sibling-bound fields may differ (clean by construction).
DEL='del(.groupName,.assistantName,.agentGroupId,.credentialFolder,.provider,.codexHostAuth,.model,.effort,.imageTag,.defaultModel,.defaultEffort,.maxMessagesPerPrompt,.memory,.dailySummary,.gitnexusInjectAgentsMd,.workgroup_id)'
diff <(jq -S "$DEL" groups/${SOURCE_FOLDER}/container.json) \
     <(jq -S "$DEL" groups/${SIBLING_FOLDER}/container.json) && echo "  ✅ parity clean" || true
```

**Why `credentialFolder`**: container-runner's per-group credential lookups (LOOKER_*, DBT_*, GITHUB_TOKEN_*, RENDER_PG_*, GIT_AUTHOR_*, Snowflake, etc.) key on `<BASE>_<FOLDER_UPPER>`. Without this field a sibling folder like `madison-reed-opencode` would look for `LOOKER_BASE_URL_MADISON_REED_OPENCODE`, which doesn't exist. `credentialFolder` redirects credential lookups to the source folder; identity-bound paths (container name, group dir mount, MNEMON_STORE override, OpenCode auth dir) stay on the sibling's own folder.

**Note: no `opencodeHostAuth` field** — the host-side opencode provider (`src/providers/opencode.ts`) always copies the per-group `auth.json` into the per-session XDG dir; there's no opt-in gate like `codexHostAuth`.

### 6a. Per-sibling OpenCode account

OpenCode auth.json lives at `~/.local/share/opencode/auth.json` by default. The host-side provider (`resolveOpenCodeSourceDir`) prefers a scoped `~/.local/share/opencode-<sibling-folder>/auth.json` when present, falling back to the global one. To put this sibling on its own OpenCode subscription (separate billing, separate model limits), create the scoped dir and login into it:

```bash
# OpenCode CLI must be installed on the host (pnpm i -g opencode-ai@1.15.7).
# Verify: opencode --version

# Run login under a throwaway XDG_DATA_HOME so any existing global
# ~/.local/share/opencode/auth.json is not touched. The browser flow at
# opencode.ai/auth handles plan selection (Go, Zen, free) and emits an API
# key that gets pasted into the terminal and written to auth.json.
TMPXDG=$(mktemp -d)
XDG_DATA_HOME="$TMPXDG" opencode providers login --provider opencode

# Stage the resulting auth.json in the scoped dir our host provider reads.
mkdir -p ~/.local/share/opencode-${SIBLING_FOLDER}
mv "$TMPXDG/opencode/auth.json" ~/.local/share/opencode-${SIBLING_FOLDER}/auth.json
rm -rf "$TMPXDG"

# Verify.
ls -la ~/.local/share/opencode-${SIBLING_FOLDER}/auth.json
```

To share one OpenCode account across all opencode siblings instead, skip this step entirely — the host falls back to the global `~/.local/share/opencode/auth.json`.

### 6b. Scoped MNEMON_STORE override — OPTIONAL (legacy escape-hatch)

**Skip this for normal siblings.** `workgroup_id` on the `agent_groups` row (step 7) already routes both mnemon recall and writes to the workgroup's shared store — `resolveMnemonStore`'s DB path (`container-runner.ts:295`) joins through `workgroups.mnemon_store_id`, and `recall_scope` defaults to `'workgroup'`. The env override wins over that DB resolution (`container-runner.ts:276`), so a stale one creates **split-brain memory** if `workgroups.mnemon_store_id` ever changes without also editing `.env`. Live codex and opencode siblings run with NO override.

Set this **only** to force a store *different* from the workgroup's canonical one (rare):

```bash
# Optional — usually unnecessary; workgroup_id (step 7) handles routing.
ENV_KEY=MNEMON_STORE_$(echo "${SIBLING_FOLDER}" | tr 'a-z-' 'A-Z_')
echo "${ENV_KEY}=${SOURCE_ID}" >> .env   # only to override the workgroup's shared store
```

### 6c. Scoped OpenCode model selection

The host-side opencode provider supports scoped env vars `OPENCODE_PROVIDER_<FOLDER>`, `OPENCODE_MODEL_<FOLDER>`, `OPENCODE_SMALL_MODEL_<FOLDER>`, `OPENCODE_EFFORT_<FOLDER>`, and `OPENCODE_BASE_URL_<FOLDER>` (falls back to bare versions if scoped isn't set; `ANTHROPIC_BASE_URL_<FOLDER>` is also accepted as a back-compat fallback for the base URL). For multiple opencode siblings on different backends, set the scoped versions per-sibling.

For an OpenCode Go-billing sibling defaulting to Kimi K2.6 with high reasoning:

```bash
FOLDER_UPPER=$(echo "${SIBLING_FOLDER}" | tr 'a-z-' 'A-Z_')

cat >> .env <<EOF
OPENCODE_PROVIDER_${FOLDER_UPPER}=opencode
OPENCODE_MODEL_${FOLDER_UPPER}=opencode/kimi-k2.6
OPENCODE_EFFORT_${FOLDER_UPPER}=high
OPENCODE_BASE_URL_${FOLDER_UPPER}=https://opencode.ai/zen/go/v1
EOF
```

**Critical: Go vs Zen billing routing.** OpenCode Go and Zen share the SAME `opencode/*` model ids and the same auth.json, but they're billed via **different API endpoints**:

| URL path | Catalog (per OpenCode console source) | Billing |
|---|---|---|
| `https://opencode.ai/zen/v1` (SDK default) | `ZenData.list("full")` — full catalog (Claude/GPT/Gemini + Asian models) | **Zen credit** |
| `https://opencode.ai/zen/go/v1` | `ZenData.list("lite")` — Go-tier only (Kimi/GLM/DeepSeek/Qwen/MiniMax/MiMo) | **Go subscription** |

Without setting `OPENCODE_BASE_URL_<FOLDER>`, the SDK defaults to `/zen/v1` and drains your Zen credit balance — even for Go-only models. Always set the Go endpoint explicitly for Go-billed siblings.

**Reasoning effort** — `OPENCODE_EFFORT` accepts user-friendly values but is **clamped to the portable intersection** `low | medium | high` before reaching upstream. Out-of-range values are mapped: `minimal → low`, `xhigh → high`, `max → high`. The container provider sends only `reasoning_effort` (not `thinking.budgetTokens`), because the latter is Anthropic-specific and 400s on most non-Anthropic upstreams (Kimi, GLM, DeepSeek). Leave unset to skip the field entirely and let each model use its upstream default.

Why the clamp: each upstream provider's API has a different validation schema:

| Model family | Upstream `reasoning_effort` schema | Default behavior |
|---|---|---|
| **OpenAI / GPT-5** (Zen) | `minimal\|low\|medium\|high` — `xhigh` is an OpenCode extension that some upstreams reject | Set `OPENCODE_EFFORT=high` for portability. `xhigh` requires OpenAI-pinned siblings. |
| **Anthropic / Claude** (Zen) | Uses `thinking.budgetTokens` (different schema entirely) | Not controlled by `OPENCODE_EFFORT` today. Future work: detect provider and switch field. |
| **DeepSeek V4 Pro/Flash** (Go) | `high\|max` | OpenCode auto-sets `max` for agent contexts when no explicit value sent. `OPENCODE_EFFORT=high` overrides to lower tier; unset = auto-max. |
| **Kimi K2.6** (Go) | `low\|medium\|high\|none` — strict literal | `OPENCODE_EFFORT=high` works. Thinking is on by default; `OPENCODE_EFFORT` only changes effort tier. |
| **GLM-5 / GLM-5.1** (Go) | `thinking: enabled\|disabled` (no granular effort) | `OPENCODE_EFFORT` is a no-op; thinking is compulsory when enabled. |
| **Qwen3.x Plus / MiniMax / MiMo** (Go) | Mostly binary on/off | Verify per-model in upstream docs before setting. |

**Practical rule**: for OpenCode Go siblings, set `OPENCODE_EFFORT=high` (or unset). For OpenAI-Zen-pinned siblings wanting native xhigh, that requires per-sibling code paths not wired today — file an issue when you need it.

**Picking `OPENCODE_MODEL`:**

| Plan | Example model ids (subject to OpenCode's catalog) |
|------|-----|
| OpenCode Go | `opencode/kimi-k2.6`, `opencode/qwen-3.6-plus`, `opencode/deepseek-v4-pro`, `opencode/glm-5.1`, `opencode/mimo-v2.5-pro` |
| OpenCode Zen | `opencode/big-pickle`, `opencode/gpt-5-nano` |
| Free | `opencode/minimax-m2.5-free`, `opencode/nemotron-3-super-free`, `opencode/deepseek-v4-flash-free` |

Run `opencode models` (from the host, after `providers login`) to see what's actually available under your plan — the catalog updates dynamically.

**OpenCode Go credit overflow:** Go subscriptions drain from Zen credit balance when Go limits are hit, so a single login with both plans active gives you a smooth fallback.

**Auth note — what works:**
- ✅ OpenCode Go / Zen / free (via `opencode providers login --provider opencode`)
- ✅ OpenAI ChatGPT Plus/Pro subscription (via `--provider openai --method <chatgpt>`)
- ✅ Provider API keys via OneCLI vault + `ANTHROPIC_BASE_URL` (OneCLI bypass mode — see `add-opencode/SKILL.md`)

### 7. Insert the agent_groups row

`agent_groups.created_at` is `NOT NULL` with no default.

**`workgroup_id` is the load-bearing field.** It places the sibling in the SAME workgroup as its source + codex sibling, which is what grants shared chat-archive visibility, mnemon recall fan-out, and workgroup-level OneCLI-secret inheritance. It lives on the `agent_groups` row, NOT in `container.json` (matching how migration 036 set up the codex siblings — `reconcileWorkgroupAtSpawn` reads the DB value, and `recall_scope` defaults to `'workgroup'` whenever it is set; putting it in container.json instead would trip the parity-check since `workgroup_id` is not a sibling-bound field). Omitting it here is the bug that isolated the first opencode sibling (`illysium-opencode`) into its own workgroup-of-one: migration 036 only auto-pairs the `-codex` suffix, never `-opencode`.

`agent_groups.name` should match `id` and `folder` — the workspace convention (`<source>-opencode`), NOT the Slack/Discord bot display name. The bot display name is platform-side (configured at api.slack.com/apps or the Discord dev portal) and is purely how chat users see the avatar; mixing the two leaves the dashboard with inconsistent groupings.

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

EXISTING=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SIBLING_FOLDER}'" 2>/dev/null | tr -d '\n')
if [ -z "${EXISTING}" ]; then
  pnpm exec tsx scripts/q.ts data/v2.db \
    "insert into agent_groups (id, folder, name, agent_provider, workgroup_id, created_at) values ('${SIBLING_ID}', '${SIBLING_FOLDER}', '${SIBLING_ID}', 'opencode', '${SOURCE_WORKGROUP}', '${NOW}')"
fi
```

### 8. Restart the host so the new adapter + env vars get picked up

```bash
sudo systemctl restart nanoclaw-v2
```

Wait ~5 seconds. On restart, the chat adapter sees `<PLATFORM>_BOT_TOKEN_${ENV_SUFFIX}` and registers a new channelType (`slack-${env_suffix-lowercased}` or `discord-${env_suffix-lowercased}`).

### 9. Wire the sibling to the desired channels

The `register` step in `setup/index.ts` is channel-agnostic. Use it for both platforms — don't hand-insert.

#### Slack path

Invite the new bot user (e.g. `@illie-opencode`) to each Slack channel you want it to operate in (Slack-side, before wiring).

```bash
SLACK_CHANNEL_ID=C0AJA89MN2E                  # Slack channel id
SLACK_CHANNEL_NAME=agents-xzo

pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "slack:${SLACK_CHANNEL_ID}" \
  --name "#${SLACK_CHANNEL_NAME}" \
  --folder "${SIBLING_FOLDER}" \
  --channel "${CHANNEL_TYPE}" \
  --session-mode "per-thread" \
  --assistant-name "${SIBLING_ID}"
```

If a `messaging_group_agents` row was hand-inserted and the sibling fires but cannot send, repair the missing destination row:

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

#### Discord path

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
  --assistant-name "${SIBLING_ID}"
```

The `register` step defaults `engage_mode='mention'` — sibling-safe (only fires on explicit `@`-mention).

> **Important — owner role under the new channelType namespace.** When the host receives an inbound from the sibling bot, the sender's user-id is namespaced by the new channel_type (e.g. `discord-axie-opencode:608746260706361344`). Existing `user_roles` rows are scoped to the OLD namespace, so the new bot sees the sender as unknown.
>
> Mirror your existing global owner roles under the new namespace:

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GRANTER=$(pnpm exec tsx scripts/q.ts data/v2.db "select user_id from user_roles where role='owner' and agent_group_id is null order by granted_at desc limit 1" | tr -d '\n')

# Mirror every global owner under 'discord:' into the new sibling namespace.
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

Slack siblings don't need this mirror — Slack's channelType is already workspace-scoped, so the per-workspace user_roles rows inherit naturally under `slack-<workspace>-opencode`.

### 10. Verify

> **Functional checks first — the parity audit (step 11) is structural and will
> NOT catch the two runtime failures that have bitten opencode siblings:**
> 1. **Wrong provider/model vs auth.json** → the agent replies `Model not found`
>    / `Invalid API key`. The bug lives in the agent-runner's config generation,
>    so `opencode models` / `opencode run` alone do **not** reproduce it — only a
>    real agent turn does. Root cause is always: `OPENCODE_MODEL`'s provider
>    prefix is not a key in the `auth.json` this sibling uses (e.g. `opencode/*`
>    when only `opencode-go` is authed, or vice-versa).
> 2. **Double-prefixed `platform_id`** → delivery fails with `Invalid
>    Discord/Slack thread ID`. The register step prepends the channel_type even
>    when the adapter already base-prefixed the id.

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

**Check B — pre-flight: `OPENCODE_MODEL`'s provider is authed (deterministic, no spawn):**

```bash
PROV="${OPENCODE_PROVIDER}"   # e.g. opencode-go (global auth) or opencode (scoped Zen)
# Resolve the auth.json this sibling actually uses: scoped dir if present, else global.
AUTH="$HOME/.local/share/opencode-${SIBLING_FOLDER}/opencode/auth.json"
[ -f "$AUTH" ] || AUTH="$HOME/.local/share/opencode/auth.json"
node -e "const a=require('$AUTH'); process.exit(('$PROV' in a)?0:1)" \
  && echo "✅ provider '$PROV' is present in $(basename $(dirname $(dirname "$AUTH")))" \
  || echo "❌ provider '$PROV' is NOT in $AUTH — OPENCODE_MODEL will fail at runtime. Fix OPENCODE_PROVIDER/MODEL or 'opencode providers login' under the right XDG dir."
```

**Check C — live round-trip (the only check that exercises model + auth + delivery):**

Send a test @-mention in the sibling's channel: `@<sibling-bot-name> reply with the single word OK`. Then assert the response was not an error:

```bash
SDIR=$(ls -dt data/v2-sessions/${SIBLING_FOLDER}/sess-* 2>/dev/null | head -1)
pnpm exec tsx scripts/q.ts "$SDIR/outbound.db" "SELECT content FROM messages_out ORDER BY rowid DESC LIMIT 1" \
  | grep -qiE "Model not found|Invalid API key|Error:" \
  && echo "❌ sibling returned an error — see Check B; fix .env then 'ncl groups restart --id ${SIBLING_ID}'" \
  || echo "✅ sibling produced a clean response — round-trip verified"
```

Checks A and B are deterministic and should both be ✅ before you announce the sibling. Check C is the end-to-end seal.

> **Note on rebuilds:** an agent-runner *source* change (e.g. fixing the provider
> config) does **not** need `./container/build.sh` — `container/agent-runner/src`
> is bind-mounted read-only into the container, so a respawn (`ncl groups restart`
> or host restart) reloads it. Only dep / Dockerfile changes need an image rebuild.

#### Interaction checks

#### Slack path

In a Slack channel where both bots are invited:

- `@<source> hello` → source agent fires.
- `@<sibling-slack-name> hello` → sibling agent fires.
- `@<source> can you @<sibling-slack-name> help with this?` → both fire.

If the sibling fires once but never picks up a follow-up `@`-mention from the source agent, check:
- Both bot users are invited to that Slack channel.
- Both apps subscribe to `message.channels` (per the add-slack skill).

#### Discord path

- `@<source-bot-name> hello` → source agent fires.
- `@<sibling-bot-name> hello` → sibling agent fires.
- `@<source-bot-name> can you @<sibling-bot-name> help with this?` → both fire.

If handoff doesn't continue, check:
- Both bots are in the guild with channel-read permission.
- The bot has `Message Content Intent` enabled in the Discord developer portal.
- `groups/${SIBLING_FOLDER}/AGENTS.md` was composed cleanly.

### 11. Parity audit

The sibling-parity invariant says only model + provider may differ between source and sibling. This step diffs the two and prints any unexpected drift before you ship.

```bash
SIBLING_FOLDER=${SIBLING_FOLDER}
SOURCE_FOLDER=${SOURCE_FOLDER}

bash <(cat <<'AUDIT'
SF="$1"; SR="$2"
echo "=== container.json structural diff (only model/provider/identity-bound fields should differ) ==="
diff <(jq -S 'del(.groupName,.assistantName,.agentGroupId,.credentialFolder,.provider,.memory,.codexHostAuth,.dailySummary)' groups/${SF}/container.json) \
     <(jq -S 'del(.groupName,.assistantName,.agentGroupId,.credentialFolder,.provider,.memory,.codexHostAuth)' groups/${SR}/container.json) \
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
echo "=== messaging-group wiring (channels) ==="
pnpm exec tsx scripts/q.ts data/v2.db "
SELECT mg.channel_type, mg.platform_id, mg.name, mga.engage_mode, mga.session_mode
FROM messaging_groups mg
JOIN messaging_group_agents mga ON mga.messaging_group_id=mg.id
WHERE mga.agent_group_id='${SR}'
"
echo
echo "Note: runtime parity (actual OneCLI secret assignment + tool surface) requires a warm-up spawn — send any message to the sibling, then verify with: docker exec <container> env | grep -E 'ANTHROPIC_API_KEY|GITHUB_TOKEN|SLACK_BOT_TOKEN'"
AUDIT
) "$SOURCE_FOLDER" "$SIBLING_FOLDER"
```

A clean audit shows ✅ on the three diff checks; any drift means the inheritance step (5) didn't run or was hand-edited. Fix the offending field and re-run the audit.

## Reverting

Assumes you still have `SOURCE_FOLDER`, `SOURCE_ID`, `SIBLING_FOLDER`, `SIBLING_ID`, `ENV_SUFFIX`, `CHANNEL_TYPE` from the install.

```bash
sudo systemctl stop nanoclaw-v2

# Drop wiring + agent_groups row.
pnpm exec tsx scripts/q.ts data/v2.db "delete from agent_destinations where agent_group_id='${SIBLING_ID}' or (target_type='channel' and target_id in (select id from messaging_groups where channel_type='${CHANNEL_TYPE}'))"
pnpm exec tsx scripts/q.ts data/v2.db "delete from messaging_group_agents where agent_group_id='${SIBLING_ID}'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from messaging_groups where channel_type='${CHANNEL_TYPE}'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from agent_groups where id='${SIBLING_ID}'"

# Drop the symlink tree.
rm -rf groups/${SIBLING_FOLDER}

# Drop the scoped OpenCode auth dir (if you created one in step 6a).
rm -rf ~/.local/share/opencode-${SIBLING_FOLDER}

# Drop env entries.
ENV_KEY=MNEMON_STORE_$(echo "${SIBLING_FOLDER}" | tr 'a-z-' 'A-Z_')
FOLDER_UPPER=$(echo "${SIBLING_FOLDER}" | tr 'a-z-' 'A-Z_')

# Slack sibling:
sed -i.bak \
  -e "/^${ENV_KEY}=/d" \
  -e "/^SLACK_BOT_TOKEN_${ENV_SUFFIX}=/d" \
  -e "/^SLACK_SIGNING_SECRET_${ENV_SUFFIX}=/d" \
  -e "/^OPENCODE_PROVIDER_${FOLDER_UPPER}=/d" \
  -e "/^OPENCODE_MODEL_${FOLDER_UPPER}=/d" \
  -e "/^OPENCODE_SMALL_MODEL_${FOLDER_UPPER}=/d" \
  -e "/^OPENCODE_BASE_URL_${FOLDER_UPPER}=/d" \
  -e "/^ANTHROPIC_BASE_URL_${FOLDER_UPPER}=/d" .env

# Discord sibling (alternative — drop these lines instead of the SLACK_* ones):
sed -i.bak \
  -e "/^${ENV_KEY}=/d" \
  -e "/^DISCORD_BOT_TOKEN_${ENV_SUFFIX}=/d" \
  -e "/^DISCORD_APPLICATION_ID_${ENV_SUFFIX}=/d" \
  -e "/^DISCORD_PUBLIC_KEY_${ENV_SUFFIX}=/d" \
  -e "/^OPENCODE_PROVIDER_${FOLDER_UPPER}=/d" \
  -e "/^OPENCODE_MODEL_${FOLDER_UPPER}=/d" \
  -e "/^OPENCODE_SMALL_MODEL_${FOLDER_UPPER}=/d" \
  -e "/^OPENCODE_BASE_URL_${FOLDER_UPPER}=/d" \
  -e "/^ANTHROPIC_BASE_URL_${FOLDER_UPPER}=/d" .env

# Discord-only — drop mirrored owner roles.
pnpm exec tsx scripts/q.ts data/v2.db "delete from user_roles where user_id like '${CHANNEL_TYPE}:%'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from users where id like '${CHANNEL_TYPE}:%'"

sudo systemctl start nanoclaw-v2
```

Optionally, uninstall the sibling's bot app from the platform.

## Notes

- `composeGroupClaudeMd` (host-side, every container spawn) regenerates `groups/${SIBLING_FOLDER}/AGENTS.md` from the same CLAUDE.md the source group uses. No manual AGENTS.md authoring.
- The opencode container reads MCP server config from `mcpServers` in container.json (and any merged in via `NANOCLAW_MCP_SERVERS`), which the runtime translates to OpenCode's `mcp` config field via `mcpServersToOpenCodeConfig`.
- The host opencode provider copies `auth.json` from the per-sibling scoped dir on every spawn. Session state (opencode.db) stays per-session in `<sessionDir>/opencode-xdg/opencode/`; only the auth token is shared.
- Worktrees are thread-scoped when `NANOCLAW_THREAD_WORKTREES=1`. Concurrent git ops across siblings share standard `.git/index.lock` semantics; turn-taking via `@`-mentions mitigates by design.
- **opencode-ai 1.15.7 is pinned** in `container/Dockerfile`. Bump deliberately (not `bun update`) and re-run `bun test src/providers/` after — the SDK type surface has been stable through 1.15.x, but rebase carefully if you jump multiple majors.

### Notes on cross-sibling auth and OpenCode plan choice

- A single OpenCode login covers Go + Zen + free models. Go drains from Zen credits when Go-tier limits are hit — one auth, two billing buckets.
- Anthropic Claude Pro/Max subscription is **not** supported by OpenCode 1.3.0+ (Anthropic restriction). Use Claude as the SOURCE side (primary agent) and OpenCode for the sibling; mixing Claude-subscription auth into OpenCode is dead.
- OpenAI ChatGPT Plus/Pro subscription IS supported (`--provider openai --method <chatgpt>`) if you want a sibling running on your existing ChatGPT subscription instead of OpenCode billing.
