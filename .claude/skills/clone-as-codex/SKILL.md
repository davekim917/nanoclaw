---
name: clone-as-codex
description: Create a Codex-backed sibling agent for an existing Claude group. Shares the source group's CLAUDE.md, repos, sources, and conversations via symlinks so both providers work off the same codebase, memory, and chat history. Both agents can be addressed individually in the same channel via engage-pattern regex.
---

# Clone Group As Codex Sibling

Create `groups/<name>-codex/` from `groups/<name>/`. The codex sibling shares:

- **CLAUDE.md** (composeGroupClaudeMd regenerates AGENTS.md flat-include from this on every spawn — no manual sync)
- **Repos** (top-level dirs that look like `<REPO>/.git/` in the source group)
- **sources/** (mnemon inbox — both agents feed the same memory)
- **conversations/** (transcript archive — both agents see each other's prior turns)

`container.json` for the new sibling gets `provider: "codex"` and `memory.enabled: true`.

`MNEMON_STORE` is set via the scoped-env convention (`MNEMON_STORE_<folder>_<with-dashes-as-underscores>=<source-id>` in `.env`) so the sibling writes to the source group's memory store rather than its own. Mirrors the existing per-group git-identity pattern (`GIT_AUTHOR_NAME_<folder>`).

## Prerequisites

- The source group exists in `groups/<name>/` and has a row in `agent_groups` (use `/q "select id, folder, name from agent_groups"`).
- `provider: "codex"` is registered (the codex provider files are in trunk; nothing to install).
- `.env` exists and is writable.

## Steps

### 1. Resolve the source group (capture `agent_groups.id`!)

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select id, folder, name from agent_groups where folder='<name>'"
```

Confirm the row exists. **Capture the `id` column value — it's an `ag-...` string, not the folder name.** Every later SQL statement that touches `messaging_group_agents.agent_group_id` or `agent_destinations.agent_group_id` MUST use this id, not the folder. Storing folder names there silently matches zero rows and leaves the existing wiring untouched.

```bash
SOURCE_FOLDER=<name>             # e.g. illie
SOURCE_ID=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SOURCE_FOLDER}'" | tr -d '\n')
test -n "${SOURCE_ID}" || { echo "ERROR: source group '${SOURCE_FOLDER}' not found"; exit 1; }
echo "Source folder: ${SOURCE_FOLDER}"
echo "Source ag-id:  ${SOURCE_ID}"
```

If the agent_group's `name` column needs to differ from the source (e.g., source folder is "illie", sibling should display as "Axie-codex"), capture the source's display name now too.

### 2. Create the sibling group directory

```bash
SIBLING_FOLDER=${SOURCE_FOLDER}-codex
SIBLING_ID=${SIBLING_FOLDER}              # we use the folder name as the new ag-id; convenient + matches NanoClaw's existing host-default groups (main, axie-dev) that do the same
mkdir -p groups/${SIBLING_FOLDER}
```

### 3. Symlink shared assets

```bash
cd groups/${SIBLING_FOLDER}
ln -sfn ../${SOURCE_FOLDER}/CLAUDE.md CLAUDE.md
ln -sfn ../${SOURCE_FOLDER}/sources sources
ln -sfn ../${SOURCE_FOLDER}/conversations conversations

# Repos: symlink every dir in the source group that contains a .git/.
for repo in ../${SOURCE_FOLDER}/*/; do
  if [ -d "${repo}.git" ]; then
    name=$(basename "${repo%/}")
    ln -sfn "../${SOURCE_FOLDER}/${name}" "${name}"
  fi
