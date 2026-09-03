# Run record: upstream-host-sweep-seam (convergence seam 2)

## Stage: plan (2026-09-03)

Primary runtime/model: Claude, Fable 5.1 (orchestrator). Grounding delegated to three workers — upstream lifecycle/reconcile seam, fork duty inventory, seam-1 constraint extraction — plus the seam-2 inventory written by the mailbox-seam session. All reports verified against source before use.

Stage state: **plan written, review pending, not approved.** No test-tree changes, no branches, no commits beyond this spec directory.

### Grounding evidence

- Contract read: `bootstrap-workflow/4.3.6/skills/shared/workflow-contract.md` end to end (plan.md required sections; executable-acceptance-criteria rule; artifacts rule — only `plan.md` and `run.md`).
- Memory read: `project_upstream_convergence_program` (program approval, standing operator decisions, burn-mode rule, deploy schedule, mailbox PR 0/1 deployed).
- Grounding inputs read in full: `seam2-upstream.md` (553 lines), `seam2-fork.md` **revision 2** (316 lines, rebased onto the PR 5 branch mid-session — the first revision was `main`-based and its line numbers were superseded), `seam2-constraints.md` (224 lines), `groups/_ops/upstream-rebaseline-2026-09/seam2-inventory.md` (284 lines).
- Precedent read: `docs/specs/upstream-mailbox-seam/plan.md` (436 lines incl. run.md) — §6 deploy gate, quiet rule v2, §4.6 drift-test and sha256-manifest patterns, §8 acceptance-case form, §10 verification commands reused verbatim.
- Live checks (read-only, live checkout, no writes):
  - `src/host-lifecycle.ts` sha256 `fbf37333e51a…` identical at `5c3082a1` and `upstream/main` `0d9328d2` — the port does not age before the next sync.
  - Fork has **no** `src/host-lifecycle.ts`; it does have `src/modules/index.ts` carrying upstream's `import '../mailbox/compose.js'` at `:17`.
  - `src/main.ts` timer call sites confirmed: starts `:517 :522 :526 :549 :557 :565`, stops `:608-613`, `stopStorageMaintenanceWorker` `:602` with no matching start, `stopAllContainers` `:630`.
  - `origin/feat/mailbox-seam-pr5-sweep-family`: `host-sweep.ts` 2,438 lines, `host-sweep.test.ts` 3,116 lines / **148** cases / 24 top-level describes.
  - Companion suite counts measured on the live checkout for sizing.
  - Fork issues `#274` (fixed `/tmp` fixture roots) and `#259` (idle reaper killed a task-script container) are both **OPEN**. The brief described #259 as "fixed separately"; it is not. Recorded as an open defect this series must not absorb (plan §4.7), not as a fixed one.

### Corrections applied during planning

| # | What the brief or an input said | What the source says | Where it landed |
|---|---|---|---|
| 1 | `host-sweep.test.ts` on the PR 5 branch is 3,082 lines / 313 cases / 14 suites | 3,116 lines / 148 cases / 24 describes, plus 19 companion suites (9,045 lines / 412 cases across the whole surface on `main`) | plan §3, sizing table |
| 2 | 15 load-bearing ordering constraints | 21 — constraints 16–21 are new with mailbox PR 5 (three-arm error classification, two `Host sweep error` emit sites, no-session-across-kill, reads-never-provision, inbound-only existence, rollup-mtime correctness) | plan §4.3 table, §4.5, risk 3 |
| 3 | Per-session boundary is "plan session → wake with nothing open → tail session" | The source table numbers **five** windows: W1 plan, W2 wake/kill, W3 observe, W4 reap/SLA, W5 tail. Three hold a session (W1, W3, W5); W2 and W4 hold nothing, and W4 is dispatch-only | plan §3, §4.3 phase list |
| 4 | Error rule has two arms (back off on unopenable, retry on duty throw) | Three arms; the middle one (`log.error` **and** backoff on a present-but-unopenable mailbox) exists because retrying every 60 s produced ~4k identical errors in the hot-journal incident | plan §4.5, cases R-4/R-5/R-6 |
| 6 | #259 (reaper) fixed separately | Open | plan §4.7 "do not absorb open defects" |

