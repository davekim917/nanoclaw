# Bounded periodic work

**Status:** APPROVED 2026-08-16 — build may begin
**Approval state:** APPROVED by the user on the post-review revision (the one carrying corrections
F1-F6). User deferred D-1, D-2 and D-3 to the lead; dispositions recorded below and in `run.md`.

**Decision dispositions (lead, on deferred authority):**
- **D-1 — session lifecycle: option (a), do nothing.** After phase 1 the 6,697 sessions cost disk
  and no CPU. The only non-degrading alternative (close + revive) is real work against a problem
  that does not yet exist. Revisit if disk becomes a constraint.
- **D-2 — Graphify spike: after phase 1 is landed and observed**, not concurrently. One change per
  restart, each verified before the next, is the sequencing this plan committed to.
- **D-3 — 7-day horizon hole: record now, fix as its own change.** It is a genuine
  permanent-non-delivery hole, but it is pre-existing, low-likelihood (it needs a `deliver_after`
  more than 7 days out, or a caller that skips the required `touchSessionActivity`), and folding it
  into this build would repeat the pattern this plan exists to stop. Carried as a named follow-up,
  not lost.
**Feature dir:** `docs/specs/bounded-periodic-work/`

## Correction that reframes this plan

The framing that motivated this work — "5,333 accumulated session DBs are the accumulator, and a
chat-session close policy is the lever that makes every loop cheap at once" — is **wrong for the
loop that is actually burning CPU**, and the plan is built on the corrected picture.

Measured on the live install:

```
sessions total                                    6,697  (5,536 active/stopped, 1,155 closed, 6 running)
active sessions older than 30d                      971
population pollSweep actually iterates            1,657   ← already excludes everything above
sessions removed from that population by
  closing every 30d+ session                          0
session outbound.db files changed in last hour       17
```

`getSessionsActiveSince` (`src/db/sessions.ts:185`) already bounds the sweep to sessions active
within 7 days, so the 971 stale sessions cost **zero** CPU in that loop. Closing old sessions is a
disk and long-term-drag fix, not a fix for the 60s CPU bursts.

The pattern claim survives the correction, restated accurately:

> A periodic pass costs work proportional to its **candidate population**, when it should cost work
> proportional to **what actually changed**. 1,657 sessions are polled to find the ~17 that moved.

That is the defect this plan fixes, in the two loops where it is measured.

## Outcome

The host's periodic passes cost work proportional to change, not to population size, and the
pattern is enforced well enough that a new loop cannot silently reintroduce it.

Concretely: the delivery sweep stops opening ~1,657 SQLite file pairs per minute to find ~17 with
work, the Graphify daemon stops rebuilding a whole workgroup index on a timer regardless of change,
and both have observable counters proving it.

## Scope

1. **Delivery sweep change-gate** (`src/delivery.ts`) — full design below, ready to build.
2. **The invariant** — one shared helper plus tests, so the next periodic pass inherits the gate
   rather than re-deriving it.
3. **Graphify unconditional full reconcile** — spike then decision; not buildable until the spike
   answers whether a no-change rebuild can be detected cheaply.
4. **Session lifecycle** — decision surface for the user. Explicitly *not* justified by CPU.

## Non-goals

- `canonicalToken` / `tokenStreamForRecall` (~16% of busy CPU). Real, but turn-triggered latency
  rather than idle-fleet burn; separate change, separate evidence.
- Caching open `better-sqlite3` handles. Breaks the documented lifecycle invariant
  ("callers own the connection lifecycle — open-write-close per op", `src/db/session-db.ts:1-7`)
  and puts ~1,657 fds under pressure.
- Tightening the 7-day horizon in `pollSweep`. The gate achieves the win without changing which
  sessions are *eligible*; narrowing eligibility risks stranding future-scheduled rows for zero
  additional benefit.
- Removing the `IOReadBandwidthMax` cap on `nanoclaw-v2-graphify`. It stays as defense-in-depth
  regardless of what phase 3 concludes.
- Any change to `journal_mode` on session DBs. `DELETE` is load-bearing for cross-mount visibility
  (`container/agent-runner/src/db/connection.ts`) and is what makes mtime a trustworthy signal.

## Requirements

