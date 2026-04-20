# config: v1 vs v2

## Scope

- **v1**: `/Users/gavriel/nanoclaw4/src/v1/config.ts` (63 lines) + `/Users/gavriel/nanoclaw4/src/v1/env.ts` (42 lines)
- **v2 counterparts**: `/Users/gavriel/nanoclaw4/src/config.ts` (63 lines, **identical**), `/Users/gavriel/nanoclaw4/src/env.ts` (42 lines, **identical**), plus host-level polling in `/Users/gavriel/nanoclaw4/src/host-sweep.ts` and `/Users/gavriel/nanoclaw4/src/delivery.ts`; container agent-runner reads at `/Users/gavriel/nanoclaw4/container/agent-runner/src/index.ts`

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| **ASSISTANT_NAME** env var (default: 'Andy') | `src/config.ts:10`; read from `.env` or `process.env` | Kept, partially used | v2 exports it but doesn't use it in host. Container receives via `NANOCLAW_ASSISTANT_NAME` env var (set by `src/container-runner.ts:302`) for transcript archiving only. v1 used it for CLAUDE.md substitution, trigger pattern, and prompt context. |
| **ASSISTANT_HAS_OWN_NUMBER** boolean env var | `src/config.ts:11-12` | **Removed, unused** | Exported but neither v1 nor v2 use it. No evidence of any implementation. |
| **POLL_INTERVAL = 2000ms** | `src/config.ts:13` | **Removed, unused** | v1 used in `index.ts:457` (IPC watcher polling). v2 replaced IPC with session DBs; no polling needed at this interval. |
| **SCHEDULER_POLL_INTERVAL = 60000ms** | `src/config.ts:14` | **Removed, unused** | v1 used in `task-scheduler.ts:231`. v2 uses hard-coded `SWEEP_INTERVAL_MS = 60_000` in `host-sweep.ts:31` instead (same value, different source). |
| **IPC_POLL_INTERVAL = 1000ms** | `src/config.ts:32` | **Removed, unused** | v1 used in `ipc.ts:50, ipc.ts:122`. v2 replaced file-based IPC with SQLite session DBs; this interval has no meaning. |
| **MOUNT_ALLOWLIST_PATH** = `~/.config/nanoclaw/mount-allowlist.json` | `src/config.ts:21` | Kept, same behavior | Used by `src/mount-security.ts` (host) to whitelist directories containers can read. Same in both versions. |
| **SENDER_ALLOWLIST_PATH** = `~/.config/nanoclaw/sender-allowlist.json` | `src/config.ts:22` | Kept, same behavior | Stored outside project root for security. Path derivation identical in v1 and v2. **Unused in v2** (no grep hits outside v1 folder). |
| **STORE_DIR** = `store/` | `src/config.ts:23` | **Removed, unused** | v1 used in `db.ts`. v2 uses central DB (`data/v2.db`) and per-session DBs (`data/v2-sessions/<id>/{inbound,outbound}.db`). `store/` directory no longer part of v2 architecture. |
| **GROUPS_DIR** = `groups/` | `src/config.ts:24` | Kept, same behavior | Per-agent-group filesystem (CLAUDE.md, skills, config). Used in `src/container-runner.ts`, `src/delivery.ts`, `src/group-init.ts`. Identical role in both versions. |
| **DATA_DIR** = `data/` | `src/config.ts:25` | Kept, extended usage | v1: IPC files, task DB. v2: central DB, session DBs, heartbeat files. More central in v2. Used in `src/index.ts`, `src/session-manager.ts`, `src/group-init.ts`, etc. |
| **CONTAINER_IMAGE** env var (default: 'nanoclaw-agent:latest') | `src/config.ts:27` | Kept, same behavior | Specifies Docker image name. Used in `src/container-runner.ts`. Identical in both versions. |
| **CONTAINER_TIMEOUT** env var (default: 1800000ms = 30min) | `src/config.ts:28` | Kept, same behavior | Maximum wall-clock time for a single container invocation. Used in `src/container-runner.ts`. Identical in both versions. |
| **CONTAINER_MAX_OUTPUT_SIZE** env var (default: 10485760 bytes = 10MB) | `src/config.ts:29` | **Removed, unused** | Exported but never referenced in v1 or v2. No evidence of implementation. |
| **ONECLI_URL** env var (no default) | `src/config.ts:30` | Kept, same behavior | OneCLI gateway URL for credential management. Read from `.env` or `process.env`. Used in `src/onecli-approvals.ts`. Identical in both versions. |
| **MAX_MESSAGES_PER_PROMPT** env var (default: 10) | `src/config.ts:31` | **Removed, unused** | v1 used in message batching for prompt formatting (`v1/index.ts:192-193, 434-435, 467`). v2 removed MAX_MESSAGES limit; agent processes all pending messages in a turn. |
| **IDLE_TIMEOUT** env var (default: 1800000ms = 30min) | `src/config.ts:33` | Kept, same behavior | How long to keep container alive after last result before killing due to inactivity. Used in `src/container-runner.ts:134-139`. Identical in both versions. |
| **MAX_CONCURRENT_CONTAINERS** env var (default: 5) | `src/config.ts:34` | **Removed, unused** | v1 used in `group-queue.ts` for queue management. v2 removed group queueing (no group-queue.ts equivalent). Sessions start containers independently; no global cap enforced. |
| **escapeRegex()** helper | `src/config.ts:36-38` | Kept, same implementation | Escapes regex special characters. Used by `buildTriggerPattern()`. Identical in both versions. |
| **buildTriggerPattern()** helper | `src/config.ts:40-42` | Kept, same implementation | Builds case-insensitive word-boundary regex from trigger string. Used in v2 by... (no grep hits in non-v1 v2 code). Exported but **unused in v2**. |
| **DEFAULT_TRIGGER** = `@${ASSISTANT_NAME}` | `src/config.ts:44` | Kept, **unused** | Default trigger pattern for agent activation. Computed from ASSISTANT_NAME. Exported but not used in v2 (no grep hits outside v1). |
| **getTriggerPattern()** helper | `src/config.ts:46-49` | Kept, **unused** | Returns regex for trigger matching. Used in v1 for routing decisions. Exported but **not used in v2** (trigger logic moved to DB `messaging_group_agents.trigger_rules`). |
| **TRIGGER_PATTERN** = computed | `src/config.ts:51` | Kept, **unused** | Pre-built DEFAULT_TRIGGER pattern. Exported but **not used in v2**. |
| **resolveConfigTimezone()** helper | `src/config.ts:55-61` | Kept, same implementation | Resolves IANA timezone from TZ env var → `.env` TZ → system timezone → 'UTC'. Identical logic in both versions. |
| **TIMEZONE** const | `src/config.ts:62` | Kept, same behavior | Current timezone for scheduled tasks, message timestamps. Used in `src/host-sweep.ts`, `container/agent-runner/src/index.ts`. Identical in both versions. |
| **readEnvFile()** function | `src/env.ts:11-42` | Kept, identical | Reads `.env` file, returns only requested keys, does not pollute `process.env`. Used by config.ts. Prevents secrets leak to child processes. Identical in both versions. |

