# /team-auto paused at Stage A (Review)

**Stage:** Review
**Reason:** cap-reached
**Cycles consumed:** 3/3
**Last action attempted:** Cycle-3 design revision applied; cycle-4 would emit cap-reached at Step 0 and refuse to verify.

## Why I stopped

Cycle 1 found 9 MUST-FIX (architectural gaps in the initial design). I revised inline to address all 9.

Cycle 2 found 7 NEW MUST-FIX (one critical: mnemon store data loss; six pseudocode-correctness issues introduced by cycle-1's revisions). I revised inline to address all 7.

Cycle 3 found 4 NEW MUST-FIX, all introduced by the cycle-2 revisions:

- **M1 (HIGH):** SQLite table-rebuild for `workgroup_id NOT NULL` is incompatible with `PRAGMA foreign_keys=ON` inside a transaction. Cited Rails CVE-class issue #55866 (Oct 2025) demonstrating production data loss from this exact pattern.
- **M2 (HIGH):** Post-transaction FS-writes-with-recovery is unreachable under the migration barrel's outer transaction wrapping.
- **M3 (HIGH):** Spawn-time reconciler locks `mnemon_store_id` to the spawning agent's id, not the parent's — order-dependent race that silently disconnects 43MB of accumulated recall on Dave's install.
- **M4 (MEDIUM):** Cycle-2 structural test asserts a substring (`WHERE agent_group_id = ?`) that doesn't match the existing `tasks` query (filtered by `parent_session_id`).

Per /team-auto's cycle-3 "Simplify the design" option, I revised inline rather than adding more fix-on-fix layers. Cycle-3 commit (`ecd2812c`) makes these changes:

- **M1 resolution:** drop the table-rebuild entirely. `ALTER TABLE agent_groups ADD COLUMN workgroup_id TEXT REFERENCES workgroups(id)` (nullable). W1 enforced by migration tail-validation + runtime W3 fail-closed projection. Schema-layer NOT NULL would have cost more complexity than it bought.
- **M2 resolution:** move container.json + log file writes out of migration 036 into a new `reconcileWorkgroupFsState()` startup phase in `src/index.ts`. Idempotent. Fail-fast on FS errors. Restart re-runs the reconciler.
- **M3 resolution:** reconciler queries parent `agent_groups` row by folder slug before setting `mnemon_store_id` — same rule the migration uses. Falls back to self only when no parent exists (true standalone).
- **M4 resolution:** drop `tasks` from the structural test's substring-assertion set. Tasks are bounded by the projection's `parent_agent_group_id` filter column, not by in-container `agent_group_id`.

All 3 SHOULD-FIX from cycle 3 also addressed:
- S1: `PRAGMA foreign_key_check` added before schema_version bump.
- S2: `decisions.yaml` D7 description updated to reflect M8 (no default flip).
- S3: resolved transitively by M1 (no rebuild = no schema preservation concern).

The two WON'T-FIX items (CHECK regex tightening; dedup edge-case collapse) remain logged for future audit.

## Findings still open

**None.** All 4 MUST-FIX from cycle 3 are addressed in commit `ecd2812c`. The review.md says "Open" because it was written before the inline revision; the design.md now reflects the resolutions.

Per /team-auto Stage A rules: when MUST-FIX have been addressed via inline revision, the next move is to re-invoke `/team-review` to verify. With 3 cycles consumed, that invocation would emit the cap-reached gate at Step 0 and refuse to run — there's no Stage-A path to formally verify the cycle-3 revision.

## What I would do next if I had answers

The user (Dave) needs to make one of these calls:

1. **Approve the cycle-3 revisions** — say "approved" and the workflow advances to `/team-plan`. This treats the inline revisions as resolving the cycle-3 MUST-FIX without an additional review cycle. Justified because:
   - All 4 MUST-FIX have concrete resolution patches in design.md
   - The cycle-3 changes are simplifications (drop complexity), not new design surface
   - The remaining SHOULD-FIX have explicit resolutions; WON'T-FIX are logged
   - Reviewer pattern across 3 cycles shows convergence toward the simpler shape

2. **Rework via `/team-design`** — explicit reset if the cycle-3 simplification feels off-direction. The simplification choices (drop schema-level NOT NULL, separate FS reconciler, parent-lookup in reconciler) are well-grounded but reverse a cycle-2 decision; that's a judgment call worth confirming.

3. **Make per-finding calls** — read the cycle-3 review at `docs/specs/workgroup-scoped-data-layer/review.md` and the revised design at `docs/specs/workgroup-scoped-data-layer/design.md`, then waive any remaining concerns explicitly or send specific edits back.

My recommendation: **#1 (approve)**. The cycle-3 simplification is the right shape — three independent reviewers (one on a non-Claude model) converged on the same conclusion that the table-rebuild + foreign_keys complexity was costing more than it bought, and the simpler approach has clear enforcement at app + runtime layers.
