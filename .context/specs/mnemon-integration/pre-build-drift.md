# Pre-Build Drift Report — mnemon-integration

**Source of Truth:** `.context/specs/mnemon-integration/design.md`
**Target:** `.context/specs/mnemon-integration/plan.md` (revised after initial drift check)
**Run mode:** 2-agent (Claude Sonnet + Codex; Gemini CLI unavailable). Initial findings re-verified inline after plan revisions.
**Generated:** 2026-04-26 (initial), revised 2026-04-27 after plan fixes.

---

## Summary (post-revision)

| Class      | Count | Notes |
|------------|-------|-------|
| CONFIRMED  | 83    | Plan now faithfully reflects the design. 5 previously-flagged gaps resolved by plan edits (B1, B2, B7, B8, B9). |
| PARTIAL    | 3     | Reviewable, accepted as-is (B4, B5, B6) — intentional plan-level decisions that improve on design |
| MISSING    | 0     | All previously MISSING entries resolved in plan edits |
| DIVERGED   | 1     | B3 acknowledged in `drift-acks.json` (architecturally correct) |
| **Effective DIVERGED (after acks)** | **0** | Gate-clearing |

---

## RESOLVED — previously MISSING (now CONFIRMED)

### [B1] Schema-mismatch detection at SessionStart, cached per-session (SF11)

**Class:** CONFIRMED (was MISSING in initial check)
**Resolution:** Plan Task B2 (`hooks.ts`) now includes:
- Module-level `Map<string, SchemaCheckResult>` cache keyed by store
- `detectSchemaMismatch(store)` async helper using `mnemon status --store` (no `--json` flag)
- Prime hook populates cache once per session at SessionStart, emits unhealthy event on mismatch
- Remind hook reads from cache only — short-circuits to empty context on cached `'mismatch'`, never re-invokes detection
- Test cases enumerated: `test_primeHook_schemaCache_populated_once`, `test_remindHook_short_circuits_on_cached_mismatch`, `test_primeHook_schemaCache_emits_unhealthy_on_mismatch`
- Acceptance criterion: "Schema-mismatch detection runs at SessionStart only; result cached in module-level `Map<string, SchemaCheckResult>` per store (covers SF11 — design.md)"

**Verified inline:** plan.md lines 581-584, 600-616, 624-633, 660-664, 714-727.

### [B2] container/skills/wiki/SKILL.md modification

**Class:** CONFIRMED (was MISSING in initial check)
**Resolution:**
- File Ownership Map line 75 now includes `container/skills/wiki/SKILL.md | D | D3 | MODIFY`
- Task D3 retitled "mnemon-companion container skill + wiki SKILL.md deferral"
- Approach explicitly describes inserting a deferral header at the top of `wiki/SKILL.md` (between frontmatter and first H1) that instructs the agent to defer to mnemon-companion when both skills are mounted
- Exact deferral header text provided in the code-pattern block
- ASSERT requires verification that wiki/SKILL.md original body is preserved verbatim
- Acceptance criterion: "`container/skills/wiki/SKILL.md` modified with deferral header that references `mnemon-companion` by name (covers design.md Module Structure requirement)"

**Verified inline:** plan.md line 75 (File Ownership Map), 1583-1597 (Task D3 approach), 1640-1646 (deferral header exact text), 1653-1654 (ASSERT), 1660-1661 (acceptance criteria).

---

## ACKNOWLEDGED — DIVERGED (effective_DIVERGED reduced to 0)

### [B3] `flock.ts` in design's container module list, absent from plan

**Class:** DIVERGED
**Acknowledgment:** `.context/specs/mnemon-integration/drift-acks.json` entry id `B3`
**Reason recorded in ack:** "design.md's container module structure section lists `flock.ts` as a container-side module file, but cycle 2 MF8 superseded that approach by moving locking into the bash wrapper script (`container/mnemon-wrapper.sh`). The plan correctly omits `flock.ts` from the container module file list — locking is now wrapper-internal. The design's own module listing has stale residue from before MF8 and was not updated. The plan reflects the current architectural intent (D3 selected = wrapper-script flock); reverting the plan to add a `flock.ts` file would re-introduce the rejected hook-callback locking approach."

**Verdict:** ACK accepted — divergence is justified, plan is correct.

---

## RESOLVED — previously PARTIAL (now CONFIRMED)

### [B7] `mnemon status --json` flag wording

**Class:** CONFIRMED (was PARTIAL)
**Resolution:** plan.md line 1503 now reads `mnemon status --store <name>` with parenthetical "(mnemon emits JSON by default — no `--json` flag, per design Research Summary)". Aligned with code patterns elsewhere in the plan that already omit the flag.

### [B8] Hook WARN/ERROR logging not explicit

