# Build State — scheduled-tasks-board

> Lead checkpoint (survives context compression). Branch: `feat/scheduled-tasks-board`. Team: `scheduled-tasks-board-build`.

## Pre-build status
- Pre-build drift (design rev5 vs plan): PASS after reconciliation (MISSING 0, DIVERGED 0). Report: `pre-build-drift.md`. Plan reconciled to 26 tasks (added D4 audit-prune, repair-row surfacing, preview 404, +6 ASSERTs).
- Branch `feat/scheduled-tasks-board` cut from main (keeps main clean; live host unaffected — team-auto stops at ship gate, no build+restart).

## Build order
A (foundations) → B (read) → D (move) → C (mutations+routes); E (frontend) parallel.
Task IDs: A=1, E=3, B=5(blockedBy A), D=7(blockedBy A,B), C=8(blockedBy A,B,D).

## Wave 1 spawned (in_progress)
- **builder-A** (Group A, task 1): 6 tasks A1-A6. Owns: 043 migration, schema/session-db index, scheduled-tasks.ts TaskDef.script, scheduling/db.ts restoreTaskRow+cancelSeriesWithStrandClear, scheduled-board-matrix.ts, scheduled-shared.ts (+ tests). Blocks B/C/D.
- **builder-E** (Group E, task 3): 6 tasks E1-E6. Owns: ScheduledBoard.tsx, ScheduledDrawer.tsx, lib/api.ts, BoardShell.tsx, main.tsx (+ tests). Confirmed active (TDD RED tests written for api.ts). Render-check §3c lead-verified post-build.

## Validation gates per group (before marking complete)
- Each named test from the plan exists (grep by name) AND passes individually — NOT just aggregate suite green.
- Each ASSERT verified by reading the file + running the test (not builder self-report).
- `pnpm run build` (host tsc) clean; dashboard typecheck clean for E.
- No regressions: existing `pnpm test` passes.
- Two-stage review (spec-compliance + code-quality) before complete.
- E1 render-check: lead visual verification (playwright/screenshot or human approval) — NOT builder self-report.

## Lead decisions during build
- **SWEEP_INTERVAL_MS home (builder-A blocker, approved):** the board's `SWEEP_INTERVAL_MS` constant lives EXPORTED in `src/dashboard/api/scheduled-shared.ts` (A6, builder-A's file), mirroring private `host-sweep.ts:90` (60_000) with a cite comment. A5 imports it from there. **Group D MUST import SWEEP_INTERVAL_MS from scheduled-shared.ts — do NOT re-export it from host-sweep.ts or add a second board copy** (avoids the cross-group boundary violation + merge conflict). My original spawn prompt wrongly suggested editing host-sweep.ts; corrected.

## Known risks to honor
- A2: C5 must cross-check module-owned registry vs live fleet's 22 series (record in commit).
- A3: B1 must record warm-assembly wall-time (if >1s, revisit chunk size).

## Next after build
Post-build drift (plan vs implementation) → team-auto Stage D (QA) → stop at ship gate.

## VALIDATED complete
- **Group A** (builder-A): VALIDATED. 102 tests pass (6 files), host `pnpm run build` (tsc) clean, `scheduled-audit` migration applies in-chain. All A1-A6 exports confirmed by ground-truth grep (the mid-build LSP diagnostics were stale). SWEEP_INTERVAL_MS approach-A applied correctly (exported in scheduled-shared.ts, matrix imports it).
- **Group E** (builder-E): VALIDATED. 40 own tests + 97 total dashboard suite (0 regressions), dashboard tsc clean, vite build clean. All 17 named test cases present. Scope note: builder-E appended a namespaced `.nc-sched-*` block to `dashboard/src/styles.css` (NOT in its ownership list, but NO group owns styles.css and it's append-only namespaced — accepted minor; the render-check palette tokens must live in CSS). **Render-check (§3c) DEFERRED to post-build** — the `/dashboard/api/scheduled` route isn't live until Group C registers it, so the board isn't renderable with data yet; I'll do the visual contrast check (stalled-red on dark card) once the route is wired, OR flag to user then.

## Wave 2
- **builder-B** (Group B, task 5): SPAWNED with A's exact export signatures + the frozen ScheduledRow contract field names (so it matches E's client types at integration). Building B1-B4. **COMPLETE + VALIDATED** (see below).

