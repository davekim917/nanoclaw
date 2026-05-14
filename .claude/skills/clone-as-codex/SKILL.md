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

For each messaging_group that the source agent is wired to, add a sibling wiring with an `engage_pattern` regex that matches only the sibling's name. Critical: the source's wiring also needs updating to match only its own name, otherwise the source agent fires on EVERY mention — including `@${SIBLING}`.

```bash
# Replace MG_ID with the messaging_group id you want both siblings on.
MG_ID=<messaging-group-id>

# Source agent: restrict to its own name (not preceded/followed by hyphen).
pnpm exec tsx scripts/q.ts data/v2.db \
  "update messaging_group_agents
   set engage_mode='pattern', engage_pattern='(?<!-)${SOURCE}(?!-)'
   where messaging_group_id='${MG_ID}' and agent_group_id='${SOURCE}'"

# Sibling agent: insert new wiring + restrict to sibling name.
pnpm exec tsx scripts/q.ts data/v2.db \
  "insert into messaging_group_agents (messaging_group_id, agent_group_id, engage_mode, engage_pattern, session_mode, priority)
   values ('${MG_ID}', '${SIBLING}', 'pattern', '${SIBLING}', 'persistent', 100)"
```

> **Edge case** — when the user `@`-mentions a Slack bot user (not the display name), platform `isMention` fires but the text may not contain `${SOURCE}` or `${SIBLING}`. In that case the regex doesn't match either agent and neither responds. The operator workflow is: address agents by name in the message text (`@${SOURCE} hi` or `@${SIBLING} hi`), not by Slack mention alone.

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
- Worktrees become thread-scoped once Stage 8 of the codex-parity work ships (`/team-ship` it via the spawn-board). Until then, each session (Claude or Codex) gets its own worktree — collaborative code-edit-in-one-thread requires Stage 8.
