# Build State Checkpoint

Last updated: 2026-04-24T14:00 UTC

## Groups Completed

- **Group B (Host-side persistence — container-config + create-agent handler)** — validated 2026-04-24T14:14 — all acceptance criteria passed after 1 fix iteration.
  - 9/9 named test cases present and grep-matched (1 fix iteration — builder initially used descriptive `it(...)` strings without the `test_X` prefix; resolved by renaming descriptions)
  - 12 pass + 1 todo (admin-enforcement marker for D5 waiver) in create-agent.test.ts
  - Full host suite: 28 files / 317 pass / 1 todo / 0 fail — regression-clean
  - `pnpm run build` exit 0
  - M1 fix confirmed: `agent_provider: provider ?? null` at create-agent.ts:113 (replaces hardcoded null)
  - D10 sequenced-write-with-rollback confirmed: init → updateContainerConfig → createAgentGroup, with rollback branches on steps 2 and 3
  - S14 full-folder rm in `safeRemoveFolder` (not just container.json)
  - C7 confirmed: no zod/ajv/valibot/yup/joi import in host
  - Negative ASSERT (Option C rejection) confirmed: no `provider === 'claude'` branch
  - Interpretation calls by builder B (all reasonable): `test.todo` placed after vitest import (module hoisting requirement); writeSessionMessage + writeDestinations mocked in unit tests (appropriate layer); literal paths used in vi.mock factories (hoisting constraint)

- **Group A (Container-side provider registry + Claude schema + MCP handler)** — validated 2026-04-24T14:00 — all acceptance criteria passed.
  - 22 named test cases all present and passing
  - 25 new tests total (22 spec'd + 3 variants), 84/84 container suite, 0 fail
  - `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` exit 0
  - Pre-existing baseline had 12 failures; now 0 — builder did not introduce regressions
  - 1 pre-existing `SQLiteError` in poll-loop interval survived (unrelated to this work, baseline reproduced)
  - Zero fix iterations needed — builder's first submission passed validation
  - Interpretation calls noted:
    - Added `_resetConfig()` to `config.ts` for test isolation (reasonable — config is a singleton)
    - Used `mock.module` on `@anthropic-ai/claude-agent-sdk` in `claude.configSchema.test.ts` to capture per-query options for sticky-config assertions

## Groups Remaining

- **Group B (Host-side persistence — `container-config.ts` + `create-agent.ts`)** — pre-condition Group A now satisfied; ready to spawn.

## Groups Out of Scope (by user decision)

- **Group C (providers-branch Codex schema)** — deferred to a separate future PR on `davekim917/providers` after syncing from upstream. Per user's fork-first policy (see memory `feedback_fork_first.md`).

## Decisions Made During Build

- Accepted builder A's interpretation that `_resetConfig()` test helper is a legitimate addition (not strictly in plan, but needed for test isolation given config module's singleton nature).
- IDE diagnostic warnings on test files (e.g., `Cannot find module 'bun:test'`, `Property 'model' does not exist on type 'never'`) were determined to be root-tsconfig noise — the container's own tsconfig typechecks cleanly.

## Escalations

- None.

## Post-Build Fixes (user-approved after Step 8 gate)

- **P2 (orphan-cleanup message specificity) — FIXED 2026-04-24T14:38.** Changed `safeRemoveFolder` to return boolean; added `orphanSuffix` helper. Both rollback-failure paths (updateContainerConfig catch + createAgentGroup catch) now append `"(orphan folder at groups/X — manual cleanup may be needed)"` to the notifyAgent text when the rm itself fails. Tightened `test_create_agent_rollback_failure_notifies_orphan` assertion to require the orphan-specific text (old assertion only checked for "failed" in the message — would pass with any error). Full suite: 317 pass / 0 fail / 1 todo. Typecheck: clean. P1 (schema placement in claude.ts) left as-is — cosmetic, would only add merge-conflict surface with upstream.

## Known Risks (Accumulated)

- **Pre-build drift acknowledgments** (from `drift-acks.json`):
  - B1 — Plan's step-2 (updateContainerConfig) rollback is tighter than design's "propagate". Intentional per S14.
  - B2 — `/add-codex` SKILL.md update omitted; deferred to Group C follow-up.
- **Waived review findings:**
  - D5 — admin gate C2 waived; separate follow-up issue to file after this PR lands.
- **Pre-existing test failure surfaced but not introduced:** 1 `SQLiteError` in a background poll-loop interval attempts to open `/workspace/inbound.db` in test environment. Reproducible on main without this branch. Not this PR's concern.
- **IDE diagnostic false positives:** root tsconfig reports errors on container test files using `bun:test`. Container's own tsconfig (`container/agent-runner/tsconfig.json`) typechecks cleanly. Does not block; flag for future repo-level tsconfig cleanup.
