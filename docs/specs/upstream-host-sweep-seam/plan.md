# Plan: Upstream host-lifecycle seam and host-sweep duty registry (convergence seam 2 of 9)

Status: APPROVED by the operator 2026-09-03 07:30 ET (revision 2.2 — gating only, on top of revision 2's Codex correction batch; see run.md). Build owner: session update-nanoclaw-3. S2-PR0/PR1 unblocked from main; PR2+ wait for the mailbox stack's final heads.
Primary runtime: Claude (orchestrator: Fable 5.1; builders: worker tiers per PR)
Program: upstream convergence, seam 2 (`groups/_ops/upstream-rebaseline-2026-09/`, memory `project_upstream_convergence_program`)
Upstream target: `nanocoai/nanoclaw` `5c3082a1` (2.3.0, 2026-09-01). `src/host-lifecycle.ts` is byte-identical at `5c3082a1` and at `upstream/main` `0d9328d2` (sha256 `fbf37333…`, verified 2026-09-03), so the port does not age before the next sync.
Fork base: `origin/feat/mailbox-seam-pr5-sweep-family` = `756f5d02` — a stack of mailbox PRs 1, 2 and 5, 28 commits off merge-base `167c96e6`. Every fork line number below is relative to that branch.
Predecessor: seam 1, `docs/specs/upstream-mailbox-seam/plan.md` — §6, §8 and §10 conventions are reused verbatim.
Executable acceptance criteria: **required** — behavior-preserving restructuring of the host's only periodic control path; every PR carries the named cases in §8 (70 total).

## 1. Outcome

After this series `src/host-sweep.ts` is a tick driver, a duty registry and an ordered phase list. Every duty it runs today lives in a `src/modules/sweep-<family>/` module that registers itself; every timer the host owns is started by its own module through upstream's `onHostStart` and stopped through `onHostShutdown`. Upstream's `src/host-lifecycle.ts` is byte-identical to `5c3082a1` and a manifest test fails if anyone patches it.

What the operator sees: nothing. No cadence change, no schema change, no migration. What changes for the program: the 2,438-line both-touched core file that is the fork's largest remaining merge-conflict surface becomes under 300 lines of driver plus module registrations, and the ledger's `onHostStart` row (215 features / 37,074 lines across G26, G28, G30, G32, G45, G48, G57, G13, G39, G23) finally gets the seam it was booked against.

### The perf invariant that constrains the whole design

> **One session list per tick, and one mailbox open per duty-group per window.** Duties are grouped by the window they run in and handed the already-open session; a duty never scans sessions and never opens its own window inside a phase.

This is the first-order design constraint, not a detail. `docs/architecture.md` states the general rule — *"Periodic passes must cost what changed, not what exists"* — and three fork commits paid for it: `c44389c5` measured the sweep at 4.7–5.1 s per tick over 3,188 active sessions, `5ee0739b` found a 10-session batch between yields was one contiguous ~15 s event-loop freeze, and `9c9e7e81` found the delivery sweep opening both SQLite files for 1,657 sessions every 60 s to find the 17 that had changed.

Mailbox PR 5 already raised the per-session cost: `main` opened both files once per swept session and held them through the body; PR 5's worst path opens **up to eight** short sessions (W1, W3, W5, plus the attempt increment, the provider-heal budget read, the provider-heal action, the SLA observe and the SLA post-kill). That is the deliberate price of invariant I-3, bounded by the quiet cache — a quiet session opens zero. The naive reading of "one timer per duty" would give each of 38 duties its own session list and its own open per session, multiplying that against ~3,200 active sessions. §4.4 is how the registry prevents it; R-3 and R-12 are the assertions that keep it prevented.

## 2. Scope and non-goals

In scope, the four steps the program defines for every seam:

1. **Port** upstream's `src/host-lifecycle.ts` and `src/host-lifecycle.test.ts` verbatim, and fire `startHostModules`/`stopHostModules` at upstream's boot positions.
2. **Re-home** the fork's periodic duties: first the six timers `src/main.ts` already owns, then every duty inside the sweep tick, family by family, into modules registering through a fork-local sweep duty registry.
3. **Delete** the inline duty bodies from `host-sweep.ts`, the direct timer calls from `main.ts`, and the G64 dead shims.
4. **Drift test**: a sha256 manifest over the ported upstream files, plus registry tests that fail when a duty regresses to an inline body or a timer regresses to `main.ts`.

### Non-goal D1: upstream's reconcile-session / reconcile-queue is NOT adopted in this series

The obvious "converge harder" move — replace the fork's tick with `createReconcileQueue` over `reconcileSession` — is declined now, on three pieces of evidence:

| Blocker | Evidence |
|---|---|
| Depends on migration 024's `session_claims`, a durable-host table family the program has already declined for this phase | `reconcile-session.ts:34` imports `getSessionClaim`, calls it at `:237`, and feeds it into `incarnationStartMs` (`:238-241`), the heartbeat gate (`:244`) and claim re-basing (`:245-249`). Upstream's own `db/coordination.ts:5-7` says nothing may change behavior on a read from those tables — the seam violates its own rule. Absent the table the gate silently no-ops back to pre-fence behavior. (seam2-upstream.md §5) |
| Depends on the async `DbDriver` | Every `DbDriver` method is async (`db/driver.ts:49-63`); the fork's `getActiveSessions()` is sync (`src/db/sessions.ts:144`) against upstream's async (`upstream/main:src/db/sessions.ts:118`). The async-DB adaptation is its own scheduled seam later in the program order. |
| Exposes no registry for what this seam has to place | `SINGLETON_KEYS` is a closed tuple (`reconcile.ts:30-42`); `ReconcileQueueOptions.singletons` is `Record<SingletonKey, …>` (`reconcile-queue.ts:39`). Adding a duty means editing two upstream core files. Per-session entry is two `MODULE-HOOK:` comment markers around hardcoded dynamic imports (`reconcile-session.ts:179-182`, `:192-200`) that exist only in `src/` — a text-anchor convention, not an engine-consumed seam. A fork module can ENQUEUE freely (`registerReconcileEnqueue`) and can only RUN by patching core. (seam2-upstream.md §2e, §2f) |

The fork's tick stays the scheduler. What this series builds is the registry upstream does not have, shaped so that when `session_claims` and the async driver land, the duties are already declarative and the driver underneath them is replaceable in one PR. §6 names the upstream contribution that would close the gap.

Also out of scope, owed elsewhere:

- **G09's decision logic and G27's two seamless residue items.** ~900 lines read processing claims and heartbeat evidence only a per-session reconcile body sees; the ledger books them CONTRIBUTE with residue 856 and 42. Mailbox PR 5 already moved the *storage* half into `src/modules/mailbox/ops/{continuation,recovery}.ts` (219 + 194 lines) — into a fork module, not onto an upstream seam, so the verdict is unchanged. This series re-homes the rest behind the fork-local registry; it does not pretend the upstream seam exists.
- **Container adoption on restart (G26).** Whether the fork drops `stopAllContainers()` (`src/main.ts:630`) for upstream's `adoptRunningSessions()` is an operator-visible behavior change with its own blast radius. It touches this seam's shutdown half and belongs to the driver seam. Nothing here depends on which way it goes.
- **Memory / curator hooks.** They no longer exist. `dbaecf8a` (2026-08-26) deleted the graph-scent lane, `683d4dfb` (2026-08-29) removed the curator writer; grep on the PR 5 branch returns only cgroup-memory and "in-memory container set" hits. No seam is planned for them.
- **`resolveSession`, central-DB migrations, the `sessions` partial UNIQUE indexes.** Zero migrations, no change to session resolution or lookup semantics, so critic finding B2 stays dormant exactly as it did for seam 1.
- **Cadence changes.** Every internal throttle is preserved: repo-fence scan 5 min, claims reconcile and self-heal 10 min each, storage worker 1 h scan / 6 h docker prune. A duty keeps its internal throttle and runs on the 60 s phase; it never gets both a matching timer interval and a throttle at a different value (seam2-fork.md §9).
- **`src/delivery.ts`.** The 1,657-session change-gate lives there, not in `host-sweep.ts`; the ledger books it separately as G29 (11 features / 269 lines / residue 0) and `delivery.ts` is a mailbox PR 3 file.

## 3. Current architecture (source evidence)

Fork, on the PR 5 branch `756f5d02`:

| File | `main` (`db6d3c6b`) | PR 5 branch | Δ |
|---|---|---|---|
| `src/host-sweep.ts` | 2,578 | **2,438** | −140 |
| `src/host-sweep.test.ts` | 3,028 / 146 cases | **3,116 / 148 cases / 24 describes** | +88 |
| `src/db/session-db.ts` | 1,283 | 79 (façade) | −1,204 |
| `src/modules/mailbox/**` | — | 2,155 new | +2,155 |

Upstream's `src/host-sweep.ts` is 153 lines; PR 5 did not close that gap and was never meant to (`docs/specs/upstream-mailbox-seam/plan.md:33` books seam 2 as an explicit non-goal of the mailbox series).

**What PR 5 changed, and what this seam therefore inherits:**

- The tick body `sweepOnce` (`:875-1102`) is byte-for-byte the same duty list in the same order as `main`; the only change is `sweepUsageRollup` becoming awaited. Every tick-level re-home decision carries over unchanged.
- `sweepSession` (`:1510-1800`) was restructured into **five explicit windows**, and the source states the rule at `:1514-1517`: *"Every duty below runs inside one of these — a short session, opened and closed, never held across a wake or a kill (invariant I-3). Reads never provision (invariant I-4)."*

| Window | Lines | Session state | Contents |
|---|---|---|---|
| W1 plan | `:1533-1631` (99) | one `withExistingNanoclawSession` | ack sync, stale-pending expiry, pre-wake orphan reset, due admission, continuation read, done-proposal mirror, recovery parking, wake eligibility → returns a `WakePlan` |
| W1-catch | `:1632-1663` (32) | — | three-way failure classification (constraint 16) |
| W2 wake / kill | `:1665-1692` (28) | **nothing open** | attempt increment (own session), `wakeContainer`, attempt restore (own session) |
| W3 observe | `:1701-1712` (12) | one short session | `getContainerState`, claim count, latest inbound/outbound timestamps |
| W4 reap / SLA | `:1713-1750` (38) | **nothing open** | dispatch only; provider heal and SLA each open their own sessions around their kills |
| W5 tail | `:1758-1793` (36) | one `withExistingNanoclawSession` | post-kill orphan reset, recurrence, spent-task GC, quiet-cache hint |

Three of those windows hold a session (W1, W3, W5); W2 and W4 hold nothing. W4 is dispatch-only — it decides and delegates, and the duties it dispatches open their own short windows around their kills. So a duty runs in one of **four** places a phase can name (plan, wake, observe, tail) plus the nothing-open dispatch layer that `session:health` occupies.

- A `SessionRunner` type (`:743`) exists precisely so a helper can open and close a session **around** a `killContainer` call rather than hold one across it. Two helpers take it: `sweepProviderHeal` (`:755`) and `enforceRunningContainerSla` (`:2074`). **Any duty that both reads session state and kills is therefore two registrations with the kill between them** — a phase duty that reads and decides, and a kill follow-up that runs in the session opened after the kill returns (§4.3).
- 16 production helpers now take a `NanoclawMailboxSession`, plus six test-only entry points including the new `_sweepSessionForTesting` (`:1803`).
- `parseSqliteUtc` already moved to `src/modules/mailbox/sqlite-utc.ts` (G60 MODULE-ALREADY), re-exported for compatibility.
- `host-sweep.ts` **remains on the raw-access ratchet allowlist** for six `legacy*Handle()` call sites and one permanent raw-path import (§5, gating).

**Duty inventory** (seam2-fork.md §2–3): 23 tick-level rows T1–T23 and 23 per-session rows S1–S22 with S9 split into S9a/S9b. Of those, **38 are movable duties**; the other 8 are machinery or pure helpers — T1 timer chain, T3 active-session load, T4 quiet cache and fan-out, T23 timing telemetry, S1 session frame and error classification, S20 quiet-hint computation, S21 the shared `writeSystemWake` primitive, S22 `parseSqliteUtc`.

**Test surface**: `host-sweep.test.ts` 3,116 lines / 148 cases / 24 describes, plus 19 companion suites. The suite kept every describe from `main` and gained one — `sweepSession on a session with no mailbox` (`:2966`, 2 cases) for the new error classification.

Upstream `5c3082a1`:

- `src/host-lifecycle.ts` (68 lines): `onHostStart`, `onHostShutdown`, the two getters, `startHostModules`, `stopHostModules`. Start callbacks run serially FIFO and a throw is logged then **rethrown**, aborting boot through `main().catch` → `process.exit(1)`. Shutdown callbacks run serially LIFO and a throw is logged and swallowed. `src/host-lifecycle.test.ts` (156 lines) pins all four properties.
- Boot positions (`src/index.ts`): `startHostModules` at `:155`, after DB and migrations (`:74-80`), adoption (`:87`), channel adapters (`:90`) and `setDeliveryAdapter` (`:151`); before the host-instance lease (`:159`), the delivery polls (`:162-163`), `startHostSweep()` (`:167`) and the CLI server (`:171`). `stopHostModules()` is the **first** line of shutdown (`:180`).
- `onHostStart` has **zero production registrants upstream**. The only shipped registrant of either hook is `onHostShutdown` in `src/modules/approvals/index.ts:44-46`. A fork adopting the start half is its first real consumer.
- There is **no** interval, backoff or jitter helper anywhere in upstream `src/`. The model to copy is `src/host-instance.ts:51-55` — `setInterval` + `renewTimer.unref?.()`, with the comment stating a renewal timer must never keep an otherwise-finished process alive — cleared in `stopHostInstanceLease` at `:71-74`.

Fork `main` already runs six duties on hand-rolled timers: started at `main.ts:517`, `:522`, `:526`, `:549`, `:557`, `:565`, stopped at `:608-613`. A seventh, `stopStorageMaintenanceWorker()` at `:602`, has **no matching start** — the worker is fire-and-forget from inside the tick. The fork has no `src/host-lifecycle.ts`, but it does have the modules barrel `src/modules/index.ts`, which already carries upstream's own `import '../mailbox/compose.js'` at `:17`.

## 4. Design

### 4.1 The lifecycle port (PR 0)

`src/host-lifecycle.ts` copied byte-identical via `git show 5c3082a1:<path>`, locked by a sha256 manifest (§4.6). Upstream's `src/host-lifecycle.test.ts` is **unportable on fork topology** (found at build, run.md): two of its eight cases read `src/index.ts` for the boot order (the fork boots in `src/main.ts`; `src/index.ts` is a 15-line crash-guard shim) and one asserts that the approvals module registers `onHostShutdown` (the fork's approvals still shut down through `response-registry`'s `onShutdown`). The fork therefore carries a fork-owned `src/host-lifecycle.test.ts` holding upstream's five registry cases verbatim **and** its two boot-order cases with only the read path swapped from `src/index.ts` to `src/main.ts` (the boot-order invariant is what this seam protects; a path is not a reason to lose it), listed in `UNPORTABLE_UPSTREAM_FILES` with the reason — the same mechanism mailbox PR 7 used for upstream's host `registry.test.ts`. L-3 additionally asserts the order against `main.ts` with a runtime ctx check; the approvals case is deferred to the seam-2 PR that migrates approvals' shutdown hook onto `onHostShutdown` (S2-PR14 at the latest; that PR re-adds the case verbatim). No barrel edit: modules that register a hook import it directly, exactly as upstream's approvals module does. `src/main.ts` gains two calls at upstream's positions — `await startHostModules({ db, signal })` after `setDeliveryAdapter()` (`main.ts:490`) and before `startActiveDeliveryPoll()` (`:508`); `await stopHostModules()` as the first shutdown action, before `stopDeliveryPolls()` (`:598`).

Upstream's file imports `type { DbDriver } from './db/driver.js'`, which the fork does not have; PR 0 adds a fork-owned **type shim** `src/db/driver.ts` (`DbDriver` = the fork's better-sqlite3 handle) so the ported file stays byte-identical and `HostStartContext.db` is the sync handle below. The shim is not an upstream file and is replaced by upstream's real async driver in the async-DB seam (found at build dispatch, run.md).