### Facts settled by the mailbox session, taken as given

1. **`db/usage.ts` is mailbox PR 6's scope.** `rollupSessionUsage` via `legacyOutboundHandle` (`host-sweep.ts:1840`) is converted by PR 6; seam 2 does not take it. The PR 5 source comment at `:1836-1838` reads as if the bridge had no owner — it does. Listed in plan §5 as a prerequisite; S2-PR12 is gated on PR 6 with no fallback that absorbs mailbox scope.
2. **The two sweep error sites get distinct strings on PR 5**, same structured fields: `Host sweep duty failed` (a duty threw; not quiet-cached; retried next tick) and `Host sweep mailbox unopenable` (backoff). The plan's error rule (§4.5), its deploy gates (§6) and cases R-4/R-5/R-6 are written against those exact strings. `Host sweep duty failed` carries the duty `name`, so a family PR gates on its own duties rather than a shared count.
3. **The three misleading "moves in PR 3" comments** (`:1223-1224`, `:1591`, `:1768-1769`) are being corrected to PR 4 on #271. No coordination item — the plan notes only that seam 2 sequences against PR 4 regardless of which text a builder reads.

### Decisions recorded (D1–D10, fixed by the lead before planning; plan §11 carries the full table)

1. **D1** — do not adopt upstream's reconcile-session / reconcile-queue now. Three blockers with evidence: migration 024 `session_claims` dependency, the async `DbDriver`, and no open registry for singletons or per-session duties. Explicit non-goal.
2. **D2** — S2-PR0 ports `src/host-lifecycle.ts` byte-identical from `5c3082a1` with a sha256 manifest drift test, wired at upstream's boot positions. Inert.
3. **D3** — S2-PR1 moves the six `main.ts` timers into their owning modules with upstream's `setInterval` + `unref` idiom and fixes the storage-maintenance start/stop ownership asymmetry.
4. **D4** — S2-PR2 builds the fork-local sweep duty registry: eight ordered phases plus a kill-follow-up list, one shared per-tick context, the three-arm error rule.
5. **D5** — S2-PR3…13 move duties in families, cheapest first, G09 last; `CodexItem` tolerance is a named acceptance case; per-family rewrite-vs-delete measurement.
6. **D6** — S2-PR14 leaves `host-sweep.ts` under 300 lines, measures residue, drafts the upstream contribution into `groups/_ops/upstream-rebaseline-2026-09/contrib/`.
7. **D7** — base branches and the gating table.
8. **D8** — seam-1 deploy conventions verbatim; #274 hazard noted; #259 not duplicated.
9. **D9** — acceptance criteria as exact named cases with per-PR ownership boundaries and verification commands.
10. **D10** — no product decision open; the two §9 items are for awareness.

### Design choices made inside those decisions

- Two registration surfaces, not one: `registerSweepDuty` for the eight phases, `registerSweepKillFollowUp` for the three post-kill duties. A single phase list cannot express constraint 12 (kill → notify → reset → follow-up) without violating constraint 18 (no session held across a kill), because the follow-ups run inside the session the health family opens *after* `killContainer` returns. This is the concrete form of the lead's requirement that any duty which both reads session state and kills becomes two registrations with the kill between them. The follow-up list is also the fork-local prefiguration of the `onStuckAction` event named in the upstream contribution draft.
- Phases are window duty-groups, which is how the perf invariant is mechanized rather than merely asserted: the driver opens W1, W3 and W5 once each and runs that window's duties inside the open session, so grouping — not per-duty opening — is what keeps the per-session open count at PR 5's baseline. R-12 pins the budget at eight.
- Duty accounting: **38 distinct duties, 39 registrations** (S17 registers twice under two names for its tail-retry and post-kill call sites). Eight inventory rows are machinery or pure helpers and are not registered: T1, T3, T4, T23, S1, S20, S21, S22.
- Perf invariant expressed as two assertions rather than prose: one `getActiveSessions()` per tick (R-3) and a per-session open budget that may not exceed mailbox PR 5's worst path of eight short sessions (R-12).
- PR 3 (idle reaps, 79 lines, residue 0) is deliberately first so the G67 rewrite-vs-delete ratio is measured on the cheapest family before the expensive ones are estimated against it.