## VALIDATED complete (Group B)
- **Group B** (builder-B, validated by lead): VALIDATED + committed. Files: `scheduled-assembly.ts` (chunked single-flight assembly, all health detectors incl. strand + duplicate-successor, NUL `\0` channel-name join key matching `channelNameOf`/`doAssemble`, `_resetAssemblyInFlightForTesting`), `scheduled-read.ts` (scope-filtered list + decode-key detail, repair-row folding, audit_tail at mutation tier, out-of-scope 404), `scheduled-read.test.ts`, plus Group-B edits to `scheduled-assembly.test.ts` (single-flight beforeEach reset — the cross-file-flake fix) and a comment-only `scheduled-shared.ts` clarification of `SWEEP_INTERVAL_MS`'s home.
  - Gates: 29/29 scoped (assembly+read) pass; full dashboard suite 236/236 clean; prior full-area run 411/411. The "1 failed file / 0 failed tests" seen under the full parallel run is transient `/tmp` SQLite I/O contention from sibling `nanoclaw-codex-fb-*` agents (fixture setup, not an assertion) — confirmed transient by re-running dashboard/ alone clean.
  - Test-isolation defect FIXED: detail test passed in isolation but failed in full suite (channel_name null) due to shared singletons (scheduledCache / in-flight / read-options) leaking across files; resolved via `beforeEach` reset. Verified.
  - A3 perf assumption VALIDATED: warm assembly measured 56ms vs 1s budget.
  - NOTE: full host `tsc` is currently RED only because builder-A's in-progress `scheduled-move.test.ts` references the not-yet-exported `moveExecuteHandler` (Group D mid-TDD). Group B's own files compile clean; full-build tsc gate deferred to post-Group-D.
  - **Collision footnote:** builder-A briefly auto-claimed Group B after finishing A; both converged independently on the identical NUL-separator + single-flight-reset fixes. Serialized to builder-B as sole writer; corruption (buildDetailRow undefined, space-vs-NUL separator) repaired. Root cause: shared working dir + idle builders free-claiming unblocked tasks.

## Group A contract clarifications (MUST embed in D + C spawn prompts)
- `VerbCtx` (scheduled-board-matrix.ts) includes `forced?: boolean` in addition to {state, kind, claimed, processAfterMs, nowMs}. C's run-now handler passes `forced:true` to verbVerdict when the user confirms the near-slot override (F3).
- `AuditEntry` (scheduled-shared.ts) carries optional `scriptBefore`/`scriptAfter` (HASH-ONLY — stored as scriptBeforeHash/scriptAfterHash in detail_json, never verbatim). C/D edit-audit callers pass scripts THERE, NOT in `before`/`after`. For moves, secret NAMES are dropped → pass `secretGainsCount`/`secretLossesCount` only (D8 / §4.5).
- `writeAudit` for `move_intent` persists the snapshot verbatim in detail_json (the one F5 exception); `purgeIntentBody(db, correlationId)` nulls it + stamps resolved_at in one statement.
- Matrix is ONE structure: `verbVerdict(verb, ctx)` + `availableVerbs(ctx)` are the ONLY guard source — C/D handlers call verbVerdict, never re-implement guards.
- `ScheduledSnapshot = Record<string,unknown>` is a permissive placeholder in shared; B produces the concrete value.

## Collision resolved
builder-A auto-claimed Group B after finishing A; stood down. builder-B is sole Group B owner. Lesson: idle builders free-claim unblocked tasks — assign D/C explicitly and stand down finished builders, OR shut them down at group boundary.

## Frozen contract (B must match E's client types)
list `{rows, counts, degraded, assembled_at}`; ScheduledRow fields: key, series_id, agent_group_id, agent_group_name, provider, channel_name, channel_type, thread_id, kind, cron, next_fire_utc, next_fire_local, health, module_owner, quiet_status, flag_intent, last_fires[].outcome, available_verbs. Detail adds prompt, script, history, audit_tail?.

## VALIDATED complete (Group D)
- **Group D** (builder-A): VALIDATED. 16/16 named tests present (4 preview, 6 move, 3 recover, 3 prune); 75/75 pass in `scheduled-move.test.ts` + `host-sweep.test.ts`. Compiles clean (0 tsc errors in move/sweep). The lone WARN in the run is the expected `test_move_compensation_restores_source` scenario (target insert fails → `restoreTaskRow` source). Files: `scheduled-move.ts` (movePreviewHandler + moveExecuteHandler), `src/host-sweep.ts` (recoverMoveIntents D3 + pruneAuditBodies D4 in one additive MODULE-HOOK), + tests. NOT yet committed (held with Group C).

