# Execution

Implemented and rebased in an isolated worktree. The change adds a narrowly
scoped recall-pair predicate to the mailbox admission seam and uses it in S19
before and after the existing asynchronous move-intent check. S19 reads the
continuation from that same mailbox seam at both points.

Regression coverage uses production-shaped SQLite fixtures and registered
sweep duties. It proves future inert waits stay active, a due wait is admitted
and wakes the same session, an unfinished continuation stays active, and a
truly spent session closes despite completed, expired, or unpaired historical
context. It inserts both a deferred wait and a continuation while S19 is
awaiting its move-intent check, proving the post-await recheck prevents either
race. It separately proves the session closes after a paired wait's primary
has completed. The unchanged collector closes the future-wait fixture, so the
new case distinguishes the repair from the previous behavior.

## Review follow-up dispositions

- The pre- and post-await continuation reads now use
  `mailbox.readWorkContinuation()`; the continuation race regression covers
  the post-await read. The sweep plan already obtains that same value from the
  mailbox, so removing the duplicate plan dependency does not expand its
  retention rule.
- `shouldCloseTaskSession` requires explicit paired-wait and continuation
  facts. Its unit cases state both values at every call site.
- The pair query names its primary row `pending_turn`, avoiding ambiguity with
  the `trigger` column.
- Retention is status-bounded without adding a new policy: S4 marks a stuck
  row failed at its existing `MAX_TRIES` cap, and S3 expires stale pending rows.
  Either terminal primary makes the pair ineligible for this predicate.
- A pending primary with a terminal recall marker is not retained. Normal pair
  completion and crash recovery do not produce that divergence; if malformed
  storage did, the runner cannot admit its incomplete pair, so retaining it
  would create permanent historical retention rather than preserve actionable
  work.

Validation after rebasing onto `origin/main` completed:

- `pnpm exec vitest run src/modules/mailbox/session-db-ops.test.ts src/modules/sweep-scheduling/scheduling.test.ts src/host-sweep-registry.test.ts src/modules/sweep-idle-reap/idle-reap.test.ts src/modules/sweep-scheduled-move/scheduled-move.test.ts --reporter=dot --maxWorkers=1` — 5 files, 183 tests passed.
- `pnpm exec vitest run src/modules/sweep-session-core/session-core.test.ts --reporter=dot --maxWorkers=1` — 1 file, 14 tests passed; this includes the existing retry-cap terminalization regression.
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run ratchet:report -- --write` — delta 0.
- `pnpm run check:public-boundary -- --root <worktree> --index`
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
- An inherited runner-provider fixture label was made neutral so the full
  indexed public-boundary scan passes. This does not change the fixture's
  setup or assertions.

Publication, review, deployment, and runtime verification remain separate from
this source-only implementation.
