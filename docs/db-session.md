# NanoClaw — Per-Session DB Schema

Reference for the two SQLite files each session owns: `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads). Start with [db.md](db.md) for the three-DB overview, the single-writer rule, and the cross-mount visibility constraints.

Schemas live in `src/db/schema.ts` as the `INBOUND_SCHEMA` and `OUTBOUND_SCHEMA` constants. Both files are created by `ensureSchema()` in `src/session-manager.ts` when a new session folder is provisioned.

---

## 1. Session folder layout

```
data/v2-sessions/<agent_group_id>/<session_id>/
  inbound.db              ← host writes, container reads (read-only open)
  outbound.db             ← container writes, host reads (read-only open)
  .heartbeat              ← mtime touched by container (not a DB write)
  inbox/<message_id>/     ← user attachments, decoded from inbound message content
  outbox/<message_id>/    ← attachments the agent produced
```

The session directory itself is mounted read-write into the container (`src/container-runner.ts`) — read-only is _not_ a mount property. The container opens `inbound.db` with `{ readonly: true }` at the SQLite connection layer (`container/agent-runner/src/db/connection.ts`), so the container could technically write to the underlying file via another path, but every code path that touches `inbound.db` from inside the container goes through that read-only handle.

One session = one folder = one pair of DBs. The `agent_group_id` parent directory also holds per-group state (`.claude-shared/`) that is shared across every session of that agent group. (The agent-runner source is not copied per group — it's a shared read-only mount from `container/agent-runner/src` into every container; see `src/container-runner.ts`.)

Path helpers in `src/session-manager.ts`: `sessionDir()`, `inboundDbPath()`, `outboundDbPath()`, `heartbeatPath()`.

---

## 2. Inbound DB (`inbound.db`)

Host-owned, container-read-only. Schema constant: `INBOUND_SCHEMA` in `src/db/schema.ts`.

### 2.1 `messages_in`

Every message landing in the session: user chat, scheduled task, recurring task, question response, internal system message.

```sql
CREATE TABLE messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,           -- EVEN only (host assigns) — see §3
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',   -- pending|completed|failed|paused
  process_after  TEXT,                     -- when to run NEXT; deferral paths rewrite it
  scheduled_for  TEXT,                     -- which slot a task occurrence is FOR; NULL pre-column
  recurrence     TEXT,                     -- cron expr for recurring
  series_id      TEXT,                     -- groups occurrences of a recurring task
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1, -- 0 = context only (don't wake), 1 = wake agent
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,            -- JSON; shape depends on kind
  source_session_id TEXT,                  -- agent-to-agent return path
  on_wake        INTEGER NOT NULL DEFAULT 0, -- 1 = only deliver on container's first poll
  repo_fence_epoch TEXT,                   -- non-NULL while held behind a repository fence
  repo_fence_original_trigger INTEGER      -- exact trigger value restored on release
);
CREATE INDEX idx_messages_in_series ON messages_in(series_id);
```

Content shapes: see [api-details.md §Session DB Schema Details](api-details.md#session-db-schema-details).

**Writers (host):** `insertMessage()` (and `nextEvenSeq()`) in `src/db/session-db.ts`; `insertTask()` and `insertRecurrence()` in `src/modules/scheduling/db.ts`. Each calls `nextEvenSeq()`.
**Reader (container):** `container/agent-runner/src/db/messages-in.ts` — polls `status='pending' AND (process_after IS NULL OR process_after <= now)`.

**`process_after` vs `scheduled_for`.** They are stamped from the same value at
insert and then diverge. `process_after` answers _when to run next_, so the
deferral paths rewrite it — a crashed provider turn put behind a retry backoff
(`deferMessageForFreshContextRetry`), a stale message re-armed with
`retryWithBackoff`. `scheduled_for` answers _which occurrence this is_, and only
a genuine reschedule moves it: a cron edit, a resume recomputed to the next
future slot, an explicit `--process-after`, an operator re-`scheduleTask`. The
board's run-now is the deliberate exception — it fires early WITHOUT shifting
the schedule, so it moves `process_after` alone (`updateTask`'s
`keepScheduledFor`). The formatter renders `scheduled_for` as the `<task>`
element's `time`, falling back to `process_after` then `timestamp` for rows
written before the column existed; the Scheduled Tasks Board renders
`process_after`, which is the right answer for "next run".

### 2.2 `delivered`

Host writes here after handing a `messages_out` row to the channel adapter. Container reads `platform_message_id` to target edits and reactions.

```sql
CREATE TABLE delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',  -- delivered|failed
  delivered_at        TEXT NOT NULL
);
```

Writer: `markDelivered()` / `markDeliveryFailed()` in `src/db/session-db.ts`. Older session DBs are brought up to schema lazily by `migrateDeliveredTable()`.

### 2.3 `destinations`

Projection of the central `agent_destinations` table (see [db-central.md §1.10](db-central.md#110-agent_destinations)) for this session's agent. The container resolves `to="name"` against this table; if the row is absent, the send is rejected as `unknown destination`.

```sql
CREATE TABLE destinations (
  name           TEXT PRIMARY KEY,
  display_name   TEXT,
  type           TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type   TEXT,            -- for type='channel'
  platform_id    TEXT,            -- for type='channel'
  agent_group_id TEXT             -- for type='agent'
);
```

Rewritten wholesale (DELETE + INSERT in a transaction) by `writeDestinations()` on every container wake and on demand when wiring changes mid-session. The comment on the table in `src/db/schema.ts` is the canonical statement of the refresh semantics.

### 2.4 `session_routing`

Single-row (`id=1`) default routing: where outbound messages go when the agent doesn't specify a destination.

```sql
CREATE TABLE session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
```

Written by `writeSessionRouting()` on every container wake, derived from `sessions.messaging_group_id` + `sessions.thread_id`.

### 2.5 Repository ingress fence

Repository publication and topic transfer can change the Git paths mounted into a container. A durable, single-row fence in `inbound.db` prevents new work from crossing that mount transition:

```sql
CREATE TABLE repo_ingress_fence (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  epoch      TEXT NOT NULL,
  generation TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('active', 'released'))
);
```

`epoch` identifies the durable publication or transfer action. `generation` is fresh for each released-to-active transition; replay of an already-active matching epoch adopts its existing generation. The exact acknowledgment token is the JSON encoding of `[epoch, generation]`, so an acknowledgment from an earlier activation of the same action cannot authorize a later stop.

The protocol is:

1. While holding the workgroup mount claim or the source/destination topic lifecycle claims, the host activates the fence for every affected session. SQLite triggers atomically convert concurrent `messages_in` inserts or trigger promotions into inert rows: `repo_fence_epoch` is set, the original `trigger` is retained, and `trigger` becomes `0`. Host wake queries and container poll queries exclude tagged rows.
2. The container stops new outer-poll admissions, in-query follow-up claims, durable-continuation starts, and poll-loop provider recovery/retry turns. A provider turn admitted before activation, including tools it already invokes, is allowed to finish. An active query ends gracefully without acknowledging; only the provider-idle outer poll writes the exact token to `outbound.db.session_state` under `repository_mount_barrier_ack`.
3. The host waits for in-progress spawns to leave the spawn path. A running container is drained only when its acknowledgment matches the exact epoch and generation, `processing_ack` has no `processing` row, and `container_state.current_tool` is empty. It then kills the container and proves the process exited. A new spawn also reads the durable fence and refuses to construct mounts while it is active.
4. The host performs the topology mutation and writes its durable completion message while the fence and lifecycle claim remain held. Exact-pair release restores each tagged row's original trigger. Due sessions wake only after the lifecycle claim is released.

Crash replay is fail-closed. A replay adopts a crash-left active generation; a new activation after release receives a different generation. Exact-pair release is replay-safe and recomputes due work, closing a crash after release but before wake. Activation failure rolls back only fences created by that attempt, never a pre-existing adopted fence. Partial drain/stop failure returns the quiescence handle and wake candidates so the action handler can release and recover them; if exact release also fails, the durable active fence continues to block spawn until recovery or replay completes.

These columns, table, and guard triggers are installed by `migrateMessagesInTable()` whenever the host opens an inbound DB. That lazy migration is the upgrade path for both old and newly created session folders.

---

## 3. Sequence numbering invariant

Every message (in or out) gets a monotonic integer `seq`, unique _within the session_ across both tables.

- **Host writes even seq** (2, 4, 6, …) to `messages_in` — `nextEvenSeq()` at `src/db/session-db.ts:75`.
- **Container writes odd seq** (1, 3, 5, …) to `messages_out` — logic at `container/agent-runner/src/db/messages-out.ts:54` (`max % 2 === 0 ? max + 1 : max + 2`), reading `MAX(seq)` across _both_ tables to preserve global ordering.

Why disjoint? `seq` is the agent-facing message ID. When the agent calls `edit_message(seq=5)` or `add_reaction(seq=6)`, `getMessageIdBySeq()` uses the parity to route the lookup: odd → `messages_out`, even → `messages_in`. The parity alone disambiguates without a join. Collisions would break editing.

If you add a code path that writes to either table, preserve parity — the invariant isn't enforced by a constraint, only by the two helper functions.

---

## 4. Outbound DB (`outbound.db`)

Container-owned, host reads only. Schema constant: `OUTBOUND_SCHEMA` in `src/db/schema.ts`.

### 4.1 `messages_out`

Everything the agent produces: chat replies, edits, reactions, cards, question sends, agent-to-agent messages, system actions.

```sql
CREATE TABLE messages_out (
  id            TEXT PRIMARY KEY,
  seq           INTEGER UNIQUE,   -- ODD only (container assigns) — see §3
  in_reply_to   TEXT,
  timestamp     TEXT NOT NULL,
  deliver_after TEXT,
  recurrence    TEXT,
  kind          TEXT NOT NULL,    -- chat|chat-sdk|system|…
  platform_id   TEXT,
  channel_type  TEXT,
  thread_id     TEXT,
  content       TEXT NOT NULL     -- JSON; operation lives inside (edit/reaction/card/…)
);
```

Content shapes: see [api-details.md §Session DB Schema Details](api-details.md#session-db-schema-details).

**Writer (container):** `writeMessageOut()` in `container/agent-runner/src/db/messages-out.ts`.
**Readers (host):** `src/delivery.ts` (polling delivery), `getMessageIdBySeq()` / `getRoutingBySeq()` for edit/reaction targeting.

### 4.2 `processing_ack`

Container-side status for each `messages_in.id` it has touched. The host polls this and syncs status back into `messages_in` — this avoids the container ever writing to `inbound.db`.

```sql
CREATE TABLE processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,      -- processing|completed|failed
  status_changed TEXT NOT NULL
);
```

Crash recovery: on container startup, stale `processing` entries get cleared. Host-side sync: `syncProcessingAcks()` in `src/host-sweep.ts`.

### 4.3 `session_state`

Persistent container-owned KV store. Main consumer is the Chat SDK session ID — storing it here lets the agent's conversation resume across container restarts. Cleared by `/clear`.

```sql
CREATE TABLE session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Access: `container/agent-runner/src/db/session-state.ts`. Repository mount quiescence also stores the exact active fence acknowledgment here under `repository_mount_barrier_ack`; the host accepts it only when the epoch and generation both match the current activation (see §2.5).