The fork has no `hostAbortController`. PR 0 adds one, aborted as the first shutdown action to match upstream `index.ts:179`, so `HostStartContext.signal` carries real semantics rather than a stub. `HostStartContext.db` takes the fork's sync handle from `initDb` (`main.ts:187`); the registry awaits callbacks either way, so a sync callback is already legal (`HostStartCallback` returns `void | Promise<void>`).

PR 0 registers nothing and is inert by construction. Acceptance case L-4 asserts that.

### 4.2 Module timers (PR 1)

The six `main.ts` timers move into their owning modules using upstream's own idiom — `setInterval`, `unref()`, cleared in the shutdown hook. Three already use `setInterval` internally (`repo-freshness.ts:126`, `plugin-updater.ts:293`, `worktree-cleanup.ts:1869`); PR 1 moves ownership of the start/stop calls, not the bodies:

```ts
// src/worktree-cleanup.ts, and the five siblings
onHostStart(() => { startWorktreeCleanup(); });          // UNGUARDED — see below
onHostShutdown(() => { try { stopWorktreeCleanup(); } catch (err) { log.error(…); } });
```

**The initial start call is deliberately not wrapped.** Today's seven calls in `main.ts:513-565` are direct and unguarded, so a synchronous startup failure rejects boot; upstream's `startHostModules` has the same semantics, logging then rethrowing so a bad module's start hook is a boot gate. Wrapping them would convert fail-fast into a host that reports healthy while worktree cleanup, repository freshness, plugin updates, commit scanning or the operator digests never started. Preserving the current behavior means the callback body stays bare and a throw still aborts boot.

The guarding the ledger asks for (ledger.md:401, *"wrap every fork timer body in try/catch"*) applies to the **recurring** execution and to shutdown, not to the initial start — a throw inside a 60-minute interval tick must never become an unhandled rejection, which is the 2026-08-06 failure mode in a different costume. So: bare start, guarded interval body, guarded stop. T-2 asserts the boot-abort, not the swallow.

The env gates that live in `main.ts` today (`DAILY_SUMMARY_ENABLED`, `BACKLOG_CANVAS_ENABLED`) move into the callbacks with them; a disabled duty registers and no-ops rather than not registering, so the registry count is stable across configurations.

**Storage-maintenance asymmetry.** PR 1 moves `stopStorageMaintenanceWorker()` out of `main.ts:602` into `src/modules/sweep-storage/index.ts` as `onHostShutdown`, beside the exported `startStorageMaintenanceOnce()` the T13 duty calls. Both halves are then declared in one file instead of two files that are neither of them the owner. The *cadence* asymmetry — the worker owning 1 h / 6 h internally while the tick pokes it every 60 s — is preserved deliberately (§2). The structural half closes when T13 moves in PR 6.

PR 1 touches no session DB, moves no sweep duty, and lands independently of the mailbox stack.

### 4.3 The sweep duty registry (PR 2)

Two registration surfaces inside `src/host-sweep.ts`, because the code has two shapes and pretending it has one would break constraint 12 or constraint 18:

