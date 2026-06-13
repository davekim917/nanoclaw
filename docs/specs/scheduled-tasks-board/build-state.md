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

## Not yet done
D, C builders await B. Render-check (E1) deferred to post-build. Post-build drift pending. QA (Stage D) pending.
