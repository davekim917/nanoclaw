---
name: customize
description: Add new capabilities or modify NanoClaw behavior. Use when user wants to add channels (Telegram, Slack, email input), change triggers, add integrations, modify the router, or make any other customizations. This is an interactive skill that asks questions to understand what the user wants.
---

# NanoClaw Customization

This skill helps users add capabilities or modify behavior. Use AskUserQuestion to understand what they want before making changes.

## Workflow

1. **Understand the request** — Ask clarifying questions.
2. **Prefer a dedicated skill** — If a skill covers the request, invoke it instead of editing core by hand:
   - Channels: `/add-telegram`, `/add-slack`, `/add-discord`, `/add-whatsapp`, `/add-signal`, `/add-imessage`, and the rest of the `/add-<channel>` family.
   - Wiring channels to agents and isolation levels: `/manage-channels`.
   - Container directory access: `/manage-mounts`.
   - Agent providers (non-default): `/add-opencode`, `/add-codex`, `/add-ollama-provider`.
   - Integrations as MCP tools: `/add-gmail-tool`, `/add-gcal-tool`, `/add-ollama-tool`, etc.
3. **Plan the changes** — Identify the v2 surface the change belongs to (entity model in the central DB, per-agent-group container config or instructions, workgroup memory canon, or core code). For a scheduled, event-driven, continuation, or recovery workflow, read `docs/workflow-automation.md` before choosing a trigger.
4. **Implement** — Make the change on the right surface.
5. **Test guidance** — Tell the user how to verify.

## Entity Model

Customizations route through the v2 entity model: users → messaging groups → agent groups → sessions. A messaging group is one chat/channel on one platform; an agent group holds the workspace, personality, and container config; a wiring links a messaging group to an agent group with a session mode and trigger rules. Inspect and edit all of this with the `ncl` admin CLI. See `docs/isolation-model.md` for the three isolation levels.

## Key Files

| File                                       | Purpose                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                             | Entry point: init DB, migrations, channel adapters, delivery polls, sweep, shutdown                                          |
| `src/router.ts`                            | Inbound routing: messaging group → agent group → session → `inbound.db` → wake                                               |
| `src/delivery.ts`                          | Polls `outbound.db`, delivers via adapter, handles system actions                                                            |
| `src/session-manager.ts`                   | Resolves sessions; opens `inbound.db` / `outbound.db`; heartbeat path                                                        |
| `src/container-runner.ts`                  | Spawns per-agent-group containers with session DB + outbox mounts, OneCLI `ensureAgent`                                      |
| `src/channels/`                            | Channel adapter infra (registry, Chat SDK bridge); specific adapters install from the `channels` branch                      |
| `src/config.ts`                            | Process-level config (assistant name, paths, timeouts) read from `.env`                                                      |
| `data/v2.db`                               | Central DB: users, roles, agent_groups, messaging_groups, wirings, container_configs                                         |
| `data/v2-sessions/<session>/`              | Per-session `inbound.db` (host→container) + `outbound.db` (container→host)                                                   |
| `groups/<folder>/standing-instructions.md` | Provider-neutral role/persona source composed into generated `CLAUDE.md` and `AGENTS.md` for default agent surfaces at spawn |
| `groups/<folder>/CLAUDE.local.md`          | Operator-curated local instructions included in the composed provider documents                                              |
| `groups/<folder>/container.json`           | Authoritative per-group runtime config; `ncl groups config update` keeps its DB projection in sync                           |
| `data/workgroups/<workgroup-id>/memory/`   | Canonical Markdown memory shared by every sibling in the workgroup                                                           |

For ad-hoc DB queries, use `pnpm exec tsx scripts/q.ts <db> "<sql>"`.

## Common Customization Patterns

### Adding a New Input Channel (e.g., Telegram, Slack, Email)

Questions to ask:

- Which channel? (Telegram, Slack, Discord, WhatsApp, Signal, email, etc.)
- Should this channel reach an existing agent group or a new one?
- What isolation level — share an agent group with other channels, or keep it separate?
- Same trigger rules as other channels on that agent group, or different?

Implementation:

1. Run the matching install skill (`/add-telegram`, `/add-slack`, …). It fetches the adapter from the `channels` branch, wires the registration import, installs the pinned package, and builds.
2. Run `/manage-channels` (or use `ncl messaging-groups` + `ncl wirings`) to create the messaging group, choose the isolation level, and wire it to an agent group with a session mode and trigger rules.

### Adding a New MCP Integration

Questions to ask:

- What service? (Calendar, Notion, database, etc.)
- What operations are needed? (read, write, both)
- Which agent group should have access?

Implementation:

- If an `/add-<service>-tool` skill exists (e.g. `/add-gmail-tool`, `/add-gcal-tool`), run it — it wires the MCP server and routes credentials through OneCLI so no raw keys reach the container.
- Otherwise wire the MCP server into the agent group's container config: `ncl groups config add-mcp-server --id <group-id> --name <name> --command <cmd> [--args <json-array>] [--env <json-object>]`, then `ncl groups restart --id <group-id>` to take effect. From inside a container the agent uses the `add_mcp_server` self-mod tool, which requires one admin approval.

### Changing Assistant Behavior

Questions to ask:

- What aspect? (persona, response style, instructions)
- Apply to one agent group or several?

Implementation:

- Shared role, persona, and instructions live in `groups/<folder>/standing-instructions.md`; operator-local instructions live in `CLAUDE.local.md`. `CLAUDE.md` and `AGENTS.md` are generated at spawn for default agent surfaces; edit the source, not either generated file.
- Durable facts, decisions, and knowledge live in the workgroup memory canon.
  Use `write_memory_file` for ordinary agent edits; do not put memory into
  `CLAUDE.md` or `CLAUDE.local.md`. Use `/migrate-memory` for legacy stores.
- Container runtime behavior (provider, model, packages, MCP servers) is authored in `groups/<folder>/container.json`; use `ncl groups config get/update --id <group-id>` so the central projection and authoritative file remain synchronized.

### Adding New Commands

Questions to ask:

- What should the command do?
- Which agent group(s)?
- Does it need new MCP tools?

Implementation:

- The agent interprets requests naturally — add standing behavior to the group's `standing-instructions.md`, not generated `CLAUDE.md`.
- For routing or trigger changes (which messages wake which agent group), update the wiring's trigger rules: `ncl wirings update --id <wiring-id> ...`.

### Adding Workflow Automation

For a recurring monitor, event-triggered handler, continuation, or recovery wake, read [Workflow automation](../../../docs/workflow-automation.md).

1. Use deterministic observation only when it can establish quiet state; requested briefings, research, planning reviews, and full campaigns may be explicit reasoning jobs.
2. Keep pending and completed work durable, inspect prior effects before retrying, and use the existing claim or atomic state mechanism for each effect identity.
3. Before adding a series, compare active workflows by owner, cadence, and purpose. A host-side script is an operator-only `--script-host` choice, never a template default.
4. Verify quiet, material change, pending work, failure/recovery, and duplicate delivery before enabling; capture receipts before claiming saved model turns or host spawns.

### Changing Deployment

Questions to ask:

- Target platform? (Linux server, different Mac)
- Service manager? (launchd, systemd)

Implementation:

1. Create the appropriate service files.
2. Update paths in `.env` / config.
3. Provide setup instructions.

## After Changes

Always tell the user.

Run from your NanoClaw project root:

```bash
# Rebuild and restart
pnpm run build
source setup/lib/install-slug.sh
# macOS:
launchctl unload ~/Library/LaunchAgents/$(launchd_label).plist
launchctl load ~/Library/LaunchAgents/$(launchd_label).plist
# Linux:
# systemctl --user restart $(systemd_unit)
```

## Example Interaction

User: "Add Telegram as an input channel"

1. Run `/add-telegram` to install the adapter, wire its registration, and build.
2. Ask: "Should Telegram reach an existing agent group, or a new one?"
3. Ask: "Share an agent group with your other channels, or keep Telegram separate?"
4. Run `/manage-channels` (or `ncl messaging-groups create` + `ncl wirings create`) to create the messaging group and wire it to the chosen agent group with a session mode and trigger rules.
5. Tell the user how to authenticate and test.
