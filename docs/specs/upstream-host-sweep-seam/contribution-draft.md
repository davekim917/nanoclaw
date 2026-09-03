# Contribution draft — host-sweep duty registry (convergence seam 2)

Status: draft, written at the end of S2-PR14. Not an offer yet — this is the shape
a contribution to `nanocoai/nanoclaw` would take, and the line the fork keeps on its
own side of it. Upstream target of record: `5c3082a1` (2.3.0, 2026-09-01).
No code here; the code is the series' own branches.

Predecessor: seam 1, `docs/specs/upstream-mailbox-seam/`. That seam had no
contribution draft, so this file also sets the shape for later ones.

## 1. What upstream would receive

Upstream has `src/host-lifecycle.ts` — start and stop hooks with a serial FIFO/LIFO
registry — and zero production registrants of the start half. It has no periodic
control path of its own beyond `src/reconcile*.ts`, which this seam deliberately did
not adopt (plan.md §2, decision D1). What it does not have, and what this seam built,
is the layer between "the host runs work on a timer" and "a module owns that work":

| Piece                   | What it is                                                                                                                       | Why upstream would want it                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase list              | Seven named phases in run order, each declared `all` or `exclusive`                                                              | Ordering becomes data. The 21 ordering constraints this fork had encoded only as statement order in one function are now `(phase, order)` pairs a test can read. |
| Duty registry           | `registerSweepDuty` / `registerSlaObservationHook` / `registerSweepKillFollowUp`, plus `registerSweepDutySource` for replay      | A module owns its periodic work the same way `onHostShutdown` already lets it own its teardown. It is the missing start-side sibling of the lifecycle port.      |
| Tick driver             | Session-major, nested, one active-sessions scan per tick, one session open per group per window, the per-session yield preserved | The perf invariant is in one place instead of implied by where a statement sits.                                                                                 |
| Shared per-tick context | One `SweepTickContext`, narrowed to `SweepSessionContext` for session phases                                                     | Duties stop re-deriving what the driver already read. It is what makes a duty movable at all.                                                                    |
| Error rule              | Every duty body runs through one wrapper that tags the error with duty and window; tick phases isolate, session phases propagate | Two distinct log strings, one emit site each. Before this, an unguarded throw in one duty silently skipped every later duty in the tick.                         |
| Duty inventory          | Id → registered name map, asserted whole (surface, name, phase, order) by one test                                               | The drift test. It is what makes the restructure reviewable: nothing dropped, nothing duplicated, nothing reordered.                                             |
| Family layout           | One `src/modules/sweep-<family>/` directory per group of related duties, registering at import through the modules barrel        | The unit of ownership. Thirteen families, each with its own suite beside it.                                                                                     |

The lifecycle port itself travels back as a no-op: `src/host-lifecycle.ts` is carried
byte-identical and locked by a sha256 manifest, so upstream would receive its own file
unchanged.

## 2. What stays fork-only

