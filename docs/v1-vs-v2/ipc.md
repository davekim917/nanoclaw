# IPC: v1 vs v2

## Scope

### v1
- **Host side:** `/Users/gavriel/nanoclaw4/src/v1/ipc.ts` (127 lines) — file-system watcher, task authorization, message routing
- **Auth/handshake tests:** `/Users/gavriel/nanoclaw4/src/v1/ipc-auth.test.ts` (614 lines) — authorization gates, schedule types, cron validation
- **Container side:** `/Users/gavriel/nanoclaw4/container/agent-runner/src/v1/ipc-mcp-stdio.ts` (509 lines) — MCP server over stdio, file-based message writes
- **Total v1 codebase:** ~1,250 lines (v1/ subtree)

### v2 counterparts
This is not a file-for-file mapping. The entire IPC abstraction layer has been replaced with SQLite DBs:

- **Host delivery/routing:** `/Users/gavriel/nanoclaw4/src/delivery.ts` (912 lines) — polls outbound.db, delivers, handles system actions
- **Host sweep/recurrence:** `/Users/gavriel/nanoclaw4/src/host-sweep.ts` (174 lines) — 60s maintenance, stale detection via heartbeat, processing_ack sync
- **Session setup/DB:** `/Users/gavriel/nanoclaw4/src/session-manager.ts` (361 lines) — DB paths, folder init, destinations + routing writes
- **Container poll loop:** `/Users/gavriel/nanoclaw4/container/agent-runner/src/poll-loop.ts` (200+ lines) — fetches messages_in, marks status in processing_ack
- **Container destinations:** `/Users/gavriel/nanoclaw4/container/agent-runner/src/destinations.ts` (118 lines) — reads inbound.db's destinations table live
- **DB layer (host):** `src/db/session-db.ts` — insertMessage, getDueOutboundMessages, markDelivered, syncProcessingAcks, etc.
- **DB layer (container):** `container/agent-runner/src/db/{messages-in,messages-out,session-state,connection}.ts`
- **Schema:** `/Users/gavriel/nanoclaw4/docs/db-session.md` (184 lines) — definitive per-session DB layout

---

## Paradigm shift

**v1: IPC as explicit message files + stdio tunnel + MCP server**

In v1, the host spawned an MCP server inside each container's stdio. The container's `ipc-mcp-stdio.ts` exposed tools (`send_message`, `schedule_task`, `register_group`, etc.) by writing JSON files to the host's `data/ipc/{groupFolder}/{messages|tasks}/` directory. The host's `ipc.ts` file-watcher scanned these directories every `IPC_POLL_INTERVAL` (~1s), parsed the JSON, applied authorization gates (isMain? folder-match?), executed side effects (DB writes, group registration), and deleted the files. Ordering, atomicity, and backpressure were implicit in the filesystem.

**v2: Everything is a message in two persistent DBs**

The IPC abstraction has been *entirely removed*. All host↔container communication now flows through two SQLite files per session:
- **inbound.db** (host writes, container reads): `messages_in` for inbound chat/tasks, `destinations` for the routing map, `session_routing` for default reply channel
- **outbound.db** (container writes, host reads): `messages_out` for agent responses, `processing_ack` for status acks, `session_state` for continuation storage

There is no MCP server inside the container that exposes system tools. Instead:
- **Container side** calls `writeMessageOut()` directly, writing a JSON `content` blob with `action="schedule_task"` (or similar) into the `messages_out` table.
- **Host side** polls `getDueOutboundMessages()` from outbound.db, deserializes the `content`, and in `handleSystemAction()` interprets the action, validates it, and applies it directly to inbound.db (no IPC file write).

The single-writer-per-file invariant (host writes inbound.db, container writes outbound.db) replaces the file-system locking and atomic rename semantics.

**Key ownership shift:**
- v1: Container owned the "request to do something" (file write). Host decided whether to act (authorization on read).
- v2: Host owns the "task is pending" state (messages_in row). Container marks its progress (processing_ack). Host syncs status, detects stale containers, and triggers recurrence.

---

## Capability map

