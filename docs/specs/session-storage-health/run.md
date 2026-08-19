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

## 2026-08-19 — build stage (C2)

### SR6 — support-threads is status-aware, rebinds in place, serialized per thread

`src/modules/support-threads/dispatch.ts`:

- The follow-up branch now requires `status === 'active'`. Reclaim only CLOSES
  a session row (it never deletes it), so the old bare `getSession` kept
  answering for archived sessions and the code's own comment — "The session was
  archived/pruned — fall through" — was reasoning from a premise that was false
  for the archival path. That produced the zombie: a write into a
  re-provisioned dir plus a spawned container on a `status='closed'` row, which
  `getActiveSessions()` never returns, so host-sweep's stuck detection,
  heartbeat ceiling and claim tolerance all skipped it for as long as it ran.
- A stale binding no longer falls through to the new-issue branch. That branch
  posts a fresh announcement and opens a second Slack thread — for a customer
  and a Linear ticket that are still the same issue. It now re-resolves a
  session on the SAME `slack_thread_id` and calls the new
  `rebindSupportThreadSession()`, which touches `session_id` (+ status/activity)
  and nothing else. T6 asserts `slack_thread_id`, `slack_parent_msg_id`,
  `subject`, `sender`, `linear_issue` and `created_at` all survive.
- `withSupportThreadLock` chains dispatches per Gmail thread id.

### T6 — and what each case actually proves

| Case | Verdict |
|---|---|
| closed binding → no write/wake on the closed row, only `session_id` replaced | **fails without the status filter** (`expected 'sess-…' not to be 'sess-…'`) |
| two concurrent follow-ups on an archived binding → one new session, both delivered | **fails without the status filter**; passes with or without the lock |
| two concurrent emails for a NEW issue → one announcement | **fails without the lock** (`expected vi.fn() to be called 1 times, but got 2`) |
| active binding → unchanged behavior | passes before and after |

Being straight about the second row: the reviewer's concurrency concern is real
but is NOT reachable through the archived-binding path today. `resolveSession`
is a synchronous find-then-create and migration 049's partial unique index on
the active `(agent_group, messaging_group, thread)` triple already forces two
racers onto one session. The lock earns its place on the NEW-issue path, where
`await adapter.postParent(...)` happens BEFORE the row is recorded — proven by
the third row above. It also carries the same durability argument migration 049
documents for itself: it survives a refactor that puts an `await` inside
`resolveSession`.

### Raw-session-id consumer enumeration (SR6's second half)

`grep -rn "getSession(" src/ --include=*.ts | grep -v test` → 40 call sites,
classified by whether they can wake or write the resolved session.

**A. Self-refresh of the session already running this turn — cannot be archived.**
`router.ts:1348`, `container-restart.ts:351`, `modules/self-mod/apply.ts:81,131,223`,
`modules/provider-fallback/handler.ts:92`, `modules/approvals/primitive.ts:220`,
`modules/agent-to-agent/create-agent.ts:39`, `modules/agent-to-agent/agent-route.ts:450`,
`cli/dispatch.ts:131`, `cli/resources/groups.ts:306`, `cli/resources/tasks.ts:263,388`.
*Proof:* collection skips `isContainerRunning` (`storage-manager.ts` session walk),
apply re-validates it (C1), and `wakeContainer` holds a storage-activity lease on
the session dir (`container-runner.ts:625`) that is mutually exclusive with the
archival's cleanup claim (`storage-activity.ts:107`).

**B. Read-only — no write, no wake, status irrelevant.**
`cli/dispatch.ts:96` (cross-group existence oracle guard), `cli/resources/tasks.ts:128`
(scope check), `dashboard/archive.ts:37`, `host-restart-warn.ts:154`,
`session-manager.ts:645` (provider name), `session-manager.ts:1604` (SSE emit).

**C. Already filters status — no change needed.**
`modules/agent-to-agent/agent-route.ts:250` — `candidate.status === 'active'`.

