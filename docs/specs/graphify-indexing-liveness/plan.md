# Graphify indexing liveness

**Status:** PROPOSED — awaiting user approval
**Revision:** 3. Revision 1 targeted the wrong mechanism. Revision 3 adds a live symptom, found
while the cross-model reviewer was running, that the plan cannot currently explain — and says so
rather than designing against a guess. Both corrections are recorded in `run.md`.
**Feature dir:** `docs/specs/graphify-indexing-liveness/`
**Predecessor:** `docs/specs/bounded-periodic-work/` (phase-3 spike, commit `24e55050`).

## The failure this exists to prevent

Between 2026-08-16T22:29Z and 2026-08-18T17:59Z the Graphify daemon indexed nothing. Every
workgroup was `dirty` and un-reconciled for **31.8 hours** — every agent in the fleet answering from
a day-and-a-half-stale knowledge graph — and nothing detected it. The outage ended on its own.

It was invisible by construction:

- the daemon writes **zero log lines**. `grep -rn 'console\.\|log\.\|logger' src/graphify-daemon/daemon.ts`
  returns one false positive (`catalog.unref()`), and `logs/graphify-daemon.log` has been 0 bytes
  since 2026-07-19 while `StandardOutput=append:` points at it
  (`/etc/systemd/system/nanoclaw-v2-graphify.service:32`);
- nothing on the host reads Graphify's health — `scripts/health-sentinel.sh` has seven vitals, all
  about the host process;