| v1 IPC Behavior | v2 Equivalent | Status | Notes |
|---|---|---|---|
| **Handshake / auth** | Database schema + envelope ID | ✓ Functional but different | v1: read `isMain` env var at startup, gate each IPC op. v2: host resolves session once, container reads `destinations` table on every query. No per-message auth envelope. |
| **Message framing** | JSON in files (atomic rename) | ✓ Replaced with DB schema | v1: `writeIpcFile()` temp-then-rename. v2: `better-sqlite3` with `journal_mode=DELETE` + open-close-per-op for cross-mount visibility. |
| **Transport (pipes/sockets)** | SQLite on FUSE mount | ✓ Completely different | v1: filesystem watching (no network). v2: cross-mount DB access (requires `journal_mode=DELETE` pragma, see session-manager.ts:9–11). |
| **Message types** | `kind` field in messages_in/out | ✓ Expanded | v1: message/task files. v2: `kind=chat|task|system|...` in DB rows, content shape in [api-details.md](../api-details.md). |
| **Auth / authorization gates** | Host-side permission checks in delivery.ts | ◐ Simplified but different | v1: checked per file (isMain flag, folder-match). v2: admin perms checked at container startup (adminUserIds set in poll-loop.ts:22–33), destination ACL in agent_destinations table, delivery.ts enforces on send. No per-message envelope. |
| **Handshake semantics** | None (session exists at startup) | ✗ Removed | v1: env vars set identity at container boot. v2: session_id/agent_group_id is stable DB fixture; container learns routing from `session_routing` table. No negotiation. |
| **Backpressure / flow control** | Implicit (filesystem poll interval) | ◐ Different model | v1: host polls files at 1s intervals; if processing is slow, files pile up. v2: messages_in rows sit with `status='pending'` until container marks `processing_ack='processing'`, then host polls and syncs status. Host can enforce delivery retry budget (MAX_DELIVERY_ATTEMPTS=3 in delivery.ts:58). |
| **Keepalives / timeouts** | No explicit mechanism | ✓ Heartbeat file replaces | v1: IPC files served as implicit liveness. v2: container touches `.heartbeat` file (mtime tracked by host). Host uses heartbeat staleness (10min threshold in host-sweep.ts:32) to detect crash and reset stuck messages. |
| **Ordering / seq parity** | Implicit filename order (timestamp+random) | ✓ Enforced | v1: files had timestamps but no formal ordering. v2: `seq` is monotonic per session, even←host / odd←container (see db-session.md §3). Parity disambiguates edit/reaction targeting. |
| **Reconnect semantics** | Container restart picks up where it left off (env vars) | ✓ Improved | v1: continuation not persisted across restarts. v2: provider continuation (Claude JSON transcript, etc.) stored in `session_state.session_id` on every SDK result. Survives crash. |
| **Error handling / retries** | File left in `errors/` dir on parse failure | ✓ Better visibility | v1: failed IPC files moved to `data/ipc/errors/` for manual inspection. v2: `status='failed'` in messages_in; delivery.ts retries with exponential backoff (3 attempts), marks failed on max. Persisted in DB for audit. |
| **Task scheduling (schedule_task)** | IPC file write → host parses → DB insert | ✓ Same end result, different path | v1: container writes task JSON, host reads/validates cron. v2: container writes `system` message with `action="schedule_task"` to messages_out, host reads + inserts into messages_in as new `kind='task'` row. Validation still in host (cron parsing at delivery time). |
| **Admin commands (/clear, /setup)** | Not in v1 IPC | ✓ Implemented | v2 has `/clear` command in poll-loop.ts, checked against adminUserIds set. Clears `session_state.session_id`. No MCP server expose. |
| **Tool-call plumbing** | MCP server in container exposes send_message, schedule_task, etc. | ✗ Removed entirely | v1 tools are now plain SDK result processors. send_message writes messages_out. schedule_task writes messages_out with action="schedule_task". |
| **Message delivery tracking** | None (fire-and-forget) | ✓ Added | v1: host sends message, doesn't track if it reached the user. v2: `delivered` table in inbound.db (platform_message_id + status). delivery.ts marks as delivered/failed. Enables message edits, reactions, and retry logic. |
| **Stale container detection** | None | ✓ Added | v1: no heartbeat. v2: host-sweep.ts checks `.heartbeat` mtime. If >10min old and processing_ack has 'processing' entries, resets with backoff. |
| **Recurrence / cron re-firing** | Not in v1 | ✓ Added | v1: tasks were one-shot. v2: `recurrence` field in messages_in + `series_id`. host-sweep.ts fires next occurrence when completed message has recurrence. CronExpressionParser used at sync time. |

