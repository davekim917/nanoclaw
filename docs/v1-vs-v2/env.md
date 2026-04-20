# env: v1 vs v2

## Scope
- v1: `src/v1/env.ts` (42 LOC), `src/v1/config.ts` (63 LOC)
- v2 counterparts: `src/env.ts` (identical), `src/config.ts` (identical structure); plus new consumers `src/webhook-server.ts`, `src/log.ts`, `src/container-runner.ts`, `container/build.sh`, `container/agent-runner/src/index.ts`

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| `readEnvFile(keys)` | `src/env.ts:11-42` | kept | Identical — reads `.env` without polluting `process.env` |
| `ASSISTANT_NAME` / `ASSISTANT_HAS_OWN_NUMBER` | `src/config.ts:8-12` | kept | Same read order: process.env → .env → default |
| `ONECLI_URL` | `src/config.ts:30` | kept | Used host-side + container-side |
| `TZ` + `isValidTimezone` guard | `src/config.ts:56-62` | kept | Passes to containers |
| `CONTAINER_IMAGE` / `CONTAINER_TIMEOUT` / `CONTAINER_MAX_OUTPUT_SIZE` | `src/config.ts:27-29` | kept | Same defaults |
| `MAX_MESSAGES_PER_PROMPT` | `src/config.ts:31` | kept | **Unused in v2** |
| `IDLE_TIMEOUT` | `src/config.ts:33` | kept | Used by container heartbeat model |
| `MAX_CONCURRENT_CONTAINERS` | `src/config.ts:34` | kept | Enforced in `container-runner.ts` |
| `POLL_INTERVAL` / `SCHEDULER_POLL_INTERVAL` / `IPC_POLL_INTERVAL` | `src/config.ts:13-32` | **dead code** | Defined but not imported anywhere in v2 runtime |
| `MOUNT_ALLOWLIST_PATH` / `SENDER_ALLOWLIST_PATH` | `src/config.ts:21-22` | kept | SENDER_ALLOWLIST_PATH unused (model replaced by `user_roles`) |
| `STORE_DIR` / `GROUPS_DIR` / `DATA_DIR` | `src/config.ts:23-25` | kept | `DATA_DIR` now hosts `v2.db` + `v2-sessions/<id>/*` |
| `buildTriggerPattern` / `getTriggerPattern` / `TRIGGER_PATTERN` / `DEFAULT_TRIGGER` | `src/config.ts:40-51` | kept | Used sparingly; trigger model largely DB-driven now |
| Container env injection via stdin JSON | `src/container-runner.ts:266-338` | **changed** | Replaced with `docker run -e`. New vars: `SESSION_INBOUND_DB_PATH`, `SESSION_OUTBOUND_DB_PATH`, `SESSION_HEARTBEAT_PATH`, `AGENT_PROVIDER`, `NANOCLAW_AGENT_GROUP_ID`, `NANOCLAW_AGENT_GROUP_NAME`, `NANOCLAW_MCP_SERVERS`, `NANOCLAW_ADMIN_USER_IDS` |
| `INSTALL_CJK_FONTS` | `container/build.sh:18-26`, `container/Dockerfile:13` | **new in v2** | Build-time arg, not runtime env |
| `WEBHOOK_PORT` (default 3000) | `src/webhook-server.ts:82` | **new in v2** | |
| `LOG_LEVEL` | `src/log.ts:16` | **new in v2** | |

## Missing from v2
Nothing user-facing. Container-only vars (`SESSION_*_DB_PATH`, `AGENT_PROVIDER`, `NANOCLAW_*`) are dynamic per-session and never belong in `.env`.

## Behavioral discrepancies
1. **Dead constants**: `POLL_INTERVAL`, `SCHEDULER_POLL_INTERVAL`, `IPC_POLL_INTERVAL` remain in `src/config.ts` but are not imported by any v2 runtime code — safe to delete
2. **Container transport**: v1 piped config via stdin JSON; v2 injects via `-e` at spawn
3. **Build-time vs runtime**: `INSTALL_CJK_FONTS` is a Dockerfile build-arg, not a process env var
4. **Output markers**: v1's `---NANOCLAW_OUTPUT_START/END---` stdout markers are gone — v2 reads from `messages_out` table

## Worth preserving?
Dead constants (`POLL_INTERVAL`, `SCHEDULER_POLL_INTERVAL`, `IPC_POLL_INTERVAL`) should be **removed** from `src/config.ts` — they're confusing carry-overs. Everything else is either actively used or deliberately dynamic. The `.env`-based config surface is byte-identical and correct to keep.
