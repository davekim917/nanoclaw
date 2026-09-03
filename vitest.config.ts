import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['src/test-setup.ts'],
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'scripts/**/*.test.ts',
      'tests/**/*.test.ts',
      'container/*.test.ts',
    ],
    // Run one test FILE at a time. 57 test files build fixtures under
    // hardcoded `/tmp/...` paths, so two files touching the same path in
    // parallel corrupt each other's state. The failures that produces are
    // always timeouts, never assertions, and they land in whichever file lost
    // the race — so they read as a real regression somewhere unrelated to the
    // change under test.
    //
    // That is not a theoretical cost. It burned two agents on 2026-08-24
    // investigating `migrate-repo-store*` failures that pass cleanly in
    // isolation, and the repo's own docs already warn that ~100 phantom
    // failures can look like a regression. A suite that cries wolf gets
    // ignored, which is worse than a slow one.
    //
    // Tests within a file still run concurrently; only cross-file parallelism
    // is off. Measured cost: ~9 minutes for the full suite, 303/303 green.
    //
    // ponytail: this treats the symptom. The root cause is the hardcoded
    // paths — give each file its own `mkdtemp` directory and this line can
    // come out. 57 files is too large and too risky a refactor to ride along
    // with an unrelated change; do it deliberately or not at all.
    fileParallelism: false,
  },
});
