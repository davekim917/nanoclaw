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
- **builder-B** (Group B, task 5): SPAWNED with A's exact export signatures + the frozen ScheduledRow contract field names (so it matches E's client types at integration). Building B1-B4.

## Frozen contract (B must match E's client types)
list `{rows, counts, degraded, assembled_at}`; ScheduledRow fields: key, series_id, agent_group_id, agent_group_name, provider, channel_name, channel_type, thread_id, kind, cron, next_fire_utc, next_fire_local, health, module_owner, quiet_status, flag_intent, last_fires[].outcome, available_verbs. Detail adds prompt, script, history, audit_tail?.

## Not yet done
D, C builders await B. Render-check (E1) deferred to post-build. Post-build drift pending. QA (Stage D) pending.