```ts
export type SweepPhase =
  | 'tick:pre-session'     // before the fan-out
  | 'session:plan'         // W1 — inside one plan session
  | 'session:wake'         // W2 — NOTHING open
  | 'session:health'       // W4 — EXCLUSIVE chain; nothing open; duties open their own windows
  | 'session:tail'         // W5 — inside one tail session
  | 'tick:post-session'    // after the fan-out; container state is current
  | 'tick:housekeeping';   // order-free central work

export const SWEEP_PHASES: readonly SweepPhase[] = [ /* the seven above, in that order */ ];

/** 'all' runs every duty in ascending order. 'exclusive' is an if/else-if chain: the first
 *  duty whose predicate holds runs and the rest do NOT — session:health's shape at :1723-1755. */
export type PhaseKind = 'all' | 'exclusive';

export interface SweepDuty {
  name: string;                 // stable id; used by the drift test and the log's `duty` field
  phase: SweepPhase;
  order: number;                // within-phase; a duplicate (phase, order) throws at registration
  /** Required in an exclusive phase, forbidden in an 'all' phase. */
  claims?(ctx: SweepSessionContext): boolean | Promise<boolean>;
  run(ctx: SweepTickContext | SweepSessionContext): void | Promise<void>;
}
export function registerSweepDuty(duty: SweepDuty): void;

/** Runs inside the SLA duty's OWN observe session, before decideStuckAction, so the
 *  decision and the telemetry row see one snapshot (`:2086-2089`). Reached only when the
 *  exclusive chain falls through to the SLA branch — never on heal or reap paths. */
export function registerSlaObservationHook(h: { name: string; order: number;
  run(ctx: SweepSessionContext, state: ContainerState | null, mailbox: NanoclawMailboxSession): void }): void;

/** Runs inside the post-kill session the SLA duty opens after killContainer returns.
 *  The fork-local prefiguration of the `onStuckAction` event upstream lacks (§6). */
export function registerSweepKillFollowUp(f: { name: string; order: number;
  run(ctx: SweepSessionContext, outcome: StuckDecision, mailbox: NanoclawMailboxSession): void | Promise<void> }): void;
```

Three surfaces, one per shape the source actually has. The two hook lists exist because a duty can run inside a window **another duty owns**: the OOM notice runs inside the SLA's observe read, and the follow-ups run inside the session the SLA opens after the kill. Neither can be a phase — the kill respawns through `onExit` and clears status through `delivery.ts`, both of which open a session on the same key, so holding one across the kill throws (constraint 18).

**`session:health` is an exclusive chain, not an ordered list.** The source at `:1723-1755` is a single `if / else if / else if / else`, and the order is **provider heal → idle task reap → idle chat reap → SLA**, with SLA as the `else`. Registering SLA before the reaps would reclassify an idle container past the ceiling from `scheduled-task-idle` to `absolute-ceiling`, and running the branches non-exclusively would let a reaped container also take an SLA pass. The `claims()` predicate is each branch's existing guard — `sweepProviderHeal`'s return value, `shouldReapIdleTaskContainer`, `shouldReapIdleChatContainer` — and the SLA branch has no predicate because it is the fallthrough.

**Phase assignment encodes all 21 load-bearing ordering constraints** from seam2-fork.md §4. This table is the whole reason the registry is ordered rather than a set; every row cites the source comment that asserts it.

| # | Constraint | Source (PR 5 branch) | Encoded as |
|---|---|---|---|
| 1 | Sessions before the singletons that read container state | `:970`, `:987` "runs after per-session sweeps so container state is current" | T6, T8 in `tick:post-session` |
| 2 | Storage maintenance after the session loop | `:1009` | T13 in `tick:post-session`, order 30 |
| 3 | Claims reconcile strictly before claims self-heal | `:1067-1069` "a claim whose pull request has merged must be CLOSED, not escalated at somebody" | T20 order 100, T21 order 110 |
| 4 | T19 and T22 reuse T3's `sessions` array, "no extra DB query" | `:1054`, `:1090` | one `ctx.sessions` per tick; no duty may call `getActiveSessions()` (§4.4) |
| 5 | T6 is the earliest unguarded call, T10 the second; both rely on the outer wrapper | `host-sweep-reschedule.test.ts` mocks T6 for this reason; ledger.md:401 | the registry wraps **every** duty body; an unguarded duty is impossible |
| 6 | The tick's re-arm is outside the try | `:856-865`, the 2026-08-06 silent-total-failure incident | driver keeps the shape; `host-sweep-reschedule.test.ts` carried unchanged |
| 7 | Orphan-claim reset before any due-count or wake decision | `:1550-1553` | S4 order 30, S5 order 40, both `session:plan`; S9b in `session:wake` |
| 8 | Admission immediately before rows become wakeable | `:1559-1564` "a warm poller cannot race ahead of either context pair" | S5 order 40, directly before S6–S9a |
| 9 | Every stopped-session wake passes through continuation admission | `:1613-1616` | S9a order 80 in `session:plan`; S9b reads its `WakePlan` |
| 10 | SLA skipped on the tick that just woke the container | `:1695-1703` (`!justWoke`), and the whole block also requires `alive && plan.hasOutbound` | `session:health` gated on `!ctx.justWoke && ctx.alive && ctx.hasOutbound` by the driver, not per duty |
| 11 | **The health branch is mutually exclusive and ordered heal → idle-task reap → idle-chat reap → SLA**, SLA being the `else`. Provider heal "returns true only when it killed the container, in which case the reap/SLA checks below have nothing left to decide this tick" | `:1723-1755`, one `if / else if / else if / else` | `session:health` declared `exclusive`; first `claims()` wins (F-3.2, F-10.2) |
| 11b | **OOM telemetry is SLA-only.** `reportContainerOomTelemetry` has exactly one call site, inside `enforceRunningContainerSla`'s own observe session, reached only when the chain falls through | `:2088`, sole call site; comment at `:2086-2087` "the decision and the telemetry row see the same snapshot" | S16 registers on `registerSlaObservationHook`, never as a phase duty (F-10.5) |
| 12 | Kill → notify → reset → follow-up, in that exact order; claims and continuation snapshotted **inside the observe session, before the kill** | `:2103-2131` | `registerSweepKillFollowUp`: S15 order 10, S17 order 20, S10 order 30 |
| 13 | Recurrence before the spent-task GC | `:1772-1777` | S18 order 20, S19 order 30, both `session:tail` |
| 14 | `providerFailedTicks.delete()` on `!alive` | `:1754-1756` | the map moves with S11 into `sweep-container-health`; `ctx.alive` is the shared input |
| 15 | The quiet-cache hint is computed last | driver machinery, not a duty | computed after the last phase |
| 16 | **Three-way failure classification** replaces one silent backoff. Vanished mailbox → silent backoff. Present-but-unopenable → `log.error` **and** backoff, because retrying every 60 s *"is what produced ~4k identical errors in the hot-journal incident"*. A duty that threw → **rethrow, never quiet-cached**: *"Quiet-caching it would hold an already-due scheduled task or recovery wake for the full 30-minute backoff, and `last_active` does not move on failure, so nothing would clear it early."* | `:1632-1663`; the `enteredPlanSession` flag distinguishes arm 2 from arm 3 | the registry owns all three arms once, for every duty (§4.5) |
| 17 | The sweep's two error sites carry different meanings and must stay separable | `:947` (per-session catch) and `:1645` (unopenable branch) | distinct log strings — `Host sweep duty failed` and `Host sweep mailbox unopenable` — so every gate stays single-cause (§4.5, §6) |
| 18 | **"No mailbox session may be held across a `killContainer` or a `wakeContainer`" (invariant I-3).** *"The kill respawns through `onExit` and clears status through `delivery.ts`, both of which open a session on the same key."* This is the single hardest constraint for one-timer-per-duty: *"any duty that both reads session state and kills must be **two** windows with the kill between them."* | why `SessionRunner` exists and why `killForProviderHeal` was split out of `applyProviderHeal` at `:674-689` | `session:wake` and `session:health` declared "nothing open"; R-10 asserts depth 0 at all ten real call sites; the two hook surfaces run inside windows the SLA duty owns (R-11) |
| 19 | **"Reads never provision" (invariant I-4).** Every sweep read is `withExistingNanoclawSession`, which resolves `undefined` rather than creating a session directory — the guard against the 2026-09-01 `inbound.db` stub crash loop, where a host open **created** the stub | invariant I-4 | `undefined` is "no mailbox", never an error; no duty may call `withMailboxSession` |
| 20 | A session exists on `inbound.db` alone; outbound reads degrade to empty. There is no `fs.existsSync` pre-check beside the seam: *"two answers to that question drift, and the one that matters is the implementation's own"* | `:1656-1659`; `hasOutbound()` reproduces the old `outDb !== null` guard at S6, S14 entry and S17 retry | `ctx.hasOutbound` is the only guard the context exposes |
| 21 | Usage-rollup mtime cached only after a rollup actually ran — a session whose `inbound.db` vanished while `outbound.db` remains would otherwise be skipped forever and its `turn_usage` never reach central totals | `:1843-1851`, commit `756f5d02` | acceptance case F-12.2 |

**The 38 duties by surface (39 registrations — S17 registers ONE name, `orphan-claim-reset`, on two surfaces: `session:tail` and the kill follow-up list; name uniqueness is per surface, `(phase, order)` uniqueness within the phase registry):**

| Surface | Kind | Duties (order) |
|---|---|---|
| `tick:pre-session` | all | T2 egress re-heal (10) |
| `session:plan` | all | S2 ack sync (10), S3 stale-pending expiry (20), S4 pre-wake orphan reset (30), S5 due admission + host-gated scripts + wake priority (40), S6 done-proposal mirror (50), S7 continuation read (60), S8 recovery parking + parked notice (70), S9a wake eligibility (80) |
| `session:wake` | all | S9b attempt consume / wake / restore (10) |
| `session:health` | **exclusive** | S11 provider self-heal (10), S12 idle task reap (20), S13 idle chat reap (30), S14 running-container SLA (40, fallthrough — no `claims()`) |
| `session:tail` | all | S17 orphan-claim retry (10), S18 recurrence re-arm (20), S19 spent task-session GC (30) |
| `tick:post-session` | all | T6 orchestrator reconciler (10), T8 thread-close advance (20), T18 task watchdog (25), T13 storage maintenance (30), T19 usage rollup (40), T22 repo-fence recovery (50) |
| `tick:housekeeping` | all | T5 approvals reason scan (10), T7 GitHub App token refresh (20), T9 steer prune (30), T10 receipts prune (40), T11 scheduled-move recovery (50), T12 audit-body prune (60), T14 auto-archive (70), T15 session-title sweep (80), T16 thread-title retry (90), T20 claims reconcile (100), T21 claims self-heal (110), T17 dashboard-token prune (120) |
| SLA observation hooks | ordered | S16 OOM and memory-pressure notice (10) |
| kill follow-ups | ordered | S15 kill-ceiling notice (10), S17 post-kill reset (20), S10 ceiling accountability (30) |