---

## Missing from v2

- **POLL_INTERVAL** (2000ms hardcoded constant) — v1 polling loop. v2 has no direct equivalent; delivery uses hard-coded `ACTIVE_POLL_MS = 1000` (`src/delivery.ts:56`). Not configurable.

- **SCHEDULER_POLL_INTERVAL** (60000ms hardcoded constant) — v1 task scheduler. v2 uses hard-coded `SWEEP_INTERVAL_MS = 60_000` (`src/host-sweep.ts:31`). Same interval, not configurable from config.ts.

- **IPC_POLL_INTERVAL** (1000ms hardcoded constant) — v1 IPC file watcher. No v2 equivalent; IPC replaced with session DBs.

- **MAX_MESSAGES_PER_PROMPT** (env var, default 10) — v1 message batching. v2 has no message batching limit; all pending messages in a turn are processed together.

- **MAX_CONCURRENT_CONTAINERS** (env var, default 5) — v1 group queue. v2 has no group-level concurrency cap; sessions start containers independently.

- **STORE_DIR** (store/ directory) — v1 task/group storage. v2 uses central DB + session DBs; no store/ directory needed.

- **SENDER_ALLOWLIST_PATH** — Path is defined but never used in either version.

---

## Behavioral discrepancies

1. **ASSISTANT_NAME usage**
   - v1: Used for CLAUDE.md template substitution (`v1/index.ts:135-137`), getLastBotMessageTimestamp comparison, and trigger pattern building.
   - v2: Only passed to container as `NANOCLAW_ASSISTANT_NAME` env var (`src/container-runner.ts:302`); container uses it for transcript archiving only. Host does not use it.
   - **Impact**: v1 personalized CLAUDE.md by name; v2 relies on statically authored CLAUDE.md in `groups/<folder>/`.