### Sizing

15 PRs, 38 duties, ~11.65 agent-weeks before overhead, ×1.3 for review rounds and deploy windows ≈ **15 agent-weeks**; 15 single-PR quiet-hour restarts ≈ **5–7 calendar weeks**, floored by mailbox PR 4 and PR 6. Per-PR breakdown in plan §5.

### Acceptance criteria

**65 named cases** across 15 PRs: L-1…L-4 (4), T-1…T-4 (4), R-1…R-12 (12), F-3.x (3), F-4.x (4), F-5.x (4), F-6.x (5), F-7.x (3), F-8.x (3), F-9.x (4), F-10.x (5), F-11.x (4), F-12.x (3), F-13.x (5), F-14.x (2). Names and assertions in plan §8; `/team-build` materializes them verbatim as its first action after approval.

### Cross-model review (plan stage)

- Stage: plan. Primary: Claude (Fable 5.1). Reviewer: Codex CLI, `gpt-5.6-sol`, `model_reasoning_effort="high"`.
- Transport: `codex exec --ignore-user-config --model gpt-5.6-sol -c model_reasoning_effort="high" --ephemeral --yolo --output-schema … --output-last-message …`, tool timeout 3,600,000 ms, wall time 291 s, status **completed**.
- Raw verdict: **needs-attention**, 6 findings, all schema fields present. Artifact: `<scratchpad>/seam2-review.json`.
- Every finding traced to `origin/feat/mailbox-seam-pr5-sweep-family:src/host-sweep.ts` at the cited lines before disposition. One correction batch applied → plan.md revision 2. No re-review, per the contract.