**Class:** CONFIRMED (was PARTIAL)
**Resolution:** Task B2 now has explicit logging discipline:
- Approach paragraph "Error logging (covers B8...)" mandates `console.warn('[mnemon] <hook> recoverable: <reason>')` and `console.error('[mnemon] <hook> BLOCKING: <reason>')`
- All three hook code patterns (Prime, Remind, Nudge) include the explicit `console.warn`/`console.error` calls (lines 632, 644, 647, 675, 678, 698, 701)
- New acceptance criterion: "Recoverable errors emit `console.warn` ... blocking errors emit `console.error` ..."

### [B9] Unknown wrapper subcommand: emit unhealthy event

**Class:** CONFIRMED (was PARTIAL)
**Resolution:** Task A2 wrapper description now specifies "Unknown subcommand → emit metric with `event_type: "unhealthy"` and `reason: "unknown-subcommand"` to `/workspace/agent/.mnemon-metrics.jsonl`, write stderr message, then `exit 2`" (line 164). New ASSERT line 173: "Unknown subcommand path emits `event_type: "unhealthy"` with `reason: "unknown-subcommand"` (NOT `event_type: "turn"` or `event_type: "error"`)"

---

## REMAINING PARTIAL (review — accepted as-is)

### [B4] `rollout.ts` and `metrics-collector.ts` not under `src/modules/mnemon/`

**Class:** PARTIAL — accepted
**Recommendation:** Script-level location is reasonable for these single-purpose entry points. Moving to module would be premature abstraction. Plan accepted.

### [B5] Conditional mounting mechanism for mnemon-companion deferred to builder

**Class:** PARTIAL — accepted
**Recommendation:** Both options satisfy the design intent. Builder discretion within architectural bounds is fine. Plan accepted.

### [B6] Discord MG deprecation shim for existing call sites

**Class:** PARTIAL — accepted
**Recommendation:** Direct routing is cleaner than a shim. Plan accepted.

---

## CONFIRMED (83 — abbreviated)

The following claim categories were verified by both agents as faithfully reflected in the plan, with the additions from this revision cycle:

- **Constraints C1-C19** (19): all 19 HARD/SOFT constraints traced to specific tasks via the plan's Constraint Traceability table.
- **Decisions D1-D7** (7): all 7 design decisions reflected in plan tasks with named code patterns matching the design.
- **Module structure** (12, +1 — wiki/SKILL.md MODIFY now in File Ownership Map): host and container module file paths, `applyMnemonMounts`/`applyMnemonEnv` exports, scripts list, Illysium container.json modification, docs/mnemon.md, wiki SKILL.md deferral.
- **Dockerfile** (3): exact SHA256 values, ARG declarations, COPY+symlink+validate sequence.
- **Hook integration** (10, +2 — schema-mismatch detection cached at SessionStart, explicit WARN/ERROR logging): SessionStart Prime, UserPromptSubmit Remind (both phase texts verbatim), Stop Nudge `{ continue: true }`, conditional mnemonStore spread, async fire-and-forget metrics emission, schema-mismatch detection cached per session, explicit log levels for recoverable vs blocking.
- **Wrapper script** (11, +1 — unknown subcommand emits unhealthy event): shadow-block recall paths, flock for write paths, passthrough for status/version/help, admin-locked store/setup, fail-closed phase resolution, exit 2 unknown commands with unhealthy classification, host-shared lock path.
- **Phase 2 transition** (4): `enable-mnemon.ts` flow, `mnemon-phase2.ts` 6-gate evaluation, no-restart graduation, health-gate refusal on unhealthy.
- **Scheduling** (4): scheduleTask resolves session by agent_group_id only, TaskDef has no platform/channel fields, per-session inbound.db insertion, idempotent inserts.
- **Observability** (4): per-turn metrics dir, per-store metrics dir, host-owned health.json, hooks never write to host-owned files.
- **Backup** (4): sqlite3 .backup with .timeout 5000, retention 7 daily + 4 weekly, no rsync, restore drill required.
- **Rejections** (5): bind-mount binary absent, `shadow` field absent, auto-graduation absent, host daemon absent, PreCompact absent.

---

## Drift Gate Status (post-revision)

```
SOT: design.md
Target: plan.md (revised)

MISSING:  0 — all blocking entries resolved by plan edits
DIVERGED: 1 — B3 acknowledged in drift-acks.json
PARTIAL:  3 — B4/B5/B6 reviewed and accepted
CONFIRMED: 83
Effective DIVERGED (after acks): 0
```

**GATE STATUS: CLEAR**

`MISSING == 0` AND `effective_DIVERGED == 0`. Build may proceed to Step 3 (team creation). PARTIAL findings (B4, B5, B6) are carried forward as known risks and are operator-judgment-accepted.
