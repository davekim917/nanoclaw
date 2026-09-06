# Task-script output occurrence isolation run

## Regression evidence

- New scheduling tests failed before the fix: script/mode updates retained a
  stale result, and both pending and paused successors copied prior object/null
  results.
- After the narrow writer change, `pnpm exec vitest run
  src/modules/scheduling/db.test.ts` passed: 44 tests.
- The host script integration suite passed: 22 tests.
- The container regression confirms `scriptOutput: null` still prevents a
  duplicate execution; `bun test src/scheduling/task-script.test.ts` passed:
  21 tests.
- Host and runner TypeScript checks passed.
- The ratchet report accepted and recorded the expected 22-line growth in the
  upstream-owned runner test for the new null-output regression.

## Scope

The change strips output only while creating a successor and on script or mode
updates. No service restart, image build, or deployment occurred in this
worktree.