- **R1** — A session with no work and no recent change is not opened by the delivery sweep.
- **R2** — For any session **inside the sweep's candidate population**, no message is delivered later
  than `backoff + one sweep interval` past the moment it becomes deliverable, **even if the change
  signal fails entirely**. Bounded delay is the only acceptable failure mode for the gate;
  permanent non-delivery is not.
  - *Scope limit, verified:* this cannot be promised for a session that leaves the population.
    `getSessionsActiveSince` (`src/db/sessions.ts:185`) drops sessions idle >7 days, and the
    codebase already documents the consequence — `touchSessionActivity`'s docstring
    (`src/db/sessions.ts:~220`) states such work "sits unseen until the cache expires — or, past the
    7-day delivery horizon, **indefinitely**". A row with `deliver_after` more than 7 days out is
    therefore already permanently undeliverable **today**, before this plan. The gate neither causes
    nor fixes it. See **D-3**.
- **R3** — A delivery failure that leaves retry state only in memory
  (`deliveryAttempts`, `src/delivery.ts:78`) must not cause the session to be skipped.
- **R4** — A row with a future `deliver_after` (`src/db/session-db.ts:748`) must not cause the
  session to be skipped.
- **R5** — The skip decision is observable: each cycle records polled and skipped counts.
- **R6** — Graphify does not rebuild a workgroup index on a timer when nothing changed (subject to
  the phase-3 spike).

## Acceptance criteria

Behavior-changing work; criteria below are the exact cases `/team-build` materializes **before**
implementing, in `src/delivery.test.ts` (existing file, vitest).

Pure decision function `shouldSkipQuietDelivery(cached, current, nowMs)`:

| # | Test name | Assertion |
|---|---|---|
| A1 | `skips a quiet session whose outbound.db is unchanged within the time bound` | returns `true` for identical mtimeNs+size, `armedAtMs` 60s ago |
| A2 | `polls when mtime moved` | returns `false` when `mtimeNs` differs by 1ns |
| A3 | `polls when size moved` | returns `false` when size differs, mtime identical |
| A4 | `polls once the time bound elapses even if nothing changed` | returns `false` when `nowMs - armedAtMs > QUIET_DELIVERY_BACKOFF_MS`, identical stat |
| A5 | `polls when there is no cache entry` | returns `false` for `undefined` cached |

Integration over `pollSweep`:

| # | Test name | Assertion |
|---|---|---|
| A6 | `never arms for a session left holding an undelivered row` | after a drain where a row remains undelivered (delivery threw), no cache entry exists → next cycle opens the DB |
| A7 | `never arms for a session holding a future deliver_after row` | outbound row with `deliver_after` 1h ahead → no cache entry → next cycle opens the DB |
| A8 | `arms only after a drain that leaves zero undelivered rows` | clean drain → cache entry recorded with the stat taken **before** the open |
| A9 | `polls a session whose container is running regardless of cache` | `isContainerRunning` true → opened even with a matching cache entry |
| A10 | `polls when a hot journal exists` | `outbound.db-journal` present → opened even with a matching cache entry |
| A11 | `a commit landing after the pre-open stat is not lost` | write to outbound.db after the stat, before arming → stored mtime is the pre-open one, so the next cycle re-polls |
| A12 | `records polled and skipped counts every cycle` | log emitted unconditionally (not only when `cycleMs >= 1000`, `src/delivery.ts:401`), payload carries both counters |
| A13 | `forced re-poll deadlines are staggered across sessions` | two sessions armed in the same cycle with different ids have different forced-poll deadlines, both within the backoff maximum |

Behavioral criteria — these assert **delivery**, not cache state, and are the ones that fail if the
gate strands a message:

| # | Test name | Assertion |
|---|---|---|
| A14 | `delivers by the backoff deadline even when the change signal never moves` | stat held artificially constant, row becomes due after arming, fake time advanced past the jittered deadline → adapter receives the message |
| A15 | `delivers a row written between the pre-open stat and arming` | insert after the clean observation, stat unchanged → adapter receives it on the next sweep, not after the backoff |
| A16 | `does not arm while pollActive owns the session` | overlapping drain returns `'busy'` → no cache entry → next sweep opens the DB |
| A17 | `does not arm when delivery failed this cycle` | adapter throws → returns `'error'` → no cache entry, and the message is retried on the next sweep |