| # | Finding (sev, conf) | Verification against source | Disposition |
|---|---|---|---|
| F1 | Health phase reverses kill precedence; S16 OOM moved onto new paths (high, 0.99) | **Confirmed twice.** `:1723-1755` is one `if / else if / else if / else`: heal → idle-task reap → idle-chat reap → **SLA as the `else`**. Revision 1 ordered SLA second, which would reclassify an idle container past the ceiling from `scheduled-task-idle` to `absolute-ceiling`. `reportContainerOomTelemetry` has exactly **one** call site (`:2088`), inside `enforceRunningContainerSla`'s own observe session, reached only on fallthrough — revision 1's shared `session:observe` phase would have emitted OOM rows on heal and reap paths that never emit them | **MUST-FIX, accepted.** `session:health` is now an `exclusive` phase kind with `claims()` predicates, ordered 10/20/30/40 with SLA as the fallthrough; `session:observe` deleted as a phase; S16 moved to a new `registerSlaObservationHook` surface. F-3.2 rewritten from "reaps register after SLA" (which would have enforced the regression) to an overlapping-predicate test proving idle reap wins over ceiling and that earlier branches emit no SLA telemetry. F-10.6 added |
| F2 | Flat phase-major traversal loses the per-session execution unit (high, 0.96) | **Confirmed.** `:914-944` is session-major: `await sweepSession(session)` runs W1–W5 for one session, then `await new Promise(r => setImmediate(r))`, then the next. Revision 1's "the tick iterates SWEEP_PHASES" reads phase-major, which would plan ~3,200 sessions before waking any | **MUST-FIX, accepted.** §4.4 now specifies the nested driver as a code block: tick-pre → one scan → per session {plan, wake, observe read, health, tail, quiet hint, yield} → tick-post → housekeeping. R-2b added, asserting A's full sequence and yield precede B's first phase and that tick phases run exactly once |
| F3 | One `enteredPlanSession` flag cannot classify later-window opener failures (high, 0.94) | **Confirmed in part.** The flag (`:1539`, set `:1542`, read `:1650`) sits inside the try/catch around W1 only; W2's helpers, W3, W5, the SLA observe and the post-kill session are unwrapped, so their failures reach `sweepOnce`'s catch. Revision 1's claim that one classifier covered every duty was wrong. **But the recommendation's second half is rejected:** adding backoff at later windows would be a behavior change, and it is the wrong behavior — W1 already proved the mailbox openable this tick, so a later failure is a reclaim race, not a persistent fault, and a genuinely persistent fault takes the backoff at W1 on the next tick. Extending it risks the exact defect the corrected PR 5 rule prevents, holding an already-due task for 30 minutes | **MUST-FIX on the plan text, accepted; remedy accepted in part.** §4.5 is now a per-boundary table with a `window` field on both log strings, and states explicitly that only a W1 opener failure backs off and why. R-4 and R-5 parameterized across plan/wake/observe/health/tail/SLA-observe/post-kill for opener **and** callback failure; R-6 extended to a mid-tick vanish |
| F4 | R-10 tested context shape, not depth zero at real call sites (medium, 0.97) | **Confirmed.** Asserting `ctx.mailbox === null` cannot catch a duty that opens its own session and kills inside the callback — plausible precisely because `session:health` permits duties to open their own windows. Enumerated the ten real call sites: `:685`, `:687`, `:800`, `:818`, `:1692`, `:1735`, `:1752`, `:2005`, `:2117`, `:2153` | **MUST-FIX, accepted.** R-10 rewritten to instrument the `AsyncLocalStorage` nesting guard and assert depth 0 at each of the ten, with the old assertion named as explicitly insufficient. R-11 additionally asserts the follow-up session opens strictly after `killContainer` returns |
| F5 | F-10.4 was vacuous (medium, 1.0) | **Confirmed.** `:189` `const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredOperationMs ?? 0)`. A 20-minute declared timeout never widens a 30-minute ceiling, so the case passed even with `CodexItem` deleted | **MUST-FIX, accepted.** F-10.4 now uses a 45-minute declared timeout: no kill at 35 minutes, `kill-ceiling` at 50, plus a control asserting the case fails when the `CodexItem` arm is removed from `activeOperationTimeoutMs` (`:2073-2075`). F-10.5 added for claim tolerance separately, since `:209` uses `CLAIM_STUCK_MS` (60 s) as its floor and 20 minutes **is** discriminating there |
| F6 | PR 1 converts fail-fast startup into silent degradation (medium, 0.95) | **Confirmed.** `main.ts:513-565` has no `try`/`catch` around any of the seven start calls — a synchronous failure rejects boot today, and upstream's `startHostModules` rethrows for the same reason. Revision 1 wrapped them, which would let a host report healthy while cleanup, freshness, plugin updates, commit scan or digests never started. The ledger's "wrap every fork timer body" caveat is about the recurring tick body, not the initial start | **MUST-FIX, accepted.** §4.2 now specifies a bare start call, a guarded recurring interval body and a guarded stop. T-2 inverted: it asserts `startHostModules` **rejects** when a start throws, and separately that a throwing interval tick is isolated and the next tick still fires |

Rejected in whole: none. Rejected in part: F3's remedy (later-window backoff), with source reasoning recorded above and in plan §4.5. Coverage: **cross-model review complete** (other-family reviewer). One correction batch applied; no further loop per the contract.

### Effect of the correction batch