**D. `observatory_item_threads` — RESOLVED, and it is not a session-id consumer at all.**
Flagged "unverified" in the grounding. Traced both consumers: the table stores
`(workgroup_id, item_id) → thread_id` and there is no `getSession` anywhere in
`dashboard/observatory-steer.ts` or `dashboard/api/observatory.ts`.
`decorateSteeredThreads` (`observatory.ts:210`) is display-only, and the steer
path resolves through `resolveSession` on the thread, which filters
`status='active'` via `findSessionForAgent`. **Proof, no fix.**

**E. FIXED in C2.** `modules/support-threads/dispatch.ts:264`.

**F. Same pattern, NOT fixed here — writes/wakes a STORED session id with no status filter.**

| Path | Stored id source |
|---|---|
| `dashboard/steer.ts:354` (`applySessionSteer`) + `:249` (child steer wake) | dashboard request / steer exec |
| `dashboard/api/scheduled-mutations.ts:483` (run-now wake) | `tasks.session_id` |
| `modules/interactive/index.ts:25` | `pending_questions.session_id` |
| `modules/approvals/response-handler.ts:115,207`, `reason-capture.ts:139,165` | `pending_approvals.session_id` |
| `modules/orchestrator-dispatch/completion.ts:42,95`, `cancellation.ts:62,85`, `dispatch.ts:493`, `host-sweep.ts:1638` | `tasks.parent_session_id` / `child_session_id` |

All of these are live code (`src/modules/index.ts:30` imports orchestrator-dispatch;
`src/index.ts:115` runs its startup reconciler). Their WRITE half is already
covered by C1 — `writeSessionMessageInternal` throws on an `archiving` row — so
the residual exposure is a session that is `closed`, i.e. already archived.
Each of them can then wake a closed row into the same zombie state SR6 just
removed from support-threads.

**Not fixed in C2, deliberately, and this is the one thing the lead must decide:**
SR6's scope is support-threads, and the lazy root-cause fix for this whole class
is ONE guard — `wakeContainer` refusing a row whose status is not `'active'`,
which every path above funnels through. That is a ~3-line change in
`src/container-runner.ts`, and **that file carries another session's uncommitted
work** (the Slack owner-safety subject change), so exact-path staging forbids
touching it in this branch. Recommend it as a separate one-commit follow-up once
that file is free; the alternative (extending the C1 write guard from
`archiving` to `closed`) is broader and would need its own pass over legitimate
writes to closed sessions.

### Verification (C2)

- `vitest run src/modules/support-threads/ src/dashboard/steer.test.ts` → **17 passed**
- `tsc --noEmit -p tsconfig.json` → clean · `eslint` on both changed sources → 0 errors

## 2026-08-19 — build stage (C3, script only — NOT executed)

`scripts/restore-session-mtimes.ts` + `scripts/restore-session-mtimes.test.ts`.
`sessionHasOpenWork` is now exported from `src/storage-manager.ts` so the script
uses the SAME blocker predicate the reaper does rather than a second copy.

### Burst window, calibrated against live data before it was hard-coded

Install TZ is UTC, and the burst is exactly where the root-cause doc put it:

```
top inbound.db mtime minutes (UTC): 2026-08-15T20:22Z 2925 · 2026-08-15T20:21Z 2102
                                    2026-08-19T21:14Z 234 · 2026-08-15T16:27Z 111
in 2026-08-15T20:21Z ±10min: 5031 files (of 6927 session dirs)
```

Default window `2026-08-15T20:21:00.000Z±10`. Note the smaller 2026-08-15T16:25–16:27Z
cluster (~142 files, matching the grounding's `disk_newest 2026-08-15T16:27:19Z`
example) is a SEPARATE earlier pass and is deliberately NOT in the default —
pass `--window 2026-08-15T16:26:00Z±5` to include it.

### Selection and safety

`--dry-run`: inbound.db mtime inside a window AND central
`COALESCE(last_active, created_at)` strictly before the window start, skipping
a session with a live storage-activity marker (`container-active`), open work
(`open-work`, via the shared predicate), an unreadable DB, a missing central
row, or no signal older than the bumped mtime. The restore target is the NEWEST
surviving signal — `outbound.db`/`archive.db`/`central.db`/`.heartbeat` mtimes
or the central row — never the oldest: reclaim must not act on a clock claiming
more idleness than the session can prove. Provenance is recorded per entry.