---

## Missing from v2

### 1. **Auth handshake envelope**
v1 had explicit authorization gates for *every* IPC operation:
- Read `isMain` and `groupFolder` from env vars at startup (ipc-mcp-stdio.ts:19–21)
- For `schedule_task`: gate the `targetJid` — non-main groups can only schedule for `chatJid` (line 187–188)
- For `register_group`: only isMain=true can call (line 471–481)
- For `send_message`: isMain || (target group's folder == sender's folder) (ipc.ts:78)

**v2 equivalent:** Authorization is now **split**:
- Container time: adminUserIds set passed at boot (poll-loop.ts:22–33), used to gate `/clear` command only
- Delivery time: host checks destination ACL via agent_destinations table, permission to send to a messaging group (delivery.ts:535–561)
- No per-message auth envelope; the session fixture itself represents authorization

**What's lost:** Per-request explicit authorization metadata. The agent can't *prove* it's "main" anymore; instead the host verifies at delivery time using the central DB. This is arguably *better* security (no token in container to leak), but if the agent needs to know *why* a request failed, it no longer gets an explicit auth reject response.

### 2. **Backpressure / request queuing**
v1 file-based IPC was **implicitly backpressured**:
- Container calls `send_message()` MCP tool, which calls `writeIpcFile()` and returns immediately (fire-and-forget)
- If the host is slow or overloaded, files pile up in `data/ipc/messages/`
- Container is blocked only if the filesystem fills

**v2 equivalent:** No queueing or explicit backpressure:
- Container calls `writeMessageOut()`, which executes a synchronous SQLite INSERT into outbound.db
- Host polls outbound.db at 1s (active) or 60s (sweep)
- If delivery fails, messages sit in outbound.db with `status='pending'` until 3 retries exhausted

**What's lost:** Queue depth visibility. In v1, you could see `ls data/ipc/messages/ | wc -l` to get backlog. In v2, you have to query the outbound DB. The container has no way to ask "how many pending messages are waiting for me?" — it just writes and hopes the host picks them up.

### 3. **Explicit keepalive / ping**
v1 had implicit keepalives via file timestamps:
- Each IPC file wrote a `timestamp` field (ipc-mcp-stdio.ts:61, 202)
- Host could reason about "last IPC activity"

**v2 equivalent:** Heartbeat file mtime:
- Container touches `.heartbeat` file (connection.ts `touchHeartbeat()`)
- Host checks mtime every 60s in host-sweep.ts
- Detects stale if >10min old and processing_ack has 'processing' entries

**What's lost:** Sub-heartbeat timeouts. If the container is hung but the heartbeat is fresh (just stuck in a long computation), the host won't detect it. v1 had no explicit timeout either, so this is not a regression, but there's no keepalive *mechanism* (no ping/pong protocol).

### 4. **Payload size limits / chunking**
v1 wrote task files with a single JSON blob:
- ipc-mcp-stdio.ts:31: `fs.writeFileSync(tempPath, JSON.stringify(data, null, 2))`
- Filesystem might have limits on inode size, but generally no explicit cap

**v2:** No explicit chunking or size limits in the DB layer:
- messages_in.content and messages_out.content are TEXT
- SQLite TEXT default is ~1GB per cell
- No mention in the codebase of max payload size

**What's lost:** Explicit awareness. In v1, if a task prompt was 10MB, it would be a 10MB JSON file. In v2, it's a 10MB DB cell. The system doesn't actively prevent this, and there's no mention of a sanitizer.

