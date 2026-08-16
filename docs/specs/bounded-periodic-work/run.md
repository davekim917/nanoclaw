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

### Ready for `/team-review --implementation`

Implementation is coherent, focused checks pass, the diff has been inspected hunk by hunk, and the
three deviations above are explicit.
