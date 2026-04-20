# task-scheduler: v1 vs v2

## Scope

**v1 task scheduler:**
- Files: `src/v1/task-scheduler.ts` (241 lines), `src/v1/task-scheduler.test.ts` (122 lines)
- Self-contained scheduler loop with DB persistence and container execution
- Stores tasks in central DB table `scheduled_tasks`
- Runs a polling loop at `SCHEDULER_POLL_INTERVAL` (configurable, typically 5–60s)

**v2 task distribution:**
- No central task-scheduler file; tasks spread across host sweep and session DBs
- Core files: `src/host-sweep.ts` (174 lines), `src/delivery.ts` (task handlers ~line 654–713), `src/db/session-db.ts` (task mutation logic)
- Optional: `container/agent-runner/src/task-script.ts` (pre-task script execution)
- Task rows live in per-session `inbound.db` table `messages_in` (polymorphic message kind)
- Recurrence computed in `host-sweep.ts` (host-sweep.ts:159–173)

---

## Capability map

| v1 Behavior | v2 Location | Status | Notes |
|---|---|---|---|
| **One-shot tasks** (schedule_type='once') | `insertTask()` in `src/db/session-db.ts:103–122`; processAfter field set, recurrence=NULL | ✅ Supported | Task inserted into messages_in with process_after timestamp, processed once, no recurrence |
| **Recurring via cron** (schedule_type='cron') | `insertTask()` with recurrence field; `host-sweep.ts:159–173` parses cron | ✅ Supported | Cron expression stored in messages_in.recurrence, next occurrence computed on completion via CronExpressionParser |
| **Recurring via fixed interval** (schedule_type='interval') | Not directly supported; v2 uses cron for all recurring | ⚠️ Removed | v2 requires cron syntax for recurrence. No interval-based scheduling (e.g., "every 5 minutes") without converting to cron |
| **Timezone handling** | `host-sweep.ts:159–161` uses CronExpressionParser with no explicit TZ param; cron-parser respects system TZ | ⚠️ Degraded | v1's explicit TIMEZONE config (via timezone.ts helpers) is absent in v2. Cron evaluation uses system/Node.js default TZ, not agent/session-level configuration |
| **Persistence** | Per-session `inbound.db` `messages_in` table + `series_id` grouping | ✅ Supported | Tasks persisted as DB rows with status (pending/completed/paused). Series_id backfilled for recurring task groups |
| **Restart recovery** | `host-sweep.ts:85–96` syncs processing_ack on startup to detect stale containers; tasks marked paused if container crashes | ✅ Supported | Stale container detection via heartbeat file mtime (host-sweep.ts:122–131); stuck messages retried with exponential backoff |
| **Due-message wake** | `host-sweep.ts:91–96` queries countDueMessages, wakes container if due tasks exist | ✅ Supported | 60s sweep checks for pending tasks with process_after in the past and wakes container if found |
| **Missed-run catch-up** (interval-based) | `computeNextRun()` skips past missed intervals to prevent cumulative drift; tests verify no infinite loop | ⚠️ Degraded | v2 doesn't handle missed intervals — if a recurring cron task gets skipped, next occurrence is computed from completion time only. No "make up" for missed runs |
| **Cancellation** | `updateTask(id, {status: 'paused'})` prevents retry churn | ✅ Supported | `cancelTask()` in `src/db/session-db.ts:128–132` sets status='completed' and clears recurrence; matches by id OR series_id |
| **Pause/resume** | `updateTask(id, {status: 'paused'})` / resume | ✅ Supported | `pauseTask()` (line 134–138) and `resumeTask()` (line 140–144); both match id or series_id |
| **Retry-on-failure** | `updateTaskAfterRun()` on error; no explicit retry logic in scheduler loop | ⚠️ Degraded | v2 uses `retryWithBackoff()` only when container goes stale (host-sweep.ts:147). No automatic retry for task execution errors |
| **Concurrent-run prevention** | Task status 'active' gate (task-scheduler.ts:221); no concurrent-run logic | ⚠️ Degraded | v2 allows multiple pending tasks to wake the container in the same sweep; container processes serially but no host-level concurrency control |
| **Idempotency** | Task ID is primary key; `insertTask()` will fail if re-run with same ID | ✅ Supported | messages_in.id is PRIMARY KEY; insertTask() fails on duplicate (caller must handle or use ON CONFLICT) |
| **Max-age drop** | No explicit max-age field; tasks can remain pending indefinitely | ⚠️ Missing | No max-age or TTL in v2 messages_in schema. A stuck task can remain pending forever unless manually cancelled |
| **Task context mode** (group vs isolated session) | v1: context_mode field drives session reuse (task-scheduler.ts:122) | ⚠️ Removed | v2 doesn't track context_mode; all tasks are processed in the container's default session context; no isolation toggle |
| **Task result logging** | `logTaskRun()` writes to task_runs table; stores error + result summary | ⚠️ Degraded | v2 has no equivalent task_runs table. Task output is written as system messages back to the agent; no persistent audit trail |
| **Task script execution** | v1: prompt + optional script field, passed to container | ✅ Supported | v2: `applyPreTaskScripts()` in `container/agent-runner/src/task-script.ts:79–121` runs scripts pre-prompt, enriches prompt with scriptOutput |