---

## Behavioral discrepancies

### 1. **Task scheduling authorization**
**v1** (ipc-auth.test.ts:71–127):
```typescript
// Main group can schedule for another group
await processTaskIpc({ type: 'schedule_task', targetJid: 'other@g.us' }, 'whatsapp_main', true, deps);
// Non-main group can ONLY schedule for itself
await processTaskIpc({ type: 'schedule_task', targetJid: 'main@g.us' }, 'other-group', false, deps);
// ↑ blocked by authorization gate (ipc.ts:170)
```

**v2** (delivery.ts:645–712):
The container writes a `system` message with `action="schedule_task"` directly into messages_out. The host reads it and calls `insertTask(inDb, {...})` **with no authorization gate**. The `targetJid` is derived from the system message `platformId` and `channelType`, not from an explicitly routed `targetJid` parameter. 

**Discrepancy:** v1 prevented non-main groups from scheduling cross-group tasks at the *request* stage. v2 has no equivalent gate — the container can write any task to any group (in theory) because it's the host that does the actual DB insert. In practice, the container only has one session and only sees messages for that session, so it can't *reach* another group's messages_in. But the authorization model is implicitly structural, not explicit.

### 2. **Message send authorization**
**v1** (ipc-auth.test.ts:339–373):
```typescript
// Main can send to any chat
expect(isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups)).toBe(true);
// Non-main can send to its own chat
expect(isMessageAuthorized('other-group', false, 'other@g.us', groups)).toBe(true);
// Non-main cannot send to another group's chat
expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(false);
```

**v2** (delivery.ts:550–561):
```typescript
const isOriginChat = session.messaging_group_id === mg.id;
if (!isOriginChat && !hasDestination(session.agent_group_id, 'channel', mg.id)) {
  throw new Error(`unauthorized channel destination: ...`);
}
```

The container's session has a fixed `messaging_group_id` + `thread_id`. The agent can only reply to that origin or to a destination in the `agent_destinations` table. There is no isMain flag.

**Discrepancy:** v1 was group-centric (folder-based identity). v2 is session-centric (agent is wired to one or more messaging groups via central DB, projected into inbound.db). If an agent is wired to multiple chats with `session_mode='agent-shared'`, it has one session and can see all of them as destinations. This is more flexible than v1's binary main/non-main gate.

### 3. **Task update semantics**
**v1** (ipc-auth.test.ts:264–309): Container passes `type='update_task'`, host reads the task, re-computes `next_run` if schedule changed, updates DB.

**v2** (delivery.ts:695–712): Container writes `system` message with `action="update_task"`, host applies the update directly. The host **does not** recompute `next_run` if the schedule changes — it only updates the fields the container specified. Recurrence is re-fired by the *host* in host-sweep.ts (line 160–165), not at update time.

**Discrepancy:** v1 eagerly recomputed next_run on update. v2 lazily computes it during the 60s sweep. If an agent updates a task's cron expression, it won't take effect until the next sweep cycle. This is a ~60s latency increase.

### 4. **Error handling**
**v1** (ipc.ts:85–91): Files that fail to parse are moved to `data/ipc/errors/` for manual inspection.

**v2** (delivery.ts:422–459): Messages that fail delivery get up to 3 retries with exponential backoff. If they still fail, they're marked `status='failed'` in the DB. There's no "errors" directory; the audit trail is in the DB + logs.

**Discrepancy:** v1's error handling was "fire-and-forget" (parse, move on). v2's is "retry + persistent state." This is better observability, but v1's "move to errors/" was a gentler way to pause processing without losing the file.

### 5. **Reconnect / session resumption**
**v1:** No persistence. If the container crashed, the next restart had no knowledge of prior messages or state.

**v2** (poll-loop.ts:51–55): Reads `session_state.session_id` at startup and passes it to the provider as `continuation`. The provider (Claude) deserializes a `.jsonl` transcript and resumes. Survives container crash.

**Discrepancy:** v2 has explicit continuation support. v1 did not. This is a strict improvement.