- PR list unchanged: 15 PRs, same 15 families, same base branches and gating.
- Registry shape changed: seven phases (was eight) with a `PhaseKind`, plus **three** registration surfaces (was two). Duty accounting unchanged at 38 distinct duties / 39 registrations.
- Sizing: S2-PR2 1.5 → 1.75 agent-weeks (exclusive-chain semantics, the nested driver spec, per-boundary classification, three surfaces). Series 11.65 → 11.9 before overhead, ≈ **15.5 agent-weeks** at ×1.3. Calendar unchanged at 5–7 weeks.
- Acceptance cases 65 → **67** (R-2b and F-10.5 added; F-3.2, F-10.2, F-10.4, F-10.6, R-2, R-4, R-5, R-6, R-10, R-11 and T-2 rewritten).

### Gating revision (rev 2.2, 2026-09-03)

Reverses rev 2.1's PR 7 gate. The mailbox session confirmed that PR 7 changes only the internals of `modules/claims/self-heal.ts` and `modules/scheduling/{create,live-count}.ts` — their exported functions take ids, not handles, and *exported signatures unchanged* is pinned as a hard constraint on PR 7, with a builder who must break one required to stop and report. S2-PR6 therefore returns to gating on S2-PR2 (mailbox PR 5 via the base branch) and S2-PR11 to gating on **mailbox PR 4**, which is what rev 2 had: PR 11's gate was never PR 5, it is the four legacy-handle bridge sites (`host-script`, `admitDueTaskContexts`, `thread-close`, `recurrence`) that PR 4 owns. Nothing in the series waits for PR 7. The rev 2.1 branch-point note and the PR 6 `db/usage.ts` confirmation are unchanged.

### Gating revision (rev 2.1, 2026-09-03, superseded above)

