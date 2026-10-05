# Run record — bounded periodic work

## Stage: plan (2026-08-16)

### Grounding evidence gathered before writing plan.md

| Fact | Command / source | Result |
|---|---|---|
| Session inventory | `q.ts data/v2.db "select status, container_status, count(*) …"` | 5,536 active/stopped, 1,155 closed, 6 running (6,697 total) |
| Age of active sessions | same, bucketed on `coalesce(last_active, created_at)` | 188 <1d, 1,468 1-7d, 2,915 7-30d, 971 30d+ |
| pollSweep candidate population | the exact query from `src/db/sessions.ts:185` | **1,657** |
| Sessions removed from that population by closing every 30d+ session | same query + 30d predicate | **0** |
| Session outbound.db files changed in last hour | `fs.statSync` sweep over `data/v2-sessions` | 17 of 5,333 |
| Host CPU duty cycle | `/proc/<pid>/stat` sampled 5s × 24 | ~6% baseline, bursts 86-134% every ~60s |
| CPU attribution | live inspector CPU profile, 150s @ 1ms, across bursts | ~57% delivery poll path, ~16% `canonicalToken`, ~7% `spawn`, ~3% GC |
| host-sweep already gated | `logs/nanoclaw.log` "Host sweep tick timing" | `sweptSessions=20 skippedQuiet=5175` |

### Decision record

- **Reframed the plan's premise.** Entering this stage the working theory was that accumulated
  sessions were the accumulator and a close policy was the lever. Testing it showed closing every
  30d+ session removes **0** sessions from `pollSweep`'s population, because
  `getSessionsActiveSince` already bounds to 7 days. The lever for the CPU burst is the change-gate,
  not the lifecycle. plan.md leads with this correction rather than burying it.
- Phase 3 (Graphify) deliberately left as a spike. A full scan builds a fresh `index.next-<hash>.db`
  (`daemon.ts:1437`) and promotes by rename (`:1614`); whether a no-change rebuild can be detected
  cheaply is unknown, and designing on that assumption would be guessing.
- Phase 4 (session lifecycle) left as a user decision. `findSession` requires `status='active'`
  (`src/db/sessions.ts:22-31`), so closing a chat session means a later reply starts a new session
  with no continuity — a product decision, not an implementation detail.
- Time-bounding the gate (R2) is a lead addition on top of the earlier cross-model design, for the
  reason recorded in plan.md: it converts the failure class from silent permanent non-delivery to
  bounded delay.

### Prior cross-model input carried into this plan

An earlier review this session (Fable, on the raw mtime-gate proposal, before plan.md existed)
identified two correctness holes in the lead's first design, both verified against source by the
lead afterwards:

- retry state lives only in the in-memory `deliveryAttempts` map (`src/delivery.ts:78,544`) — a
  failed delivery never moves the file mtime → accepted, became R3;
- `getDueOutboundMessages` filters `deliver_after <= now` (`src/db/session-db.ts:748`) → accepted,
  became R4.

It also supplied the arm-only-when-clean rule and the `-journal` bypass, both carried into the
design. This is recorded as input, **not** as the mandatory plan-stage cross-model review, which
runs below against the raw plan.md.

### Plan-stage cross-model review

- Stage: plan. Primary runtime/model family: Claude (Opus 5).
- Reviewer target: Codex, requested model `gpt-5.6-sol`, `model_reasoning_effort="high"`.
- Command: `codex exec --ignore-user-config --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --ephemeral --yolo`, stdin = review prompt + rubric + raw `plan.md`, timeout 3600000 ms.
- Outcome: `completed`, exit 0, single valid JSON object.
- Raw verdict: **must_fix** — 4 MUST-FIX, 2 SHOULD-FIX.
- Coverage: cross-family (Claude primary, Codex reviewer). Not degraded.

All six findings traced to source by the lead and **accepted**. One bounded correction batch applied
to `plan.md`.