### 4.4 `container_state`

Single-row (`id=1`) host-visible operation and resource tracker. Claude records `Bash` on `PreToolUse` and clears it on `PostToolUse`/`PostToolUseFailure`; Codex records the transition between zero and nonzero native in-flight items with a bounded one-hour deadline. The runner also samples cgroup v2 memory state every 15 seconds. The host reads the row during the stale-container sweep so known long operations are not killed by the normal 30-minute ceiling and OOM counter increases are logged with their configured limit and observed peak.

```sql
CREATE TABLE container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  provider_status          TEXT,
  provider_executing       INTEGER NOT NULL DEFAULT 0,
  provider_last_event_at   TEXT,
  provider_last_probe_at   TEXT,
  provider_probe_failures  INTEGER,
  provider_recovery_attempts INTEGER,
  provider_failure_reason  TEXT,
  memory_current_bytes     INTEGER,
  memory_peak_bytes        INTEGER,
  memory_max_bytes         INTEGER,
  memory_oom_events        INTEGER,
  memory_oom_kill_events   INTEGER,
  memory_telemetry_at      TEXT,
  updated_at               TEXT NOT NULL
);
```

- **Writer (container):** operation/provider state helpers in `container/agent-runner/src/modules/mailbox/container-state.ts` plus `resource-telemetry.ts` for cgroup samples.
- **`provider_executing`** is the container's "I am busy right now" flag for the host's idle reapers. They otherwise infer busy-ness from state the host can see — a due inbound row, a `processing` claim, a `work_continuation` record — and work the runner drives on its own behalf appears in none of it: the pre-task script batch runs before its rows are claimed (up to `NANOCLAW_TASK_SCRIPT_TIMEOUT_MS`, 120s by default), and every turn after the first one in a stream runs with no claim at all, because the initial batch is completed at its `result`. The flag tracks **turns, not stream lifetime** — `setProviderTurnExecuting()` is raised by the prompt that starts a turn and lowered by the `result` that ends it, the same boundary `poll-loop.ts` maintains `turnIdle` at. A multi-turn stream stays open after `result` to accept pushes, so a flag held for the whole stream would keep the reaper off an idle container. Windows outside a turn (the script batch, the turn-end checkpoint) are a second, counted scope — `beginProviderBusyScope()`/`endProviderBusyScope()` in a bounded `try`/`finally`. They are separate because they overlap: the active poll callback runs a follow-up's pre-task script concurrently with the turn it belongs to, and one shared boolean let whichever finished first expose the other to the reaper. The published column is their union. A container killed mid-window cannot clear it, so the next container clears it at startup.
- **Reader (host):** `getContainerState()` in `src/db/session-db.ts`; consumed by the sweep's `activeOperationTimeoutMs()` helper in `src/host-sweep.ts`.
- **Restart cleanup:** container startup clears prior operation/provider state and immediately overwrites resource fields with the new cgroup's counters.
- `CREATE TABLE IF NOT EXISTS` — forward-compatible with `outbound.db` files created before this table existed; `getContainerState()` returns `null` if the table or row is absent.

---

## 5. Schema evolution

Unlike the central DB, session DBs do **not** go through numbered migrations. Both `INBOUND_SCHEMA` and `OUTBOUND_SCHEMA` use `CREATE TABLE IF NOT EXISTS`, so a fresh session always gets the current shape. For session folders created under older builds, column-level gaps are patched lazily on open — e.g. `migrateDeliveredTable()` in `src/db/session-db.ts` adds `platform_message_id` and `status` to the `delivered` table if missing.

If you add a column to either schema, add a matching lazy migration for existing session folders, and prefer nullable columns or defaulted values so no data backfill is required.