Phase 3 and 4 have no acceptance criteria yet; they gate on a spike and a user decision
respectively.

## Current architecture (with evidence)

- `pollSweep` (`src/delivery.ts:379-407`) iterates `getSessionsActiveSince(now - 7d)` and calls
  `deliverSessionMessages` per session, yielding after each. Its own comment records the history:
  "2350 sessions/cycle observed", and "every stall drops live Discord inbound at the local forward
  hop" (`src/delivery.ts:394-395`).
- `deliverSessionMessages` opens both session DBs, runs `getDueOutboundMessages`
  (`src/db/session-db.ts:748`) and `getDeliveredIds`, and closes them.
- Retry state after a transient delivery failure lives **only** in the module-level
  `deliveryAttempts` map (`src/delivery.ts:78`, incremented at `:544`). Nothing is written to
  `outbound.db`, so the file's mtime does not move.
- `pollActive` (`src/delivery.ts:351-371`) already drains running sessions every ~1s, with
  `inflightDeliveries` preventing double-drain.
- `host-sweep` already implements this pattern twice: `quietSessions`
  (`src/host-sweep.ts:123-131`, consumed `:735-746`) with a **time-bounded** backoff
  (`QUIET_SESSION_BACKOFF_MS`, 30 min), and `usageRollupMtimeCache` (`:1475`) with a pure,
  unit-testable decision (`shouldSkipUsageRollup`, `:1484`). Live evidence it works:
  `sweptSessions=20 skippedQuiet=5175`.
- Session DBs use `journal_mode = DELETE` (`src/db/session-db.ts:19,42,100`;
  container side `container/agent-runner/src/db/connection.ts`), so every commit lands in the main
  file and moves its mtime. Bind mounts share the inode, so the host sees container commits
  immediately.
- `recoverHotJournal` (`src/db/session-db.ts:69-81`) documents the SIGKILL-mid-write case where a
  `-journal` file exists and a rollback (a write) is required before any read.
- Only **task** sessions are ever closed (`shouldCloseTaskSession`, `src/host-sweep.ts:876`, applied
  `:1450`). `findSession` requires `status = 'active'` (`src/db/sessions.ts:22-31`), so a closed
  chat session would not be found by a later inbound message — a new session would be created
  instead. That is the crux of the phase-4 decision.
- Graphify's 6-hourly timer marks **every** workgroup dirty and full-scan-required unconditionally
  (`src/graphify-daemon/daemon.ts:708-713`, `markDirty` `:737-743`). A full scan builds a fresh
  `index.next-<hash>.db` (`:1437-1440`) and promotes it by rename (`:1614`). Observed rebuilding a
  2.6 GB workgroup index at 42 MB/s.

## Design

### Phase 1 — delivery sweep change-gate

Module-level state in `src/delivery.ts`, shaped after `usageRollupMtimeCache`:

```ts
interface QuietDeliveryMark { mtimeNs: bigint; size: number; armedAtMs: number; }
const quietDeliveryCache = new Map<string, QuietDeliveryMark>();
const QUIET_DELIVERY_BACKOFF_MS = 10 * 60_000;
```

Pure decision (exported for tests):

```ts
export function shouldSkipQuietDelivery(
  cached: QuietDeliveryMark | undefined,
  current: { mtimeNs: bigint; size: number },
  nowMs: number,
): boolean
```

Returns `true` only when a cache entry exists, both stat fields match exactly, and
`nowMs - cached.armedAtMs <= QUIET_DELIVERY_BACKOFF_MS`.

In `pollSweep` only (never `pollActive`), per session:

1. If `isContainerRunning(session.id)` → poll (no gate).
2. If `<outbound>-journal` exists → poll (hot-journal rollback is a write; pre-rollback state is
   ambiguous).
3. `fs.statSync(outboundPath, { bigint: true })` → `{ mtimeNs, size }`. **Take this before opening.**
   A failed stat (ENOENT) → poll.