done
cd -
```

### 4. Write container.json

```bash
cat > groups/${SIBLING_FOLDER}/container.json <<'EOF'
{
  "provider": "codex",
  "memory": { "enabled": true },
  "mcpServers": {}
}
EOF
```

Operator should manually copy any `mcpServers` from `groups/${SOURCE_FOLDER}/container.json` that should also be available to the codex sibling — most should.

### 5. Wire scoped MNEMON_STORE override

The override value must be the source group's **ag-id** (not folder), because `container-runner.ts` defaults `MNEMON_STORE` to `agentGroup.id`, and we want both siblings to write to the same store.

```bash
ENV_KEY=MNEMON_STORE_$(echo "${SIBLING_FOLDER}" | tr '-' '_')
# Idempotent: replace existing line or append.
if grep -q "^${ENV_KEY}=" .env; then
  sed -i.bak "s|^${ENV_KEY}=.*|${ENV_KEY}=${SOURCE_ID}|" .env
else
  echo "${ENV_KEY}=${SOURCE_ID}" >> .env
fi
grep "^${ENV_KEY}=" .env
```

After this, the host's container-runner.ts reads `process.env.${ENV_KEY}` at spawn time and uses its value (the source group id) as the container's `MNEMON_STORE`, so both Claude and Codex sessions write to the same mnemon store.

### 6. Insert the agent_groups row

`agent_groups.created_at` is `NOT NULL` with no default — must be supplied.

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DISPLAY_NAME=<display_name>     # what users see in the dashboard, e.g. "illie-codex"

EXISTING=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SIBLING_FOLDER}'" 2>/dev/null | tr -d '\n')
if [ -z "${EXISTING}" ]; then
  pnpm exec tsx scripts/q.ts data/v2.db \
    "insert into agent_groups (id, folder, name, agent_provider, created_at) values ('${SIBLING_ID}', '${SIBLING_FOLDER}', '${DISPLAY_NAME}', 'codex', '${NOW}')"
fi
```

> **Operator: set `DISPLAY_NAME` above** to whatever you want users to see in the dashboard. This is independent of the source group's display name.

### 7. Wire mention disambiguation per channel (Stage 6 — see also `/manage-channels`)

