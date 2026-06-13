# Post-Build Drift Report: Plan (SOT) → Implementation

> `/team-drift` (post-build, plan-vs-implementation) — 2026-06-13, invoked by `/team-build` Step 7 under `/team-auto`.
> SOT: `plan.md` (26 tasks, A1–A6 / B1–B4 / C1–C6 / D1–D4 / E1–E6) · Target: the built implementation (14 source files + co-located tests).
> Extractors: Claude (general-purpose) + Codex (read-only, reasoning=xhigh), independent, two-document boundary.

## Result

| Class | Count |
|-------|-------|
| CONFIRMED | 122 |
| PARTIAL | 3 (all minor/justified — none blocking) |
| DIVERGED | 0 |
| MISSING | 0 |

**Gate: PASS** — MISSING 0, effective DIVERGED 0.

### Cross-model convergence (the decisive signal)
The two extractors ran independently on the two-document boundary. Claude produced an exhaustive 126-claim verdict table; Codex independently read every implementation file, verified the named test cases, and — applying explicit skepticism ("test names alone can hide contract drift; I'm checking the suspicious cases directly") — homed in on the **exact same three** soft spots Claude flagged as PARTIAL: move claimed-state/503 test coverage, the E3 prompt search, and the module static-map test. **Neither extractor escalated anything to DIVERGED or MISSING.** Two independent models converging on the same three (and only three) non-CONFIRMED items, all PARTIAL, is the strongest PASS this check produces.

### Every load-bearing claim CONFIRMED, traced to enforcing code (not test-only)
The §4.2 move-execute sequence — move_intent audit written BEFORE cancelTask (move.ts:463-485), staged paused-insert F1 (move.ts:517-532), fresh-row-id compensation never deleting a succeeded target (move.ts:487-502,546-563), exactly-one-live-row fleet-wide invariant (move.ts:586-596), TOCTOU delta_changed 409 (move.ts:430-433), source_busy 409 (matrix-gated), 503-on-unreadable (move.ts:426-427); run-now 503-on-unknown F6 (matrix.ts:95-98) + needs_force-near-slot F3; cron-edit M6 recompute (mutations.ts:262-265); resume skip-missed-slots §4.7 (mutations.ts:349-352); cancel pure-strand + action='cancel' (mutations.ts:428-466 via cancelSeriesWithStrandClear); sweep recoverMoveIntents fleet-wide+idempotent+additive (host-sweep.ts:354-453); pruneAuditBodies 90d NULL-bodies-keep-metadata (host-sweep.ts:465-480); single moduleOwner registry owner='memory' (scheduled-shared.ts:281-298); 9 routes requireAuth + splat-last (dashboard/index.ts:73-85); no materialized read table (D10) and insert-first move (D14) both correctly ABSENT. All named test cases across the 14 test files present.

## The 3 PARTIALs (logged for user review — none block the gate)

| # | Area | Finding | Disposition |
|---|------|---------|-------------|
| P1 | D2 — move execute 503 | `503 session_unreadable` on an unreadable SOURCE inbound.db is **enforced in code** (`scheduled-move.ts:426-427`) but has **no dedicated move test** (the sibling C-path in `scheduled-mutations.test.ts` does test the 503). Test-coverage gap only — the code is correct. | **ACTION:** add `test_move_unreadable_source_503` (the one actionable gap — directed to builder-A). |
| P2 | C5 — module static-map test | `test_mnemon_static_map` asserts a `memory-lint-*` id, not a literal mnemon series id. **Justified:** the live-fleet cross-check (33 series) found ZERO mnemon/support series, so the static map is intentionally empty (documented `scheduled-shared.ts:276-279`); the plan's "known mnemon series id" has no real referent. | **ACCEPT** — correct-as-built; the static-map mechanism IS exercised. Test name is a minor nuance. |
| P3 | E3 — free-text search | Search matches `series_id / agent_group_name / channel_name / cron` (the fields present on snapshot rows), not the prompt body. The plan E3 prose says "search over prompt," but prompt text is **deliberately excluded from the lean list snapshot** (fetched only in the detail drawer, per the read-layer design D-decision); searching prompt would require widening the snapshot the design rejects. | **ACCEPT as plan-vs-design tension** — impl faithfully follows the design. Flagged to Dave at the ship gate as a scope note (prompt-text search is not in v1; the prompt is visible per-task in the drawer). |

## No DIVERGED into rejected options
Both extractors confirmed the implementation never reintroduces a rejected option: materialized read read-table (D10), insert-first move (D14), moving one-offs/thread-loops (kind-masked in the matrix), single-RPC endpoint, central scheduling-table migration — all correctly excluded.

## Gate
MISSING 0 · DIVERGED 0 · PARTIAL 3 (P1 actioned, P2/P3 accepted). **Post-build gate PASSES.** Implementation faithfully realizes the plan; proceed to Stage D (`/team-qa`) after P1's test lands.