| # | Sev | Finding | Lead verification | Disposition |
|---|---|---|---|---|
| F1 | MUST-FIX | R2 unachievable: a row due past the 7-day horizon leaves the candidate population and is never delivered | Confirmed, and the codebase already documents it: `touchSessionActivity` docstring, `src/db/sessions.ts:~220`, says such work sits unseen "past the 7-day delivery horizon, indefinitely". Pre-existing; not caused by the gate | ACCEPTED — R2 rescoped to the candidate population with the limit stated; hazard raised as user decision **D-3** rather than silently folded in |
| F2 | MUST-FIX | Synchronized cache expiry recreates the ~1,657-session burst every 10 min; "98%" is wrong (6/hr vs 60/hr = 90%) | Arithmetic confirmed against the plan's own numbers; herd behavior follows from arming all clean sessions in one cycle | ACCEPTED — per-session deterministic jitter added, cost restated as `O(changes + population/backoff)`, observability expectation corrected from "double digits" to order 10² |
| F3 | MUST-FIX | `deliverSessionMessages` returns `void` and no-ops under `inflightDeliveries`, so pollSweep cannot tell "clean" from "busy"; arming on the no-op marks an uninspected session quiet | Confirmed `src/delivery.ts:434-445` — early `return` when inflight, `Promise<void>` signature | ACCEPTED — drain returns `'busy' \| 'clean' \| 'pending' \| 'error'`; arm only on `'clean'`; A16/A17 added |
| F4 | MUST-FIX | Acceptance criteria assert cache contents, not delivery by deadline; an implementation could pass while stranding messages | Confirmed by reading the original A4/A8/A11 — all assert internal state | ACCEPTED — behavioral criteria A14 (delivery by jittered deadline with a frozen stat signal) and A15 (write racing the pre-open stat) added |
| F5 | SHOULD-FIX | R5 unmet: the timing log only fires when `cycleMs >= 1000`, so healthy fast skip-heavy cycles emit nothing | Confirmed `src/delivery.ts:401` | ACCEPTED — log emitted unconditionally; A12 restated |
| F6 | SHOULD-FIX | `src/periodic-gate.ts` would have one consumer; A13 tested shape; `shouldSkipUsageRollup` has no time bound so the "universal invariant" is contradicted | Confirmed `src/host-sweep.ts:1484` — pure mtime equality, no bound | ACCEPTED — shared helper and old A13 dropped, predicate stays local, invariant documented with the usage-rollup inconsistency named rather than hidden |

No finding was rejected. No second review loop opened (contract: one bounded correction batch).

## Stage: build (2026-08-16)

Approved plan: `docs/specs/bounded-periodic-work/plan.md` (post-review revision). Scope built:
phases 1 and 2. Phase 3 deferred per D-2, phase 4 is option (a) per D-1.

### Files changed

| File | Change |
|---|---|
| `src/delivery.ts` | change-gate (cache, jittered deadline, pure predicate), `DrainOutcome` on the drain path, `sweepDeliverSession`, `runSweepDeliveryCycle`, per-session failure isolation |
| `src/delivery.test.ts` | A1-A18 |
| `docs/architecture.md` | the invariant, with why each part is load-bearing (phase 2) |

Git state checked before starting: `src/delivery.ts` and `src/delivery.test.ts` were clean against
HEAD, so no surgical index staging was needed for this build. `docs/architecture.md` diff verified
as a single hunk (mine).

### Test-first evidence

Acceptance criteria were materialized before implementing and observed failing:

```
node_modules/.bin/vitest run src/delivery.test.ts
→ Tests  17 failed | 34 passed (51)      # A1-A17 fail, existing suite unaffected
```

After implementation:

```
node_modules/.bin/vitest run src/delivery.test.ts
→ Tests  52 passed (52)                  # A1-A18
node_modules/.bin/vitest run             # full host suite
→ Tests  1 failed | 3821 passed | 1 skipped | 1 todo (3824)
```

The single failure is `src/design-artifact-loop-vendor.test.ts` — vendored `render.ts` drifted from
`~/plugins/design-artifact-loop/server/render.ts`. **Pre-existing and unrelated**: that file is
clean against HEAD in this working tree, its last commit is `89ca8162` (another session's diagram
refactor), and it shares no code with this build's diff.

