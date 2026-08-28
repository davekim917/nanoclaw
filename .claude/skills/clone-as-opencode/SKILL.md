---
name: clone-as-opencode
description: Create an OpenCode-backed sibling agent for an existing Claude or Codex group. The sibling joins the source workgroup and shares its CLAUDE.md, repos, sources, and conversations. Cross-agent collaboration happens via standard platform `@`-mentions — requires installing a second bot app for the sibling so each agent has its own real bot user. Works on Slack and Discord. Targets OpenCode Go / Zen via OAuth-issued API key.
---

# Clone Group As OpenCode Sibling

Create `groups/<source>-opencode/` from `groups/<source>/`. The opencode sibling shares:

- **CLAUDE.md** — regenerated per-group by composeGroupClaudeMd on every spawn (do NOT symlink — the composer overwrites it).
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

`container.json` for the new sibling gets `provider: "opencode"` and `memory.enabled: true`.

**One-memory invariant.** Every current and future sibling — Claude, Codex,
OpenCode, or another provider — joins the source workgroup. Workgroup membership
therefore makes it inherit the one workgroup memory canon; cloning never creates
a provider-owned copy. Once the workgroup canon is active, no memory migration
is part of cloning or a later provider-role change.

**Capability parity invariant for new siblings.** An OpenCode sibling must
inherit the source group's NanoClaw capability surface unless a provider/runtime
architecture block is named explicitly. Step 5 preserves `mcpServers`, `tools`,
`onecliSecrets`, mounts, skills, and other non-sibling-bound fields by
construction. OpenCode should not get a special MCP downgrade: stdio MCPs map to
native local MCP entries, Streamable HTTP MCPs map to native remote MCP entries,
deprecated SSE is invalid, and `remote-mcp-bridge` is only an explicitly
documented compatibility exception. Browser automation is part of the baseline:
the shared agent image exposes `agent-browser` to login shells, so a newly
spawned OpenCode sibling should have the same `agent-browser open/snapshot/click`
workflow as Claude and Codex.

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
SOURCE_FOLDER=<source-folder>             # e.g. example-labs
SOURCE_ID=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SOURCE_FOLDER}'" | tr -d '\n')
test -n "${SOURCE_ID}" || { echo "ERROR: source group '${SOURCE_FOLDER}' not found"; exit 1; }
# Workgroup the sibling must JOIN — the SOURCE's workgroup, not the sibling's
# own folder. This is what grants shared chat-archive and
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

Follow `.claude/skills/add-slack/SKILL.md` to install a new app in the same workspace where the source agent's bot lives. **Name the bot user something distinct but discoverable** — using the source name with a suffix (e.g. `helper-opencode` when source is `helper`) makes Slack's `@`-autocomplete group them together for the user.

Required bot scopes (per add-slack skill step 6): `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `reactions:read`, `users:read`.

Required bot events (step 10): `message.channels`, `message.groups`, `message.im`, `app_mention`.

Set the Request URL to the same `https://<your-domain>/webhook/slack` as the existing source app — the host's webhook router dispatches by Slack app id, not by URL path.

After installing the new app to the workspace, capture the **bot token** (`xoxb-...`) and **signing secret** from the Slack app settings.

#### Discord path