---

## Worth preserving?

### 1. **Per-request authorization envelope**
**Recommendation:** No, v2's structural approach is better. In v1, a malicious container could spoof an isMain flag to bypass gates (though env vars are hard to spoof). v2's model — the host resolves identity once and checks permissions against the central DB — is more robust and easier to audit.

### 2. **Message send ACL at request time**
**Recommendation:** Partially — v2 should validate `agent_destinations` rows exist *before* the agent attempts a send, so it fails fast instead of silently dropping at delivery time. Currently, if an agent tries `<message to="nonexistent">...</message>`, it writes to messages_out and the host later rejects it. A pre-send validation in the container (via destinations.ts) would be better UX.

### 3. **Backpressure / delivery acknowledgment**
**Recommendation:** Maybe. If an agent rapidly fires 100 `send_message()` calls, they all block on SQLite INSERT (fast) and return immediately. The host drains them at 1s per poll. If the channel adapter is slow, messages pile up in messages_out. There's no way for the agent to ask "is there backlog?" or "wait until sent." This is probably fine for most use cases (agents don't spam), but if latency-sensitive, a `send_message()` that returns `{delivered_at}` would help.

### 4. **Heartbeat / stale detection**
**Recommendation:** Yes, and it's been preserved (`.heartbeat` file replaces file-based timestamps). But the 10min threshold is conservative. Consider shorter thresholds for interactive agents (containers should be responsive, stale is a sign of crash, not slow work).

---

## File references

### v1 (historical, in `src/v1/` and `container/agent-runner/src/v1/`)
- **ipc.ts:30–127** — startIpcWatcher loop, per-group folder scan, message/task file dispatch
- **ipc.ts:129–356** — processTaskIpc with authorization gates (lines 169, 228, 241, 254, 271, 313, 326)
- **ipc-auth.test.ts:71–127** — schedule_task authorization tests
- **ipc-auth.test.ts:339–373** — message send authorization tests
- **ipc-mcp-stdio.ts:37–68** — send_message MCP tool, writeIpcFile
- **ipc-mcp-stdio.ts:70–216** — schedule_task tool with validation, target_group_jid param
- **ipc-mcp-stdio.ts:445–504** — register_group tool, isMain gate

### v2 (active, in `src/` and `container/agent-runner/src/`)
- **db-session.md:1–50** — inbound.db schema (messages_in, delivered, destinations, session_routing)
- **db-session.md:120–174** — outbound.db schema (messages_out, processing_ack, session_state)
- **db-session.md:104–117** — seq parity invariant
- **delivery.ts:383–394** — drainSession loop (active poll 1s, sweep 60s)
- **delivery.ts:467–638** — deliverMessage, handles all message kinds, permission checks, delivery retry
- **delivery.ts:645–906** — handleSystemAction, interprets action="schedule_task" etc.
- **host-sweep.ts:48–109** — sweepSession, syncProcessingAcks, stale detection via heartbeat, recurrence handling
- **session-manager.ts:1–12** — cross-mount invariant doc (journal_mode=DELETE, close-per-op)
- **session-manager.ts:122–130** — initSessionFolder, schema creation
- **session-manager.ts:152–222** — writeSessionRouting, writeDestinations (replaces static env vars with live table)
- **session-manager.ts:231–267** — writeSessionMessage (host writes to messages_in)
- **poll-loop.ts:22–33** — PollLoopConfig with adminUserIds set
- **poll-loop.ts:46–77** — runPollLoop entry, getPendingMessages, markProcessing
- **destinations.ts:44–52** — getAllDestinations, findByName (reads from inbound.db live)
- **db/messages-in.ts** — getPendingMessages, markProcessing, markCompleted
- **db/messages-out.ts** — writeMessageOut (container writes system actions here)
- **db/session-state.ts** — getStoredSessionId, setStoredSessionId (continuation persistence)
- **db/connection.ts** — touchHeartbeat, journal_mode=DELETE pragma, cross-mount setup

---

Generated from deep-dive analysis of v1 IPC → v2 DB paradigm shift.