### Deviations from plan, and why

- **A18 added** (not in the approved criteria). Implementing R-1 revealed that reading `delivered`
  for *every* swept session — rather than only sessions with due rows, as before — widens the blast
  radius of a corrupt or legacy session DB: a throw would abort the cycle for every session behind
  it. Per-session `try/catch` added, cache explicitly cleared on that path so a failure can never
  arm the gate. A18 pins it. This is a failure path the plan required to be handled ("failures
  surface rather than swallow"), so it is a correction inside approved intent, not new scope.
- **`_setQuietDeliveryMarkForTest` seam added.** A14 needs the cache armed while a row is due —
  unreachable through the public path, because arming requires a clean drain and `fs.utimes` cannot
  restore nanosecond mtime precision. Recorded rather than quietly weakening A14 into a state
  assertion.
- **`shouldSkipQuietDelivery` takes `sessionId`** (plan showed a 3-arg signature). Required by the
  per-session jitter that F2 introduced.

### Edge cases and failure paths exercised

Beyond the happy path: delivery error (A6, A17), future `deliver_after` (A7), running container
(A9), hot journal (A10), commit racing the pre-open stat (A11, A15), frozen change signal past the
deadline (A14), concurrent `pollActive` ownership (A16), unreadable session DB mid-cycle (A18),
missing `outbound.db` (drain returns `pending`, no arm).

### Not done in this build

- `dist/` deliberately NOT compiled. It is a live deploy surface — a crash restart ships whatever
  was last built. Deploy and restart are the user's call.
- Phase 3 Graphify spike (D-2), phase 4 session lifecycle (D-1 option (a): nothing).
- D-3's 7-day-horizon hole remains open, recorded in plan.md as its own future change.

### Ready for review (superseded by the review stage below)

Implementation is coherent, focused checks pass, the diff has been inspected hunk by hunk, and the
three deviations above are explicit.

## Stage: review --implementation (2026-08-16)

Target: approved `plan.md` + raw diff of commit `9c9e7e81`. Nothing was deployed at review time —
`dist/` was deliberately not compiled, so this review gated activation rather than following it.

### Lenses selected

Correctness, failure handling, plan fidelity, verification quality (always), plus **state and
rollback** (in-memory cache, concurrent pollActive/pollSweep lifecycle) and **performance** (the
drain's query order changed on a hot path). Security and product lenses not selected: no trust
boundary, credential, or user-visible surface changed.

### Lead pass, before the external review

Traced the central question — can the gate arm on a session that still has deliverable work? — to
source:

- Arming requires `outcome === 'clean'`, which requires every row in `messages_out` to have a
  `delivered` row. `deferAck` rows are excluded from `deliveredNow`, so they force `pending`.
- `delivered` is **append-only**: no `DELETE FROM delivered` exists anywhere in `src/` or
  `container/agent-runner/src/`, and every `status='failed'` write in the tree targets inbound
  `messages_in`, not the outbound `delivered` table. So a row can never return to outstanding
  without the outbound file changing. This is what makes an armed gate safe.
- Delivery writes to `inbound.db`, never `outbound.db`, so a drain that delivers does not move the
  stat it armed with — correct, because everything it delivered is now recorded.
- `busy` and every error path call `quietDeliveryCache.delete`, so uncertainty actively disarms.

### Cross-model review

- Stage: implementation. Primary: Claude (Opus 5). Reviewer: Codex, requested `gpt-5.6-sol`,
  `model_reasoning_effort="high"`.
- Command: `codex exec --ignore-user-config --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --ephemeral --yolo`, stdin = rubric + approved plan + raw diff, timeout 3600000 ms.
- Outcome: `completed`, exit 0, one valid JSON object. Raw verdict: **must_fix**, 1 MUST-FIX.
- Coverage: cross-family. Not degraded.

| # | Sev | Finding | Lead verification | Disposition |
|---|---|---|---|---|
| G1 | MUST-FIX | The live-container bypass used `session.container_status` (the swept snapshot) instead of `isContainerRunning`. Spawn records its in-memory entry before the central row updates and the sweep snapshots all sessions up front, so a live container can read `stopped`. Worse, A9 could not catch it: the test inserted a row before the second sweep, which moves the mtime, so it passed even with the bypass deleted entirely | Confirmed both halves. `activeContainers.set(session.id, …)` at `src/container-runner.ts:914` is the authoritative record and precedes the row update. A9 as written did insert `out-live` before re-sweeping. **Mutation-checked**: deleting the bypass left A9 green | **ACCEPTED** |

Lead's amendment to the finding's framing, recorded because it changes severity reasoning but not
the disposition: the practical failure is **plan fidelity + verification quality**, not message
stranding. mtime carries the real safety — a live container that writes moves the file, and
`pollActive` drains running sessions every second regardless. The genuine defect is that the plan
specified `isContainerRunning`, the build silently substituted a weaker signal, and the test could
not tell the difference. That substitution was never recorded as a deviation, which is the drift
this gate exists to catch.

### Correction batch (one, per the contract)

1. `sweepDeliverSession` now treats a session as live when `isContainerRunning(session.id)` **or**
   the row says running/idle (row kept as a fallback for the reverse skew).
2. A9 rewritten to isolate the bypass: the cache is armed to the **current** post-insert stat, so
   the change signal says "nothing moved" and the liveness check is the only thing that can cause a
   poll.
3. `isContainerRunning` is imported **lazily** (`await import`). The first attempt used a static
   import, which pulled container-runner (docker, spawn, image builds) into the module graph of
   every consumer of `delivery.ts` and broke `src/storage-manager.test.ts` — an unrelated suite
   whose partial `child_process` mock lacks `execFile`. Completing another area's mock to
   accommodate this change would have been the wrong repair; keeping the graph unchanged is the
   smaller correction, and `await import()` is the repository's sanctioned tool for it (CLAUDE.md,
   host module-system rule).

### Fresh verification after the correction

```
# mutation check — proves A9 now bites
bypass deleted   → A9 FAILS: "expected 'skipped' not to be 'skipped'"
bypass restored  → A9 passes

node_modules/.bin/tsc <delivery.ts, delivery.test.ts> --noEmit    → clean
node_modules/.bin/vitest run src/delivery.test.ts src/storage-manager.test.ts
                                                                  → 88 passed (2 files)
node_modules/.bin/vitest run                                      → 1 failed | 3824 passed | 1 skipped | 1 todo
```

The single remaining failure is `src/design-artifact-loop-vendor.test.ts`, pre-existing vendor
drift against `~/plugins/design-artifact-loop`; its files are clean against HEAD and share no code
with this diff. Before the correction the run showed **two** failing files (storage-manager's mock);
after, it is back to one.

### Edge cases exercised this stage

Live container with a stale `stopped` row (A9, mutation-checked), unreadable session DB mid-cycle
(A18), frozen change signal past the deadline (A14), commit racing the pre-open stat (A11, A15),
concurrent `pollActive` ownership (A16), delivery error (A6, A17), future `deliver_after` (A7), hot
journal (A10), plus the lead's source trace that `delivered` rows are never revoked.

### Verdict

**`clear`** — no verified MUST-FIX remains after one bounded correction batch. Known risks carried
forward: R-1 (a gate bug costs ≤10 min of delay, not loss), R-2 (~1,657 stats/min), and D-3's
pre-existing 7-day-horizon hole, which this change neither causes nor fixes.

---

## Phase 3 spike — Graphify unconditional full reconcile (2026-08-18)

**Verdict: the premise is wrong. Do not build a change-gate for the 6h full reconcile yet.**

The spike asked whether the 6-hourly unconditional rebuild (`daemon.ts:718-723` → `markDirty`)
can be made change-driven. It cannot, because the change signal it would gate on is already
broken — and while investigating that, the daemon was found wedged.

### Live state, measured

```
graphify daemon           up since 2026-08-15 16:28, CPU 10h37m, RSS 3.6G (MemoryHigh 4G), swap 494M
workgroup-A    reconciling=true  lastStartedAt 2026-08-17T01:39:52Z   → still running 28.5h later
workgroup-B dirty=true  reconciling=false  lastCompletedAt 2026-08-17T01:39:52Z
main         dirty=true  reconciling=false  lastCompletedAt 2026-08-16T22:29:18Z  lagMs 31.8h
workgroup-C     dirty=true  reconciling=false  lastCompletedAt 2026-08-16T22:29:47Z  lagMs 31.8h
workgroup-A/workgroup-B     watcherDegraded=true, lastFailure = ENOSPC inotify watch limit
workgroup-A full-scan input  data/workgroups/<workgroup-A> = 30 GB (canonical repo clones add <0.5 GB)
workgroup-A index.db         6.9 GB
inotify watches, system   1,038,202 / 1,048,576  (99.0%)
  cursor-server 571,722 · graphify 414,173 · host 18,419
cgroup io.max             8:0 rbps=8000000  (drop-in added 2026-08-13 22:48)
observed read rate        7.64 MB/s sustained — pinned exactly at the cap
memory.events             high 908,426  (continuous reclaim against MemoryHigh=4G)
```

### Causal chain (each link verified in source and on the box)

1. **inotify is exhausted system-wide.** Watch registration fails with ENOSPC, so change events for
   those paths are never delivered. The code already documents this exact failure
   (`daemon.ts:563-567`: "without a sticky flag the daemon forgets it is half-blind and keeps
   serving stale reads as fresh") — `watcherDegraded` is set, reported in `status`, and **acted on
   nowhere**.
2. **A broken watcher forces full scans.** `canReconcileIncrementally` (`daemon.ts:911`) requires
   `pendingFilesystemChanges.size > 0`; watchers are what populate that map. No events → no
   incremental path → every reconcile is a full scan. The 6h timer is therefore not waste, it is
   the *compensating control* for the broken signal.
3. **The 8 MB/s read cap plus MemoryHigh=4G makes a large workgroup's service time exceed its
   arrival rate.** Page cache counts toward the cgroup, so a working set above `MemoryHigh` is
   continuously reclaimed and re-read — at 8 MB/s (`memory.events high=908,426`). Mid-run the
   worker thread sat in `folio_wait_bit_common`, state `D`, on an `etilqs_*` SQLite temp file while
   the main thread idled in `ep_poll`.

   **Corrected against the outcome:** this is *not* a permanent livelock. workgroup-A's reconcile
   completed unassisted at 2026-08-18T14:57:14Z — 13 minutes **before** the cgroup properties were
   changed at 15:10:47Z. The measured shape is:

   ```
   workgroup-A      2026-08-17T01:39:52Z → 2026-08-18T14:57:14Z   37.3 hours
   workgroup-B  (2.7 GB index, fits under MemoryHigh)           6 minutes
   fullReconcileMs timer                                          6 hours
   ```

   Service time 37.3h against a 6h arrival rate on a strictly serial runner: the backlog is
   unbounded by construction. That, not a hang, is why main and workgroup-C sat 31.8 hours stale.
4. **The background runner is strictly serial and reconciles are non-preemptible.** `drain()`
   (`background-runner.ts:269-275`) awaits one job at a time, and `queueReconcile` passes
   `preemptActive: false` (`daemon.ts:1254`). One stuck workgroup starves every other one
   indefinitely — which is why main and workgroup-C have been dirty and idle for 31.8 hours.
5. The 6h timer re-marks everything dirty on schedule, so this state can never converge.
6. **Admission requires global fleet quiescence — the dominant mechanism.** `execute()` returns
   `preempted` whenever `scanInteractivePressure` (`background-runner.ts:103`) finds *any* session
   in the fleet with a pending/processing trigger chat message lacking a terminal ack. Sampled on
   the live install every 10s for two minutes: **pressure=true in 11 of 12 samples (92%)**, each
   scan costing ~820 ms and opening session DB pairs. Background indexing therefore only starts in
   a fleet-wide quiet moment, and quiet moments get rarer as the fleet grows — the wrong direction.

### Post-change state (2026-08-18T15:11 restart, cap removed, MemoryHigh 12G)

```
memory.events high        0          (was 908,426 — the memory half of the diagnosis holds)
read rate                 0 MB/s     (nothing admitted)
all four workgroups       dirty=true, reconciling=false
watcherDegraded           true again within 60s of boot — ENOSPC on first watch sync
```

Removing the resource caps was necessary but not sufficient. With the caps gone the daemon still
indexes nothing, because admission is blocked 92% of the time and nothing acts on the degraded
watcher.

**Net effect: the whole fleet was served ~30-hour-stale graphs from 2026-08-17 to 2026-08-18.**

### What this means for D-2

- **Not buildable as scoped.** Gating a rebuild on "did anything change" requires a trustworthy
  change signal. The watcher is the signal, it is degraded, and nothing in the daemon reacts to
  that. Fix observation before optimizing the compensating full scan.
- **The IO cap is not benign defense-in-depth.** The plan's non-goals list assumed it stays
  "regardless of what phase 3 concludes". That was wrong: an absolute bandwidth ceiling interacting
  with `MemoryHigh` converted a bounded 40-minute burst into an unbounded stall. `IOWeight=10` was
  already in the unit since 2026-07-29 and is the correct proportional mechanism.
- **Fairness is a separate, real defect.** Serial + non-preemptible + one 7 GB workgroup = global
  starvation, independent of watchers or the IO cap.

### Recommended sequence (operational actions need the user; none taken)

1. Drop the absolute read cap (`IOReadBandwidthMax=`), keep `IOWeight=10`.
2. Raise `MemoryHigh` above the largest index working set (workgroup-A 6.9 GB → 12G / MemoryMax 16G).
   Box has 46 GB with 22 GB available.
3. Restart the daemon to clear the wedged reconcile; confirm workgroup-A completes and the other
   workgroups drain.
4. Then, as its own planned change: act on `watcherDegraded` (raise `fs.inotify.max_user_watches`,
   and/or reduce graphify's 414k watch footprint), and give the background runner per-workgroup
   fairness so one large index cannot monopolize it.
5. Only after 4 is a change-gate on the 6h rebuild worth designing.


### Outcome after the approved operational batch (2026-08-18)

Applied, in order: cleared `IOReadBandwidthMax` (keeping `IOWeight=10`), raised `MemoryHigh` 4G→12G
and `MemoryMax` 6G→16G, restarted; then raised `fs.inotify.max_user_watches` 1,048,576 → 2,097,152
(persisted at `/etc/sysctl.d/60-inotify.conf`) and restarted again so watchers re-register — the
watcher thread skips roots already in its map, so a raised limit is inert without a restart.

```
                          before                    after
inotify watches           1,038,202 / 1,048,576     1,058,168 / 2,097,152   (99% → 50%)
watcherDegraded           true (both large workgroups)       false (all)
memory.events high        908,426                   0
io.max                    8 MB/s absolute           none (IOWeight=10 only)
fleet graph staleness     ~31.8 h                   < 2 h
workgroup-A reconcile        37.3 h (2026-08-17→18)    completed 18:06:49Z; new run in progress
workgroup-C reconcile        stalled 31.8 h            0.6 min (19:51:19 → 19:51:53)
workgroup-A indexed sources  254,537                   272,548
```

All four workgroups reconciled between 17:59Z and 19:51Z — the first successful pass since
2026-08-16. Duration attribution inside that window is partly unresolved: the runner is serial, and
`lastStartedAt` is overwritten by the next run, so only workgroup-C's 0.6 min is a directly measured
start→complete pair.

**Not fixed by any of this — the two that need a design change, not a knob:**

1. Admission requires global fleet quiescence (`scanInteractivePressure`, measured 92% blocked).
   Scales inversely with fleet size.
2. The background runner is serial and reconciles are non-preemptible, so one large workgroup can
   still monopolize it once admitted.

D-2 remains **not buildable as scoped**: a change-gate on the 6h rebuild is only worth designing
after 1 and 2, since until then the constraint is admission and fairness, not redundant work.
