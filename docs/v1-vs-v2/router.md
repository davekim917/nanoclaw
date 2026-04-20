# router: v1 vs v2

## Scope
- v1 (distributed across): `src/v1/index.ts` (startMessageLoop, trigger check), `group-queue.ts` (concurrency, retry), `router.ts` (outbound formatting, 44 LOC), `sender-allowlist.ts` (drop/allow)
- v2: `src/router.ts` (317 LOC), `src/session-manager.ts` (346 LOC), `src/container-runner.ts`, `src/access.ts`, `src/db/messaging-groups.ts` (trigger_rules schema)

## Routing-flow diff

### v1 (polling, per-group)
1. Channel receives message → `onMessage` → store in DB
2. Sender allowlist drop-mode filter → discard denied
3. `startMessageLoop` polls every POLL_INTERVAL
4. For each group: lookup channel (`findChannel` O(n)), check trigger requirement, load allowlist, scan for pattern, skip if no trigger
5. Pull messages since `lastAgentTimestamp`, XML-format with tz context
6. If active container: write JSON to IPC file; else `enqueueMessageCheck(groupJid)` → GroupQueue
7. Retry on failure (up to 5, exp. backoff); rollback cursor on agent error

### v2 (event-driven, entity model)
1. Channel adapter → `routeInbound(platformId, threadId, message)`
2. Apply thread policy (`supportsThreads` → collapse to null)
3. Resolve `messaging_group` (lookup or auto-create)
4. Extract sender → upsert `users` row → `userId` (namespaced `channel_type:handle`)
5. Lookup wired agent groups via `messaging_group_agents`; drop if none
6. `pickAgent` (highest priority; **trigger_rules matching is TODO**)
7. `enforceAccess`: owner/admin/member gate; `unknown_sender_policy: strict | request_approval | public`
8. `resolveSession` by `session_mode` (`agent-shared`/`shared`/`per-thread`)
9. `insertMessage` to session `inbound.db`, write session_routing + destinations
10. `startTypingRefresh`; `wakeContainer(session)` (dedup by `activeContainers` + `wakePromises`)
11. Container polls inbound.db, writes outbound.db; host `delivery.ts` polls and sends via adapter; `stopTypingRefresh` on container exit

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| Sender allowlist drop/allow modes | — | **removed** | Replaced by access gate + `unknown_sender_policy` |
| Group registration auto-creating folder on first message | `router.ts` auto-creates messaging_group; group folder via `group-init.ts` on wake | moved | Admin skill path for agent groups |
| Trigger pattern matching (`requiresTrigger`, `DEFAULT_TRIGGER`) | `messaging_group_agents.trigger_rules` JSON | **deferred** | Schema ready; `pickAgent` has TODO comment |
| `lastAgentTimestamp` cursor tracking | — | **removed** | All messages written immediately to inbound.db |
| IPC file polling (`inputDir`, `_close` sentinel) | — | **removed** | DB polling replaces |
| GroupQueue concurrency + waiting-groups | `container-runner.ts:42-82` `activeContainers` + `wakePromises` | reimplemented | Per-session not per-group |
| Task scheduler → enqueue to GroupQueue | host-sweep due-wake + delivery system-actions | preserved | |
| Session reuse rules (session mode) | `session-manager.ts` (agent-shared/shared/per-thread) | **enhanced** | Explicit per-wiring |
| Remote control command interception | — | **removed** | |
| Idle timeout + stdin close | `container-runner.ts:135-140` `resetIdle` | kept | Heartbeat instead of stdin |
| Host-level retry on agent error | — | **removed** | Container is authority; host sweep retries stale only |
| Typing indicator | `delivery.ts:startTypingRefresh` | kept | Gated on heartbeat |

## Missing from v2
1. **Trigger-rule matching** — `router.ts:198` TODO. Currently every wired agent fires on every message (only priority breaks ties). **Without this, multi-agent wirings don't work as intended.**
2. **Sender drop mode** — v1's silent-drop for noisy users is gone. v2 only has binary allow/deny.
3. **Cursor / state recovery** — v2 writes immediately to DB. If container crashes mid-output, no host-level dedup guarantees (beyond `messages_in.id` PK)
4. **Remote control** — v1 intercepted `/remote-control` commands pre-storage; no v2 equivalent
5. **Host-level retry with backoff on agent error** — v1 had MAX_RETRIES=5 + exp. backoff on `processGroupMessages`; v2 only retries on stale heartbeat detection

## Behavioral discrepancies
1. **Trigger evaluation**: v1 eager (skip group until trigger arrives, accumulate context); v2 TODO — once implemented, likely drops non-trigger messages at ingest (semantic change)
2. **Session reuse**: v1 single session per group; v2 multiple (one per thread on threaded platforms)
3. **Access control timing**: v1 pre-storage (cheap drop); v2 post-sender-resolution (requires `users` upsert)
4. **Unknown channels**: v1 silently ignored; v2 auto-creates `messaging_groups` row — no data loss but orphaned rows possible
5. **Formatting**: v1 host formats with tz + cursor-based message subset; v2 pushes raw JSON to inbound.db, container formats from full session history

## Worth preserving?
1. **Trigger rule matching (HIGH priority)** — schema is ready; 10-line implementation in `pickAgent`. Currently broken-by-default for multi-agent wirings
2. **Sender drop mode (MEDIUM)** — add `(agent_group_id, sender_pattern)` drop table; orthogonal to privilege
3. **State recovery (LOW)** — add unique constraint on `messages_in.id` if not already; v2's model is simpler + more robust
4. **Host-level retry on agent error (MEDIUM)** — currently only stale containers retry. Explicit container-exit-error retry could be valuable
5. **Remote control** — decide: restore as opt-in skill or document deletion