W3's shared observe read — `getContainerState`, the claim count, the latest inbound and outbound timestamps (`:1710-1715`) — is **driver machinery, not a duty**. It feeds `ctx.observed`, which is what S12's and S13's `claims()` predicates consult (`:1729-1748`). The SLA branch performs its own second observe read inside its own session (`:2086`), which is where the OOM hook runs; that second read is the SLA duty's, not the driver's.

### 4.4 The shared per-tick context and the open budget

This is where §1's perf invariant is mechanized. **Duties are grouped by window, and the driver hands each group the session that window already has open.** A session phase is exactly a window's duty group: the driver opens W1 once and runs the eight `session:plan` duties inside it, opens W5 once and runs `session:tail` inside it. No duty opens its own window inside a phase, and no duty scans sessions. Duties that must kill are the declared exception (constraint 18) and open their own short windows around the kill, exactly as `sweepProviderHeal` and `enforceRunningContainerSla` already do on the PR 5 branch.

**The traversal is session-major, not phase-major.** The driver is nested, and this is load-bearing: today's loop completes W1 through W5 for one session and yields before starting the next (`:914-944`, `:1515-1804`). A flat pass over the phase list would plan all ~3,200 sessions before waking any of them, leaving admitted task rows and every `WakePlan` stale across thousands of mailbox opens. The tick phases run once; the session phases run once per swept session:

```
tick:pre-session                       (all tick duties, ascending order)
one getActiveSessions() scan           → ctx.sessions
for each session:
    quiet-cache check → skip           (mark valid and last_active unchanged)
    W1  open → session:plan            → ctx.plan
        W1 catch → three-arm classification (§4.5)
    W2  nothing open → session:wake    → ctx.justWoke
    W3  open → driver observe read     → ctx.observed   (only when alive && !justWoke && hasOutbound)
    W4  nothing open → session:health  exclusive chain; the SLA branch owns its own
                                       observe session, its OOM hook and its post-kill session
    W5  open → session:tail            → then the quiet-cache hint
    await setImmediate                 (yield after EVERY session, never every N)
tick:post-session                      (container state is now current)
tick:housekeeping
```

The `setImmediate` yield after every session is not a detail: a swept session costs up to ~1.5 s of synchronous SQLite and filesystem work, so a 10-session batch between yields was one contiguous ~15 s event-loop freeze (`5ee0739b`, comment at `:934-941`). R-2b asserts the nesting directly — session A's full sequence and its yield complete before session B's first phase begins.

The registry has **one** context, built once per tick:

```ts
interface SweepTickContext {
  readonly now: number;
  readonly sessions: readonly Session[];        // the ONE getActiveSessions() call per tick
  readonly activeContainerSessionIds: ReadonlySet<string>;
}
interface SweepSessionContext extends SweepTickContext {
  readonly session: Session;
  readonly mailbox: NanoclawMailboxSession | null;  // the window's handle; null in 'nothing open' phases
  readonly hasOutbound: boolean;                     // constraint 20
  readonly alive: boolean;
  readonly justWoke: boolean;
  readonly plan: WakePlan;                           // built by session:plan, read by session:wake
  readonly observed: ContainerObservation | null;    // the driver's W3 read, consulted by claims()
}
```

There is no `healHandled` flag. Exclusivity is the phase kind, not a mutable field a duty sets — a flag would let a second duty forget to check it, which is exactly the regression the `if/else if` chain cannot have.

Preserved as-is:

- **`quietSessions`** (`:121`) stays in `host-sweep.ts` as fan-out machinery: bounded at `sessions.length + 500`, invalidated by `session.last_active`, hint computed after the last phase. It has a time bound and `last_active` invalidation but deliberately **no mtime change-signal and no stagger** — a re-home keeping only the mtime half loses the invalidation; keeping only the time bound re-creates the burst.
- **`usageRollupMtimeCache`** (`:1816`) moves with T19 into `sweep-usage`. It has the mtime signal and deliberately no time bound, the one sanctioned exception in `docs/architecture.md` because its failure mode is a missed usage rollup, not an undelivered message. Written **only after a real rollup** (constraint 21).
- **`providerFailedTicks`** (`:570`) moves with S11; **`oomKillObserver`** (`:103`) with S16; **`unreadableSessions`** (`:1500`) and **`lastSkippedQuiet`** (`:122`) stay in the driver.
- **The per-session `setImmediate` yield** after every swept session (`:953`, commit `5ee0739b`): a swept session costs up to ~1.5 s of synchronous work, so a 10-session batch between yields was one contiguous ~15 s event-loop freeze. The driver keeps it in the same place.

### 4.5 The error rule

Mailbox PR 5 already ships the two distinct strings, with the classifying flag and the reasoning in comments at `:928-933` and `:1641-1660`. The registry owns the rule so no module re-derives it — but the rule is **per opening boundary**, not one flag for the whole session. `enteredPlanSession` (`:1539`, set at `:1542`, read at `:1650`) lives inside the try/catch around W1 alone; W2's own-session helpers, W3, W5, the SLA observe and the post-kill session are not wrapped, so a failure there reaches `sweepOnce`'s per-session catch. The registry therefore marks each open independently — an entered-callback marker per open, not one per session:

| Boundary | Failure | Log string | Session outcome |
|---|---|---|---|
| any | `SessionDbMissingError` | none | quiet backoff; ordinary steady state |
| **W1 opener** | mailbox present, will not open | `Host sweep mailbox unopenable` (`log.error`) | quiet backoff |
| W1 duty body | threw | `Host sweep duty failed` (`log.error`, `duty` field) | **no quiet mark**; retried next tick |
| W2 / W3 / W5 / SLA observe / post-kill opener | will not open | `Host sweep mailbox unopenable` + a `window` field | **no quiet mark**; retried next tick |
| W2 / W3 / W5 / SLA observe / post-kill duty body | threw | `Host sweep duty failed` + `duty` and `window` fields | **no quiet mark**; retried next tick |

**As built on mailbox PR 5's final head `9078f5cf` (rev-3 grounding, build stage):** only W1 has a classifying try/catch (`:1544-1667`, keyed on `SessionDbMissingError` / `SessionDbUnopenableError` / the entered marker); every later-window failure falls to `sweepOnce`'s generic per-session catch (`:934`, `Host sweep duty failed`, no `window` field, no quiet mark). The rows below for W2–W5, SLA observe and post-kill are therefore what PR 2 **builds** — new log structure with the same outcome (no backoff), not a port of existing classification.

Two things this table settles that revision 1 got wrong:

- **Classification happens at every boundary, not only W1.** Revision 1 claimed one flag covered every duty. It cannot: once W1 succeeds the flag is true, so a later opener failure was indistinguishable from a duty exception. Each open now carries its own marker and the log line names the `window`, so an operator can tell a W5 opener fault from a recurrence duty fault.
- **Only a W1 opener failure backs the session off, and that is deliberate.** A later-window failure does **not** take the 30-minute backoff, matching today's behavior exactly. The reason is that W1 already proved the mailbox openable this tick, so a failure at W3 or W5 is far more likely a reclaim race than a persistent EACCES — and a genuinely persistent fault fails at W1 on the very next tick and takes the backoff there. Extending the backoff to later windows would be a behavior change, and it would risk the opposite defect the corrected PR 5 rule was written to prevent: holding an already-due scheduled task for 30 minutes on a transient condition.

Because `duty` and `window` are structured fields, a family PR's post-deploy check filters to its own duty names rather than counting a shared string.

### 4.6 Drift tests

1. **Upstream manifest** — `src/host-lifecycle-seam/UPSTREAM-MANIFEST.json`: `{ upstream: "5c3082a1", files: { "<path>": "<sha256>" } }` over an explicit `UPSTREAM_FILES` constant (`src/host-lifecycle.ts` only; `src/host-lifecycle.test.ts` is in `UNPORTABLE_UPSTREAM_FILES`, §4.1, and the test asserts the two sets are disjoint). The test asserts the manifest's key set **equals** `UPSTREAM_FILES`, then recomputes and compares every hash. `--update <sha>` regenerates via `git show <sha>:<path>` and is the only sanctioned way to touch those files. A manifest rather than `git show` because CI's clone carries no upstream objects. Same pattern as `src/mailbox-seam-upstream.test.ts` and `src/design-artifact-loop-vendor.test.ts`.
2. **Timer drift** (PR 1) — `src/host-sweep-registry.test.ts` greps `src/main.ts` for the seven start/stop symbols and asserts zero matches.
3. **Duty drift** (PR 2, tightened at PR 14) — the same file asserts 39 registrations across 38 distinct duty names matching the checked-in inventory id set, and after the last family PR that `src/host-sweep.ts` exports nothing outside the driver/registry/phase-list allowlist and is under 300 lines.

### 4.7 What each family PR does

The same four things every time, so review is a template rather than a fresh read:

1. Create `src/modules/sweep-<family>/index.ts` registering its duties at import; add it to `src/modules/index.ts`.
2. Move the duty bodies out of `host-sweep.ts` unchanged.
3. Move that family's slice of `host-sweep.test.ts` beside the module, and **record moved / rewritten / deleted case counts in run.md** — the measurement the ledger's G67 asked for and never got (ledger.md:1085: "if >60% is delete, P2 drops by ~3 agent-weeks"). Seam 1's PR 5 answered it only for the storage slice: 146 → 148 cases, no suite deleted, every invalidated `vi.mock` rewritten. Seam 2 changes control-flow shape, so it is the real test of the hypothesis, and PR 3 is deliberately first and smallest so the ratio is known before the expensive families.
4. Delete the inline body and its `host-sweep.ts` imports.

**Carry explicitly — the `CodexItem` tolerance.** Upstream's incarnation gate supersedes the fork's `spawn-grace-window`, but upstream's `bashTimeoutMs(state)` widens the ceiling only when `state.currentTool === 'Bash'`. The fork's `activeOperationTimeoutMs` (`:2068-2071`) also honours `CodexItem`, and it does not come free with the gate — a Codex session declaring a long tool timeout would be killed by upstream's ceiling. Named acceptance case F-10.4, not a comment.

**One deletion.** G64 books `idle-artifact-prune-shims` (`:2047-2057`) as DELETE — back-compat shims over `storage-manager.ts`, verified not on the DO-NOT-DELETE list. They go with the storage family in PR 6.

