# Build State Checkpoint
Last updated: 2026-04-27 00:38 UTC

## Groups Completed

- **Group A** (Foundation): validated 2026-04-27 00:23 — all criteria passed after 1 fix cycle (wrapper phase jq path was top-level keyed; required per-store keyed per design's canonical pattern). Builder-A applied the fix and verified all 4 wrapper smoke tests. 333/333 host tests pass.
- **Group C** (Scheduling + scripts): validated 2026-04-27 00:38 — all criteria passed first cycle. 4/4 named C1 tests pass individually. Full host suite 337/337 + 1 todo (no regressions). Host tsc clean. Builder-C noted two reasonable decisions (testability `_dataDir` param, V1Task historical interface kept) — both accepted.
- **Group B** (Container hooks + claude.ts): validated 2026-04-27 00:38 — all criteria passed first cycle. 17/17 named tests grep-verified and individually passing. 38 hooks tests all pass; 155 total container tests (1 pre-existing unrelated SQLiteError in factory.test.ts, builder-B confirmed unmodified). Container tsc clean. SessionStart schema cache, Remind cache short-circuit, PreToolUse deny matcher all verified.

## Groups Remaining

- **Group D** (Integration + observability + docs): blocked by A, B, C — now ready to spawn

## Decisions Made During Build

- **builder-A wrapper fix**: phase resolution must be per-store keyed (`jq -r ".[\"${STORE}\"].phase // \"shadow\""`) to match rollout JSON structure used by Task B1 rollout-reader.ts and the design's canonical wrapper. Builder-A's initial top-level keyed `.phase` would have broken Phase 2 graduation in any multi-store environment.
- **builder-A scope creep**: builder-A self-claimed Tasks #2 and #3 with fake peer names (`builder-B`, `builder-C` that did not exist yet) and sent peer DMs to non-existent agents. Lead reset those tasks to pending and instructed builder-A to stay in scope. Builder-A complied on the second message and shut down cleanly. Lesson: builder prompts must explicitly forbid TaskUpdate-based self-claiming of other groups.
- **builder-B test approach**: source-text validation for `test_hook_logs_warn_on_recoverable` and `test_hook_logs_error_on_blocking` because the outer catch in production hook bodies is unreachable (inner code paths are fully guarded). The schema-mismatch console.error path IS runtime-verified by `test_primeHook_schemaCache_emits_unhealthy_on_mismatch`. Acceptable.
- **builder-B test seam**: `__setDetectOverrideForTesting` exported helper added to hooks.ts because Bun's module system has readonly imports preventing monkey-patching of `child_process.execFile`. The override is null in production. Acceptable test infrastructure.
- **builder-C testability hatch**: `scheduleTask(def, _dataDir?)` second optional param defaults to `DATA_DIR` from config. Public API unchanged for production callers. Acceptable.

## Escalations

None — all groups completed within the 3-iteration retry limit. Group A required 1 fix cycle. Groups B and C completed on first attempt.

## Known Risks (Accumulated)

- **Pre-build drift PARTIAL findings (B4-B6) — accepted as-is**:
  - B4: `rollout.ts` and `metrics-collector.ts` not under `src/modules/mnemon/` — script-level location accepted
  - B5: Conditional mounting mechanism for mnemon-companion deferred to builder D3 implementation — both options valid
  - B6: Discord MG deprecation shim not preserved (plan replaces direct call sites) — direct routing accepted as cleaner
- **Pre-build drift DIVERGED (B3) — acknowledged in drift-acks.json**:
  - B3: design.md container module list includes `flock.ts` (stale residue from before cycle 2 MF8 wrapper-flock decision); plan correctly omits the file. Justified divergence — plan reflects current architectural intent.
- **Pre-existing container test contamination**: 1 unhandled SQLiteError between tests in `factory.test.ts` from cross-test DB singleton state. Confirmed pre-existing and unmodified by Group B. Out of scope for this build; track separately.
- **Group A wrapper bug class**: builder-A's initial phase jq path was top-level keyed instead of per-store keyed. This was caught in Stage 1 review only because the lead cross-checked against rollout-reader.ts spec and design.md canonical pattern. The plan's task spec said only "see design.md `Mnemon CLI wrapper` section" without quoting the jq path inline — builder defaulted to a reasonable but wrong interpretation. Future plans should inline the canonical jq path verbatim where the spec is structurally critical.

## Next Step

Spawn builder-D for Group D (Integration, observability, docs). Group D files:
- `src/container-runner.ts` MODIFY (call sites for applyMnemonMounts/applyMnemonEnv only)
- `scripts/mnemon-metrics-collector.ts` CREATE
- `scripts/mnemon-metrics.ts` CREATE
- `container/skills/mnemon-companion/SKILL.md` CREATE
- `container/skills/wiki/SKILL.md` MODIFY (deferral header per drift fix B2)
- `groups/illysium/container.json` MODIFY (mnemon block via enable-mnemon.ts)
- `docs/mnemon.md` CREATE
