# types: v1 vs v2

## Scope
- v1: `src/v1/types.ts` (112 LOC) — 10 exported types/interfaces covering AdditionalMount, MountAllowlist, AllowedRoot, ContainerConfig, RegisteredGroup, NewMessage, ScheduledTask, TaskRunLog, Channel, OnInboundMessage/OnChatMetadata
- v2 counterparts (distributed):
  - `src/types.ts` — central DB entities (`AgentGroup`, `MessagingGroup`, `MessageIn`, `User`, `MessagingGroupAgent` etc.)
  - `src/container-config.ts` — file-based per-group container config
  - `src/mount-security.ts` — mount types
  - `src/channels/adapter.ts` — v2 channel interface
  - `container/agent-runner/src/db/messages-in.ts`, `destinations.ts` — session-level types
  - `src/db/schema.ts` — schema reference

## Capability map

| v1 type / field | v2 location | Status | Notes |
|---|---|---|---|
| `AdditionalMount` | `src/mount-security.ts:16-18` | kept | Same fields |
| `MountAllowlist` / `AllowedRoot` | `src/mount-security.ts:21-29` | kept | `nonMainReadOnly` field removed (see container-runtime doc) |
| `ContainerConfig` | split: `src/container-config.ts:36` (file-based) + `src/mount-security.ts` | refactored | `timeout` dropped; added `mcpServers`, `packages`, `imageTag` |
| `RegisteredGroup` | `agent_groups` + `messaging_group_agents` + `container.json` | refactored | One entity split across two DB tables + filesystem |
| `RegisteredGroup.trigger` | `messaging_group_agents.trigger_rules` JSON | moved | Per-wiring, not per-group |
| `RegisteredGroup.containerConfig` | `groups/<folder>/container.json` | moved | DB → disk |
| `RegisteredGroup.isMain` | convention (`agent_group_id = 'main'`) | removed | No explicit flag |
| `NewMessage` | split: `MessageIn` (`src/types.ts:98-111`) + `InboundMessage` (`src/channels/adapter.ts:33-38`) + `MessageInRow` (`container/.../db/messages-in.ts`) | refactored | Platform fields separated |
| `NewMessage.chat_jid` | `channel_type` + `platform_id` | refactored | Explicit split, no more JID parsing |
| `NewMessage.sender` / `sender_name` | inside JSON `content` blob | moved | Less type safety, more flexibility |
| `NewMessage.is_from_me` / `is_bot_message` | — | removed | Inferred from identity or `messages_out` |
| `NewMessage.reply_to_*` | inside `content` blob | moved | |
| `ScheduledTask` (entire type) | `MessageIn` with `kind='task'` + `recurrence` | removed | No separate task entity; no task UI/API |
| `TaskRunLog` | — | removed | No audit trail in v2 |
| `Channel` (connect/disconnect/sendMessage/ownsJid/syncGroups/setTyping) | `ChannelAdapter` (`src/channels/adapter.ts:60-105`) | refactored | Stateless request/response, async, no callback loop |
| `Channel.ownsJid` | — | removed | Routing keyed on `channel_type + platform_id` |
| `OnInboundMessage(chatJid, message)` | `onInbound(platformId, threadId, message)` | refactored | Routing fields explicit |
| `OnChatMetadata` | `onMetadata(platformId, name?, isGroup?)` | refactored | Drops timestamp/channel params |

## Schema diff (v1 `RegisteredGroup` → v2 split)
- **Identity** (`name`, `folder`, `created_at`) → `agent_groups` table
- **Wiring** (`trigger`, `requiresTrigger`) → `messaging_group_agents` table (`trigger_rules`, `response_scope`, `session_mode`)
- **Container config** (`containerConfig`) → `groups/<folder>/container.json`
- Normalization gain: an agent group can have N wirings with different triggers

## Missing from v2
1. `ScheduledTask` + `TaskRunLog` — no first-class task entity or execution log
2. `ContainerConfig.timeout` — per-group timeout override gone; single hardcoded `IDLE_TIMEOUT`
3. `NewMessage.is_from_me` / `is_bot_message` — flat flags gone
4. `Channel.ownsJid` — JID ownership concept gone
5. `Channel.connect()`/`disconnect()`/`isConnected()` lifecycle — replaced by stateless `setup`/`teardown`

## Behavioral discrepancies
- **JID → channel_type + platform_id**: routing fields are now structured, not bundled strings
- **Pull vs push channels**: v1 channels pushed events via callbacks; v2 adapters are stateless with DB-mediated flow
- **Container config storage**: v1 in DB, v2 on disk (survives container restarts without DB query)

## Worth preserving?
- **ScheduledTask / TaskRunLog**: v2's removal leaves a visibility gap; if scheduled-task introspection matters, reintroduce a log table keyed on `messages_in.id` to capture run metadata
- **Per-group timeout**: meaningful loss — some agent groups are slow, others fast; hardcoded timeout = false positives
- **is_from_me / is_bot_message**: trivial to reconstruct; not worth restoring
- **Channel lifecycle callbacks**: obsolete; v2 model is cleaner