- `watcherDegraded` exists for exactly this case, is documented in place ("keeps serving stale
  reads as fresh", `daemon.ts:563-567`), and is **acted on nowhere**.

## Correction that reframes this plan

Revision 1 led with an admission-starvation fix, on the strength of a real measurement:
`scanInteractivePressure` was true in 11 of 12 samples taken 10s apart. **That measurement is
sound and the conclusion drawn from it was not.**

Pressure does not *hold* the lane. `execute()` (`background-runner.ts:317`) rejects a pressured job
and returns `preempted` immediately; `drain()` resolves it and moves on; `queueReconcile`
(`daemon.ts:1258-1260`) re-queues `preemptRetryMs` — 5 s — later. So a pressured reconcile retries
about 12 times a minute. At the measured ~8% quiet rate it is admitted within roughly a minute, not
hours. Admission cost the fleet seconds, not the 31.8 hours observed.

Probed on the live install to close it out: **0 sessions currently assert pressure**, so the 11/12
reading was ordinary bursty traffic rather than a session stuck pinning the gate true.

The actual chain, in load-bearing order:

1. **inotify exhaustion** (1,038,202 of 1,048,576 watches) made watch registration fail, so
   `pendingFilesystemChanges` stayed empty, so `canReconcileIncrementally` (`daemon.ts:911`) could
   never be true and **every reconcile was a full scan**.
2. **Full scans are slow, serialized, and non-preemptible.** `drain()`
   (`background-runner.ts:269-275`) runs one job at a time and reconciles pass `preemptActive: false`
   (`daemon.ts:1254`). One workgroup's full scan held the single lane for **37.3 hours** while every
   other workgroup waited.
3. **The resource caps inflated that scan.** An 8 MB/s `IOReadBandwidthMax` against `MemoryHigh=4G`
   forced continuous reclaim-and-re-read (`memory.events high=908,426`).

Items 1 and 3 are already fixed operationally (inotify ceiling 2,097,152, usage now 50%; the
absolute IO cap removed, `MemoryHigh` 12G). With healthy watchers a reconcile is incremental and
takes minutes — measured 0.6 min for a 4,448-source workgroup, against 37.3 hours before.

So the remaining question is not "how do we schedule full scans more fairly" but **"why are we
doing this many full scans at all"** — and the answer is that the 6-hourly timer
(`daemon.ts:718-723`) calls `markDirty`, which sets `fullScanRequired = true`
(`daemon.ts:747-753`) for **every** workgroup, four times a day, regardless of whether anything
changed or whether the watchers were watching.

That is the load. Removing unnecessary work beats scheduling it better.

## A live symptom this plan does not yet explain

Sampled 2026-08-18T22:58Z, three hours after the restart that fixed the watchers:

```
workgroup-A       reconciling=TRUE   lastStarted 21:37:09Z  lastCompleted 21:35:04Z   indexed 296,657
main           dirty, idle        lastCompleted 18:05:29Z
workgroup-B   dirty, idle        lastCompleted 17:59:19Z
workgroup-D  dirty, idle        lastCompleted 17:29:46Z
workgroup-E / workgroup-F / workgroup-C   clean, lastCompleted 19:51-19:52Z (boot reconciles)
MemAvailable 22.5 GB · watcherDegraded false everywhere · daemon reading 15 MB/s
```

Since 19:52Z **only `workgroup-A` has run.** It completed a reconcile at 21:35:04 and began another at
21:37:09; three workgroups have been dirty and idle for four to five hours with memory free and no
watcher degradation.

Two mechanisms could produce this and **the daemon emits nothing that distinguishes them**:

1. **Lane occupancy.** `queueReconcile`'s `.then()` (`:1272-1276`) re-queues while `state.dirty`, and
   `dirty` is recomputed after each pass as `dirtyVersion changed || fullScanRequired ||
   pendingFilesystemChanges.size > 0`. A 30 GB workgroup under active write always accumulates
   changes during its own pass, so it re-queues immediately, forever. The lane is serial and
   reconciles are non-preemptible, so everyone else waits.
2. **Admission lottery.** Pressure gates admission; whoever wins a quiet moment then holds the lane
   non-preemptibly for hours. The losers retry every 5 s and never reach `execute()` while the lane
   is busy.

Distinguishing them requires knowing queue depth, which workgroup holds the lane and for how long,
and how long each queued workgroup has waited. **None of that is observable today.** Designing a
fairness mechanism now would be picking a fix for an unmeasured cause — the exact move this whole
line of work exists to stop. So phase 2 is extended to emit precisely the fields that decide it, and
fairness stays a non-goal with a trigger that is now **live rather than hypothetical**.

## Outcome

The fleet can never again be silently stale: the daemon says what it is doing, and the owner is
told within 15 minutes when it stops. And the periodic full-scan load that makes lane
monopolisation possible is cut to a quarter, while the case that actually needs a full scan — a
change signal known to be untrustworthy — triggers one immediately instead of waiting up to 6
hours.

## Scope

1. **An eighth health-sentinel vital.** Requires no daemon change and no restart. Closes the
   detection gap first, because everything else is easier to size once the system reports.
2. **Daemon observability.** A periodic structured status record. It currently emits nothing.
3. **Full-scan cadence.** Make the existing 6-hourly tick conditional: a healthy workgroup is
   full-scanned no more than once a day, a degraded one keeps today's cadence, and a watcher going
   degraded forces a scan immediately.

Phase 1 also corrects a stale comment it sits next to: the script's header claims six vitals
(`health-sentinel.sh:11-17`) while the code has seven — `crashloop` was added without updating it.

## Non-goals

Each carries the trigger that reopens it, so cutting it is a decision rather than an omission.

- **The admission bound (`ignorePressure`) that revision 1 led with.** Demoted on the evidence
  above: it buys seconds. It remains worth ~10 lines as insurance against one reachable tail case —
  a session whose container died leaves a non-terminal `processing_ack`, and
  `sessionHasInteractivePressure` (`background-runner.ts:63-99`) would then read pressure as
  permanently true, reproducing "nothing ever indexes" with no diagnostic. **State the basis
  honestly:** the demotion rests on a point probe (0 sessions asserting pressure at one instant) of
  a signal that is volatile by the hour — a re-probe during review returned `true` again. Both that
  reading and revision 1's 11-of-12 are single samples of the same bursty signal, so this is a bet
  on phase 2's telemetry, not on an observed absence of the condition. *Trigger: phase 2's record
  showing `pressurePreempted` climbing while `queueDepth` stays empty — the shape that means
  admission, not occupancy, is the blocker.*
- **Round-robin fairness across the serial lane.** Still cut, but the honest reason has changed:
  not "unlikely" — **its trigger is already firing** (see the live symptom above; one workgroup has
  held the lane since 19:52Z while three wait). It stays cut because the cause is not yet
  distinguishable from admission behaviour, and phase 2 is specifically extended to distinguish
  them. Designing the fix first would be guessing. *Trigger to build: phase 2's record showing lane
  occupancy — a non-zero `queueDepth` alongside a single `laneHolder` persisting past 30 minutes —
  rather than repeated `pressurePreempted` with an empty queue.*
- **Making reconciles preemptible.** Deliberately non-preemptible, with the reason at
  `daemon.ts:1250-1253`: "the deterministic atomic baseline must finish or a busy workgroup can
  discard hours of progress forever."
- **Removing the periodic full scan entirely.** It is the only backstop for changes the watcher
  missed, and an incremental pass cannot substitute — incremental work processes
  `pendingFilesystemChanges`, which is empty precisely when the watcher missed something. Cadence is
  the honest knob; correctness is not.
- **Bypassing the memory deferral** (`background-runner.ts:306`). It prevents OOM on a box shared
  with agent containers.
- **Reducing Graphify's watch footprint** (414,173 watches). *Trigger: usage above 80% of the
  ceiling.*

## Requirements

- **R1** — The health sentinel alerts the owner when the daemon has work it is not doing, when a
  watcher is degraded, or when the daemon cannot be reached — reusing the existing per-vital 6h
  cooldown. **Bare lag is not the predicate.** `lagMs` (`daemon.ts:1074-1076`) is time since
  `lastCompletedAt`, which for a quiet workgroup only advances when a scan runs, so it saw-tooths
  with the scan cadence regardless of health. Verified live at 2026-08-18T22:51Z: all seven
  reachable workgroups sat at 2.98-5.36 h lag with `watcherDegraded` false — a bare 2 h threshold
  would have DM'd the owner about a fleet with a real but different problem, and after phase 3 an
  idle workgroup would breach roughly 22 h a day. The predicate is:

  ```
  breach if   unreachable
           or any watcherDegraded
           or (any dirty && nothing reconciling && max lag > GRAPH_LAG_MAX_MS)
           or max lag > GRAPH_LAG_CEILING_MS          # catastrophic backstop, default 26h
  ```

  The third clause is the 31.8-hour outage's exact signature: work pending, nothing running. The
  fourth catches the case where something reconciles forever and never completes.
- **R2** — A failure to reach the daemon is itself reported, and can never abort the sentinel and
  take the other seven vitals down with it.
- **R3** — The daemon emits a status record every `STATUS_LOG_MS` carrying enough to decide the
  open question above: per workgroup, its lag, dirty/reconciling state, watcher health, how long the
  current reconcile has run, and how long it has been queued without running; plus daemon-level
  queue depth, which workgroup holds the lane, and runner counters for admitted /
  pressure-preempted / memory-deferred. A daemon-level heartbeat record is emitted even when there
  are zero workgroups, so "the log is empty" can never again be ambiguous between healthy and dead.
- **R4** — A workgroup with a healthy watcher is periodically full-scanned no more often than
  `FULL_SCAN_MS` (24h), rather than every 6 hours.
- **R5** — A watcher transitioning to degraded forces a full scan for that workgroup immediately,
  rather than waiting for the next periodic one.
- **R6** — R4 cannot reduce coverage. A workgroup whose watcher is degraded keeps today's 6-hourly
  cadence exactly, and only a completed **full** scan may defer the next one.

## Acceptance criteria

These are the exact cases `/team-build` materializes **before** implementing.

### `scripts/health-sentinel.sh` (phase 1)

No bash test framework exists in this repo; the script's own convention is a documented manual run
(`TEST_ALERT=1 bash scripts/health-sentinel.sh`, `health-sentinel.sh:22`). Commands and observed
output are recorded in `run.md`.

| # | Check | Expected |
|---|---|---|
| S1 | `GRAPH_LAG_MAX_MS=1 GRAPH_FORCE_DIRTY=1 bash scripts/health-sentinel.sh` | breach detected, one DM sent. The second knob is required because the R1 predicate is gated on pending work — a lag threshold alone is no longer deterministic |
| S2 | immediate re-run of S1 | silent — the 6h per-vital cooldown holds |
| S3 | `bash scripts/health-sentinel.sh` on a fleet that is stale-but-working (something reconciling) | silent, exit 0 — this is the case a bare-lag predicate got wrong |
| S4 | daemon stopped (`sudo systemctl stop nanoclaw-v2-graphify`) | vital reports "daemon unreachable" as a breach and the script still exits 0 with the other seven vitals evaluated |
| S5 | socket present but returning malformed JSON | same as S4 — degraded, not aborted |
| S6 | an orphan index directory (`data/graphify/workgroups/<orphan>/`, no such workgroup) | `unknown workgroup` reply is skipped, **not** reported — the healthy-fleet run stays silent with four orphans present |
| S7 | a workgroup whose reply is **empty** (connection closed, zero bytes) | treated as unreachable-for-that-workgroup, not a crash. Live-verified to occur: `workgroup-A` returned zero bytes during review while its index was under load |
| S8 | socket that accepts and never replies | the python client's timeout fires and the script completes; a hung sentinel would otherwise re-fire from the timer every 15 min and pile up |
| S9 | breach path runs with the vital enabled | offsets are still persisted — the `graph` vital must not be able to exit non-zero before the dedup/persist block (`health-sentinel.sh:126`), because skipping the persist double-counts the next log window and produces secondary false breaches on `stalls` and `recovery` |

S4 and S5 are the ones that matter. A vital that dies when the thing it watches breaks is worse
than no vital, because it silently disables the other seven.

### `src/graphify-daemon/daemon.test.ts` (phases 2 and 3)

| # | Test name | Assertion |
|---|---|---|
| D1 | `logs one status record per workgroup with lag, state and watcher health` | injected sink receives a record per workgroup carrying `workgroupId, dirty, reconciling, lagMs, watcherDegraded, reconcilingForMs` |
| D2 | `logs a warning record when a watcher is degraded` | `watcherDegraded` true → a record with `level:'warn'` naming that workgroup |
| D3 | `logs a warning record when a workgroup exceeds the lag threshold` | `lastCompletedAt` older than `STATUS_WARN_LAG_MS` → `level:'warn'` |
| D4 | `logs runner counters` | after one admission, one pressure preemption and one memory deferral, the record carries all three counts |
| D5 | `skips a healthy workgroup on a tick inside the daily floor` | `watcherDegraded` false, `lastFullScanAt` 6h ago; advance 6h → no reconcile queued, `dirty` unchanged |
| D6 | `full-scans a healthy workgroup once the daily floor elapses` | same, `lastFullScanAt` 24h ago → `markDirty` applied and a reconcile queued |
| D7 | `a degraded watcher forces a full scan immediately` | watcher error callback fires → `fullScanRequired` true with no timer advance |
| D8 | `a degraded workgroup still full-scans every tick` | `watcherDegraded` true, `lastFullScanAt` 1h ago; advance 6h → reconcile queued anyway (R6) |
| D9 | `stamps lastFullScanAt only when a full scan completes` | an incremental reconcile completes → `lastFullScanAt` unchanged; an archive-only reconcile completes → unchanged; a full scan completes → stamped |
| D10 | `does not stamp lastFullScanAt for a full scan that failed or was preempted` | `result.status` of `failed` and of `preempted` after the full-scan branch ran → `lastFullScanAt` unchanged, so the backstop is not deferred by work that did not finish |
| D11 | `stamps lastFullScanAt on the isolated reconcile path too` | constructed with `isolateReconcile: true` → a completed full scan stamps. **This is the criterion the rest of the suite cannot reach:** `isolateReconcile` defaults to `!import.meta.url.endsWith('.ts')` (`daemon.ts:550`), so it is `false` under vitest and `true` in built `dist/`, and `daemon.test.ts` sets it zero times. Without D11 a stamp placed on the in-process path alone would pass every other test and never fire in production |
| D12 | `a watcher error sets watcherDegraded on both watcher paths` | the in-process handler (`daemon.ts:1219-1221`) today sets only `lastFailure`; the sticky flag is set only in the isolated branch (`:567`). Both paths must route through one handler, or R5 is inert in exactly the configuration the tests run |
| D13 | `emits a heartbeat record with zero workgroups` | a daemon whose catalog is empty still emits one record per tick, so an empty log is never ambiguous between healthy and dead |

D8 and D9 are the ones that bite. Widen the interval without the `watcherDegraded` clause and D8
fails; stamp `lastFullScanAt` on any completion rather than on a full scan and D9 fails — which
would let a stream of incremental reconciles push the backstop out indefinitely, the exact hole
this phase must not open.

### `src/graphify-daemon/background-runner.test.ts` (phase 2)

| # | Test name | Assertion |
|---|---|---|
| B1 | `counts admissions, pressure preemptions and memory deferrals` | after one of each, `runner.counters()` returns `{admitted:1, pressurePreempted:1, memoryDeferred:1}` |

## Current architecture (with evidence)

- `start()` installs three timers (`daemon.ts:710-741`): archive poll (10 s), **full reconcile**
  (`fullReconcileMs`, default `DEFAULT_FULL_RECONCILE_MS = 6h`, `:57`), and catalog refresh. The
  full-reconcile tick calls `markDirty(id)` then `queueReconcile(id)` for every workgroup.
- `markDirty` (`:747-753`) sets `dirty`, `fullScanRequired`, and bumps both versions. Setting
  `fullScanRequired` is what makes `canReconcileIncrementally` (`:911`) false, forcing the expensive
  path. **Marking dirty and requiring a full scan are one operation today**; separating them is the
  whole of phase 3.
- `markFilesystemChanges` (`:754-766`) already models the distinction correctly — it calls
  `markDirty` only on `fullScan`, an empty change list, or an overflow past
  `MAX_INCREMENTAL_FILESYSTEM_CHANGES`; otherwise it sets `dirty` alone. Phase 3 gives the timer the
  same discipline.
- The watcher error path (`:563-570`) sets the sticky `watcherDegraded` and nothing else — the
  natural place for R5.
- `status()` (`:1060-1086`) already exposes `lagMs`, `watcherDegraded`, `reconciling`,
  `lastCompletedAt` and `lastFailure` over the control socket. **Phase 1 needs no daemon change**;
  the data is already there and simply unread.
- `scripts/health-sentinel.sh` runs every 15 min from `nanoclaw-health-sentinel.timer` (confirmed
  active), is silent when healthy, DMs the owner over `data/cli.sock` on breach, and dedups per
  vital with a 6h cooldown (`ALERT_COOLDOWN_S`, `:42`).
- `WorkgroupGraphDaemonOptions` (`:180-220`) has no clock but is already heavily injectable
  (`fullReconcileMs`, `preemptRetryMs`, `catalogRefreshMs`, `reconcileStoreFactory`, …), so a
  `now?: () => number` seam matches the established style.

## Design

### Phase 1 — the eighth vital (no daemon change)

`scripts/health-sentinel.sh` gains `graph`, in the file's existing per-vital shape: threshold from
env with a default, breach appended to `BREACHES`, state and cooldown handled by the machinery
already there.

```
GRAPH_LAG_MAX_MS   default 7200000 (2h)
```

Enumerate `data/graphify/workgroups/*/` for workgroup ids — no central-DB dependency — and ask the
daemon over `data/graphify/graphify.sock` for each one's `status`. Breach when any workgroup's
`freshness.lagMs` exceeds the threshold, any `freshness.watcherDegraded` is true, or the daemon
cannot be reached.

**Orphan index directories must not become a permanent false alarm.** The directory listing is not
the workgroup list: on the live install there are **11** directories against **7** workgroups in
`data/v2.db` — four (four ids with no live workgroup) are residue from deleted
workgroups, and the daemon answers each with

```json
{"id":"1","ok":false,"error":"unknown workgroup: <orphan>"}
```

A vital that treated any non-`ok` reply as a breach would therefore DM the owner every 15 minutes,
forever, which is worse than having no vital at all — it trains the owner to ignore the channel that
the rest of this plan depends on. So the two failure shapes are distinguished: `ok:false` carrying
`unknown workgroup` is a **skip** (stale directory), while a connect failure, a timeout, or
unparseable output is a **breach**. That is S6.

Using the directory listing at all is a deliberate trade: the control socket has no "list
workgroups" command (`control-server.ts` `COMMANDS`), and reaching into `data/v2.db` would add a
dependency to a script whose job is to still work when things are broken. Skipping unknown ids
costs one comparison and keeps the script self-contained.

**Speak to the socket with `python3`, not `nc`.** The script already shells to `python3` for its
state file (`:51,126`) and needs no other new binary; `nc` is not guaranteed present, and a script
whose job is to work when things are broken should not acquire a new dependency to do it. The query
is wrapped so a missing socket, timeout, or malformed JSON yields "unreachable" rather than a
non-zero exit under `set -euo pipefail` (S4, S5).

### Phase 2 — the daemon says something

A `logSink?: (record: object) => void` option defaulting to
`(record) => process.stdout.write(JSON.stringify(record) + '\n')`, and a
`STATUS_LOG_MS = 5 * 60_000` interval (`unref`'d, alongside the existing timers) emitting per
workgroup:

```
per workgroup : { level, at, workgroupId, dirty, reconciling, reconcilingForMs, queuedForMs,
                  lagMs, watcherDegraded }
per daemon    : { level, at, workgroups, queueDepth, laneHolder, laneHeldForMs,
                  admitted, pressurePreempted, memoryDeferred }
```

`queueDepth`, `laneHolder`, `laneHeldForMs` and `queuedForMs` are the four fields that decide the
open question: a single `laneHolder` persisting with a non-empty `queueDepth` means occupancy;
`pressurePreempted` climbing with `queueDepth` empty means admission. The daemon record is emitted
even when `workgroups` is 0, so an empty log is never ambiguous between healthy and dead.

`level` is `warn` when `watcherDegraded` is true or `lagMs > STATUS_WARN_LAG_MS` (2h), else `info`.
stdout is already wired to `logs/graphify-daemon.log`; no unit change is needed.

`reconcilingForMs` is the field that would have named the 37.3-hour job on its first hour, and it is
what the deferred fairness trigger reads.

The runner gains three counters and a `counters()` getter (B1). Nothing about admission behaviour
changes in this phase.

Volume: ~10 workgroups every 5 minutes at ~200 bytes ≈ 1.7 MB/year.

### Phase 3 — stop doing four full scans a day

**A rejected design, recorded because it is the obvious one and it does nothing.** The tempting
split is two timers — a 6h tick that only sets `dirty`, and a 24h tick that sets `fullScanRequired`.
It reduces zero work. `canReconcileIncrementally` (`:911`) requires `pendingFilesystemChanges.size > 0`,
and the timer path has no pending changes by definition, so `queueReconcile`'s
`if (canReconcileIncrementally) … else await this.reconcile(…)` (`:1244-1245`) falls straight
through to a full scan whether `fullScanRequired` was set or not. Dropping the flag changes the
bookkeeping and not the behaviour.

**What actually reduces the load** is ticking less often — and doing so only where the change
signal is trustworthy. Keep the single 6h timer and make its per-workgroup body conditional:

```ts
export const DEFAULT_FULL_RECONCILE_MS = 6 * 60 * 60_000;   // unchanged: the tick
export const DEFAULT_FULL_SCAN_MS      = 24 * 60 * 60_000;  // new: per-workgroup floor
```

```ts
for (const [id, state] of this.states) {
  if (!state.watcherDegraded && this.now() - (state.lastFullScanAt ?? 0) < FULL_SCAN_MS) continue;
  this.markDirty(id);
  this.queueReconcile(id);
}
```

**Where `lastFullScanAt` is stamped is the whole correctness question**, and the obvious answers are
all wrong:

- *At every `state.lastCompletedAt` assignment* — there are four (`:1411`, `:1626`, `:1774`,
  `:1830`), and two of them are **not** full scans. `reconcileFilesystemChanges` (incremental) and
  `reconcileArchive` (archive-only) would each push the backstop out by a day, so a workgroup
  receiving a steady trickle of watcher events would never be fully scanned again. That is D9.
- *Inside `reconcileInProcess`* — it is also reached from `buildCandidateOnce` (`:1130`), the
  build-only entrypoint the isolated worker runs with `promote = false`, i.e. inside a different
  process against a different `WorkgroupState`. Wrong layer.

Stamp it in exactly one place: `queueReconcile`'s existing `.then()` (`:1256`), where
`backgroundQueued` is already reset, guarded by which branch the operation actually took —

```ts
let ranFullScan = false;
const operation = (async () => {
  …
  if (state.dirty) {
    if (this.canReconcileIncrementally(state)) await this.reconcileFilesystemChanges(state, sig);
    else { ranFullScan = true; await this.reconcile(state, sig); }
  } else if (state.archiveDirty) await this.reconcileArchive(state, sig);
})();
```

```ts
if (result.status === 'completed' && ranFullScan) state.lastFullScanAt = this.now();
```

One site, set from the same branch that decides the work, and only on a completed run — so a
failed, preempted, or aborted full scan does not defer the next one.

- A **healthy** workgroup full-scans once a day instead of four times: the watcher is delivering
  changes, and every one of them already drives an incremental reconcile through
  `markFilesystemChanges`. The daily pass stays as the backstop for a silently missed event.
- A **degraded** workgroup keeps today's 6-hourly cadence exactly (R6) — the guard's first clause
  short-circuits — because that is precisely the case where the change signal cannot be trusted.
- **R5:** the watcher error path (`:567`), which today sets the sticky flag and nothing else, also
  calls `markDirty` on the transition into degraded. A workgroup whose signal goes bad gets a full
  scan *at that moment* rather than up to six hours later.

Net: full-scan load on a healthy fleet drops 4×, coverage for an unhealthy workgroup strictly
improves, and the two cases are distinguished by the flag the daemon already maintains.

## Safety, rollback, observability

- Each phase reverts independently. Phase 1 touches one script and no daemon. Phase 2 is additive
  logging. Phase 3 is the only behaviour change to indexing, and reverting restores the 6h cadence.
- **Phase 3 is the risk-bearing change.** Its failure mode is a missed change persisting up to 24h
  instead of up to 6h — bounded staleness, not loss, and only in the window where the watcher
  silently misses an event *without* raising an error. `chokidar` surfaces errors (which R5 now
  acts on); the uncovered case is a genuinely silent miss, for which 24h remains a backstop.
- **`dist/` is a live deploy surface** — a crash restart ships whatever was last built. Nothing is
  compiled until the build is complete, tests pass, and the change is committed. Deployment and the
  daemon restart are the user's call.
- The ordering is deliberate: detection ships before the behaviour change, so if phase 3 misjudges
  the cadence, phase 1 tells the owner within 15 minutes.

## Implementation path

| Order | Work | Files owned | Depends on |
|---|---|---|---|
| 1 | Materialize S1-S5, run them, observe failures | `scripts/health-sentinel.sh` | — |
| 2 | `graph` vital | `scripts/health-sentinel.sh` | 1 |
| 3 | Materialize D1-D4, B1; observe failures | `daemon.test.ts`, `background-runner.test.ts` | — |
| 4 | Counters + `counters()` | `background-runner.ts` | 3 |
| 5 | Log sink + status timer | `daemon.ts` | 4 |
| 6 | Materialize D5-D8; observe failures | `daemon.test.ts` | 5 |
| 7 | Cadence split + degrade-triggered full scan | `daemon.ts` | 6 |

One builder throughout; the write sets overlap and the total is small.

## Verification

```bash
node_modules/.bin/vitest run src/graphify-daemon/daemon.test.ts src/graphify-daemon/background-runner.test.ts
node_modules/.bin/tsc --noEmit -p tsconfig.json
node_modules/.bin/vitest run                          # full host suite
GRAPH_LAG_MAX_MS=1 bash scripts/health-sentinel.sh    # S1
bash scripts/health-sentinel.sh                       # S2, S3
sudo systemctl stop nanoclaw-v2-graphify && bash scripts/health-sentinel.sh   # S4
```

Post-deploy, on the live install:

```bash
tail -f logs/graphify-daemon.log   # 0 bytes since 2026-07-19; must now move
```

## Risks and unresolved decisions

- **R-1 — a silently missed watcher event now persists up to 24h.** Bounded staleness, in a window
  that requires the watcher to miss an event without erroring. Accepted; phase 1 makes the
  consequence visible.
- **R-2 — `FULL_SCAN_MS = 24h` and `GRAPH_LAG_MAX_MS = 2h` are judgements, not measurements.** Both
  are knobs, and phase 2 reports what actually happens so they can be retuned on evidence rather
  than on argument.
- **R-3 — the pressure scan remains population-proportional** (~820 ms, opening session DBs). Same
  pattern the predecessor plan named, in a third place. Out of scope here.
- **R-4 — memory starvation is still unbounded** by design. Phase 1 and 2 make it visible within 15
  minutes instead of invisible forever.
- **R-5 — `lastFullScanAt` must not be seeded at startup.** `start()` restores `lastCompletedAt`
  from disk (`:694-696`), but that value is stamped by incremental reconciles too, so seeding
  `lastFullScanAt` from it would reopen the D9 hole across every restart. In-memory only is
  fail-open: undefined → `?? 0` → the tick fires → the boot reconcile stamps it within minutes.
- **R-6 — `watcherDegraded` is sticky and never cleared** (`:567`), so R6's "keeps today's cadence"
  means "until the daemon restarts", even after watchers resync successfully. Conservative, and
  stated here so it is not later read as a bug.
- **R-7 — `lastFullScanAt` is epoch milliseconds**, unlike its ISO-string neighbours
  `lastStartedAt` / `lastCompletedAt`. Storing an ISO string would make the comparison `NaN`, which
  fails *open* — every tick fires, phase 3 silently does nothing, with the same signature as a
  misplaced stamp.
- **D-1 (user)** — is 2h the right staleness threshold for a DM? Lower means earlier warning and
  more noise. Note the predicate is now gated on pending work, so the threshold no longer fires on
  ordinary idleness.
- **D-2 (user)** — phase 3 changes indexing behaviour on a live fleet. It can be deferred and the
  plan still delivers its main value (never invisible again) through phases 1 and 2 alone.