`--execute --manifest <path>`: pins every entry by inode AND mtime (changed →
counted, not acted on), writes the fsynced preimage manifest BEFORE the first
`utimes`, re-checks the pin inside the claim, and reports `alreadyRestored` on
rerun so a second pass is a no-op.

**Deviation, recorded:** SR7 says execute runs "while the reclaim serializer is
held". That serializer is in-process state inside the host's storage worker
thread and a standalone script cannot hold it. The faithful cross-process
equivalent is the exclusive cleanup claim the archiver itself takes, so each
`utimes` runs inside `tryRunWithStorageCleanupClaim(sessPath, …)` — an archival
of that session cannot interleave, and a claim held elsewhere is reported as
`claimBusy` rather than forced.

### T7 — `vitest run scripts/restore-session-mtimes.test.ts` → 8 passed

Window parsing · burst+pre-burst selection · skips for live marker / open work /
orphan row · provenance per source · `created_at` fallback when `last_active` is
null · never choosing a target newer than the bumped mtime · execute + preimage +
no-op rerun + preimage round-trip · inode/mtime pin rejecting a moved entry.

The inode-pin case tampers with the manifest's recorded inode rather than
recreating the file: ext4 reuses freed inodes, so "delete and rewrite" is not a
reliable way to change one and the test was flaky asserting it that way.

### Live `--dry-run` (read-only, run once, nothing executed)

```
windows: 2026-08-15T20:21:00.000Z±10m
selected: 5015
  provenance .heartbeat: 136
  provenance central:last_active: 4276
  provenance outbound.db: 603
skipped: 16
  central-activity-after-burst: 1
  open-work: 15
restored-clock range: 2026-04-28T14:42:24.355Z .. 2026-08-15T18:32:08.486Z
```

Re-measured after the dry-run: still 5,031 inbound.db files in the burst window,
i.e. the dry-run changed nothing on disk. Every restored clock lands before the
burst, as it must.

Projected drain once executed (post-ship), from the manifest:

```
age buckets of the restored clocks: >90d 347 · 30-90d 548 · 14-30d 1668 · <14d 2452
immediately eligible at RECLAIM_DAYS=14: 2563
```

At 50/tick hourly that is ~52 ticks (~2.2 days) for the age-eligible set alone.
With `ACTIVE_CAP=2000` the cap dominates (6,857 active − 2,000 = 4,857 deficit),
so every tick runs a full 50 until the active count reaches the cap — roughly 97
ticks, ~4 days. Bounded either way; no stampede.

Full output: `scratchpad/restore-dry-run.txt`; manifest:
`scratchpad/restore-manifest.json` (both session-local, not in the repo).

### .env

Appended (inert until the host restarts; `.env` is gitignored):

```
NANOCLAW_SESSION_RECLAIM_DAYS=14
NANOCLAW_SESSION_RECLAIM_PER_TICK=50
NANOCLAW_SESSION_ACTIVE_CAP=2000
```

### Not done, by instruction

No `pnpm run build`, no service restart, no push, and no `--execute` in any
form. The next step is the lead's: ship + restart + verify a bounded live tick
(`storage-manager: session reclaim config` line, then `session-reclaim` actions
≤50), and only then `--execute --manifest`.

### Branch-level verification (all three commits)

- `tsc --noEmit -p tsconfig.json` → **clean**
- `vitest run src/ scripts/` → **3,849 passed, 1 failed, 1 skipped, 1 todo** (254 files).
  The single failure is `src/message-archive.test.ts` hitting the 5s per-test
  timeout under parallel load; it passes in isolation (17 passed, 5.7s) and
  imports nothing from the reclaim path. An earlier full run flaked the same way
  on `src/migrate-repo-store*.test.ts` (also green in isolation, 54 passed) and
  those did not recur here — load flakes, not a regression.
- Commits: `dfa6e3db` (C1), `1e567527` (C2), C3 = this commit.
- Zero pushes, zero `pnpm run build`, zero restarts, zero `--execute`.