## Group C status (C1–C5 validated; C6 + integration fixes in flight)
- **C1–C5** (builder-A): VALIDATED. 18/18 named tests present (4 edit, 3 pause/resume, 5 run-now, 3 cancel, 3 module-owner); 22/22 `scheduled-mutations.test.ts` pass.
- **C6** (route registration) in_progress.
- **C5 live-fleet cross-check (DONE by lead):** 33 active series — 10 `memory-synth-*`, 10 `memory-lint-*` (both module-owned, owner='memory'), 12 `task-*` operator, 1 `task-…-support-poller` (operator-owned, NOT module-owned — confirmed no auto-reseed via `per-email-thread-sessions/activation-runbook.md:45`), ZERO `mnemon-*`/`support-*` series. So C5's registry (memory-synth-/memory-lint- → 'memory', empty static map) is CORRECT against ground truth.

## Pending integration fixes (directive sent to builder-A — do AFTER C6, before Group C complete)
1. **MUST (spec violation):** unify the module-owner registry. assembly.ts:93-97 ships a DIVERGENT local copy (owner='mnemon' + dead mnemon-/support- prefixes) that violates plan C5 ASSERT (owner must be 'memory') and populates the user-visible badge wrong. Fix: single `moduleOwner` in scheduled-shared.ts, imported by BOTH assembly + mutations; assembly:403 → `moduleOwner(seriesId).owner ?? null`; delete assembly's local `moduleOwnerOf`/`MODULE_OWNED_PREFIXES`. (No import cycle — verified.)
2. **SHOULD (hygiene):** scheduled-assembly.ts has 2 raw 0x00 NUL bytes (lines 287 lookup + 653 build) as the channel-name map separator — consistent so functionally green, but reads as binary to tooling. Replace with ` ` escapes.

## Not yet done
- builder-A: finish C6 + the 2 integration fixes, re-run `npx vitest run src/dashboard/api/ src/host-sweep.test.ts` green.
- Lead: validate C6 (9 routes registered, requireAuth-wrapped, splat last) + the integration fixes; then FULL host `pnpm run build` (tsc — now unblocked) + FULL `pnpm test` + dashboard build; commit Groups D+C.
- ~~Render-check (§3c health-pill palette)~~ **DONE — PASS (lead, computed WCAG):** the flagged "stalled-red on dark card" combo clears AA — stalled count `--st-failed` on `--st-failed-bg`(red@0.14)/panel = **4.82:1** (≥4.5 normal text); stalled border on panel = **5.74:1** (≥3 UI); degraded badge / inline-stalled header = 4.82:1; stalled-link text 15:1. Computed from the actual oklch tokens (rigorous > screenshot). Lone sub-threshold: the 10px uppercase micro-label (`--fg-3`) at 3.55:1 — pre-existing app-wide label token, NOT the flagged red concern, and the count it labels passes; non-blocking a11y nit. **Residual:** styles.css:1296-1297 still carries the stale `[RENDER-CHECK] pending` comment — flip to "verified PASS" (trivial doc edit; fold into builder-A cleanup or post-build).
- Post-build drift (plan vs implementation). Then team-auto Stage D (QA). STOP at ship gate.

## ✅ ALL GROUPS BUILT + VALIDATED + COMMITTED (update)
- Commits on `feat/scheduled-tasks-board`: `ef9b1c9b` (A+E), `f95a8357` (B), `ebe456b6` (C+D + integration unification).
- **Group C** VALIDATED: 18/18 named, 22/22 mutations; C6 9 routes (requireAuth, scheduled ns, splat last).
- **Integration fixes** DONE+validated: single `moduleOwner` in scheduled-shared.ts (owner='memory'); assembly's 'mnemon' copy removed; 2 NUL bytes → ` ` escapes; B test-isolation mkdtemp hardened (448/448 incl. shuffled).
- **Authoritative gates (lead):** host tsc CLEAN; full host suite **1792 pass / 0 fail** single-threaded (parallel-run failures = /tmp SQLite contention, proven green in isolation 67/67); dashboard tsc CLEAN; prettier-clean; tree clean.
- **Render-check §3c** PASS (computed WCAG; styles.css comment flipped to verified). builder-A also fixed a real D2 restoreTaskRow PK-collision bug.
- **Post-build drift: PASS** (`post-build-drift.md`) — Claude+Codex independent, **122 CONFIRMED / 3 PARTIAL / 0 DIVERGED / 0 MISSING**; both models converged on the same 3 PARTIALs (none blocking). Every load-bearing ASSERT traced to enforcing code; rejected options (D10 materialized table, D14 insert-first) confirmed absent.
  - P1 (move 503-on-unreadable: code correct, no dedicated test) → directed builder-A to add `test_move_unreadable_source_503` (only actionable item). P2 (mnemon-static-map test) ACCEPT correct-as-built. P3 (E3 search list-fields-not-prompt) ACCEPT — plan-vs-design tension, impl follows design; flag to Operator at ship gate.
