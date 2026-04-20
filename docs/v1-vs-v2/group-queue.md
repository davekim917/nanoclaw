# group-queue: v1 vs v2

## Scope
- v1: `src/v1/group-queue.ts` (325 LOC), `group-queue.test.ts` (457 LOC) — in-memory per-group state machine, IPC-file dispatch
- v2: **no equivalent class**. Serialization is now DB-based and distributed across `src/session-manager.ts`, `src/host-sweep.ts`, `src/container-runner.ts`, `src/delivery.ts`

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| Per-group message queue | `inbound.db.messages_in` + `status='pending'` | replaced | Atomic status transitions serialize work per-session |
| Per-group task queue | `inbound.db.messages_in` with `kind='task'` | replaced | Same table; `kind` discriminates |
| `MAX_CONCURRENT_CONTAINERS` global cap | `container-runner.ts:42-52` `activeContainers` Map + `wakeContainer` dedup | kept | Enforced at spawn |
| One container per group invariant | One container per **session** | redefined | Session is identity unit now |
| Task-before-message priority (`drainGroup`) | `host-sweep.ts` recurrence + `delivery.ts` active poll | **partially lost** | No priority; polled by `process_after` timestamp ordering |
| Exponential retry backoff | `host-sweep.ts:145-147` `BACKOFF_BASE_MS * 2^tries` | kept | Max 5 tries, same shape |
| Idle preemption (`notifyIdle`/`closeStdin`) | heartbeat file mtime | **removed** | No interrupt signal — container polls continuously |
| Message dispatch to active container (`sendMessage`) | Write to `messages_in` table | replaced | Host writes; container polls |
| Cascading drain on task arrival | `delivery.ts` (~1s) + `host-sweep.ts` (~60s) polls | **async-ized** | Work discovery on next tick, not synchronous |
| Shutdown without kill | containers continue under `--rm` | similar | Host shutdown does not stop containers |
| Task dedup (`pendingTasks.some(t => t.id === id)`) | PK on `messages_in.id` | partial | Unique ID prevents DB duplicates; does not prevent two distinct rows with same series_id |
| `drainWaiting` (waiting-group fairness) | Implicit: any session can wake if slot free | async | No explicit fairness |

## Serialization model diff
**v1 (push-based):** `GroupState` in memory per group: `active`, `pendingMessages`, `pendingTasks`, `idleWaiting`, `runningTaskId`. `drainGroup()` synchronously dispatches. IPC file write signals container readiness. State lost on restart.

**v2 (pull-based via DB):** `messages_in.status` is the queue (`pending` → `processing` → `completed`/`failed`). Host writes rows + calls `wakeContainer()`; container polls + atomic UPDATE to take work. One writer per DB file (host→inbound, container→outbound) eliminates cross-mount contention. Heartbeat file mtime replaces IPC for liveness. State persisted; survives crashes.

## Missing from v2
1. **Idle-state preemption** — v1 could interrupt an idle container on task arrival via `closeStdin`. v2 has no interrupt; container finishes current work and polls again
2. **Synchronous drain cascade** — v1's `drainGroup` immediately ran the next item; v2 discovers it on the next poll tick (~1s active, ~60s sweep)
3. **In-memory task dedup** — v1 checked pending-task list before enqueue. v2 can have two task rows with the same series_id coexisting (both pending) — relies on atomic `status` update for single-execution, best-effort
4. **Priority ordering** — v1 tasks preempted messages; v2 is timestamp-ordered only

## Behavioral discrepancies
| Aspect | v1 | v2 |
|---|----|----|
| Wake trigger | on enqueue (sync) | on `wakeContainer()` call, or poll finding due message |
| Idle timeout | implicit via IPC | explicit heartbeat mtime (10 min) |
| Task ordering | FIFO within group, tasks preempt messages | `process_after` timestamp; ties by insert seq |
| Retry | host `scheduleRetry()` | host sweep detects stale, increments `tries`, sets backoff |
| Concurrency cap | same | same (enforced in `spawnContainer` dedup) |

## Worth preserving?
1. **Explicit task dedup** — add `(kind, series_id, session_id)` unique index on `messages_in`, or dedup in `host-sweep.ts` before inserting retry rows. Currently best-effort via atomic status update
2. **Priority ordering** — add a `priority` column or document the ~1s task-wake latency as the SLA
3. **Idle preemption** — not critical; 1s polling is acceptable for most workflows
4. **Fairness** — v1's `drainWaiting` ensured no group starved. v2 is fair by timestamp but untested under concurrent load. Monitor in production