**Do not absorb open defects.** Fork issue #259 (the scheduled-task idle reaper killing a task-script container mid-run) is OPEN and owned outside this series; PR 3 moves S12/S13 behavior-preserving and does not fix it. Fork issue #274 (fixed `/tmp/nanoclaw-*` fixture roots colliding across worktrees) is also open and is a live hazard for multi-builder runs — §6.

## 5. PR series

**Base branches (D7).** PR 0 and PR 1 branch from `origin/main` now. PR 2 onward branch from `feat/mailbox-seam-pr5-sweep-family`, rebased onto `main` once mailbox PR 5 lands — PR 5 rewrote `host-sweep.ts` off the raw façade and mailbox PR 4 changes `recurrence`/`host-script` signatures, so a seam-2 branch off `main` would derive `host-sweep.ts`'s shape twice (explicit collision warning, seam2-constraints.md §1).

**Branch from PR 5's post-linearization head, never from a remembered sha.** The mailbox session is re-basing #271 onto PR 3, so the branch's head moves; `5324df6c` in particular is **not** a valid seam-2 base. Resolve the head at branch time (`git rev-parse origin/feat/mailbox-seam-pr5-sweep-family`) and record the sha you actually used in run.md.

**The legacy-handle bridge is what gates the last three family PRs.** `host-sweep.ts` still holds six `legacy*Handle()` call sites, each a callee mailbox PR 5 was not allowed to touch:

| Line | Callee | Owning mailbox PR | Seam-2 PR blocked |
|---|---|---|---|
| `:1226` | `runHostGatedTaskScripts` (`modules/scheduling/host-script.ts`) | PR 4 | S2-PR11 |
| `:1227` | `admitDueTaskContexts` (`session-manager.ts`) | PR 4 | S2-PR11 |
| `:1594` | `syncDoneProposalMirror` (`dashboard/thread-close.ts`) | PR 4 | S2-PR11, S2-PR13 |
| `:1770` | `handleRecurrence` (`modules/scheduling/recurrence.ts`) | PR 4 | S2-PR11 |
| `:1840` | `rollupSessionUsage` (`db/usage.ts`) | PR 6 | S2-PR12 |
| `:2416` | `deferMessageForFreshContextRetry` (`session-manager.ts`) | PR 4 | S2-PR9 |

**These are prerequisites, not seam-2 work.** Converting the six callees off the bridge belongs to the mailbox series; seam 2 waits for them and takes none of them.

The `db/usage.ts` conversion is **done** on mailbox PR 6's branch (verified at `75c24b52`; PR 6 final head `a49b8172`) — on PR 5's head `9078f5cf`, S2-PR2's base, `rollupSessionUsage` still takes a raw handle (`src/db/usage.ts:130`) and the sweep opens outbound through the module's raw opener (`:1855`), a second consumer of the KEEP-PATCH import beside `recoverMoveIntents` (`:1433`); PR 2 registers T19 as-is and S2-PR12 branches from PR 6's head: `rollupSessionUsage` now takes `mailbox: Pick<NanoclawMailboxSession, 'listTurnUsageSince'>` (`src/db/usage.ts:118-124`) instead of a raw handle, reading through the named op in `src/modules/mailbox/ops/reads.ts`. The PR 5 source comment at `:1836-1838` reads as if the bridge had no owner; it does, and the work has landed on that branch.

One sequencing note: three comments on the PR 5 branch (`:1223-1224`, `:1591`, `:1768-1769`) say those callees move in "PR 3" where the mailbox plan says PR 4. The comments are being corrected on #271. Seam 2 sequences against **PR 4** regardless of which text a builder happens to read.

**Mailbox PR 7 is not a seam-2 gate.** PR 7 empties the remaining host allowlist entries, three of which this series' families call — `modules/claims/self-heal.ts` (S2-PR6) and `modules/scheduling/{create,live-count}.ts` (S2-PR11), all still listed at PR 6's head. It changes only their internals: their exported functions take ids, not handles, and *exported signatures unchanged* is pinned as a hard constraint on PR 7, with a builder who must break one required to stop and report. So neither family waits for it.

**One permanent KEEP-PATCH.** `host-sweep.ts:54` imports `openInboundDb as openInboundDbByPath` from `src/modules/mailbox/openers.js` for the scheduled-move recovery, and it can never go through the seam: *"The scheduled-move recovery below walks an INJECTED sessions root, not `DATA_DIR`, so its session DBs are not addressable by a mailbox key."* S2-PR7 carries the import into `src/modules/sweep-scheduled-move/` with that reason restated at the import site, and keeps the file on the ratchet allowlist. It is a deliberate exception with a written cause, not residue to eliminate — the same class as `storage-manager.ts`'s worker-thread reclaim probe, which mailbox PR 5 documented as the sanctioned PR 7 exception. Acceptance case F-7.3 asserts the behavior the exception exists for.

**Gating table:**

| Seam-2 PR | Base | Blocked until | Why |
|---|---|---|---|
| S2-PR0 lifecycle port | `origin/main` | — | inert; no sweep contact |
| S2-PR1 module timers | `origin/main` | — | `main.ts` only; no session DB |
| S2-PR2 registry | mailbox PR 5 branch | mailbox PR 5 **merged** | needs PR 5's five windows |
| S2-PR3 idle reaps | S2-PR2 | S2-PR2 | registry must exist |
| S2-PR4 central housekeeping | S2-PR2 | S2-PR2 | |
| S2-PR5 orchestrator, dormant | S2-PR2 | S2-PR2 | |
| S2-PR6 claims + storage + egress | S2-PR2 | S2-PR2 | `modules/claims/self-heal.ts` is still on the host allowlist at PR 6's head, but mailbox PR 7 changes only its internals — its exported functions take ids, not handles, and "exported signatures unchanged" is pinned as a hard constraint on PR 7 |
| S2-PR7 scheduled-move recovery | S2-PR2 | S2-PR2 | |
| S2-PR8 repo fence + approvals scan | S2-PR2 | S2-PR2 | |
| S2-PR9 per-session core | S2-PR2 | **mailbox PR 4 merged** | S17's `deferMessageForFreshContextRetry` bridge |
| S2-PR10 container health | S2-PR2 | S2-PR2 | fully on the seam already |
| S2-PR11 scheduling + thread-close | S2-PR2 | **mailbox PR 4 merged** | four bridge sites owned by PR 4. `modules/scheduling/{create,live-count}.ts` are converted by PR 7 but keep their exported signatures, so this family does **not** additionally wait for PR 7 |
| S2-PR12 usage rollup | S2-PR2 | **mailbox PR 6 merged** | `db/usage.ts`'s `rollupSessionUsage` bridge is PR 6's scope; seam 2 does not take it |
| S2-PR13 continuation + ceiling (G09) | S2-PR2 | mailbox PR 4 merged | `host-restart-warn.ts` consumes four `host-sweep.ts` exports and is a PR 4 file |
| S2-PR14 final + contribution draft | S2-PR2 | all of the above | |

**Sizing** (agent-weeks; PR 5 branch line counts, seam-1 measured rates — mailbox averaged ~0.4 wk per RE-HOME group, tests ~191 lines per feature):

| PR | Duties | Duty lines | Cases moved | Tier | Weeks |
|---|---|---|---|---|---|
| S2-PR0 lifecycle port | — | 68 + 156 test | 4 new | worker | 0.25 |
| S2-PR1 module timers | — | ~60 moved | 4 new | worker | 0.5 |
| S2-PR2 registry, phases, context | 0 | ~330 new | 13 new | worker-high | 1.75 |
| S2-PR3 idle reaps (G28) | S12, S13 | 79 | 13 | worker | 0.4 |
| S2-PR4 central housekeeping (G30/G13/G26/G57) | T7, T9, T10, T15, T16, T17 | 49 | 11 | worker | 0.6 |
| S2-PR5 orchestrator, dormant (G39) | T6, T14, T18 | 174 | 39 | worker-high | 0.75 |
| S2-PR6 claims + storage + egress (G48/G45/G64) | T2, T13, T20, T21 | 42 | 207 | worker-high | 0.75 |
| S2-PR7 scheduled-move recovery (G30) | T11, T12 | 259 | 11 | worker-high | 0.6 |
| S2-PR8 repo fence + approvals (G08) | T5, T22 | 24 | 9 | worker | 0.4 |
| S2-PR9 per-session core (G27) | S2, S3, S4, S17 | 87 | 7 | worker-high | 0.6 |
| S2-PR10 container health (G23/G27) | S11, S14, S16 | 568 | 50 | worker-high | 1.5 |
| S2-PR11 scheduling + thread-close (G40) | T8, S5, S18, S19 | 233 | 15 | worker-high | 1.0 |
| S2-PR12 usage rollup (G22) | T19 | 69 | 3 | worker | 0.4 |
| S2-PR13 continuation + ceiling (G09) | S6, S7, S8, S9a, S9b, S10, S15 | 794 | 42 | worker-high | 2.0 |
| S2-PR14 final + contribution draft | — | residue only | 2 new | worker | 0.4 |
| | **38** | | | | **11.9** |

×1.3 for review rounds and deploy windows ≈ **15.5 agent-weeks**. With 3 builders the calendar bound is the deploy cadence: 15 deploys at one quiet-hour window per night ≈ **5–7 weeks**, floored by when mailbox PR 4 and PR 6 land.

**Stacked-PR CI rule** (unchanged from seam 1): `.github/workflows/ci.yml` runs only for PRs targeting `main`, so a stacked PR gets no CI until GitHub retargets it after the PR below merges. Builders' local targeted checks are the gate until then; merge only after the retargeted run is green.

**Ownership boundaries.** Each family PR may touch: its own `src/modules/sweep-<family>/**`, its slice of `src/host-sweep.test.ts`, the duty's own source files, `src/modules/index.ts` (one import line), and `src/host-sweep.ts` only to delete the moved body and its imports. It may **not** touch: the phase list, `SweepDuty`/`SweepKillFollowUp`, the shared context, the error rule, the quiet cache, another family's module, `src/delivery.ts`, `src/mailbox/**`, or `RATCHET.json` beyond removing a file its own move cleaned.

## 6. Deploy, canary, rollback

