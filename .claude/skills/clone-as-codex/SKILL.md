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

### 1. Resolve the source group

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select id, folder, name from agent_groups where folder='<name>'"
```

Confirm the row exists. If the agent_group's `name` column needs to differ from the source (e.g., source is "illie", sibling should be "Axie-codex" for display), capture the source's display name now — you'll re-use it.

### 2. Create the sibling group directory

```bash
SOURCE=<name>
SIBLING=${SOURCE}-codex
mkdir -p groups/${SIBLING}
```

### 3. Symlink shared assets

```bash
cd groups/${SIBLING}
ln -sfn ../${SOURCE}/CLAUDE.md CLAUDE.md
ln -sfn ../${SOURCE}/sources sources
ln -sfn ../${SOURCE}/conversations conversations

# Repos: symlink every dir in the source group that contains a .git/.
for repo in ../${SOURCE}/*/; do
  if [ -d "${repo}.git" ]; then
    name=$(basename "${repo%/}")
    ln -sfn "../${SOURCE}/${name}" "${name}"
  fi
done
cd -
```

### 4. Write container.json

```bash
cat > groups/${SIBLING}/container.json <<'EOF'
{
  "provider": "codex",
  "memory": { "enabled": true },
  "mcpServers": {}
}
EOF
```

Operator should manually copy any `mcpServers` from `groups/${SOURCE}/container.json` that should also be available to the codex sibling — most should.

### 5. Wire scoped MNEMON_STORE override

Replace dashes with underscores in the sibling folder name for the env key:

```bash
ENV_KEY=MNEMON_STORE_$(echo "${SIBLING}" | tr '-' '_')
# Idempotent: append if not already present.
grep -q "^${ENV_KEY}=" .env || echo "${ENV_KEY}=${SOURCE}" >> .env
```

After this, the host's container-runner.ts reads `process.env.${ENV_KEY}` at spawn time and uses its value (the source group id) as the container's `MNEMON_STORE`, so both Claude and Codex sessions write to the same mnemon store.

### 6. Insert the agent_groups row

```bash
SIBLING_ID=$(pnpm exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='${SIBLING}'" 2>/dev/null)
if [ -z "${SIBLING_ID}" ]; then
  # NB: the agent_group id is a generated identifier; the host has a helper
  # for this. Easiest path: use the host's createAgentGroup() via a
  # one-shot tsx script. Below shows the SQL form for the rare case the
  # host helper isn't available — folder is unique so re-running is safe.
  pnpm exec tsx scripts/q.ts data/v2.db \
    "insert into agent_groups (id, folder, name, agent_provider) values ('${SIBLING}', '${SIBLING}', '<display_name>-codex', 'codex')"
fi
```

> **Operator: replace `<display_name>` with whatever you want users to see in the dashboard.** This is independent of the source group's display name.

### 7. Wire mention disambiguation per channel (Stage 6 — see also `/manage-channels`)

Two agents sharing one Slack bot user need a way to route `@bot ...` messages to the right sibling. The router supports `engage_mode='mention-pattern'`: requires both an `@`-mention of the bot AND a text-pattern match. Reduces noise (random "codex" in chat won't wake the bot) while still letting one bot serve both siblings.

**Trigger syntax** that this wiring enables (assuming the bot's Slack username is `${SOURCE}`):

- `@${SOURCE} do X` → source agent fires (real `@`-mention, no `@codex` keyword)
- `@${SOURCE} @codex do Y` → sibling agent fires (real `@`-mention + literal `@codex` keyword)
- `@${SOURCE} use codex as a subagent` → source agent fires — the bare word `codex` is fine. Only the literal string `@codex` routes to the sibling. This is deliberate: prevents false-fires when the source agent is asked to *use* codex as a subagent.
- `@${SOURCE}-codex do Z` → ⚠️ does NOT fire — `${SOURCE}-codex` isn't a real Slack user, so Slack treats it as literal text and `isMention=false`. Use `@${SOURCE} @codex ...` instead.

```bash
# Replace MG_ID with the messaging_group id you want both siblings on.
MG_ID=<messaging-group-id>

# Source agent: @-mention required + must NOT contain literal "@codex".
# Negative-lookahead anchors at the start of the text and bans "@codex"
# anywhere in the message. Bare "codex" (without @) is allowed — the
# source agent can still be asked to "use codex as a subagent" without
# accidentally routing the message to the sibling.
pnpm exec tsx scripts/q.ts data/v2.db \
  "update messaging_group_agents
   set engage_mode='mention-pattern', engage_pattern='^(?!.*@codex)'
   where messaging_group_id='${MG_ID}' and agent_group_id='${SOURCE}'"

# Sibling agent: @-mention required + MUST contain literal "@codex".
pnpm exec tsx scripts/q.ts data/v2.db \
  "insert into messaging_group_agents (messaging_group_id, agent_group_id, engage_mode, engage_pattern, session_mode, priority)
   values ('${MG_ID}', '${SIBLING}', 'mention-pattern', '@codex', 'persistent', 100)"
```

> **Why literal `@codex` (not bare `codex`)?** When you ask the source agent to "use codex as a subagent" or "ask codex to check your work", the bare word `codex` shouldn't route to the sibling — that's intentional source-side delegation, not a hand-off. Anchoring on the literal `@` prefix gives a clean separation: `codex` = something the source agent uses, `@codex` = the sibling agent. Slack won't autocomplete `@codex` to a real mention (no user by that name), but the literal text is still in the message body, so the pattern matches.

> **Self-echo loops are prevented at the adapter layer.** The Slack adapter (via `@chat-adapter/slack`'s `isMessageFromSelf` + `@chat`'s `handleIncomingMessage`) drops events where `event.user === bot_user_id` before they reach the router. So `${SIBLING}` posting in a thread will NOT trigger `${SOURCE}` (or itself) on the echo. Verified at `node_modules/chat/dist/index.js:2943`.

### 8. Restart the host so the new agent_groups row + .env scoped-env is picked up

```bash
sudo systemctl restart nanoclaw-v2
```

### 9. Verify

Open the channel from step 7 and send `@${SIBLING} hello`. The Codex container spawns (one-time delay for image cold start), writes to the shared mnemon store, and replies. The source `@${SOURCE}` should still respond only to its own name.

## Reverting

To undo a clone-as-codex run:

```bash
sudo systemctl stop nanoclaw-v2
SOURCE=<name>
SIBLING=${SOURCE}-codex

# Drop wiring + agent_groups row.
pnpm exec tsx scripts/q.ts data/v2.db "delete from messaging_group_agents where agent_group_id='${SIBLING}'"
pnpm exec tsx scripts/q.ts data/v2.db "delete from agent_groups where folder='${SIBLING}'"

# Restore source wiring to plain 'mention' (or 'mention-sticky' for Discord).
pnpm exec tsx scripts/q.ts data/v2.db "update messaging_group_agents set engage_mode='mention', engage_pattern=null where agent_group_id='${SOURCE}'"

# Drop the symlink tree.
rm -rf groups/${SIBLING}

# Drop the scoped-env line.
ENV_KEY=MNEMON_STORE_$(echo "${SIBLING}" | tr '-' '_')
sed -i.bak "/^${ENV_KEY}=/d" .env

sudo systemctl start nanoclaw-v2
```

## Notes

- The composeGroupClaudeMd flow (host-side, runs every container spawn) regenerates `groups/${SIBLING}/AGENTS.md` from the same CLAUDE.md the source group uses, with `@-includes` resolved inline for Codex. No manual AGENTS.md authoring.
- The codex container reads MCP server config from `~/.codex/config.toml` (regenerated each session by `writeCodexMcpConfigToml`) and hook config from `~/.codex/hooks.json` (regenerated each session by `writeCodexHooksJson`).
- Worktrees are thread-scoped when `NANOCLAW_THREAD_WORKTREES=1` is in `.env` — both siblings in the same thread share `data/v2-threads/<mg>:<thread>/worktrees/<repo>/`, so uncommitted edits from one agent are visible to the other via `git status`.

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