Create a new Discord application at [discord.com/developers/applications](https://discord.com/developers/applications) — separate from the primary bot's app. Name the bot user something distinct but discoverable (e.g. `Example Agent-OpenCode`).

1. From the **General Information** tab, copy the **Application ID** and **Public Key**.
2. Go to the **Bot** tab and click **Add Bot** if needed; copy the **Bot Token** (click **Reset Token** if needed — visible only once).
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. Go to **OAuth2** → **URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files`, `Use Slash Commands`
5. Copy the generated URL, open it, and invite the bot to the **same guild** the source bot is already in.

> **Note on slash commands**: `/deploy`, `/update-container`, `/update-plugins` etc. stay bound to the primary `DISCORD_BOT_TOKEN` only. Sibling bots receive `@`-mentions but don't expose admin slash commands.

### 3. Add the sibling's env vars

Pick an `ENV_SUFFIX` that mirrors the source's suffix with `_OPENCODE` appended (e.g. existing `EXAMPLE_LABS` → new `EXAMPLE_LABS_OPENCODE`). Uppercase alphanumeric + underscores. The host's adapter discovers it on next restart.

```bash
ENV_SUFFIX=EXAMPLE_LABS_OPENCODE              # uppercase, underscores OK
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
# — absent if the source has none. Do NOT symlink CLAUDE.md: the composer
# overwrites it every spawn.
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
(stdio -> stdio/local, `type: "http"` -> native Streamable HTTP/remote,
`type: "sse"` -> hard reject). If the source still contains an old
`remote-mcp-bridge` entry, carry it only as a named architecture-block exception
and prefer converting the source to `type: "http"` before cloning when the
server supports Streamable HTTP.

```bash
# Preserve shared capabilities and resource baseline; replace sibling identity/provider state.
jq --arg folder "${SIBLING_FOLDER}" --arg src "${SOURCE_FOLDER}" '
  del(.groupName, .assistantName, .agentGroupId, .credentialFolder, .provider,
      .codexHostAuth, .codexAuthFallbacks, .model, .effort, .imageTag,
      .defaultModel, .defaultEffort, .maxMessagesPerPrompt, .memory, .dailySummary)
  | if (.slack_user_token | type) == "object" then
      .slack_user_token |= del(.also_allowed_in)
    else . end
  | { provider: "opencode" } + .
  | .groupName = $folder
  | .assistantName = $folder
  | .agentGroupId = $folder
  | .credentialFolder = $src
  | .memory = { "enabled": true }
' groups/${SOURCE_FOLDER}/container.json > /tmp/cj-sibling.json && \
  mv /tmp/cj-sibling.json groups/${SIBLING_FOLDER}/container.json

# Verify parity — only sibling-bound fields may differ (clean by construction).
DEL='del(.groupName,.assistantName,.agentGroupId,.credentialFolder,.provider,.codexHostAuth,.codexAuthFallbacks,.model,.effort,.imageTag,.defaultModel,.defaultEffort,.maxMessagesPerPrompt,.resources,.memory,.dailySummary,.workgroup_id) | if (.slack_user_token | type) == "object" then .slack_user_token |= del(.also_allowed_in) else . end'
diff <(jq -S "$DEL" groups/${SOURCE_FOLDER}/container.json) \
     <(jq -S "$DEL" groups/${SIBLING_FOLDER}/container.json) && echo "  ✅ parity clean" || true
```

**Why `credentialFolder`**: container-runner's per-group credential lookups (LOOKER_*, DBT_*, GITHUB_TOKEN_*, RENDER_PG_*, GIT_AUTHOR_*, Snowflake, etc.) key on `<BASE>_<FOLDER_UPPER>`. Without this field a sibling folder like `example-retail-opencode` would look for `LOOKER_BASE_URL_EXAMPLE_RETAIL_OPENCODE`, which doesn't exist. `credentialFolder` redirects credential lookups to the source folder; identity-bound paths (container name, group dir mount, OpenCode auth dir) stay on the sibling's own folder.

**Note: no `opencodeHostAuth` field** — the host-side opencode provider (`src/providers/opencode.ts`) always copies the per-group `auth.json` into the per-session XDG dir; there's no opt-in gate like `codexHostAuth`.

### 6a. Per-sibling OpenCode account

OpenCode auth.json lives at `~/.local/share/opencode/auth.json` by default. The host-side provider (`resolveOpenCodeSourceDir`) prefers a scoped `~/.local/share/opencode-<sibling-folder>/auth.json` when present, falling back to the global one. To put this sibling on its own OpenCode subscription (separate billing, separate model limits), create the scoped dir and login into it:

```bash
# Derive the host CLI version from the image pin; it must stay aligned with the
# container CLI and SDK.
OPENCODE_VERSION=$(sed -nE 's/^ARG OPENCODE_VERSION=([0-9]+\.[0-9]+\.[0-9]+)$/\1/p' container/Dockerfile)
test -n "$OPENCODE_VERSION"
pnpm install -g "opencode-ai@${OPENCODE_VERSION}"
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

### 6b. OpenCode model selection

Model/effort config follows the same template as claude/codex: a **code-level
default** is the floor, the **per-group DB value** (`container_configs`, set via
`ncl`) overrides it. There are **no `.env` model vars** — the old
`OPENCODE_MODEL_<FOLDER>` / `OPENCODE_PROVIDER_<FOLDER>` / `OPENCODE_BASE_URL_<FOLDER>`
scoped vars were removed (one config pattern across all harnesses).

A new Go-billing sibling needs **no model config at all** — it inherits
`DEFAULT_OPENCODE_MODEL` (`opencode-go/glm-5.3-flash`, effort `high`) from
`src/providers/opencode.ts`. To run a different model, set it on the DB row
**after** the `agent_groups` row exists (step 7):

```bash
ncl groups config update --id "${SIBLING_FOLDER}" --model opencode-go/glm-5.1 --effort high
```

**Go vs Zen billing routing — by the model-slug PREFIX, not a base URL.** Both
share the same `auth.json`, but the provider prefix selects the billing
endpoint, and the host derives `OPENCODE_PROVIDER` from it automatically:

| Model slug prefix | Endpoint | Billing |
|---|---|---|
| `opencode-go/*` (e.g. `opencode-go/kimi-k2.7-code`) | `/zen/go/v1` | **Go subscription** (default — cheapest) |
| `opencode/*` (e.g. `opencode/gpt-5.5`) | `/zen/v1` | **Zen credit** (opt-in; use only for a Zen-only model) |
| `nvidia/*` | NVIDIA | per NVIDIA cred |

The container enables EVERY credentialed provider in-session, so the agent can
switch to any go/zen/nvidia model mid-thread with the `-m <slug>` flag (no
restart) — `ncl groups config update --model` / `change_model` is the
persistent group-level equivalent. Default to `opencode-go/*`; reach for
`opencode/*` only when you deliberately want a Zen-only model.

**Reasoning effort** — `-e` / the `--effort` DB field accept `low | medium | high`
(the portable intersection). `xhigh`/`max`/`minimal` are NOT accepted for
opencode (they 400 on most Go/Zen upstreams); the container sends only
`reasoning_effort`, never the Anthropic-specific `thinking.budgetTokens`. Leave
unset to let each model use its upstream default (most Go thinking models —
Kimi/GLM/DeepSeek/Qwen — already run high by default).

**Picking a model** — run `opencode models` (from the host after `providers login`,
or ask the running agent to call its `list_models` tool) for the live catalog;
it updates dynamically. Examples: `opencode-go/kimi-k2.7-code`,
`opencode-go/glm-5.1`, `opencode-go/deepseek-v4-pro`, `opencode-go/qwen3.7-plus`.

**OpenCode Go credit overflow:** Go subscriptions drain from Zen credit balance when Go limits are hit, so a single login with both plans active gives you a smooth fallback.

**Auth note — what works:**
- ✅ OpenCode Go / Zen / free (via `opencode providers login --provider opencode`)
- ✅ OpenAI ChatGPT Plus/Pro subscription (via `--provider openai --method <chatgpt>`)
- ✅ Provider API keys via OneCLI vault + `ANTHROPIC_BASE_URL` (OneCLI bypass mode — see `add-opencode/SKILL.md`)

### 7. Insert the agent_groups row

`agent_groups.created_at` is `NOT NULL` with no default.

**`workgroup_id` is the load-bearing field.** It places the sibling in the SAME workgroup as its source + codex sibling, which grants the same memory canon, shared chat-archive visibility plus workgroup-level OneCLI-secret inheritance. It lives on the `agent_groups` row, NOT in `container.json` (matching how migration 036 set up the codex siblings; `reconcileWorkgroupAtSpawn` reads the DB value, and putting it in container.json instead would trip the parity-check since `workgroup_id` is not a sibling-bound field). Omitting it here is the bug that isolated the first opencode sibling (`example-labs-opencode`) into its own workgroup-of-one: migration 036 only auto-pairs the `-codex` suffix, never `-opencode`.

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

Invite the new bot user (e.g. `@helper-opencode`) to each Slack channel you want it to operate in (Slack-side, before wiring).

```bash
SLACK_CHANNEL_ID=CTEST00004                  # Slack channel id
SLACK_CHANNEL_NAME=agents-example

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

The `register` step defaults `engage_mode='mention'` — sibling-safe (only fires on explicit `@`-mention).

> **Important — owner role under the new channelType namespace.** When the host receives an inbound from the sibling bot, the sender's user-id is namespaced by the new channel_type (e.g. `discord-example-agent-opencode:123456789000000019`). Existing `user_roles` rows are scoped to the OLD namespace, so the new bot sees the sender as unknown.
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

**Check B — pre-flight: the model's provider is authed (deterministic, no spawn):**

```bash
# Effective model = DB value (container_configs) or the code default; provider =
# its slug prefix (the host derives OPENCODE_PROVIDER from this — there is no
# .env var to read anymore).
MODEL=$(pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT model FROM container_configs WHERE agent_group_id='${SIBLING_FOLDER}'" 2>/dev/null | tr -d '\n')
[ -n "$MODEL" ] || MODEL="opencode-go/glm-5.3-flash"   # DEFAULT_OPENCODE_MODEL
PROV="${MODEL%%/*}"   # e.g. opencode-go (Go), opencode (Zen), nvidia
# Resolve the auth.json this sibling uses: scoped dir if present, else global.
AUTH="$HOME/.local/share/opencode-${SIBLING_FOLDER}/auth.json"
[ -f "$AUTH" ] || AUTH="$HOME/.local/share/opencode/auth.json"
node -e "const a=require('$AUTH'); process.exit(('$PROV' in a)?0:1)" \
  && echo "✅ provider '$PROV' (from model '$MODEL') is present in $AUTH" \
  || echo "❌ provider '$PROV' is NOT in $AUTH — '$MODEL' will fail at runtime. Pick a model whose provider is authed, or 'opencode providers login' for it."
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

**Check D - running sibling has the shared global CLI surface:**

This catches custom `imageTag` drift and the historical `agent-browser` PATH
miss. Run it after Check C has caused a sibling container to spawn.

```bash
CNAME=$(docker ps --filter "name=nanoclaw-v2-${SIBLING_FOLDER}-" --format '{{.Names}}' | head -1)
test -n "$CNAME" || { echo "ERROR: no running sibling container - send the live round-trip first"; exit 1; }
docker exec "$CNAME" bash -lc 'command -v agent-browser && agent-browser --version'
```

Expected: a path under `/pnpm` or `/usr/local/bin`, followed by an
`agent-browser` version. Failure means the sibling is not at capability parity;
rebuild/fix the image or remove the custom `imageTag` before shipping.

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
FOLDER_UPPER=$(echo "${SIBLING_FOLDER}" | tr 'a-z-' 'A-Z_')

# Slack sibling:
sed -i.bak \
  -e "/^SLACK_BOT_TOKEN_${ENV_SUFFIX}=/d" \
  -e "/^SLACK_SIGNING_SECRET_${ENV_SUFFIX}=/d" \
  -e "/^OPENCODE_PROVIDER_${FOLDER_UPPER}=/d" \
  -e "/^OPENCODE_MODEL_${FOLDER_UPPER}=/d" \
  -e "/^OPENCODE_SMALL_MODEL_${FOLDER_UPPER}=/d" \
  -e "/^OPENCODE_BASE_URL_${FOLDER_UPPER}=/d" \
  -e "/^ANTHROPIC_BASE_URL_${FOLDER_UPPER}=/d" .env

# Discord sibling (alternative — drop these lines instead of the SLACK_* ones):
sed -i.bak \
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
- **OpenCode's exact Docker pin is the source of truth** for the CLI and
  `@opencode-ai/sdk`. Derive both from it, never use `bun update`, and re-run
  `bun test src/providers/` after a deliberate bump.

### Notes on cross-sibling auth and OpenCode plan choice

- A single OpenCode login covers Go + Zen + free models. Go drains from Zen credits when Go-tier limits are hit — one auth, two billing buckets.
- Anthropic Claude Pro/Max subscription is **not** supported by OpenCode 1.3.0+ (Anthropic restriction). Use Claude as the SOURCE side (primary agent) and OpenCode for the sibling; mixing Claude-subscription auth into OpenCode is dead.
- OpenAI ChatGPT Plus/Pro subscription IS supported (`--provider openai --method <chatgpt>`) if you want a sibling running on your existing ChatGPT subscription instead of OpenCode billing.

## Guard parity contract

The three providers (Claude, Codex, OpenCode) are **one team that must be at command-guard parity by construction** — same guards, same fail-closed behavior, enforced by a shared guard core plus a machine-checked conformance/dispatch test suite. Cloning a group as OpenCode is not "done" when the bot replies; it's done when the OpenCode sibling's guard wiring satisfies the contract below. This generalizes — see `.claude/skills/clone-as-provider-template/SKILL.md` for the provider-agnostic form.

OpenCode raises the stakes: the per-spawn config sets `permission: 'allow'` (every tool call auto-approved), so the guard plugin's `tool.execute.before` throw is the **only** guardrail standing between the agent and a destructive command. There is no second line of defense to fall back on.

### The contract — what "done" means for an OpenCode sibling

1. **Mount the bootstrap guard plugin; every guard routes through the shared core — no inline policy copies.** The OpenCode adapter is `opencode-guard.ts` (exports `NanoclawGuard`, mounted via the per-spawn config's `plugin: [...]` array — wired in `container/agent-runner/src/providers/opencode.ts`). It intercepts `bash` via `tool.execute.before` and edit tools via the same hook, and it imports its verdicts from the shared cores — `block-destructive-core.ts` (`evaluateBashCommand`, `evaluateGitCloneDestination`, `consumeGateApproval`, `runNanoclawGate`, `IS_NANOCLAW`), `email-gate-core.ts` (the email-gate verdict), and `file-protection-core.ts` (`EDIT_TOOLS`, `checkEditProtection`). The guard set at parity with Claude/Codex: **self-approval**, **snowflake-connector**, **email-gate**, **git-clone destination**, **destructive bash/SQL**, and **file-protection** (edits to `.env` / lockfiles / `.git` / terraform). It must never re-implement a verdict inline — the adapter owns only OpenCode's throw-to-abort I/O surface; any guard the runtime can route is sourced from the shared cores, never a local copy.

2. **Refuse to spawn an unguarded prod agent — fail closed when the guard plugin is absent or malformed.** Because `permission: 'allow'` removes every other guardrail, an OpenCode sibling running without the plugin is an unguarded prod agent. The contract is: when the guard plugin is missing or won't load, the sibling must not come up able to run destructive commands — refuse the spawn (fail closed), not warn-and-continue. The `fs.existsSync(GUARD_PLUGIN)` check that gates the `plugin: [...]` mount in `opencode.ts` is the hook point: a missing or unloadable plugin must abort the spawn, not drop the guard and proceed.

3. **Env / secret parity — the OpenCode shell tools must not see the auth env vars.** A sibling is at parity only when its bash surface cannot `printenv` the OAuth tokens / API keys handed to the container. The robust form is to strip the auth env vars from the child process before launch. Defense-in-depth holds alongside it for OpenCode: host-side `scrubSecrets` filters secret values out of chat replies, the OneCLI proxy gates most HTTPS egress, and the container is single-tenant — but those are mitigations, not a substitute for the env strip the contract requires.

4. **Pass the machine-checked suite — that gate IS the definition of done.** Two layers:
   - **Cross-surface conformance** — `conformance.test.ts` is the single readable manifest of expected verdicts for the canonical destructive / git-clone / file-protection set. If it holds, every surface that imports the same cores agrees by construction.
   - **Per-adapter dispatch coverage** — `opencode-guard.test.ts` locks the wrapper's throw/allow contract (`gateBashOrThrow` throws on hard-block / non-ephemeral `rm` / managed-dir `git clone`, allows safe commands and `/tmp` clones). An OpenCode sibling is shipped only when conformance **and** the OpenCode dispatch-coverage test are green.

### OpenCode adds NO runtime tool-denylist — parity is a recurring enumeration test

The Claude container carries a built-in tool denylist (the first responsibility of its PreToolUse hook). OpenCode has no equivalent runtime denylist, and it does not need one: the specific built-in tool names Claude denies cannot occur on OpenCode's tool surface in the first place. Parity here is therefore **not** "add a denylist to OpenCode" — it is a recurring **enumeration test** that asserts none of the denied names are reachable on OpenCode's tool surface. If a future OpenCode release ever exposes one of those names, that test fails and forces a decision. Don't port the denylist; keep the enumeration check current.
