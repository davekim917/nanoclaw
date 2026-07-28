# Plan: Durable Work Continuation

Status: approved; independent plan review completed with one correction batch
Approved by: operator, 2026-07-28
Primary runtime: Codex

Independent review note: the primary Claude credential returned HTTP 429 before consuming input. OAuth slot 2 then authenticated successfully. Its first response ignored the requested shape; the operator explicitly requested a retry, and the retry used CLI-enforced JSON Schema and returned a valid `must_fix` review. Source validation accepted eight findings and rejected one false premise; the accepted corrections are incorporated below.

## Outcome

An agent that says it is continuing work must actually receive another turn without waiting for a human ping. The mechanism must survive user questions, container ceilings, and host restarts, while staying scoped to the current messaging thread.

This is a focused replacement of PR #138's continuation subsystem, not a rewrite of NanoClaw. It keeps the useful session-state, direct provider-stream, scheduled-wake, and restart-recovery seams while removing the fragile text parsing and fake inbound-message path.

## User contract

1. Before ending a turn with unfinished work, the agent calls `continue_work({ task })`.
2. The runner starts that task immediately after the current result. No user message, timer, or idle poll is needed.
3. A question or status request in the same thread does not erase queued work. The agent answers it, then the runner resumes the queued work.
4. A natural-language request to stop causes the agent to call `cancel_continuation`. A changed task replaces the queued task by calling `continue_work` again.
5. Starting a new thread creates a new NanoClaw session and therefore a clean continuation boundary.
6. `/clear` keeps its existing provider-context reset behavior. This feature does not change, recommend, or depend on it for continuation control.

## Non-goals

- No general workflow engine, durable job queue, DAG, or task-board replacement.
- No new user-facing slash command.
- No continuation across messaging threads.
- No parsing public prose for phrases such as "starting that now."
- No use of `ncl tasks` for same-thread continuation or short in-session waits.

## State model

Use one `session_state` record, `work_continuation`, in the existing outbound session DB:

```ts
interface WorkContinuation {
  id: string;
  task: string;
  phase: 'queued' | 'running';
  chain: number;
  runner_id?: string;
  resume_attempts: number;
}
```

The existing row timestamp is the record timestamp. No additional table or migration is required.

Transitions:

- `continue_work({task})`: validate and atomically replace the record with a new `id`, `phase='queued'`, incremented chain count, and `resume_attempts=0`.
- delivered ordinary result with queued work: compare-and-set that exact `id` to `running`, stamp the current process's random `runner_id`, then push a continuation prompt directly into the existing provider stream.
- prompt ledger: every prompt pushed into the stream is recorded as `{ prompt, continuationId? }` in the existing FIFO. A result may complete only the continuation ID carried by the FIFO entry it answers.
- delivered continuation result: delete only the `running` record whose `id` is attached to that answered prompt. If the agent called `continue_work` during the turn, the newer `id` survives and launches next.
- `cancel_continuation`: delete the record. It is an internal agent tool used for an explicit natural-language stop, not a user command.
- stopped/crashed container with `queued` or `running` work: the host increments `resume_attempts` while no container owns outbound.db and wakes the session. A fresh runner resumes a `running` record only when its `runner_id` differs from the fresh process ID; the same process never injects its own running task twice.
- recovery cap: after two automatic recovery attempts for one continuation ID, the host posts one public accounting and stops waking it until real inbound. The continuation remains durable.
- real inbound while work is queued: process the real inbound first, leave the record intact, reset `chain` and `resume_attempts` to zero, then launch the continuation after that result unless the agent replaced or cancelled it.
- chain cap: retain the existing finite cap of 50. A rejected handoff tells the agent to give the user an honest public accounting; it never silently parks work.

All mutations use ID-checked compare-and-set helpers so a stale result cannot clear a replacement task.

## Implementation groups

### A. Replace `NEXT:` parsing with structured continuation tools

Files:

- create `container/agent-runner/src/mcp-tools/work-continuation.ts`
- create `container/agent-runner/src/mcp-tools/work-continuation.test.ts`
- modify `container/agent-runner/src/mcp-tools/index.ts`
- modify `container/agent-runner/src/db/session-state.ts`
- modify its focused tests

Work:

- Add `continue_work` and `cancel_continuation` MCP tools with strict schemas.
- Reject empty/whitespace tasks, tasks over the existing bounded length, unknown fields, and continuation beyond the chain cap.
- Add typed read, queue/replace, mark-running-with-runner, compare-and-clear, cancel, real-inbound-reset, and interrupted-resume helpers.
- On first read, normalize a valid legacy `pending_next` value into `work_continuation` and delete the old key; malformed legacy state is deleted rather than executed.

Assertions:

- A stale completion cannot delete a newer task.
- Repeated cancellation is harmless.
- A replacement made during a running continuation survives that turn's result.
- A real inbound resets the chain and recovery-attempt counters without deleting the task.
- A same-runner `running` record is not eligible for idle reinjection; a different-runner record is.
- No tool writes to `messages_in` or `processing_ack`.

### B. Direct runner continuation, without synthetic batches

Files:

- modify `container/agent-runner/src/poll-loop.ts`
- modify `container/agent-runner/src/poll-loop.test.ts`
- modify `container/agent-runner/src/integration.test.ts`

Work:

- Delete `extractNextDirective`, `decideNextContinuation`, raw `NEXT:` parsing, and synthetic `next-*` batches.
- Change the existing archive FIFO from prompt strings to ledger entries carrying an optional continuation ID. Bind direct continuation pushes to that ledger and complete only the ID shifted for the delivered result.
- Launch queued work only inside the existing `!willRetryWrapping && !willRetryTaskBlocks` delivered-final-result branch. An error or undelivered result leaves it queued.
- On runner startup or idle, resume a persisted queued record, or a running record owned by a different runner, directly. Never inject a running record owned by the current process.
- Preserve real-inbound priority: an already-arrived user turn is processed before idle continuation injection.
- Keep the current 50-turn safety ceiling.

Assertions:

- Public prose containing `NEXT:` or "working on that next" has no control effect.
- A queued task starts after the current result without an idle gap.
- An unwrapped/task-block-nudged/error result leaves the task queued and launches nothing.
- A user status question does not clear the task and the task resumes afterward.
- Explicit cancel prevents launch; replacement launches only the replacement.
- Crash before launch and crash while running each resume exactly one durable task.
- Continuation creates no `messages_in` row and no fake processing acknowledgement.

### C. Recovery based on durable evidence

Files:

- modify `src/host-sweep.ts` and tests
- simplify `src/host-restart-warn.ts` and tests
- modify `src/index.ts` only as required by the simplified API

Work:

- Replace `pending_next` reads with validated `work_continuation` reads, including legacy normalization compatibility.
- Wake a stopped session with durable queued/running continuation, using the existing bounded respawn throttle.
- Base ceiling and restart accountability on explicit continuation state, active processing claims, or a tool whose `tool_started_at` is within the absolute-ceiling window.
- Replace the respawn-episode SQL and row-exclusion rules with the continuation record's exact `resume_attempts` cap. The host may update it only while the container is stopped and therefore cannot be the outbound DB writer.
- Remove `lastOutboundKind='status'` entirely. Future-tense prose is not a control signal; the structured tool is the authority.
- Startup recovery scans all active sessions, not only central rows still marked `container_status='running'`; this closes the graceful-old-host/first-new-start gap.
- Recovery wake IDs are deterministic per interruption episode so restart replay is idempotent.

Assertions:

- A session marked stopped by an older graceful host is still considered at first startup.
- Stale status narration outside the ceiling window never wakes a session.
- A normal chat result with no durable work never wakes a session.
- Repeating startup or sweep does not create duplicate accountability rows.
- A persisted continuation wakes and resumes after both graceful and crash restart paths.
- A stale `current_tool` from an old container does not wake a session.
- Two failed automatic recovery attempts park the continuation with one public accounting until real inbound resets the counter.

### D. Make `wait` delivery idempotent and late-safe

Files:

- modify `container/agent-runner/src/mcp-tools/wait.ts` and tests
- modify `src/modules/scheduled-wake/index.ts` and tests

Work:

- Generate a stable `wake_id` in the tool payload.
- Validate exact payload shape, bounded prompt length, finite delay, ISO timestamp, minimum delay, and maximum delay.
- Use the existing `insertMessageIfNew` helper (`ON CONFLICT(id) DO NOTHING`) with an inbound row ID derived deterministically from `wake_id`, so delivery replay is exactly-once.
- Treat an overdue but otherwise valid delivery as due immediately; never acknowledge it and drop the wake.
- Keep the wake in the same session/thread and preserve `process_after` for future delivery.

Assertions:

- Replay after host crash creates one inbound wake.
- Overdue delivery creates one immediately due wake.
- Invalid, too-soon, too-far, malformed, and oversized requests are rejected without acknowledgement.
- No standalone task session is created.

### E. Lifecycle instructions and cleanup

Files:

- modify `container/CLAUDE.md`
- remove the dead Codex AGENTS composer only if it remains unreferenced after the continuation changes
- update focused lifecycle documentation/tests that mention `NEXT:`

Work:

- Tell the model to call `continue_work` before making a future-work promise, use `wait` only for time-based delay, and call `cancel_continuation` only for an explicit stop.
- State that status questions do not cancel queued work and a new messaging thread is the normal clean boundary.
- Do not add lifecycle meaning to `/clear`; leave its existing provider-context reset path unchanged.
- Rewrite the live `wait` tool description to point to `continue_work`, and remove every runtime/tool instruction that tells an agent to emit `NEXT:`.
- Preserve the current project-document byte budget and re-run its guard.

## Verification

Focused red/green tests first where the current behavior can be isolated:

```text
container/agent-runner/src/mcp-tools/work-continuation.test.ts
container/agent-runner/src/poll-loop.test.ts
container/agent-runner/src/integration.test.ts
container/agent-runner/src/mcp-tools/wait.test.ts
src/host-sweep.test.ts
src/host-restart-warn.test.ts
src/modules/scheduled-wake/index.test.ts
```

Then run:

```bash
cd container/agent-runner && bun test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test
pnpm run build
git diff --check
```

Runtime acceptance uses an isolated test session and proves:

1. an agent calls `continue_work`, ends its current result, and receives the next task immediately;
2. a user status question is answered and the queued task resumes;
3. a container kill during continuation resumes once after respawn;
4. a host restart during continuation produces one accounting wake and resumes once;
5. two delivery attempts for one scheduled wake create one inbound row;
6. a new messaging thread has no continuation state from the prior thread;
7. the runner's existing `/clear` provider-context reset behavior is byte-for-byte unchanged by this feature.

## Scope and risk controls

- One cohesive implementation owner: the runner state machine, host recovery, and tests share invariants and should not be split across parallel writers.
- No schema migration, new service, background daemon, or user command.
- Existing dirty work is preserved; edits are limited to the files above plus directly coupled tests/docs.
- Build and publish are separate. Activating host/container changes requires a deliberately timed service/container restart because it interrupts live work.