Verbatim from seam 1 (`docs/specs/upstream-mailbox-seam/plan.md` §6) — this series changes none of it.

```bash
gh pr merge <n> --merge && git pull --ff-only origin main
pnpm run build && node -p "require('./dist/BUILD_INFO.json').sha" && git rev-parse HEAD   # must match
grep -c registerSweepDuty dist/host-sweep.js                                              # symbol grep, PR >= 2
sudo systemctl restart nanoclaw-v2
```

- **One PR per restart, never paired.** The operator's standing answer: one variable per restart.
- **Quiet rule v2**, re-checked at execution time and never trusted from a stale event: 0 human inbound and 0 interactive wakes in the last 10 minutes, scheduled-task traffic ignored. Every restart is surfaced to the operator for approval first.
- **Post-restart gate**, all required or it is not deployed: `OneCLI preflight ok` present; `grep -c 'OneCLI gateway applied' logs/nanoclaw.log` > 0 within 2 minutes; `docker ps --filter name=nanoclaw-v2-` non-empty; 12 `Channel adapter started`; 0 ERROR; runtime and `NRestarts` stable.
- **QA seat first**, immediately after the gate: `ncl groups restart --id <qa-seat> --message <smoke prompt>`, then a live round trip on the QA seat and one per production workgroup **with actual tools, never curl**.
- **Rollback**: `git revert <merge>` → build → restart, under 10 minutes. **No migrations in this series**, so there is no data to restore and both code versions read the same files.

Seam-specific checks after each PR, each single-cause by construction (constraint 17 — mailbox PR 5 splits the old shared `Host sweep error` string):

```bash
grep -c 'Host sweep duty failed'        logs/nanoclaw.error.log   # a duty threw; 0 expected, and filter by duty name
grep -c 'Host sweep mailbox unopenable' logs/nanoclaw.error.log   # unchanged vs the previous 24 h, never gated together with the above
grep -c 'Nested mailbox session'        logs/nanoclaw.error.log   # still 0 at 24 h (I-3)
grep    'Host sweep tick timing'        logs/nanoclaw.log | tail  # tick duration within the pre-PR envelope
```

Plus the moved family's own log lines at their previous rate — each family PR names them from the inventory's log-line column. Because `Host sweep duty failed` carries the duty `name` as a structured field, a family PR gates on its own duty names rather than on a shared count.

**Multi-builder hazard.** Fork issue #274: 53 host suites build fixtures under a hardcoded `/tmp/nanoclaw-*` root and `fileParallelism: false` is process-local, so two worktrees running the same suite collide and fail as `disk I/O error`, never as assertion failures. Until #274 is fixed, no two seam-2 builders run the same suite concurrently. Standing build-mode bans carry over: no full host suite in parallel with another builder; no container enumeration, stop, or orphan-cleanup paths without `child_process` mocked.

