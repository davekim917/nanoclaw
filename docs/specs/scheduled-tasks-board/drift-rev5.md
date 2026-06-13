# Drift Report: F1–F6 Resolution Claims → design rev 5

> `/team-drift` — 2026-06-13, invoked by `/team-auto` (Stage A cap-cycle verification, in place of a 4th review cycle)
> SOT: F1–F6 converged cycle-3 review resolutions (`.claude/tmp/drift-sot.md`)
> Target: `docs/specs/scheduled-tasks-board/design.md` rev 5
> Extractors: Agent A (Claude, general-purpose) + Agent B (Codex, read-only, reasoning=high) — independent, two-document boundary

## Result

| Class | Count |
|-------|-------|
| CONFIRMED | all substantive claims (Claude 17/17; Codex 22/23) |
| PARTIAL | 1 — stale doc footer (Codex-only catch), **fixed** |
| DIVERGED | 0 |
| MISSING | 0 |

Both extractors independently reached the same substantive verdict: every F1–F6 resolution claim and both LOW carry-forwards are CONFIRMED in rev 5, with verbatim matches on the load-bearing strings (`max(2 × SWEEP_INTERVAL, 2min)`; the three-step staged-insert sequence; the reworded standing privacy guarantee; `503 claim_state_unreadable`; both REJECTION claims — stale imminent-fire sentence absent, true skip-next not claimed as v1).

## The one PARTIAL (resolved)

Codex Claim #1 (meta: "target is rev 5 with all fixes applied") → PARTIAL: the design's closing **Status/Next-step footer still read "rev 2 — awaiting Codex cross-model pass."** A stale footer, not a substantive drift — the header (line 3) and all six fix sections were correct. **Fixed**: footer updated to rev 5 / approved / next-step `/team-plan`. Claude's extractor did not surface this because it extracted only the SOT's own claims (the footer is not an F1–F6 claim); Codex added the implied meta-claim and caught it — exactly the cross-model-diversity value.

## Per-fix confirmation

- **F1** staged paused-insert (`scheduleTask now+guard_grace → pauseTask → updateTask`) + stale sentence removed — CONFIRMED both.
- **F2** fleet-wide recovery predicate + idempotent re-check before restore — CONFIRMED both.
- **F3** `force` = documented residual, 409 default retained, true skip-next → v2 OUT — CONFIRMED both.
- **F4** `guard_grace = max(2×SWEEP_INTERVAL, 2min)`, distinct from stall formula — CONFIRMED both.
- **F5** `move_intent.detail_json` time-bounded exception, purged on `resolved_at`, guarantee reworded — CONFIRMED both.
- **F6** run-now × unknown = `503 claim_state_unreadable`; edit/pause/cancel remain — CONFIRMED both.
- LOW: matrix one-table-driven enforcement note; axes-precedence note — CONFIRMED both.

## Gate

MISSING 0 · effective DIVERGED 0 · PARTIAL 0 (the lone PARTIAL fixed). **No blocking drift — rev 5 faithfully implements every cap-cycle resolution.** Review stage clears; `/team-auto` proceeds to Stage B (`/team-plan`).
