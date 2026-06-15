# Pre-Build Drift Report: Design rev 5 (SOT) → Plan

> `/team-drift` (pre-build, design-vs-plan) — 2026-06-13, invoked by `/team-build` Step 2 under `/team-auto`.
> SOT: `design.md` rev 5 · Target: `plan.md` · Extractors: Claude (general-purpose) + Codex (read-only, reasoning=high), independent, two-document boundary.

## Result (after plan reconciliation)

| Class | Initial | After fix |
|-------|---------|-----------|
| CONFIRMED | 76 (Claude) / 46 (Codex) | all |
| PARTIAL | 11 / 5 | 0 (closed) |
| DIVERGED | 0 / 1 | 0 (fixed) |
| MISSING | 2 / 2 | 0 (added) |

Both extractors independently converged on the same blocking gaps — the plan **under-encoded** mechanisms the design already specifies. Per the `/team-build` pre-build gate, the correct action is "fix the plan to match the design (the plan was wrong)" — no design change, every fix cited to a design section. Reconciled before team creation.

## Blocking gaps closed (MISSING / DIVERGED)

| # | Gap | Both/one | Fix in plan |
|---|-----|----------|-------------|
| MISSING-1 | 90-day audit-body retention prune (§5 IN + §4.4) had no task | Both (Claude #57, Codex #42) | **New Task D4** — `pruneAuditBodies` sweep step (same host-sweep MODULE-HOOK as D3); NULLs body columns at 90d, keeps action metadata for series lifetime |
| MISSING-2 | `move_restore_failed` / stale `move_intent` audit-only repair rows surfaced as stalled on the strip (§4.2 step 5) had no consuming task | Claude #93b MISSING, Codex #24 PARTIAL | **B3** now folds unresolved audit repair rows into the snapshot via `idx_scheduled_audit_unresolved`; **E1** renders them in the stalled section |
| DIVERGED-1 | Preview returned 403 for non-manage caller; design §4.2 says "404 otherwise" (disclose-as-not-found, C7 — 403 reveals existence) | Codex #27 DIVERGED | **D1** interface + test changed to 404 disclose-as-not-found |

## High-value PARTIALs closed

| Gap | Fix |
|-----|-----|
| Mutation against an unreadable-session `:key` → 503 `session_unreadable` (§3a) not asserted | Added to C-group shared contract + D2 ASSERT |
| Move audit rows keyed to BOTH groups (one per side, shared correlation_id, §4.4) not asserted | D2 ASSERT (two-row write) |
| `detail_json` secret-delta = counts+hashes only, names never persisted (§4.4) not asserted for non-intent move rows | A6 ASSERT |
| Duplicate-successor `kind='task'` filter + "list/detail return ALL live rows for dup series" (§4.1) not carried into B2/B3 | B2 ASSERT |
| One-off overdue interval = 2 sweeps (§4.1) not asserted | B2 ASSERT |
| Cron edit `.next()`-twice finite-interval check (§4.5) not asserted | C1 ASSERT |
| Mutation handlers emit `session_event` with non-null `agent_group_id` (§4.5) not asserted | C-group shared contract |
| Thread-loop badge (§5 IN) not explicit in E2 | E2 ASSERT |

## No DIVERGED into rejected options

Both extractors confirmed the plan never reintroduces a rejected option: materialized read table (D10), insert-first move (D14), moving one-offs/thread-loops (§5 OUT), single-RPC endpoint (§3b-B), central scheduling-table migration (D1) — all correctly excluded.

## Gate

MISSING 0 · DIVERGED 0 · PARTIAL 0 after reconciliation. **Pre-build gate PASSES.** Plan faithfully reflects design rev 5; team creation proceeds.