4. `shouldSkipQuietDelivery(...)` → skip, increment `skipped`, continue.
5. Otherwise drain. **Arm only when the drain proves the session fully clean:** zero rows in
   `messages_out` lacking a `delivered` row — which counts future `deliver_after` rows, satisfying
   R4 — **and** no delivery error this cycle, satisfying R3. Store the stat taken in step 3, with
   `armedAtMs = Date.now()`.
   - **The drain must report its outcome.** `deliverSessionMessages` currently returns `void` and
     early-returns when `inflightDeliveries.has(session.id)` (`src/delivery.ts:434-445`), so a
     caller cannot distinguish "drained and clean" from "someone else owns this session and I did
     nothing". Arming on that no-op would mark an uninspected session quiet. It changes to return
     `'busy' | 'clean' | 'pending' | 'error'`; **arm only on `'clean'`**. `pollActive` ignores the
     value, so its behavior is unchanged.
6. Delete cache entries for sessions no longer in the swept population, mirroring
   `src/host-sweep.ts:763-765`.

**Why the time bound (R2).** Every mtime-only gate shares one failure shape: if the change signal
ever fails, the session is skipped forever and the failure is silent. `QUIET_DELIVERY_BACKOFF_MS`
converts that class from permanent non-delivery into ≤10 min of delay.

**Cost, stated correctly.** Re-polling each quiet session 6×/hour instead of 60× is a **90%**
reduction in forced opens, not 98%. Total cost is `O(changes + population/backoff)` per hour, not
`O(changes)`.

**Staggering is required, not optional.** Sessions armed in the same sweep expire in the same
sweep, so a naive backoff re-creates the exact ~1,657-session burst this plan exists to remove,
once every 10 minutes. The forced re-poll deadline is therefore per-session jittered:

```ts
armedAtMs + QUIET_DELIVERY_BACKOFF_MS/2 + (hashToUnitInterval(session.id) * QUIET_DELIVERY_BACKOFF_MS/2)
```

Deterministic per session id, so it survives restarts and spreads forced audits across the second
half of the window. The 10-minute maximum still holds. Consequence for **R5/A12**: steady-state
`polled` is roughly `changes + population/backoff-window` per cycle — order 10² per cycle, not the
double digits originally claimed.

**Why arm-after rather than skip-before.** Arming only on a provably clean drain means every
uncertainty — a failure, a pending row, a future-scheduled row — results in *polling*, which is
today's behavior. The gate can only ever be wrong in the direction of doing more work.

### Phase 2 — the invariant (documentation only; no shared abstraction)

The original design extracted a `src/periodic-gate.ts` helper. **Dropped**: it would have exactly
one consumer, which is the abstraction-with-one-implementation this repo's contract rejects, and a
test asserting "pollSweep delegates to the helper" checks shape rather than behavior. The predicate
stays local to `src/delivery.ts`; A14-A17 prove the behavior instead.

Record the rule where periodic work is described:

> Any periodic pass over sessions must be gated on a change signal, bounded by time, staggered
> across sessions, and must record polled/skipped counts. Work proportional to population size is a
> defect.

**Known inconsistency, recorded not silently fixed:** `shouldSkipUsageRollup`
(`src/host-sweep.ts:1484`) is pure mtime equality with **no** time bound, so it does not satisfy the
rule above. It is out of scope here — its failure mode is a missed usage-accounting rollup, not an
undelivered message, and `rollupSessionUsage`'s own watermark prevents double-counting. Named so the
rule is not stated as universal when one existing consumer contradicts it.

### Phase 3 — Graphify full reconcile (spike first)

Open question the spike must answer: can a no-change full reconcile be detected before building a
2.6 GB `index.next-*`? Candidate signals already in the codebase: the source content hash used by
`hashTree` (`src/repo-store.ts:235`), `state.lastCompletedAt`, and the archive fingerprint the
poll already computes. If yes, the 6-hourly timer becomes "probe, rebuild only on change". If no,
the fallback is lengthening the interval and keeping the IO cap.

Not buildable until the spike reports. Deliberately not designed here on assumption.

### Phase 4 — session lifecycle (user decision)

Options, with the tradeoff that actually matters — `findSession` only finds `status='active'`
sessions, so "closed" means a later reply starts a **new** session with no continuity:

- **(a) Do nothing.** 6,697 sessions cost disk and nothing else after phase 1. Honest default.
- **(b) Close + revive.** Close chat sessions after N days idle; on new inbound for that
  (messaging_group, thread), flip back to `active` instead of creating a new session. Preserves
  continuity; needs `findSession` to look past `status`.