2. **Trigger pattern handling**
   - v1: Trigger pattern from `getTriggerPattern()` used at host routing layer (`v1/index.ts:200, 419`).
   - v2: Trigger rules stored in DB (`messaging_group_agents.trigger_rules` JSON field), evaluated at delivery time by router. `getTriggerPattern()` exported but unused.
   - **Impact**: v1 required config-level trigger changes; v2 allows per-messaging-group customization via DB.

3. **Timezone resolution**
   - v1: `resolveConfigTimezone()` used in `task-scheduler.ts:5`.
   - v2: Same function; `TIMEZONE` used in `host-sweep.ts`, `container/agent-runner/src/index.ts:45` (but never actually referenced in agent-runner). 
   - **Impact**: Identical behavior; minor: container reads env var but doesn't use it.

4. **Poll intervals**
   - v1: `POLL_INTERVAL`, `SCHEDULER_POLL_INTERVAL`, `IPC_POLL_INTERVAL` all separately configured.
   - v2: Hard-coded `ACTIVE_POLL_MS = 1000`, `SWEEP_POLL_MS = 60_000` in `src/delivery.ts`. Container poll loop uses hard-coded `POLL_INTERVAL_MS = 1000`, `ACTIVE_POLL_INTERVAL_MS = 500` in `container/agent-runner/src/poll-loop.ts:10-11`.
   - **Impact**: v2 intervals are not tunable via env vars; requires code change.

5. **Message batching**
   - v1: `MAX_MESSAGES_PER_PROMPT` limits messages per turn (`v1/index.ts:467`).
   - v2: No limit; all pending messages (minus filtered/denied commands) are formatted and sent to agent in one turn.
   - **Impact**: v2 may send larger prompts; unbounded context risk if message queue grows.

6. **Container concurrency**
   - v1: `MAX_CONCURRENT_CONTAINERS` enforced via group queue (`v1/group-queue.ts`).
   - v2: No global or per-group limit. Each session independently starts its container on wake.
   - **Impact**: v2 can spawn many containers simultaneously; no backpressure mechanism.

7. **IPC → Session DB**
   - v1: Uses file-based IPC (JSON files, `IPC_POLL_INTERVAL` polling).
   - v2: Uses SQLite session DBs (`inbound.db` host-owned, `outbound.db` container-owned).
   - **Impact**: v2 is more reliable (ACID semantics) but less debuggable (binary format).

---

## Worth preserving?

**No.** The config.ts file is largely a legacy artifact. Most of its exports are unused in v2, and the few that remain (TIMEZONE, IDLE_TIMEOUT, ONECLI_URL, paths) are minimally invasive. The hardcoded poll intervals and removed features (MAX_MESSAGES, MAX_CONCURRENT_CONTAINERS, IPC_POLL_INTERVAL) reflect architectural changes that are intentional and correct for v2. The trigger pattern and ASSISTANT_NAME handling in config.ts should be removed from the host layer entirely — they're now managed by the DB and container env vars. Consolidate host-level config into a smaller, focused module that only exports what v2 actually uses: TIMEZONE, IDLE_TIMEOUT, CONTAINER_TIMEOUT, ONECLI_URL, path constants, and the env file reader.
