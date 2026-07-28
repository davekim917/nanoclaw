# Run: Durable Work Continuation

Stage: implementation complete and independently reviewed; not deployed
Primary runtime: Codex

## Approval

- The operator approved the recommended focused rewrite on 2026-07-28.
- Preserve good primitives only where they reduce risk or complexity.
- `/clear` is explicitly excluded as a continuation or cancellation control; it remains the provider's existing new-session/context-reset command.
- The normal clean boundary is a new messaging thread.

## Grounding

- Current branch: `agent-continuity-lifecycle-fixes`.
- Worktree was clean before creating this plan.
- Current PR implementation uses raw `NEXT:` extraction, `pending_next`, synthetic in-memory batches, ceiling/status heuristics, scheduled-wake delivery, and host restart warnings.
- Prior source/runtime review identified concrete gaps in first-rollout restart recovery, `pending_next` clearing, scheduled-wake replay/overdue handling, and synthetic acknowledgement semantics.
- The approved replacement is one durable continuation record plus two internal tools, direct stream continuation, explicit-state recovery, and idempotent same-session wake delivery.

## Plan review

- Required reviewer: Claude CLI, `claude-opus-5`, high effort, plan-only, tools disabled, no session persistence.
- Command used the required explicit model, effort, safe mode, no-session-persistence, plan permission mode, empty tool set, strict MCP config, and JSON output.
- Result: HTTP 429 weekly limit before input consumption (`input_tokens: 0`, `duration_api_ms: 0`).
- Retry: none, per the bounded cross-model review contract.
- Operator-directed alternate attempt: OAuth credential slot 2, isolated temporary Claude profile, all other Anthropic credential slots removed from the child environment.
- Alternate result: authenticated and completed against `claude-opus-5` at high effort, with no permission denials, but returned prose plus attempted disabled tool calls instead of the required single JSON verdict.
- Alternate disposition: invalid output; no automatic retry was made.
- Operator then explicitly requested another attempt with JSON output.
- Schema-enforced retry: same isolated OAuth slot 2, `claude-opus-5`, high effort, tools disabled, custom no-tool system prompt, and CLI `--json-schema` validation.
- Result: valid `must_fix` structured review with four MUST-FIX and five SHOULD-FIX findings.
- Cross-model coverage: complete.

### Finding disposition

Accepted and incorporated in one correction batch:

1. Bind continuation IDs to the existing prompt FIFO so only the answered continuation result can clear its record.
2. Stamp running work with a per-process runner ID so the same process cannot reinject work that it already launched.
3. Keep autonomous recovery bounded with an exact per-continuation attempt counter and one public park accounting.
4. Launch continuation only from the existing delivered-final-result branch, never from wrapping/task-block retries or errors.
5. Reset the chain and recovery count on real inbound without deleting queued work.
6. Freshness-bound `current_tool` evidence when startup scanning broadens.
7. Remove the permanent `lastOutboundKind='status'` fallback instead of maintaining a redundant heuristic.
8. Rewrite the live `wait` description and grep away all runtime instructions for the removed `NEXT:` directive.

Rejected after source tracing:

1. The reviewer claimed `insertMessageIfNew` might not exist. It is already implemented in `src/db/session-db.ts` through `runInsertMessage(..., true)` with `ON CONFLICT(id) DO NOTHING` and returns whether a row was inserted. The plan now names this existing primitive explicitly; no duplicate helper will be added.

Correction loops: one. No further plan review, per the bounded-correction contract.

## Build

- Status: completed 2026-07-28.
- Approved plan: `docs/specs/durable-work-continuation/plan.md`.
- Builder: one cohesive Codex lead; no parallel writers because session-state, prompt-ledger, and host-recovery transitions share race invariants.
- Starting worktree state: only this specification directory was untracked; no pre-existing user edits were present.

### Implemented contract

- Replaced prose parsing with internal `continue_work({task})` and `cancel_continuation()` tools.
- Persisted one ID-bearing `work_continuation` record with queued/running phase, chain count, runner ownership, and exact host resume attempts. Legacy `pending_next` is migrated once.
- Bound continuation IDs to the prompt FIFO. Only a delivered final result for that ID clears it; replacement work survives a stale completion.
- Gave real inbound priority, reset counters without deleting the task, and left `/clear` exclusively on its existing provider session-reset path.
- Removed synthetic in-memory batches and their acknowledgement ambiguity. Same-process continuation starts directly on the active query; a new runner may recover queued or orphaned-running work.
- Replaced the permanent outbound `status` heuristic with explicit continuation state and freshness-bounded tool/processing evidence.
- Kept ceiling and restart accountability, with two bounded recovery attempts and one deterministic public parked notice.
- Added stable wake IDs, replay-idempotent insertion, overdue-immediate delivery, strict new-payload validation, and deterministic compatibility IDs for already-emitted legacy wake payloads.
- Rewrote the container lifecycle contract; plain future-tense prose and `NEXT:` have no control effect.

## Implementation review

- Required reviewer: Claude CLI, OAuth credential slot 2, `claude-opus-5`, high effort, tools disabled, no session persistence, strict MCP configuration.
- Input: approved plan, this run record, complete tracked diff, and the new untracked continuation-tool files via stdin.
- Output: schema-enforced JSON. Verdict: `must_fix`, with three MUST-FIX and six SHOULD-FIX findings.
- Correction budget: one implementation-review correction batch; no reviewer rerun.