- **(c) Close hard.** Close after N days; a later reply starts fresh. Simplest, loses thread
  continuity — probably wrong for a personal assistant where someone replies to a month-old thread.
- **(d) Archive files, keep rows.** Compress/move the two SQLite files for long-idle sessions,
  leave the row active; revive by decompressing on demand.

Recommendation if asked: **(a) now, (b) later if disk becomes a real constraint** — because after
phase 1 the inventory costs no CPU, and (b) is the only option that does not degrade the product.

## Safety, rollback, observability

- **Rollback:** phase 1 is one commit touching `src/delivery.ts` (+ tests). Revert restores exact
  current behavior; the cache is in-memory, so nothing persists across a restart.
- **Failure mode by construction:** bounded delay (R2), never silent loss.
- **Observability:** `Sweep delivery poll timing` gains `skipped` and is emitted **every cycle**.
  Today it fires only when `cycleMs >= 1000` (`src/delivery.ts:401`), which would make a healthy
  fast skip-heavy cycle indistinguishable from a stopped sweep — the exact regression this gate
  could cause. Post-deploy, `polled` should fall from ~1,657 to order 10² per cycle (changes plus
  the staggered forced-audit share) while delivered-message counts per hour stay flat. If `polled`
  falls and deliveries also fall, revert.
- **Deploy hazard:** `dist/` is a live deploy surface — a crash restart ships whatever was last
  built. Compile into `dist/` only when the change is complete and committed.
- **Shared tree:** other sessions are editing this working tree; stage per-file, never `git add -A`.

## Implementation path

| Step | Owner boundary | Depends on | Check |
|---|---|---|---|
| 1 | Materialize A1-A17 in `src/delivery.test.ts`, run once to observe failure | approval | `vitest run src/delivery.test.ts` |
| 2 | Drain-result enum on `deliverSessionMessages`; `shouldSkipQuietDelivery` + jittered deadline + cache + `pollSweep` wiring + unconditional counters | 1 | A1-A17 pass |
| 3 | Document the invariant (no shared abstraction — see Phase 2) | 2 | full `vitest run` green |
| 4 | Commit, compile only changed files into `dist/`, restart on user's schedule | 3 | `polled` drops, hourly deliveries flat |
| 5 | Phase-3 spike → report → separate decision | 4 landed and observed | n/a |
| 6 | Phase-4 decision by user | independent | n/a |

## Risks and unresolved decisions

- **R-1 (highest):** a gate bug strands messages. Mitigated by R2's time bound, arm-after-clean, and
  the polled/deliveries counter check. Residual: up to 10 min delay in a bug case.
- **R-2:** `statSync` with `bigint: true` on every swept session each cycle — ~1,657 stats/min. Cheap
  relative to what it replaces, but it is not free; A12's counters make the tradeoff measurable.
- **R-3:** this is the sixth change to a live fleet in a short window. Sequencing (one phase per
  restart, observed before the next) is part of the plan, not optional.
- **D-1 (user):** phase 4 option (a)/(b)/(c)/(d).
- **D-2 (user):** whether phase 3's spike happens now or later.
- **D-3 (user):** the pre-existing 7-day horizon hazard surfaced by review. A row scheduled more
  than 7 days out — or written into a session that then goes idle past the horizon without
  `touchSessionActivity` — is permanently undeliverable **today**, independent of this plan, and the
  codebase documents it (`src/db/sessions.ts:~220`). Options: (i) leave it, record it; (ii) persist a
  pending-outbound deadline on the session row and include marked sessions in the candidate query
  until a clean drain clears it, with a test whose `deliver_after` crosses the horizon and survives
  a restart. (ii) is a real fix for a real hole but is **its own change** — folding it in here would
  repeat the mole-whacking this plan exists to stop.

## Verification commands

```bash
node_modules/.bin/vitest run src/delivery.test.ts
node_modules/.bin/vitest run                     # full host suite before commit
# post-deploy, from logs:
#   "Sweep delivery poll timing"  -> polled should be double digits, skipped ~1.6k
#   hourly delivered counts       -> unchanged vs the prior day
```