Gating table only — no design change, no acceptance-case change, no re-review. S2-PR6 and S2-PR11 now wait for mailbox **PR 7**, which empties the last host allowlist entries: `src/modules/claims/self-heal.ts` and `src/modules/scheduling/{create,live-count}.ts` are all still listed at PR 6's head (`origin/feat/mailbox-seam-pr6-operator-surfaces:src/mailbox/RATCHET.json`, 41 entries, verified), and those two families call them, so their signatures may change. Also recorded: PR 2+ must branch from mailbox PR 5's post-linearization head rather than a remembered sha (#271 is being rebased onto PR 3; `5324df6c` is not a valid base), and the `db/usage.ts` prerequisite is confirmed **complete** on PR 6 at `75c24b52` — `rollupSessionUsage` takes `Pick<NanoclawMailboxSession, 'listTurnUsageSince'>` at `src/db/usage.ts:118-124`, reading through `src/modules/mailbox/ops/reads.ts`.

### Open for the operator

Nothing blocking. Plan §9 carries two awareness items: the 15-restart deploy count with a bundling alternative, and the drafted-but-unposted upstream contribution. Approval of `plan.md` revision 2 is required before `/team-build`.

## Stage: build

Not started.
- 2026-09-03 07:30 ET — operator approved plan rev 2.2 ('go for it'); build delegated to session update-nanoclaw-3; S2-PR0/PR1 unblocked; PR2+ wait for mailbox PR 5/4 final heads (open Codex P1/P2 fixes pending on #271/#291).

### Build start (2026-09-03 11:20 ET-morning, orchestrator session `update-nanoclaw-3`)

- Approved plan: `docs/specs/upstream-host-sweep-seam/plan.md` rev 2.2 (status line committed at `2713edc0`). Git state at start: live checkout clean on `main` = `origin/main` = `2713edc0`.
- Scratch worktrees under the session scratchpad (never the live checkout; `node_modules` symlinked read-only to the live tree; binaries invoked directly, `nice -n 10`, targeted suites only): `wt-s2-pr0` → `feat/host-sweep-seam-pr0-lifecycle`, `wt-s2-pr1` → `feat/host-sweep-seam-pr1-module-timers`, both cut from `origin/main` `2713edc0`. PR 1 stacks on PR 0's first commit (it needs `onHostStart`); the PR 0 builder hands the sha over by file.
- Dispatch: two `worker`-tier builders IN PARALLEL (plan §5 tier column), briefs at `<scratchpad>/brief-{common,pr0,pr1}.md`; reports go to files (seam-1 lesson: long teammate messages arrive late and truncated).
- Verified before dispatch: `git show 5c3082a1:src/host-lifecycle.ts` sha256 `fbf37333e51a…` (matches plan); `src/host-lifecycle.test.ts` `aa8077a4b73e…`; scratch-worktree + symlink recipe runs `src/mailbox-seam-upstream.test.ts` 25/25.

**Plan correction (§4.1) found at dispatch:** upstream's `src/host-lifecycle.ts` imports `type { DbDriver } from './db/driver.js'`; the fork has no `src/db/driver.ts`, so a byte-identical port cannot typecheck as written. Resolution (engineering, no intent change): PR 0 adds a fork-owned TYPE shim `src/db/driver.ts` exporting `DbDriver` as an alias for the fork's better-sqlite3 handle (what `initDb` returns), so `HostStartContext.db` is the sync handle exactly as §4.1 states and the ported file stays byte-identical under the manifest. The shim is not in `UPSTREAM_FILES`; upstream's real async driver replaces it in the async-DB seam. plan.md §4.1 is amended in the same commit as this note.

### S2-PR0 build — correction 2 (upstream test file unportable)

- Builder report (`217706d6` port + wiring, `b5a5e20e` tests): L-1, L-3, L-4 pass; tsc/prettier/public-boundary clean; both ported files hash-match `5c3082a1`. **3 of the 8 cases in upstream's byte-identical `src/host-lifecycle.test.ts` fail on the fork**: `starts after delivery is ready and before delivery polling` and `aborts modules and awaits their LIFO shutdown before host cleanup` read `src/index.ts` (fork boots in `src/main.ts`); `registers built-in approvals cleanup with the host lifecycle` asserts approvals registers `onHostShutdown` (fork approvals use `response-registry` `onShutdown`; migrating it contradicts L-4 at PR 0). Verified against `git show 5c3082a1:src/host-lifecycle.test.ts` (cases at :125, :135, :146).
- Decision (engineering, D2 amended; plan §4.1, §4.6, L-2 corrected in this commit): the test file is **unportable** — `UPSTREAM_FILES` = `src/host-lifecycle.ts` only; fork-owned `src/host-lifecycle.test.ts` keeps upstream's five registry cases verbatim; `UNPORTABLE_UPSTREAM_FILES` records the file + reason (mailbox PR 7 mechanism); orchestration cases covered by L-3; approvals case deferred with re-raise trigger = the PR that migrates approvals' shutdown hook onto `onHostShutdown` (S2-PR14 at the latest). No intent/scope change: PR 0 stays inert.
- L-3 shape delivered: source-position assertions on `main()` and `shutdown()` in `src/main.ts` (precedent `src/main.memory-startup-order.test.ts`) plus a runtime assertion that `startHostModules` hands the same `{db, signal}` ctx to every callback. Accepted.
- Branch is not rebased onto `main` (4 unrelated docs commits); rebase happens on deploy night per the standing procedure.
- Refinement (program lead, accepted): the two upstream boot-order cases are KEPT in the fork-owned file with only the read path swapped to `src/main.ts`; verified by `diff` against `git show 5c3082a1:src/host-lifecycle.test.ts` — the only deltas are the header comment, the removed approvals case (8 lines) and the two path lines. Correction commit `444b5366`; manifest now covers `src/host-lifecycle.ts` alone; `UNPORTABLE_UPSTREAM_FILES` records the test file with reason and fork replacement. Lead's fresh verification + Codex implementation review dispatched on `2713edc0..444b5366`.