Accepted and corrected:

1. Cap fresh-tool-only ceiling recovery episodes as well as explicit continuation recovery.
2. Suppress same-process idle reinjection after deterministic error, empty result, exhausted stream, or thrown provider error.
3. Add direct host recovery state-machine coverage: attempt increments, rollback on failed wake insertion, cap, parking, legacy migration, and exactly-one public notice.
4. Treat null/non-delivering results as paused work, never successful continuation completion.
5. Scope restart-note deduplication to a ten-minute restart episode so a later distinct restart is still accountable.
6. Accept already-emitted legacy `schedule_wake` payloads without `wake_id`, deriving a deterministic replay key.
7. Migrate legacy `pending_next` into the exact capped continuation state before host recovery.
8. Tolerate a legacy outbound DB without `processing_ack` during restart evidence collection.

Rejected after source tracing:

1. The reviewer described concurrent host parked-notice output as a host/container writer race. `writeOutboundDirect` is the existing supported host writer: host rows use even sequence numbers, container rows use odd sequence numbers, and the session DB uses the load-bearing cross-mount `DELETE` journal mode plus busy timeout. The stopped-container constraint applies to continuation-state mutation, not to this established outbound write seam.

Lead disposition after the bounded correction and verification: clear. No unresolved MUST-FIX or SHOULD-FIX finding remains.

## Verification

- Focused host regression set: 117 passed across `host-sweep`, `host-restart-warn`, and `scheduled-wake`.
- Focused container regression set: 155 passed, 1 pre-existing skip across session state, continuation tools, wait, poll loop, and integration.
- Full host suite: 231 files passed; 3,147 tests passed, 1 skipped, 1 todo.
- Full container suite: 965 passed, 4 skipped, 0 failed across 73 files.
- The full Bun suite initially starved one pre-existing 500 ms poll integration test until its 10-second harness timeout; the same test passed alone in 0.63 seconds. Its test-only budget was raised to 30 seconds with runtime timing unchanged, after which the full suite passed in 11.72 seconds.
- Host TypeScript: `pnpm exec tsc --noEmit` passed.
- Container TypeScript: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` passed.
- Host build: `pnpm run build` passed.
- Changed host files pass ESLint with no errors (27 pre-existing-style catch-all warnings remain in the two large lifecycle files). Repository-wide lint remains baseline-red with 33 errors and 545 warnings in unrelated files, including `src/worktree-cleanup.ts`.
- Changed host files pass Prettier check. Repository-wide formatting identified only four changed files; they were formatted and rechecked.
- Diff hygiene: `git diff --check` passed.
- Container project document: 16,970 bytes, below the 32 KB Codex cap.

### Edge and race cases exercised

- User inbound arriving before queued work, explicit cancellation, replacement continuation during running work, stale completion IDs, same-runner duplicate suppression, fresh-runner recovery, error/null/stream-loss requeue, legacy migration, and chain/recovery caps.
- Fresh versus stale tool evidence, missing legacy claim tables, graceful/startup restart dedupe, later independent restarts, failed recovery-wake rollback, system-row exclusions, parked-row filtering, and exactly-once public accounting.
- Wait timestamps by relative minutes, UTC `Z`, explicit offsets, past/sub-second/invalid values, unknown fields, duplicate new payloads, duplicate legacy payloads, and overdue-immediate scheduling.

## PR review correction batch

Eight inline Codex findings on commit `3f4b1bc` were traced against the replacement design.

Accepted and corrected:

1. Lifecycle wake rows now use an atomic inert-message plus deferred-recall pair. The due-admission seam replaces the marker with fresh recall before making the wake triggerable.
2. Scheduled one-shot rows age from `process_after`, so a valid long wait cannot expire as it first becomes due; overdue rows still expire after the configured grace period.
3. Continuation recovery throttling now includes the durable `session_state.updated_at` from the last counted recovery attempt, surviving both container-registry cleanup and host restart.
4. `wait` stamps the initiating inbound message ID. The host validates that anchor in the same session DB and copies its exact route instead of trusting a potentially stale session default.
5. Short waits are accepted down to one second and overdue timestamps are delivered immediately.
6. New and legacy scheduled-wake replays share stable IDs and conflict-safe paired insertion.

Rejected with contract evidence:

1. `/clear` remains solely the provider-context reset. It does not cancel durable work; `cancel_continuation` is the explicit cancellation control.
2. An empty/non-delivering provider result does not prove work completion. It requeues the continuation, while only a delivered result bound to the active continuation ID can complete it.

CI corrections:

- The scheduled-mutation rate-limit integration test now deterministically pre-fills the limiter and exercises one rejected handler call instead of racing a five-second timeout through up to 200 expensive calls.
- Memory curator tests now derive their canonical data root from the checkout under test rather than hard-coding one developer machine path.
- Final host suite: 873 suites passed; 3,152 tests passed, 1 skipped, 1 todo, 0 failed.
- Final container suite: 965 passed, 4 skipped, 0 failed. Both TypeScript checks passed.

## Activation boundary

- No commit, push, container image rebuild, service restart, or production activation was performed. Existing live sessions are unchanged until the operator explicitly publishes and deploys this work.
