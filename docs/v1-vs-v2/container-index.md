# container index (agent-runner entry): v1 vs v2

## Scope
- v1: `container/agent-runner/src/v1/index.ts` (736 LOC) — monolithic: arg parsing, IPC polling, SDK integration, output marshaling
- v2 (split): `container/agent-runner/src/index.ts` (124 LOC) + `poll-loop.ts` (436 LOC) + `destinations.ts` (118 LOC) + `formatter.ts` (228 LOC) + `db/*.ts` + `providers/*.ts`

## Startup sequence diff

| Step | v1 (IPC) | v2 (SQLite poll) |
|------|----------|------------------|
| Arg parsing | stdin JSON via `readStdin()` (v1:105-115) | env vars: `AGENT_PROVIDER`, `NANOCLAW_*` (v2 index.ts:44-51) |
| Env setup | `sdkEnv` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (v1:626-629) | same, delegated to provider (index.ts:109) |
| DB open | — (IPC files only) | inbound.db (RO) + outbound.db (RW) + `session_state` table |
| MCP server config | hardcoded nanoclaw server (v1:477-486) | same + `NANOCLAW_MCP_SERVERS` env for additional (index.ts:94-104) |
| Message loop | `waitForIpcMessage()` polling (v1:350-366) | `poll-loop.ts:62+` `getPendingMessages()` every 1000ms idle / 500ms active |
| Provider | Claude SDK direct | provider abstraction factory (`providers/factory.ts`, supports claude/mock/custom) |
| Message stream | `MessageStream` iterable (v1:71-103) | same pattern in `providers/claude.ts:51-80` |
| System prompt | manual CLAUDE.md load + hardcoded destinations (v1:416-420) | `buildSystemPromptAddendum()` from inbound.db destinations (`destinations.ts:76-117`) |
| Query execution | `runQuery()` with IPC polling during query (v1:374-545) | `processQuery()` polls messages_in + `provider.query()` (`poll-loop.ts:259-319`) |
| Session resumption | sessionId on stdin + `resumeAt` tracking | `getStoredSessionId()` from outbound.db; cleared on `/clear` admin command |
| Shutdown | stdout output markers + exit(1) on error | no markers; logs errors; host manages lifecycle |
| Heartbeat | — | file touch at `SESSION_HEARTBEAT_PATH` on each result |

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| Parse prompt/session/group/chat/etc. from stdin | env + inbound.db | kept | |
| Env injection (ANTHROPIC_BASE_URL, proxy) | passed to provider.query() (index.ts:109) | kept | |
| Stdin JSON parsing | — | **removed** | |
| IPC file polling | `messages_in` table | modernized | Same semantics, DB-backed |
| IPC `_close` sentinel | implicit (process killed by host) | simplified | |
| Output wrapping markers | writes to `messages_out` | **removed** | |
| Session archiving PreCompact hook | `providers/claude.ts` hook | kept | |
| Session resumption by ID | `getStoredSessionId()` (poll-loop.ts:51) | **persisted** | Survives container restart |
| Scheduled task script execution | `task-script.ts:applyPreTaskScripts()` (poll-loop.ts:159) | kept | |
| Command filtering (`/help`, `/login`) | `categorizeMessage()` + filtered set (formatter.ts:14, poll-loop.ts:95-100) | **enhanced** | Explicit categories |
| Admin commands (`/clear`, etc.) | `categorizeMessage` + `NANOCLAW_ADMIN_USER_IDS` gate (poll-loop.ts:102-131) | kept | Explicit admin role from env |
| Destination routing `to=` | `destinations` table + `dispatchResultText()` (poll-loop.ts:350-432) | modernized | Named destinations instead of raw JIDs |
| Multi-destination message blocks | `MESSAGE_RE` regex (poll-loop.ts:350-414) | kept | |
| Tool allowlist | `providers/claude.ts:19-39` | kept | |
| MCP server setup | index.ts:81-104 | kept + extensible | |
| `@-syntax` additional dirs | `/workspace/extra/*` discovered at startup (index.ts:64-74) | kept | |
| Global CLAUDE.md | SDK preset append (index.ts:56-58) | kept | |
| Idle stream termination | — | **new** (IDLE_END_MS = 20s prevents zombies) |
| Admin user ID prefixing (chat-sdk) | explicit `channel_type:` prefix (formatter.ts:58-66) | **new** | |
| Processing ACK | **new** | prevents re-processing on container restart |
| Message kind formatting | `formatMessages()` (formatter.ts) | enhanced | Routes by kind: chat/task/webhook/system |

## Missing from v2
None of v1's core capabilities dropped. Notes on format/protocol shifts:
1. **Stdout markers removed** — host now parses `messages_out` table instead of stdout
2. **Stdin protocol gone** — follow-up messages via `messages_in` table
3. **Script-phase fast exit removed** — v1 could skip container entirely if `wakeAgent=false`; v2 gates message processing but container keeps polling (slightly more idle cost)

## Behavioral discrepancies
1. **Idle timeout**: v1 had no query-level timeout → zombies possible. v2 ends stream after 20s with no SDK events
2. **Resume**: v1 re-read sessionId from stdin each run; v2 persists in `session_state` across restarts
3. **Admin gating**: v1 passed everything through; v2 categorizes + admin-gates `/clear` etc.
4. **Destination naming**: v1 raw JID; v2 human names from destinations table
5. **Poll cadence**: v2 dual-rate — 1000ms idle, 500ms active (CPU efficiency + responsiveness)
6. **Message kind routing**: v1 uniform; v2 distinguishes chat/chat-sdk/task/webhook/system with per-kind formatting

## Worth preserving?
v1 should remain historical reference only. v2 strictly supersedes:
- DB-backed state survives restarts
- Provider abstraction allows non-Claude agents
- Dynamic destinations from inbound.db
- Session invalidation detection + processing ACK idempotence
- Dual poll rate + idle termination prevent pathological query hangs

No merge-back candidates identified.