Two agents sharing one Slack bot user need a way to route `@bot ...` messages to the right sibling. The router supports `engage_mode='mention-pattern'`: requires both an `@`-mention of the bot AND a text-pattern match. Reduces noise (random "codex" in chat won't wake the bot) while still letting one bot serve both siblings.

**Trigger syntax** that this wiring enables (assuming the bot's Slack username is `${SOURCE}`):

| You type | What fires |
|---|---|
| `@${SOURCE} do X` | source only |
| `@${SOURCE} use codex as a subagent` | source only (bare `codex` doesn't route to sibling) |
| `@${SOURCE} @codex do Y` | **both** (source on real `@`-mention, sibling on literal `@codex` text) |
| `@codex do Z` | sibling only (no real `@`-mention; sibling uses pattern-only mode) |
| `@${SOURCE}-codex do W` | ⚠️ nothing — `${SOURCE}-codex` isn't a real Slack user, just literal text; doesn't match either pattern |

Why each side uses a different engage mode:

- **source** uses `mention` (plain platform `@`-mention). Always fires when the bot is mentioned. The sibling firing alongside is additive, not exclusive — siblings can collaborate when both are addressed.
- **sibling** uses `pattern` (text contains literal `@codex`, no platform `@`-mention required). This makes the sibling addressable alone via `@codex …` even though no Slack user exists by that name. Random chatter saying `@codex` would also fire it; tighten the regex if that becomes noisy in this channel.

```bash
# Replace MG_ID with the messaging_group id you want both siblings on.
MG_ID=<messaging-group-id>

# Source agent: any real @-mention of the bot fires it. No pattern.
# IMPORTANT: agent_group_id is the ag-id captured in step 1, not the folder.
pnpm exec tsx scripts/q.ts data/v2.db \
  "update messaging_group_agents
   set engage_mode='mention', engage_pattern=NULL
   where messaging_group_id='${MG_ID}' and agent_group_id='${SOURCE_ID}'"

# Sibling agent: text contains literal '@codex' (no real @-mention needed).
# session_mode='per-thread' so each thread gets its own session; matches the
# source's default behavior for threaded channels.
pnpm exec tsx scripts/q.ts data/v2.db \
  "insert into messaging_group_agents (messaging_group_id, agent_group_id, engage_mode, engage_pattern, session_mode, priority, created_at)
   values ('${MG_ID}', '${SIBLING_ID}', 'pattern', '@codex', 'per-thread', 100, '${NOW}')"
```

### 7b. Wire bi-directional agent_destinations for walkie-talkie peer-wake

For `[over]` to actually wake the peer (rather than just decoratively appearing in the message), each agent needs an `agent_destinations` row authorizing it to send to the other. Idempotent — re-running is safe. All four columns key on the ag-id, not folder.

```bash
# Source → sibling
pnpm exec tsx scripts/q.ts data/v2.db \
  "insert or ignore into agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
   values ('${SOURCE_ID}', 'codex', 'agent', '${SIBLING_ID}', '${NOW}')"

# Sibling → source
pnpm exec tsx scripts/q.ts data/v2.db \
  "insert or ignore into agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
   values ('${SIBLING_ID}', '${SOURCE_FOLDER}', 'agent', '${SOURCE_ID}', '${NOW}')"
```

> **Why both directions?** Either agent can emit `[over]` to hand off; the peer-wake helper in `delivery.ts` calls `routeAgentMessage(target=sibling, originator=session)`, which permission-checks against `agent_destinations`. Missing rows → "unauthorized agent-to-agent" error in the host log + the hand-off silently drops.

> **Self-echo loops are prevented at the adapter layer.** The Slack adapter (via `@chat-adapter/slack`'s `isMessageFromSelf` + `@chat`'s `handleIncomingMessage`) drops events where `event.user === bot_user_id` before they reach the router. So `${SIBLING}` posting in a thread will NOT trigger `${SOURCE}` (or itself) on the echo. Verified at `node_modules/chat/dist/index.js:2943`. The walkie-talkie peer-wake path bypasses this by writing directly to the sibling's session inbound DB — it doesn't go through Slack or the router.

### 8. Restart the host so the new agent_groups row + .env scoped-env is picked up

```bash
sudo systemctl restart nanoclaw-v2
```

### 9. Verify

Open the channel from step 7 and send `@${SIBLING} hello`. The Codex container spawns (one-time delay for image cold start), writes to the shared mnemon store, and replies. The source `@${SOURCE}` should still respond only to its own name.

## Reverting

To undo a clone-as-codex run (assumes you still have `SOURCE_FOLDER`, `SOURCE_ID`, `SIBLING_FOLDER`, `SIBLING_ID` from the install):

```bash
sudo systemctl stop nanoclaw-v2

# Drop wiring + agent_destinations + agent_groups row (by ag-id).
pnpm exec tsx scripts/q.ts data/v2.db "delete from messaging_group_agents where agent_group_id='${SIBLING_ID}'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from agent_destinations where agent_group_id='${SIBLING_ID}' or target_id='${SIBLING_ID}'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from agent_destinations where agent_group_id='${SOURCE_ID}' and target_id='${SIBLING_ID}'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from agent_groups where id='${SIBLING_ID}'"

# Restore source wiring to plain 'mention' (or 'mention-sticky' for Discord).
pnpm exec tsx scripts/q.ts data/v2.db "update messaging_group_agents set engage_mode='mention', engage_pattern=null where agent_group_id='${SOURCE_ID}'"

# Drop the symlink tree.
rm -rf groups/${SIBLING_FOLDER}

# Drop the scoped-env line.
ENV_KEY=MNEMON_STORE_$(echo "${SIBLING_FOLDER}" | tr '-' '_')
sed -i.bak "/^${ENV_KEY}=/d" .env

sudo systemctl start nanoclaw-v2
```

## Notes

- The composeGroupClaudeMd flow (host-side, runs every container spawn) regenerates `groups/${SIBLING_FOLDER}/AGENTS.md` from the same CLAUDE.md the source group uses, with `@-includes` resolved inline for Codex. No manual AGENTS.md authoring.
- The codex container reads MCP server config from `~/.codex/config.toml` (regenerated each session by `writeCodexMcpConfigToml`) and hook config from `~/.codex/hooks.json` (regenerated each session by `writeCodexHooksJson`).
- Worktrees are thread-scoped when `NANOCLAW_THREAD_WORKTREES=1` is in `.env` — both siblings in the same thread share `data/v2-threads/<mg>/<thread>/worktrees/<repo>/`, so uncommitted edits from one agent are visible to the other via `git status`. For DMs / non-threaded channels the share key collapses to `data/v2-threads/<mg>/none/worktrees/<repo>/`.
- Concurrent git operations across siblings: the shared worktree has standard git internal locks (`.git/index.lock`). The walkie-talkie turn-taking protocol mitigates by design — only one sibling is active per turn under `[over]` hand-off. If two siblings happen to fire on the same user message (`@illie @codex collab`), git ops can race; in practice failures are loud (`fatal: Unable to create '.git/index.lock'`) and the agent retries.

### Known limitation: Codex Bash secret sanitization is a no-op

The Claude provider's `createSanitizeBashHook` returns `hookSpecificOutput.updatedInput` with an `unset ANTHROPIC_API_KEY ...` prefix before every Bash command. Per the Codex hooks docs (developers.openai.com/codex/hooks), Codex parses `updatedInput` but does **not** apply it — the hook fails open. So a Codex container can `printenv` and see the OAuth tokens / API keys passed to it.

Mitigations in place that do work for Codex:
- Host-side `scrubSecrets` on outbound delivery filters registered secret values out of chat replies.
- OneCLI proxy intercepts most HTTPS egress; secrets in headers/URLs that route through it get logged + gated.
- The container is single-tenant — only Dave's own agents run in it, no adversarial workloads.

Not mitigated: an agent that bypasses the proxy (NO_PROXY) and exfiltrates via direct HTTP to a remote it controls. Proper fix is to rewrite the Codex container's env before launch — out of scope for this pilot. Track if it becomes a real concern.

## Future work — captured for later, not in scope today

### 1. Flip primary provider (Claude-nerf resilience)

The Claude-as-canonical / Codex-as-sibling split is just symlink direction. Three escape hatches if the Claude Max subscription gets squeezed:

- **Flip canonical**: `mv groups/illie groups/illie.tmp && mv groups/illie-codex groups/illie && ...` — relink symlinks the other way. ~10 min of mechanical work.
- **Drop Claude side**: delete the source `agent_groups` row, leave the codex sibling as the sole agent for that messaging group. Shared store + repos stay put. `@illie` in Slack still wakes the same bot; it routes only to the codex agent now.
- **Inverse skill**: a `clone-as-claude` skill that takes a codex-backed source group and creates a Claude-backed sibling. Currently a copy of `/clone-as-codex` with provider strings flipped.

Decision criteria for picking the right path when the time comes: cost trajectory of each provider, parity quality of the codex-side guardrails (Stage 2 should hold up), whether you want to keep both for redundancy or commit to one. Don't pre-build any of this — flipping is cheaper than the abstraction.

### 2. Generalize this skill → `/clone-agent-as-provider <source> <provider>`

Today `/clone-as-codex` hardcodes `provider: "codex"` and the `@codex` keyword. A generalized version would take both as arguments:

```
/clone-agent-as-provider illie opencode    # creates illie-opencode with @opencode keyword
/clone-agent-as-provider illie claude      # for codex-canonical → claude sibling
```

Implementation when it's worth doing:

- Parameterize the keyword (default to the provider name).
- Parameterize the sibling folder suffix (default to `-<provider>`).
- Wrap the existing seven steps in a single skill that takes `(source, provider)` and emits the parameterized SQL + symlink commands.
- Migrate the existing `/clone-as-codex` to be a thin alias.

Punt this until you have a second non-Claude provider in production. With only Codex today, the generalization is solving for a future that may not happen.