**Upstream contribution (draft only).** PR 14 writes `groups/_ops/upstream-rebaseline-2026-09/contrib/sweep-duty-registry.{patch,PR-BODY.md}` against `5c3082a1`, proposing the three seams that would let the fork's duties run on upstream's reconcile path: `registerReconcileHook`-style duty registration at the existing `MODULE-HOOK:` markers, a `work_continuation` mailbox op, and an `onStuckAction` outcome event exposing `decideStuckAction`'s result — the shape this plan's `registerSweepKillFollowUp` prefigures. That is the ledger's seam #4 of its top five (ledger.md:939, ~900 host-sweep lines). Drafting only; posting is a later decision under the operator's standing approval, like the two seam-1 drafts already parked in that directory.

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | A registered start callback throws and aborts host boot (upstream rethrows) | Every registered body wrapped, no exceptions; L-2 pins the rethrow so the property is understood, T-2 pins that no fork callback can reach it |
| 2 | The tick stops re-arming — the 2026-08-06 silent-total-failure mode | The re-arm stays outside the try; `host-sweep-reschedule.test.ts` carried unchanged and green at every PR |
| 3 | **A duty holds a mailbox session across a kill or wake (constraint 18)** — the hardest constraint in the series | R-10 instruments the nesting guard and asserts mailbox depth 0 at all ten real wake and kill call sites, not merely that the phase context is null; kill follow-ups and the SLA observation hook get their own surfaces so they run inside windows the SLA duty owns; each family PR repeats mailbox PR 5's I-3 audit for its own duties |
| 4 | Perf regression: a moved duty re-scans sessions or opens its own window per duty | One `ctx.sessions` per tick and one open per duty-group; R-3 asserts a single `getActiveSessions` call, R-12 asserts the per-session open budget does not exceed PR 5's |
| 5 | A duty is dropped rather than moved | 39-registration / 38-name assertion against the checked-in inventory ids; a family PR that forgets a duty fails the drift test |
| 6 | An ordering constraint is lost in the move | All 21 encoded as phase, kind and order in §4.3 with source citations; nine have their own acceptance case (R-1, R-2b, R-11, F-3.2, F-6.3, F-9.2, F-10.2, F-11.2, F-13.2) |
| 7 | The three-arm error rule collapses back to two, delaying due work by 30 minutes | R-4, R-5 and R-6 test the arms separately; the rule lives in the driver, not in modules |
| 8 | `CodexItem` tolerance silently lost to upstream's Bash-only gate | Named acceptance case F-10.4 |
| 9 | Test rewrite cost exceeds the estimate (G67's unanswered >60%-delete question) | Measured per family PR and reported in run.md; PR 3 is first and smallest so the ratio is known before the expensive families |
| 10 | spawn_task silently re-enabled by making its watchdog live again | PR 5 ports G39 dormant with the capability grant revoked; F-5.3 asserts no action when the capability is absent |
| 11 | Two builders collide on `/tmp` fixture roots (#274) | One worktree per suite; §6 |
| 12 | Mailbox PR 4 / PR 6 slip and block PR 9/11/12/13 | Those four are last in the order and the other seven family PRs are independent of them, so a slip costs sequence position, not throughput. Seam 2 does not route around a slip by absorbing mailbox scope |

## 8. Acceptance criteria (executable; `/team-build` materializes these, names verbatim)

Host, `vitest`. 70 cases.

**S2-PR0 — lifecycle port (4)**
- **L-1** `src/host-lifecycle-seam.test.ts` › "every ported upstream file matches UPSTREAM-MANIFEST.json" — manifest key set equals `UPSTREAM_FILES`; recompute sha256 for each; assert equality.
- **L-2** `src/host-lifecycle.test.ts` (fork-owned copy of upstream's five `host module lifecycle registry` cases, verbatim — §4.1) › "start callbacks run FIFO and a throw propagates; shutdown callbacks run LIFO and a throw is swallowed" — upstream's assertions, unmodified; the two boot-order cases are kept with only the `src/index.ts` → `src/main.ts` path swapped; the approvals case is deferred.
- **L-3** `src/main.test.ts` › "startHostModules fires after the delivery adapter and before the delivery polls; stopHostModules is the first shutdown action" — source-position assertions inside `main()` and `shutdown()` in `src/main.ts` (the precedent `src/main.memory-startup-order.test.ts` uses; `main()` cannot be driven under test without mocking its ~40 imports) — `startHostModules(` sits between `setDeliveryAdapter(` and `startActiveDeliveryPoll(`, and `hostAbortController.abort()` + `stopHostModules()` precede `stopDeliveryPolls()` — plus a runtime assertion that `startHostModules` hands every callback the same `{db, signal}` context. Deferred, with a re-raise trigger: when any seam PR makes `main()`'s boot sequence executable under test, L-3 upgrades to ordered spies over the real path (Codex PR 0 review, run.md).
- **L-4** same file › "the lifecycle port registers no callbacks" — after importing the modules barrel, both getters return empty at PR 0. **Superseded at PR 1** (the timers register), replaced by T-5 below; the case is removed in PR 1's diff, not weakened in place.

**S2-PR1 — module timers (5)**
- **T-1** `src/host-sweep-registry.test.ts` › "main.ts starts no duty timer directly" — grep `src/main.ts` for the seven start/stop symbols; assert zero matches.
- **T-2** same file › "a timer that fails to start still aborts boot, and a failing interval tick does not" — make `startWorktreeCleanup` throw; assert `startHostModules` **rejects** and the throw propagates (fail-fast preserved, matching today's unguarded `main.ts` calls and upstream's rethrow). Separately, make the recurring interval body throw; assert the process sees no unhandled rejection, the error is logged, and the next tick still fires.
- **T-3** `src/modules/sweep-storage/storage.test.ts` › "storage maintenance start and stop are declared in one module" — `onHostShutdown` stops the worker, `startStorageMaintenanceOnce` is exported from the same module, `main.ts` references neither.
- **T-4** `src/host-sweep-registry.test.ts` › "module intervals are unref'd and cleared on shutdown" — after `startHostModules` then `stopHostModules`, no timer keeps the loop alive and each interval had `unref` called.
- **T-5** `src/main.test.ts` › "after PR 1 the registries hold exactly the six timer starts and seven shutdowns, regardless of env gates" — with a fresh module registry, import the modules barrel and the six timer modules; assert exactly 6 start callbacks and 7 shutdown callbacks (six timers + storage); repeat with `DAILY_SUMMARY_ENABLED=0` and `BACKLOG_CANVAS_ENABLED=0` and assert the same counts (a disabled duty registers and no-ops, §4.2). Replaces L-4 from PR 1 onward.

**S2-PR2 — registry (15)**
- **R-1** `src/host-sweep-registry.test.ts` › "duties run in SWEEP_PHASES order and by order within a phase" — probes across all seven phases (the `SweepPhase` union in §4.3; "eight" was a miscount) with interleaved `order` values; observed sequence equals the declared one.
- **R-2** same file › "a duplicate (phase, order) pair is a registration error, and claims() is required exactly in exclusive phases" — two duties at the same coordinates throws; a `session:health` duty without `claims()` other than the fallthrough throws; an `all`-phase duty carrying `claims()` throws.
- **R-2b** same file › "the driver is session-major: session A completes every phase and yields before session B starts" — two sessions, probes in `session:plan`, `session:wake` and `session:tail`; assert the observed order is A-plan, A-wake, A-tail, yield, B-plan, B-wake, B-tail, and **not** A-plan, B-plan, A-wake…; assert the tick phases ran exactly once each around the loop.
- **R-3** same file › "one getActiveSessions call per tick regardless of duty count" — three duties in three phases; one tick; assert exactly one call and that each duty saw the same `ctx.sessions` reference.
- **R-4** same file › "a duty that throws in any window logs Host sweep duty failed and the session is never quiet-cached" — parameterized over `session:plan`, `session:wake`, the driver observe read, `session:health` and `session:tail`, plus the SLA observe and post-kill hook lists; for each, assert `log.error` with `Host sweep duty failed` carrying the `duty` and `window` fields, **no** quiet mark, and that the session is swept again on the next tick.
- **R-5** same file › "an unopenable mailbox backs the session off at W1 and only at W1" — parameterized over the same window set for **opener** failure: the W1 case asserts `Host sweep mailbox unopenable` and a quiet mark; every later window asserts the same string with its `window` field and **no** quiet mark, matching today's behavior. A companion assertion: no single cause emits both strings, so each gate stays single-cause.
- **R-6** same file › "a vanished mailbox backs off silently at any window" — `SessionDbMissingError` raised at each window in turn; assert a quiet mark at W1, no error log of either string, and that a mid-tick vanish after W1 is retried rather than treated as a fault.
- **R-7** same file › "the registered duty set matches the seam-2 inventory" — 39 registrations across 38 distinct names; the name set equals the checked-in inventory id set.
- **R-8** `src/host-sweep-reschedule.test.ts` › "the tick re-arms after a duty throws" — existing case, carried unchanged, now driven through the registry.
- **R-8b** `src/host-sweep-registry.test.ts` › "a throw from the session scan itself still re-arms the tick" — `getActiveSessions` throws; the timer re-arms; tick-pre duties are not re-run in the same tick. (Added at build: with tick-level duty isolation, R-8's duty-throw path no longer reaches the re-arm guard, so the machinery path needs its own case.)
- **R-4b** same file › "a tick-level duty that throws is logged and the later tick duties still run" — three tick duties, the middle throws; the third runs; the log carries `duty` and `window`. (Constraint 5 made executable at PR 2; F-4.4 re-proves it for T10 at PR 4.)
- **R-9** `src/host-sweep-registry.test.ts` (not `host-sweep.test.ts`: the quiet cache lives in the tick, and a tick driven from that file would reach docker, GitHub and an LLM — hermeticity outranks placement) › "quiet-session cache keeps its time bound and last_active invalidation" — a fully quiet session is skipped until the earlier of its next due row and 30 minutes; a `last_active` change invalidates the mark immediately.
- **R-10** `src/host-sweep-registry.test.ts` › "every real wake and kill runs at mailbox depth zero" — instrument the `AsyncLocalStorage` nesting guard to record open-session depth at the moment of the call, then drive **every** wake and kill branch and assert depth 0 at each: `wakeContainer` in W2 (`:1692`) and the task watchdog's parent wake (`:2005`); `killContainer` for `provider-failed-selfheal` (`:685`) plus its `onExit` wake (`:687`), `provider-failed-selfheal-parked` (`:800`), `killForProviderHeal` (`:818`), `scheduled-task-idle` (`:1735`), `chat-idle-reap` (`:1752`), `absolute-ceiling` (`:2117`), `claim-stuck` (`:2153`). Asserting `ctx.mailbox === null` is explicitly **not** the assertion — a duty could open its own session and kill inside the callback while that still passed.
- **R-11** same file › "kill follow-ups run in order in a session opened only after the kill returns" — three registered follow-ups and a simulated `kill-ceiling` outcome; assert order 10 → 20 → 30, all inside one session, and that the session opened strictly after `killContainer` returned.
- **R-12** same file › "a swept session opens no more windows than the PR 5 baseline" — count `session()` opens on the full path; assert it does not exceed eight, and that a quiet session opens zero.

**S2-PR3 — idle reaps (3)**
- **F-3.1** `src/modules/sweep-idle-reap/idle-reap.test.ts` › "shouldReapIdleTaskContainer and shouldReapIdleChatContainer keep their existing decisions" — the 13 ported cases, assertions unchanged.
- **F-3.2** same file › "the idle reaps win over ceiling enforcement in the exclusive chain" — a container that is BOTH idle by the task-reap predicate AND past the absolute ceiling is killed as `scheduled-task-idle`, not `absolute-ceiling`; the same overlap for the chat reap; and in both cases the SLA branch never runs, so no OOM or SLA telemetry row is written. Assert the declared chain is heal (10) → idle task (20) → idle chat (30) → SLA (40, fallthrough).
- **F-3.3** `src/host-sweep-registry.test.ts` › "the idle-reap bodies are gone from host-sweep.ts" — the two symbols are no longer exported from `src/host-sweep.ts`.

**S2-PR4 — central housekeeping (4)**
- **F-4.1** `src/modules/sweep-central/central.test.ts` › "each prune duty deletes exactly the rows its retention window covers" — steer idempotency, receipts, dashboard tokens: ported assertions.
- **F-4.2** same file › "the GitHub App token refresh acts only inside the refresh margin" — ported.
- **F-4.3** same file › "session-title and thread-title sweeps keep their caps, cooldowns and backoffs" — 3 per tick, 1 h cooldown, 10 new messages, 15 min failure backoff; retry batch cap 1, max 5 attempts, 24 h window.
- **F-4.4** `src/host-sweep-registry.test.ts` › "the receipts prune is registered and therefore guarded" — the duty that had no try/catch of its own now runs through the registry wrapper; a throw does not abort the tick.

**S2-PR5 — orchestrator, dormant (4)**
- **F-5.1** `src/modules/sweep-orchestrator/orchestrator.test.ts` › "the task watchdog transitions and parent notifications are unchanged" — the ported watchdog cases (11 on `9078f5cf`; "31" was a stale count from the sizing table, corrected at build).
- **F-5.2** same file › "auto-archive covers completed tasks older than 24h and never failed tasks" — ported.
- **F-5.3** same file › "the dormant module takes no action when the spawn_task capability is revoked" — with the capability absent, the reconciler and watchdog duties run and change nothing.
- **F-5.4** `src/host-sweep-registry.test.ts` › "reconciler, thread-close and watchdog run in tick:post-session" — the container-state ordering constraint survives.

**S2-PR6 — claims, storage, egress (5)**
- **F-6.1** `src/modules/sweep-claims/claims.test.ts` › "the self-heal nudge ladder keeps its 24h per-claim cooldown and 10-minute scan throttle" — the 92 ported claims cases.
- **F-6.2** `src/modules/sweep-storage/storage.test.ts` › "storage maintenance runs after the session fan-out and keeps the worker's own cadence" — phase and order; the ported storage cases.
- **F-6.3** `src/host-sweep-registry.test.ts` › "claims reconcile is ordered strictly before claims self-heal" — declared order asserted; a probe proves reconcile's deletions are visible to self-heal in the same tick.
- **F-6.4** same file › "egress re-heal runs before the session fan-out" — phase assertion.
- **F-6.5** `src/modules/sweep-storage/storage.test.ts` › "the idle-artifact prune shims are gone and callers use storage-manager directly" — G64 deletion; the two symbols no longer exist and the ported shim cases target `storage-manager.ts`.

**S2-PR7 — scheduled-move recovery (3)**
- **F-7.1** `src/modules/sweep-scheduled-move/scheduled-move.test.ts` › "move-intent recovery restores from snapshot and defers on an unreadable live count" — the 11 ported cases.
- **F-7.2** same file › "audit-body prune nulls the three preview columns at 90 days and keeps the metadata row" — ported.
- **F-7.3** same file › "recovery walks the injected sessions root by path and is exempt from the mailbox seam" — the permanent KEEP-PATCH is asserted, not accidental: a session under an injected root outside `DATA_DIR` is still recovered, and the module stays on the ratchet allowlist with the reason recorded at the import site.

**S2-PR8 — repo fence and approvals scan (3)**
- **F-8.1** `src/modules/sweep-repo-fence/repo-fence.test.ts` › "orphaned fences whose publication is gone are released and their sessions woken after the loop" — the 9 ported cases.
- **F-8.2** same file › "the fence scan keeps its 5-minute internal throttle and reuses the tick's session list" — assert no extra `getActiveSessions` call.
- **F-8.3** same file › "the approvals reason-reject scan finalizes elapsed holds" — ported.

**S2-PR9 — per-session core (4)**
- **F-9.1** `src/modules/sweep-session-core/session-core.test.ts` › "processing_ack sync and stale-pending expiry keep their windows and never expire recurring rows" — ported; 24 h default honoured.
- **F-9.2** same file › "the orphan-claim reset runs before any due-count or wake decision" — a session with an orphan claim and a due row: the claim is cleared and the paired input deferred **before** `countDueMessages` is consulted.
- **F-9.3** same file › "resetStuckProcessingRows keeps the dup-reply guard and the retry backoff" — an already-answered input is marked completed, not retried; failed past 5 tries.
- **F-9.4** same file › "orphan processing_ack rows are deleted so a respawn is not killed on stale evidence" — ported.

**S2-PR10 — container health (6)**
- **F-10.1** `src/modules/sweep-container-health/health.test.ts` › "decideStuckAction keeps all 19 existing decisions" — ported unchanged.
- **F-10.2** same file › "provider self-heal claims the health phase and the later branches do not run" — a heal that kills makes the exclusive chain stop; assert neither idle reap nor the SLA branch ran, and that no SLA observe session was opened.
- **F-10.3** same file › "the two-tick provider debounce is cleared when the container is not alive" — a fresh container does not inherit a dead one's half-finished debounce.
- **F-10.4** same file › "a CodexItem tool declaring a timeout beyond the ceiling widens the ceiling" — the ceiling is `Math.max(ABSOLUTE_CEILING_MS, declared)` (`:189`), so the declared timeout must **exceed** 30 minutes to be discriminating. With `current_tool='CodexItem'` and a declared 45-minute timeout: no kill at a 35-minute heartbeat age, and `kill-ceiling` at a 50-minute age. A control with `current_tool='Bash'` behaves identically, and a control with the `CodexItem` arm removed from `activeOperationTimeoutMs` kills at 35 minutes — the case must fail if `CodexItem` support is deleted.
- **F-10.5** same file › "a CodexItem declared timeout widens the claim tolerance" — tolerance is `Math.max(CLAIM_STUCK_MS, declared)` (`:209`), so with a declared 20-minute timeout a claim aged 5 minutes is **not** `claim-stuck` where the 60-second default would have killed it, and a claim aged 25 minutes is. Asserted independently of the ceiling because the two use different defaults.
- **F-10.6** same file › "OOM and memory-pressure notices are written only on the SLA path, with onWake=0" — with the chain falling through to SLA, the notice is written inside the SLA's own observe session and the live container reads it; with the chain claimed earlier by provider heal or either idle reap, **no** OOM row is written (the regression F-10.2 and F-3.2 would otherwise permit).

**S2-PR11 — scheduling and thread-close (4)**
- **F-11.1** `src/modules/sweep-scheduling/scheduling.test.ts` › "recurrence re-arms the next pending row and clears the predecessor in one transaction" — ported.
- **F-11.2** same file › "recurrence runs before the spent task-session GC" — a just-fired recurring series is not collected in the same tick.
- **F-11.3** same file › "script-failure backoff and auto-pause at 8 consecutive failures are unchanged" — 2→60 minute backoff; the paused notice is written due-immediately with onWake=0.
- **F-11.4** same file › "thread-close advance clears saved work, stops the container and archives, in that order" — ported.

**S2-PR12 — usage rollup (3)**
- **F-12.1** `src/modules/sweep-usage/usage.test.ts` › "shouldSkipUsageRollup keeps its mtime gate" — the 3 ported cases.
- **F-12.2** same file › "the usage mtime cache is written only after a rollup actually ran" — inbound gone while outbound remains → the session resolves undefined, the rollup does not run, the cache is unchanged and the session is retried next tick; a real rollup updates the cache.
- **F-12.3** same file › "the rollup reuses the tick's session list and opens only changed sessions" — no extra `getActiveSessions` call; one open per changed session.

**S2-PR13 — continuation and ceiling accountability (5)**
- **F-13.1** `src/modules/sweep-continuation/continuation.test.ts` › "the durable continuation wake keeps its throttle, cap and attempt restore" — the 12 ported cases; a refused wake restores the consumed attempt.
- **F-13.2** same file › "every stopped-session wake passes through continuation admission even when a scheduled row is due" — a due scheduled row does not let saved work bypass the throttle or cap.
- **F-13.3** same file › "ceiling-kill accountability queues at most WORK_CONTINUATION_RESUME_MAX_ATTEMPTS wakes" — the 17 ported decide/apply cases; cap 2.
- **F-13.4** same file › "the kill sequence is kill, notify, reset, follow-up, with claims snapshotted before the kill" — the snapshot is taken in the observe session; the notice is written after the kill; a follow-up failure does not break the kill path.
- **F-13.5** same file › "the parked-continuation notice is posted once per continuation id and recovery episode" — ported idempotency case.

**S2-PR14 — final (2)**
- **F-14.1** `src/host-sweep-registry.test.ts` › "host-sweep.ts contains no inline duty bodies" — it exports only the driver, registry and phase-list allowlist, and is under 300 lines.
- **F-14.2** same file › "the registered duty set still matches the inventory after every family has moved" — R-7's assertion re-run at the end state.

**Family-case rule (added at build, 2026-09-03, after Codex found it on PR 3, PR 4 and PR 8):** every family PR must, for each moved registration, drive the REGISTERED duty through the registry (obtain it by name, invoke `claims`/`run` with a mocked context) and assert the underlying dependency was reached — a case that calls the body directly proves nothing about the wrapper the PR actually wrote. Exclusive-chain assertions read the registry's actual order and each duty's `claims` presence (S14 = no predicate).

Each PR lists which cases it makes pass. No case may be renamed or retargeted to a weaker assertion; if a criterion turns out wrong, `plan.md` is corrected first and the change recorded in `run.md`.

## 9. Open decisions for the operator (plain terms)

- **None that change behavior.** Every duty keeps its cadence, thresholds and log lines. No migration, no schema change, nothing an agent or a channel sees is different. This series is structural.
- **For awareness — deploy count.** Fifteen quiet-hour restarts under the existing one-PR-per-restart rule, over roughly five to seven weeks. If that is more interruptions than wanted, the alternative is bundling the seven independent family PRs into three deploys of two or three, cutting it to eleven restarts at the cost of more than one variable per restart. Recommendation: keep one per restart, same as seam 1.
- **For awareness — one upstream ask is drafted, not posted.** PR 14 writes the duty-registry contribution draft into the record directory. Posting stays a later decision under the standing approval, exactly like the two seam-1 drafts already parked there.

Everything else here is an engineering decision already made and stated (§11).

## 10. Verification commands (per PR, in a scratch worktree, never in the live checkout)

```bash
./node_modules/.bin/prettier --check .
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run src/host-lifecycle.test.ts src/host-lifecycle-seam.test.ts src/main.test.ts   # PR 0 (L-1..L-4)
./node_modules/.bin/vitest run src/host-sweep-registry.test.ts src/host-sweep-reschedule.test.ts
./node_modules/.bin/vitest run src/host-sweep.test.ts src/modules/sweep-<family>/*.test.ts    # per family PR
./node_modules/.bin/vitest run src/mailbox-seam-upstream.test.ts src/mailbox-seam-ratchet.test.ts
pnpm run check:public-boundary -- --portable
```

Targeted files only. Never the full host suite while another builder is running, and never the same suite from two worktrees (#274). The full serial suite (`vitest run --no-file-parallelism`) is reserved, run alone against a frozen tree, before a merge.

## 11. Decisions recorded (engineering, per the program's delegation)

| # | Decision |
|---|---|
| D1 | Upstream's reconcile-session / reconcile-queue is **not** adopted in this seam. The fork's tick stays the scheduler. Evidence in §2. |
| D2 | PR 0 ports `src/host-lifecycle.ts` byte-identical from `5c3082a1` with a sha256 manifest drift test and fires start/stop at upstream's boot positions. Inert. |
| D3 | PR 1 moves the six `main.ts` timers into their owning modules using upstream's `setInterval` + `unref` + clear-in-shutdown idiom, and fixes the storage-maintenance ownership asymmetry. No session-DB contact; lands independently of the mailbox stack. |
| D4 | PR 2 builds a fork-local sweep duty registry: a seven-phase list (`session:health` exclusive, the rest `all`) plus an SLA-observation hook list and a kill-follow-up list, encoding all 21 ordering constraints. The driver is session-major and nested, with the per-session yield preserved. One shared per-tick context, a single active-sessions scan, one mailbox open per group per window, and error classification at every opening boundary with the two distinct log strings and a `window` field. |
| D5 | PR 3–13 move duties in families, cheapest first, with per-family rewrite-vs-delete measurement; G09 last; the `CodexItem` tolerance is a named acceptance case; G64 shims are deleted with the storage family; the scheduled-move raw-path import is a permanent KEEP-PATCH with its reason recorded at the import site; memory/curator hooks do not exist. |
| D6 | PR 14 leaves `host-sweep.ts` as driver + registry + phase list under 300 lines, measures residue, and drafts the upstream contribution into the record directory. |
| D7 | PR 0/1 base on `origin/main`; PR 2 onward on the mailbox PR 5 branch at its post-linearization head. PR 9/11/13 wait for mailbox PR 4 and PR 12 for mailbox PR 6; nothing waits for PR 7. The six legacy-handle conversions are mailbox-series prerequisites; seam 2 takes none of them. Gating table in §5. |
| D8 | Deploy conventions are seam 1's verbatim: one PR per restart, quiet rule v2 re-checked at execution, QA seat first, the five-part gate, revert-build-restart rollback, no migrations. Log gates use the two distinct strings `Host sweep duty failed` and `Host sweep mailbox unopenable`, never a shared count (constraint 17). |
| D9 | Acceptance criteria are exact named cases (§8); ownership boundaries and verification commands are per PR (§5, §10). |
| D10 | No product decision is open. The two operator-facing items in §9 are for awareness. |

## 12. References

- Record: `groups/_ops/upstream-rebaseline-2026-09/{seam2-inventory.md, ledger.md §2.3 line 357 / §4 / §9 risk 9 / lines 401, 481-484, 583, 802, 939, 1085, seam-catalog.md §17 + :104-106, critic.md B2, contrib/}`
- Grounding: seam2-upstream.md (upstream lifecycle and reconcile seam at `5c3082a1`), seam2-fork.md rev 2 (duty inventory on the PR 5 branch, 21 ordering constraints, legacy-handle bridge, perf history), seam2-constraints.md (mailbox branch stack, ratchet invariants, deploy conventions, review policy)
- Upstream `5c3082a1`: `src/host-lifecycle.ts`, `src/host-lifecycle.test.ts`, `src/index.ts:155,180`, `src/host-instance.ts:51-55,71-74`, `src/reconcile.ts:30-42`, `src/reconcile-queue.ts:37-42`, `src/reconcile-session.ts:34,179-182,192-200,218-250`, `src/db/coordination.ts:5-7`, `src/db/migrations/024-host-coordination.ts`, `src/modules/approvals/index.ts:44-46`
- Fork (PR 5 branch `756f5d02`): `src/host-sweep.ts`, `src/host-sweep.test.ts`, `src/host-sweep-reschedule.test.ts`, `src/modules/mailbox/ops/{continuation,recovery}.ts`, `src/modules/mailbox/sqlite-utc.ts`, `src/mailbox/RATCHET.json`; fork `main`: `src/main.ts:490,508,517-565,598-613,630`, `src/modules/index.ts:17`, `docs/architecture.md` (bounded-periodic-work invariant), `src/mailbox-seam-upstream.test.ts` (manifest pattern)
- Predecessor: `docs/specs/upstream-mailbox-seam/{plan.md,run.md}`
- Process: `.claude/skills/sync-upstream/SKILL.md §4`, `docs/review-policy.md`, memories `project_upstream_convergence_program`, `feedback_deploy_is_pull_build_restart`, `feedback_host_tests_unsafe_concurrent`, `feedback_never_branch_shared_checkout_main_only`