- P1 test added + committed (`bcbbe408`).

## ⚠️ Stage D QA — COMPLETE, found 6 MUST-FIX → fix pass IN PROGRESS (operator approved "go")
- **QA report:** `qa-report.md`. Denoise CLEAN; Style 1 SHOULD+2 ADV; Doc 1 SHOULD (fixed B-1); review-swarm (4 reviewers: adversarial/domain/security/concurrency) 4 BUG+17 SUGG; Codex 4 (2 after reconciliation). All reviewers reconciled, zero cross-lane contradictions.
- **6 MUST-FIX:** M1 recovery bare-series_id over-count→cross-group loss; M2 fleet-count swallow-read→undercount→double-row; M3 editHandler non-string→live-content corruption; M4 decodeKey path-traversal; M5/M6 group-filter server-side no-op + test.
- **Reconciliation wins:** Codex E-2 (cancel-race) REFUTED by tracing the synchronous read→cancel span (downgraded to SHOULD-FIX defensive); CONC-BUG (swallow→double-row) UPGRADED to MUST-FIX. S7 = lead's own NUL→space directive regression.
- **Fix pass:** spec at `qa-fixes.md`; single builder `fixer` (agentId ab06f310...) doing 6 MUST-FIX + 6 high-value SHOULD-FIX (E-2/E-3/E-4/S7/ADV-S1/ADV-S2) + A-1, TDD. Deferred: cosmetic ADVISORY (A-2/A-3/B-2/S1-S6/CONC-S1/S3/S4/ADV-S4).
- **Fix pass COMMITTED `9dfac427`** + validated by lead: host tsc clean, dashboard tsc clean, full host suite **1823 pass / 0 fail** (single-thread), all 6 MUST-FIX named tests present (incl. `test_recover_scoped_count_ignores_unrelated_group`). Lead independently re-read + verified the 4 most-critical fixes against code: H1 `countLiveRowsInSessions` (scoped + fail-safe), `recoverMoveIntents` (M1 scoped count + M2 unreadable-defer + ADV-S2 resolve), E-2 invariant enforcement (500+leave-intent, cancel-0-abort), M4 decodeKey (`.`/`..`/NUL reject + `sessionInboundPathFor` containment).
- **Re-QA COMPLETE** (operator-approved `/team-qa --only swarm,codex`): Codex + 3 reviewers (concurrency/security/adversarial). Verdict:
  - All 6 original MUST-FIX **confirmed fixed** (Codex + concurrency + security independently). M4 traversal **fully closed** (security repro'd both layers). E-3 scope-leak **gone**.
  - Codex's lone NEW HIGH (recovery purges `liveCount>1` double-row) **adjudicated as an intentional conservative limit, NOT a bug** (concurrency-reviewer + lead trace): the duplicate is pre-existing, E-2 already returned 500, the board's duplicate-successor health surfaces it, and Codex's "leave-unresolved" fix would reintroduce the ADV-S2 zombie + auto-dedup is its own data-loss risk. Added an observability `log.warn` on the `>1` branch (host-sweep.ts) — no logic change.
  - **NEW MUST-FIX found by adversarial-reviewer (confirmed by security repro): cron-validation gap** — M3 guarded prompt/script but left `cron` unguarded; `{"cron":""}`/`{"cron":null}` bypass cronIsValid (cron-parser 5.5.0 accepts them as wildcard) → write `recurrence=''`/null → **runaway per-minute fire loop** (the recurring-task-runaway class). Security's full input-surface audit confirmed cron was the SOLE unguarded boundary. FIXED: `typeof` guard + `cronIsValid` empty-string rejection (scheduled-mutations.ts) + regression test `test_edit_cron_empty_or_null_rejected_no_runaway`.
  - Security SUGGESTION applied: preview `readSourceLiveRow` routed through `sessionInboundPathFor` (containment backstop on the preview read path).
- **Residual fixes COMMITTED** (this commit): cron fix+test, preview chokepoint, recovery `>1` log. Gates: host tsc clean, dashboard tsc clean, full host suite **1828 pass / 0 fail** (single-thread).
- **Deferred follow-up (non-blocking):** `scheduled-move.test.ts` + `host-sweep.test.ts` still hardcode fixed `/tmp` dirs → flake under parallel CI; switch to `mkdtempSync` like the other test files (concurrency-reviewer note).
- **NEXT: SHIP GATE** — present to Operator. Nothing merges/pushes/deploys without him.
