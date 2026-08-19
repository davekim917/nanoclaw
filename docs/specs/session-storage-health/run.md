# session-storage-health — run record

## 2026-08-19 — plan stage

- Lead: Claude (Fable 5), session "observatory". Origin: infra triage
  (event-loop I/O saturation + inotify exhaustion traced to 6,857 unreaped
  active sessions), then debug worker `archival-debug` root-caused WHY the
  existing 30d hourly archival produced zero actions since 2026-08-13
  (migration DDL mass-touched every inbound.db mtime; max(mtime,
  dbLastActive) veto; prior stampede 2026-08-05 = previous cycle). Evidence:
  scratchpad archival-stopped-rootcause.md + reaper-evidence.md +
  disk-breakdown.md.
- The owner delegated decision authority for this infra lane ("for all others I
  still defer to you", 2026-08-19); review gate still applied.
- plan.md rev 1 written; cross-model review: same Codex transport as all
  session reviews (gpt-5.6-sol high, ephemeral, yolo, foreground, 3600000
  ms). Status `completed`. Verdict `must_fix`: 8 MUST-FIX + 2 SHOULD-FIX.
- Lead dispositions — ALL TEN ACCEPTED, several bounded on the
  single-host-process fact (in-process serialization instead of durable
  lock subsystems):
  1. SR1 crash consistency → fsynced intent manifest + startup replay +
     keep-mtime-on-admitted-work (T1 crash injection).
  2. Archival races → re-validate inside apply + status CAS
     'active'→'archiving' + spawn/wake/write refusal + module-level
     serializer (SR2/SR2b, T2/T2b).
  3. Tar-then-rm crash safety → full lifecycle ordering (temp tar →
     validate → atomic publish → close → rm) + startup finisher +
     append-only reclaim journal (SR2b, T2b).
  4. Budget semantics → one serializer + one union selection
     oldest-first; blocked rows don't consume slots (SR2/SR4, T2/T4).
  5. ROLLOUT ORDER (the sharpest catch): recovery must run only after the
     capped code is live-verified — otherwise the old uncapped archiver
     sees ~5,800 restored mtimes in one tick. Path reordered: ship+restart+
     verify BEFORE C3.
  6. Recovery precision → burst-window + central-activity bound + manifest
     with inode/mtime pinning + idempotent rerun + preimage (SR7, T7).
  7. support-threads concurrency/continuity → session_id-only rebinding,
     per-thread serialization, exactly-once semantics (SR6, T6).
  8. Archived-state rollback → reclaim journal (id, prior status, rescue
     path) + mechanical restore procedure + resume test (Rollback).
  9. (SHOULD) knob completeness/validation/startup logging → SR4b, T4.
  10. (SHOULD) enumerate all raw-session-id consumers in C2, prove-or-fix
     each, observatory_item_threads explicitly included (SR6, T6).
- One bounded correction batch applied → plan.md revision 2. Coverage:
  full. Proceeding to build under the owner's delegated authority; ship step
  still shows him the restart.

## 2026-08-19 — build stage (C1)

Builder: worker-high, live checkout, feature branch `feat/session-storage-health`.
No `pnpm run build`, no restart, no recovery execution at any point.

### Failing-first observations (against unmodified `main`)

Every reproducible defect was captured as a failing test BEFORE the fix. Run
output kept at `scratchpad/` in the session; the assertions are the record:

| Test | Observed on current code |
|---|---|
| T5 future `process_after` blocks | archived (`archive-session … status: applied`) |
| T5 live `work_continuation` blocks | archived |
| T5 unconsumed `trigger=0` row blocks | archived |
| T2 cap 50 over 120 eligible | 120 archived (`expected [120 items] to equal [50 items]`) |
| T2 overlapping + force entry point | `expected 120 to be 50` |
| T3 session knob 14d, worktree 30d | `expected [] to equal ['sess-000']` |
| T3 fallback when knob unset | already correct (passed) |
| T4 count cap, nothing age-eligible | `expected [] to equal [3 ids]` |
| T4 blocked oldest yields its slot | `expected [] to equal ['sess-001']` |
| T4 cap 0 disables | already correct (passed) |
| T4 age ∪ overflow dedupe | `expected 2 ids to equal 4 ids` |
| T4b invalid knob warns once + config log | no such logs |
| T2b tar failure keeps the row active | `expected 'closed' to be 'active'` (row was closed BEFORE the tar) |
| T2b container starts between collect and apply | `expected 'applied' to be 'skipped'` |
| T2b write between collect and apply | `expected 'applied' to be 'skipped'` |

### Implementation

- **SR1** — `reconcilePendingUpgradeContexts` (`src/session-manager.ts`) now
  stats every target's `inbound.db`, writes+fsyncs one intent manifest
  (`data/pending-upgrade-mtimes.json`) before the first DDL, restores the
  pre-pass mtime for every session that admitted nothing, and deletes the
  manifest in a `finally`. `replayUpgradeMtimeManifest()` runs at the head of
  the same function, restoring only files whose current mtime is (a) newer
  than the recorded one, (b) at/after the manifest write, and (c) inside a
  10-minute window — so real post-crash traffic keeps its clock. Return type
  gained `mtimesRestored`.
- **SR2** — module-level reclaim serializer in `src/storage-manager.ts`
  (`beginReclaimPass`/`takeReclaimBudget`/`endReclaimPass`). The pass wraps the
  WHOLE of `getStorageReport` (collection and apply), so anything re-entering
  storage maintenance while one is open draws from the same budget.
- **SR2b** — full lifecycle in `createArchiveSessionAction`: revalidate inside
  apply (container / open work / mtime unchanged since collection) → CAS
  `active`→`archiving` → `tar -cf` to `<rescue>.tmp` → non-empty + `tar -tf`
  listable → `renameSync` publish → fsynced JSONL journal line → CAS
  `archiving`→`closed` → `rm -rf`. Any tar/validate failure removes the temp
  and returns the row to `active`. `finishInterruptedSessionArchivals()` (called
  from `src/index.ts` right after `resetStorageActivityState()`) resolves every
  interrupted state idempotently and is **journal-gated** — a `closed` dir is
  only removed when a journal line names a published archive for it, so the
  ~1,200 sessions closed by ordinary close paths are never touched.
- **SR3/SR4/SR4b** — `sessionReclaimMs` / `sessionReclaimPerTick` /
  `sessionActiveCap` on `StoragePolicy`, parsed by `parseSessionKnob` (integer,
  floor 1 / 0 for the cap; invalid → default + one warning per process).
  Resolved values are logged once via `storage-manager: session reclaim config`.
  Selection is one union pass (`selectSessionsToArchive`): age-eligible ∪
  count-overflow, oldest-idle first, `limit = min(budget, ageEligible +
  deficit)`. Blocked sessions are filtered out during the walk, so they cannot
  consume an overflow slot. `dirSizeBytes` now runs only for SELECTED sessions
  (it used to walk every eligible dir — 5,800 recursive walks per tick under
  the current backlog).
- **SR5** — `sessionHasOpenWork` blocks on `status IN ('processing','pending')`
  (any unconsumed row, due or future) and on a non-empty
  `session_state.work_continuation` / `pending_next` in outbound.db.
- **`skipped.budgetDeferredSessions`** added to the report so a live tick shows
  how much backlog the budget deferred.

### Migration: NOT required

`sessions.status` is `TEXT DEFAULT 'active'` with no CHECK/enum
(`src/db/schema.ts:126`), so `'archiving'` needs no schema change. Migration
049's unique index is partial (`WHERE status = 'active'`), so an archiving row
simply leaves the index — and `releaseArchivingRow()` closes rather than
reviving a row whose triple a fresh session claimed meanwhile.

### Spawn / wake / write refusal of `archiving`

Enumerated rather than added blindly:

- **spawn/wake** — `wakeContainer` takes a storage-activity lease on the session
  dir (`src/container-runner.ts:625` → `acquireStorageActivityLease`), and the
  archival apply holds the exclusive cleanup claim for its ENTIRE lifecycle
  (`tryRunWithStorageCleanupClaim`, `src/storage-activity.ts:107`). The two are
  mutually exclusive by construction, so a spawn cannot interleave an archival.
  Routing-side, `findSessionForAgent` and `getActiveSessions` both filter
  `status='active'`, which excludes `archiving` for free. **No edit to
  `src/container-runner.ts`** — that file carries another session's uncommitted
  work, and exact-path staging forbids touching it.
- **write** — `writeSessionMessageInternal` now throws on an `archiving` row
  before its re-provisioning branch. That branch is exactly the zombie-maker
  from the grounding (§3d): it would re-create the dir seconds before the rm.

### Verification (C1)

- `vitest run src/storage-manager.test.ts` → **57 passed**
- `vitest run src/session-manager.test.ts` → **46 passed**
- `vitest run src/storage-pressure-alert.test.ts src/host-sweep.test.ts` → passed
- Full host suite `vitest run src/` → **3366 passed, 3 failed**. The 3 failures
  are `src/migrate-repo-store*.test.ts` 5s timeouts under parallel load; both
  files pass in isolation (`54 passed`, 104s of real git work). Neither imports
  storage-manager or session-manager.
- `tsc --noEmit -p tsconfig.json` → clean.
- `eslint` on the four changed source files → 0 errors (only the repo-wide
  pre-existing `no-catch-all` warnings).

### Deliberate contract changes (both are the plan, not drift)

1. `storage-manager.test.ts` "treats only due triggered work as busy" →
   "treats any unconsumed inbound row as busy, due or not". SR5 reverses this
   assertion on purpose.
2. "fails closed when a legacy session database lacks the scheduling columns" →
   "fails closed when a session inbound database cannot be read". The blocker
   predicate no longer reads `trigger`/`process_after`, so a legacy DB missing
   only those columns is now fully evaluable; fail-closed is retained for a
   genuinely unreadable DB.

### QUESTION for the lead (SR5 breadth) — implemented literally, measurable to narrow

SR5 says "ANY pending messages_in row (due or future)". Implemented literally.
The evidenced gap (grounding §3b) was narrower: `trigger=1` rows with a FUTURE
`process_after`. Measured the difference on live data before choosing — a
deterministic 408-session sample of the 6,927 on-disk sessions, read-only:

```
sampled 408 · anyPending 24 · pendT1Due 0 · pendT1Future 0 · pendT0 24
processing 0 · workContinuation 0 (of 408 outbound DBs read)
```

So the literal reading retains ~5.9% of sessions (≈410 fleet-wide) that the
narrow reading would archive, and all 24 are `trigger=0` accumulated context.
Not a re-outage (94% still drain), and the content survives in the rescue tar
either way. Narrowing later is one predicate in `sessionHasOpenWork`. Flagged,
not improvised.