| Piece                                      | Why it does not travel                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mailbox/RATCHET.json` and its scanner | A migration artifact of seam 1, not a feature. It counts files that still touch session DBs raw, and only shrinks. Upstream has no such migration in flight.                                                                                                                                                   |
| Mailbox-specific duties                    | Most of the 38 duties are fork behavior with no upstream counterpart — continuation and ceiling accountability, the repo-ingress fence release, scheduled-move recovery, the OneCLI-era approvals sweep, the dashboard thread-close advance, usage rollup. They are what the registry carries, not what it is. |
| `src/host-sweep.ts`'s tick constants       | `ABSOLUTE_CEILING_MS`, `CLAIM_STUCK_MS`, `SPAWN_GRACE_MS` and the quiet-session cache are this fork's container-supervision policy.                                                                                                                                                                            |
| The `CodexItem` tolerance                  | Upstream's incarnation gate widens the tool ceiling only for `Bash`; this fork also honours a Codex session's declared timeout (case F-10.4). It is a fork provider concern.                                                                                                                                   |
| The scheduled-move raw-path opener         | A permanent, written exception: that recovery walks an injected sessions root, so its DBs are not addressable by a mailbox key. It stays on the allowlist with the reason at the import site.                                                                                                                  |
| The type shim `src/db/driver.ts`           | Stands in for upstream's real async driver until the async-DB seam. Upstream already has the real one.                                                                                                                                                                                                         |

## 3. API surface

Everything a family module imports from the driver. This is the whole contract; a
module that needs more than this row set is not yet a module.

| Export                                             | Kind                    | Contract                                                                                                                                                         |
| -------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SWEEP_PHASES`                                     | `readonly SweepPhase[]` | The seven phases in run order. Index comparison is how a test states "before".                                                                                   |
| `sweepPhaseKind(phase)`                            | fn                      | `'all'` or `'exclusive'`. An exclusive phase runs at most one duty per session — the first whose `claims()` returns true, else the single no-claims fallthrough. |
| `registerSweepDuty(duty)`                          | fn                      | `{ name, phase, order, claims?, run }`. Validates the exclusive-phase rule and rejects a duplicate `(phase, order)`.                                             |
| `registerSlaObservationHook(hook)`                 | fn                      | Runs inside the SLA duty's own observe session, before any kill.                                                                                                 |
| `registerSweepKillFollowUp(followUp)`              | fn                      | Runs in the session opened _after_ `killContainer` returns — the single-writer invariant.                                                                        |
| `registerSweepDutySource(name, registrar)`         | fn                      | Records a module's registrar so the test-only reset can replay it. Production calls it once per family at import.                                                |
| `SweepTickContext` / `SweepSessionContext`         | types                   | The shared per-tick read. `sessions`, `activeContainerSessionIds`, `now`; session phases add `session`, `mailbox`, `plan`, `alive`, `hasOutbound`.               |
| `asSessionContext(ctx)`                            | fn                      | Narrows the union with a loud throw. A session-phase duty is unreachable from a tick context, so this is a shape assertion, not a cast.                          |
| `SweepWindowAbort`                                 | class                   | The one error a duty may throw to abandon its window without failing the tick.                                                                                   |
| `runSlaObservationHooks` / `runSweepKillFollowUps` | fns                     | Called by the SLA duty at the two points only it can reach.                                                                                                      |
| `SWEEP_DUTY_INVENTORY`                             | map                     | Inventory id → registered name. The only place the driver names a duty.                                                                                          |
| `startHostSweep` / `stopHostSweep`                 | fns                     | The timer. Upstream would wire these through `onHostStart` / `onHostShutdown`.                                                                                   |

Test-only accessors (`_listSweepRegistrationsForTesting`, `_resetSweepRegistryForTesting`,
`_unregisterSweepDutySourceForTesting`, `_setSweepYieldForTesting`) travel with the
registry: the drift test is the reason the registry is worth having, and it cannot be
written without them.

## 4. The tests that travel

| Test                                  | What it pins                                                                                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration inventory (R-7 / F-14.2) | The whole `(surface, name, phase, order)` tuple list, in run order, reached through the production modules barrel. A swap anywhere fails. This is the drift test.                                                                                                |
| Phase-list order (R-1)                | `SWEEP_PHASES` is the declared run order, and the driver runs it.                                                                                                                                                                                                |
| Exclusive-phase rule                  | At most one claiming duty per session; exactly one no-claims fallthrough; a second one throws at registration.                                                                                                                                                   |
| Error rule                            | A tick duty that throws is logged with `duty` and `window` and the tick continues; a session duty that throws propagates and the session is not quiet-cached. Two distinct strings, one emit site each.                                                          |
| Duty-source replay                    | Reset restores every recorded source, not just the built-ins; the built-in source is not test-owned and refuses to be unregistered.                                                                                                                              |
| Depth-zero (R-10)                     | A duty that kills or wakes holds no mailbox session while it does so.                                                                                                                                                                                            |
| Per-family wiring                     | Each family has one case asserting the production barrel — not the test's own import — still carries its line, with the duty's plan-mandated phase and order.                                                                                                    |
| Registered-duty drive                 | For every moved duty, at least one case obtains it from the registry by name and drives its `run`/`claims`, asserting the underlying dependency was called with the expected arguments. A case that calls the moved body directly proves nothing about the move. |
| Hermeticity tripwire                  | A `child_process` mock that records and throws on any real spawn, asserted empty in every case that advances timers or runs a duty body, with a case proving it bites.                                                                                           |

The fork-only tests that do **not** travel: the ratchet suite and the family suites for
duties upstream does not have.

## 5. Open item this draft cannot close

`plan.md` §8 F-14.1 requires `src/host-sweep.ts` to be under 300 lines at the end state.
It is 1,137 (631 code, 420 comment, 86 blank) and holds no duty body: driver, registry,
phase list, shared context, error rule and inventory, nothing else. The ceiling was an
estimate made before the build and is wrong by roughly 2x on code alone. Either the
number is corrected or the driver is split — a decision for the operator, not for this
draft. Any contribution offer should quote the real shape, not the estimate.
