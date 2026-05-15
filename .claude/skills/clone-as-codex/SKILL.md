---
name: clone-as-codex
description: Create a Codex-backed sibling agent for an existing Claude group. The sibling shares the source group's CLAUDE.md, repos, sources, conversations, and mnemon store via symlinks + scoped-env. Cross-agent walkie-talkie collaboration works natively via Slack mentions — requires installing a second Slack app for the sibling so each agent has its own real bot user.
---

# Clone Group As Codex Sibling

Create `groups/<source>-codex/` from `groups/<source>/`. The codex sibling shares:

- **CLAUDE.md** — symlinked; composeGroupClaudeMd regenerates AGENTS.md flat-include from it on every spawn.
- **Repos** — symlinked top-level dirs that contain `.git/`.
- **sources/** — mnemon inbox; both agents feed the same memory.
- **conversations/** — transcript archive; both agents see each other's archived turns.
- **mnemon store** — scoped-env override (`MNEMON_STORE_<sibling>=<source-ag-id>`) routes both writers to the same store.
- **Thread worktree** — when `NANOCLAW_THREAD_WORKTREES=1`, both siblings in the same Slack thread mount the same `data/v2-threads/<thread-id>/worktrees/<repo>/` host path. Uncommitted edits flow across.

`container.json` for the new sibling gets `provider: "codex"` and `memory.enabled: true`.

**Critical architectural choice — two Slack apps, not one shared bot.** Each sibling agent has its own Slack bot user, installed as a separate Slack app in the workspace. This lets agents `@`-mention each other (real Slack mentions, real autocomplete) and have those mentions fire the peer via standard `engage_mode='mention'`. The single-bot/text-pattern alternative was tried and abandoned — it triggered runaway agent-to-agent loops that bypassed Slack entirely.

## Prerequisites

- The source group exists in `groups/<source>/` and has a row in `agent_groups`.
- `provider: "codex"` is registered (codex provider is in trunk; nothing to install).
- `.env` exists and is writable.
- **You have admin rights in the Slack workspace** to create a second Slack app for the sibling.

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

### 2. Install the sibling's Slack app

Follow `.claude/skills/add-slack/SKILL.md` to install a new app in the same workspace where the source agent's bot lives. **Name the bot user something distinct but discoverable** — using the source name with a suffix (e.g. `illie-codex` when source is `illie`) makes Slack's `@`-autocomplete group them together for the user.

Required bot scopes (per add-slack skill step 6): `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `reactions:read`, `users:read`.

Required bot events (step 10): `message.channels`, `message.groups`, `message.im`, `app_mention`.

Set the Request URL to the same `https://<your-domain>/webhook/slack` as the existing source app — the host's webhook router dispatches by Slack app id, not by URL path.

After installing the new app to the workspace, capture the **bot token** (`xoxb-...`) and **signing secret** from the Slack app settings.

> **Note on naming**: the Slack-side bot display name (`illie-codex`), the env-var suffix (`ILLYSIUM_CODEX`), and the resulting channelType (`slack-illysium-codex`) are independent but conventionally aligned. The adapter accepts uppercase + underscores in the suffix and maps `_` → `-` when deriving the channelType, so `SLACK_BOT_TOKEN_ILLYSIUM_CODEX` becomes `slack-illysium-codex` — symmetric with the existing `SLACK_BOT_TOKEN_ILLYSIUM` → `slack-illysium`.

### 3. Add the sibling's env vars

Pick an `ENV_SUFFIX` that mirrors the source's suffix with `_CODEX` appended (e.g. existing `ILLYSIUM` → new `ILLYSIUM_CODEX`). Uppercase alphanumeric + underscores. The host's slack adapter discovers it on next restart and creates a new `channelType` value `slack-<env_suffix-lowercased-with-dashes>`.

```bash
ENV_SUFFIX=ILLYSIUM_CODEX                 # uppercase, underscores OK
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

### 4. Create the sibling group directory + symlinks

```bash
SIBLING_FOLDER=${SOURCE_FOLDER}-codex
SIBLING_ID=${SIBLING_FOLDER}                # use folder name as ag-id, matching host-default groups (main, axie-dev)

mkdir -p groups/${SIBLING_FOLDER}
cd groups/${SIBLING_FOLDER}
ln -sfn ../${SOURCE_FOLDER}/CLAUDE.md CLAUDE.md
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
  "gitnexusInjectAgentsMd": true,
  "tools": [],
  "memory": { "enabled": true },
  "codexHostAuth": true
}
EOF

# Manually copy the "tools" array from groups/${SOURCE_FOLDER}/container.json
# — the operator decides which tools are appropriate for the codex sibling.
```

### 6. Scoped MNEMON_STORE override

Routes the sibling's memory writes to the source group's existing store. The override value is the source's **ag-id** (not folder), because `container-runner.ts` defaults `MNEMON_STORE` to `agentGroup.id`.

```bash
ENV_KEY=MNEMON_STORE_$(echo "${SIBLING_FOLDER}" | tr '-' '_')
if grep -q "^${ENV_KEY}=" .env; then
  sed -i.bak "s|^${ENV_KEY}=.*|${ENV_KEY}=${SOURCE_ID}|" .env
else
  echo "${ENV_KEY}=${SOURCE_ID}" >> .env
fi
grep "^${ENV_KEY}=" .env
```

### 7. Insert the agent_groups row

`agent_groups.created_at` is `NOT NULL` with no default.

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DISPLAY_NAME=<display_name>                 # what users see in the dashboard, e.g. "illie-codex"

EXISTING=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SIBLING_FOLDER}'" 2>/dev/null | tr -d '\n')
if [ -z "${EXISTING}" ]; then
  pnpm exec tsx scripts/q.ts data/v2.db \
    "insert into agent_groups (id, folder, name, agent_provider, created_at) values ('${SIBLING_ID}', '${SIBLING_FOLDER}', '${DISPLAY_NAME}', 'codex', '${NOW}')"
fi
```

### 8. Restart the host so the new Slack adapter + env vars get picked up

```bash
sudo systemctl restart nanoclaw-v2
```

Wait ~5 seconds. On restart, the slack adapter sees `SLACK_BOT_TOKEN_${ENV_SUFFIX}` and registers a new channelType `slack-${env_suffix-lowercased}`.

### 9. Wire the sibling to the desired Slack channels

The sibling needs to be added to the relevant Slack channels FROM SLACK first — invite the new bot user (e.g. `@illie-codex`) to `#agents-xzo` and any other channels you want it to operate in. Slack delivers the first message it receives in each channel to the host's webhook; the host auto-creates a `messaging_groups` row for the channel under the new `channelType`. After that auto-wire happens, the sibling's `messaging_group_agents` row gets created automatically with `engage_mode='mention'` (the platform-default — fires on real `@`-mention of its bot user).

The source bot keeps its own `messaging_group_agents` row in the existing `slack-<source>` channelType — untouched by this skill. Both bots share the channel physically; their NanoClaw routing is separate.

> If you'd rather not rely on auto-wire, you can pre-insert the row manually after step 8 — see `.claude/skills/manage-channels/SKILL.md`.

### 10. Verify

In a Slack channel where both bots have been invited, post a message:

- `@<source> hello` → source agent fires (the existing illie bot).
- `@<sibling-slack-name> hello` → sibling agent fires (the new codex bot).
- `@<source> can you @<sibling-slack-name> help with this?` → both fire (each on its own real mention).

If the sibling fires once but never picks up a follow-up `@`-mention from the source agent, check that:
- The sibling bot user is invited to that Slack channel.
- The source bot user is *also* invited (same channel).
- Both apps subscribe to `message.channels` (per the add-slack skill).

## Reverting

Assumes you still have `SOURCE_FOLDER`, `SOURCE_ID`, `SIBLING_FOLDER`, `SIBLING_ID`, `ENV_SUFFIX` from the install.

```bash
sudo systemctl stop nanoclaw-v2

# Drop wiring + agent_groups row.
pnpm exec tsx scripts/q.ts data/v2.db "delete from messaging_group_agents where agent_group_id='${SIBLING_ID}'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from messaging_groups where channel_type='slack-$(echo "${ENV_SUFFIX}" | tr '[:upper:]_' '[:lower:]-')'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from agent_groups where id='${SIBLING_ID}'"

# Drop the symlink tree.
rm -rf groups/${SIBLING_FOLDER}

# Drop env entries.
ENV_KEY=MNEMON_STORE_$(echo "${SIBLING_FOLDER}" | tr '-' '_')
sed -i.bak \
  -e "/^${ENV_KEY}=/d" \
  -e "/^SLACK_BOT_TOKEN_${ENV_SUFFIX}=/d" \
  -e "/^SLACK_SIGNING_SECRET_${ENV_SUFFIX}=/d" .env

sudo systemctl start nanoclaw-v2
```

Optionally, uninstall the sibling's Slack app from the workspace at `api.slack.com/apps`.

## Notes

- `composeGroupClaudeMd` (host-side, runs every container spawn) regenerates `groups/${SIBLING_FOLDER}/AGENTS.md` from the same CLAUDE.md the source group uses, with `@-includes` resolved inline for Codex. No manual AGENTS.md authoring.
- The codex container reads MCP server config from `~/.codex/config.toml` (regenerated each session by `writeCodexMcpConfigToml`) and hook config from `~/.codex/hooks.json` (regenerated each session by `writeCodexHooksJson`).
- Worktrees are thread-scoped when `NANOCLAW_THREAD_WORKTREES=1` is in `.env`. The mount key is platform-derived (`<base>/<thread-id-or-dm-platform>/worktrees/`), so both bots' MGs in the same Slack channel resolve to the same path. Uncommitted edits from one sibling are visible to the other via `git status`.
- Concurrent git operations across siblings: the shared worktree has standard git internal locks (`.git/index.lock`). Turn-taking via the `@`-mention pattern mitigates by design — only one sibling is active per turn after a hand-off. If both fire on the same user message (`@illie @illie-codex collab`), git ops can race; failures are loud (`fatal: Unable to create '.git/index.lock'`) and the agent retries.

### Known limitation: Codex Bash secret sanitization is a no-op

The Claude provider's `createSanitizeBashHook` returns `hookSpecificOutput.updatedInput` with an `unset ANTHROPIC_API_KEY ...` prefix before every Bash command. Per the Codex hooks docs (developers.openai.com/codex/hooks), Codex parses `updatedInput` but does **not** apply it — the hook fails open. So a Codex container can `printenv` and see the OAuth tokens / API keys passed to it.

Mitigations in place that do work for Codex:
- Host-side `scrubSecrets` on outbound delivery filters registered secret values out of chat replies.
- OneCLI proxy intercepts most HTTPS egress; secrets in headers/URLs that route through it get logged + gated.
- The container is single-tenant — only the operator's own agents run in it, no adversarial workloads.

Not mitigated: an agent that bypasses the proxy (NO_PROXY) and exfiltrates via direct HTTP to a remote it controls. Proper fix is to rewrite the Codex container's env before launch — out of scope for the pilot.

## Future work — captured for later, not in scope today

### 1. Flip primary provider (Claude-nerf resilience)

The Claude-as-canonical / Codex-as-sibling split is just symlink direction + `messaging_group_agents` rows. Three escape hatches if the Claude Max subscription gets squeezed:

- **Drop Claude side**: delete the source's `messaging_group_agents` rows; the codex sibling stays wired to the same channels. `@<source>` in Slack just stops responding; `@<sibling-slack-name>` continues. Shared store + repos stay put. ~30 seconds of SQL.
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