---

## Missing from v2

1. **Interval-based recurrence** — v1 `schedule_type='interval'` (e.g., "every 5000ms") is gone. v2 only supports cron expressions. Workaround: convert to equivalent cron (e.g., `*/5 * * * * *` for every 5 min).

2. **Timezone awareness** — v1 passed `TIMEZONE` config to cron parser and had explicit `formatLocalTime()` helpers. v2 has no way to specify a session/agent timezone for cron evaluation; it uses the system/Node.js TZ.

3. **Task context modes** — v1's `context_mode: 'group' | 'isolated'` is removed. No way to force a task into a dedicated session vs. the agent group's shared session.

4. **Task result audit trail** — v1 logged every run to `task_runs(task_id, run_at, duration_ms, status, result, error)`. v2 has no persistent task execution history; output is a system message only.

5. **Max-age / task TTL** — v1 tasks could be implicitly aged out (not directly visible in the code, but conceivable via cleanup logic). v2 has no TTL; a paused/completed task lingers in messages_in forever.

6. **Task-level concurrency control** — v1 prevented concurrent runs of the same task (single status check per loop iteration). v2 can queue multiple pending tasks in one sweep, though the container processes them serially.

---

## Behavioral discrepancies

1. **Missed-interval catch-up** (v1 `computeNextRun()` lines 32–46 vs. v2 absence):
   - **v1:** If a task is due at 10:00, 10:05, 10:10 but the scheduler is down during 10:00–10:15, it computes `next_run = 10:20` (skips missed intervals, stays on the grid).
   - **v2:** If the same recurring cron task is skipped, the next occurrence is computed from the *completion* time (host-sweep.ts:160–161), not from the original grid. A task that should run at :00 and :05 every 10 minutes might drift if completions are delayed.

2. **Stale-container recovery** (v1 none vs. v2 heartbeat-based):
   - **v1:** Tasks remain due if the container crashes; the scheduler will retry on the next poll.
   - **v2:** If the heartbeat goes stale (container unresponsive for 10 min), stuck processing messages are retried with exponential backoff. Tasks stuck in 'processing' state are reset.

3. **Task script pre-processing** (v1 prompt + script → container vs. v2 script → output enrichment):
   - **v1:** Passes script alongside prompt to container; container execution model unclear from scheduler.ts (likely runs in group-queue).
   - **v2:** Host runs script *before* waking container; script output (`scriptOutput`) is merged into prompt JSON via `applyPreTaskScripts()` (task-script.ts:115–117). If script fails or returns `wakeAgent=false`, the task is skipped entirely.

4. **Retry semantics**:
   - **v1:** On execution error (runTask throws), `updateTaskAfterRun()` is called with `error`. Next retry relies on scheduler polling the same task again (no backoff).
   - **v2:** Execution errors are not retried; container processes the task once. If the container crashes mid-task, the message is retried with exponential backoff only up to `MAX_TRIES=5` (host-sweep.ts:145–150).

---

## Worth preserving?

**Interval-based recurrence** (v1 `schedule_type='interval'`) is a practical feature that v2 trades away. Cron syntax is powerful but less intuitive for simple "every X milliseconds" patterns. If users want "run every 30 seconds," they must learn cron (`*/30 * * * * *` for seconds doesn't exist in standard cron; workaround is job-level looping in the prompt). Consider a thin adapter layer in agent-facing APIs to accept `{interval: 5000}` and convert to cron, or extend the v2 schema to support an optional `interval_ms` alongside `recurrence`.

**Task context modes** (`group` vs. `isolated`) were a way to isolate task execution context. v2's removal simplifies the model but loses the ability to run a task in a fresh container state. If a task needs a clean slate (no session history), that's now impossible; workaround is a manual system-action to clear session state before running the task.

**Task result audit trail** is a gap for operational visibility. v2's system messages are ephemeral; there's no way to query "how many times did task X run and what were the outcomes?" Adding a lightweight `task_execution_log` table (optional, populated on task completion) would help without burdening the common case.

---

## References by line

- v1 task-scheduler: `src/v1/task-scheduler.ts:20–49` (computeNextRun), `:203–235` (startSchedulerLoop)
- v1 test coverage: `src/v1/task-scheduler.test.ts:49–121` (drift, missed-interval, once-task tests)
- v1 timezone: `src/v1/timezone.ts:26–37` (formatLocalTime with explicit TZ)
- v1 types: `src/v1/types.ts:60–74` (ScheduledTask interface with context_mode)
- v2 sweep: `src/host-sweep.ts:154–173` (handleRecurrence, insertRecurrence)
- v2 delivery system actions: `src/delivery.ts:645–713` (handleSystemAction switch on schedule_task/cancel_task/pause_task/resume_task/update_task)
- v2 session-db: `src/db/session-db.ts:103–198` (insertTask, cancelTask, pauseTask, resumeTask, updateTask, all with series_id matching)
- v2 task-script: `container/agent-runner/src/task-script.ts:79–121` (applyPreTaskScripts, wakeAgent logic)
- v2 DB schema: `docs/db-session.md:31–56` (messages_in table with process_after, recurrence, series_id)
