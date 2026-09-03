import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['src/test-hermeticity.ts', 'src/test-setup.ts'],
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
    // Run one test FILE at a time.
    //
    // Historically this was load-bearing: 57 test files built fixtures under
    // hardcoded `/tmp/...` paths, so two files touching the same path in
    // parallel corrupted each other's state. The failures that produced were
    // always timeouts or `disk I/O error`, never assertions, and they landed in
    // whichever file lost the race — so they read as a real regression
    // somewhere unrelated to the change under test. That burned two agents on
    // 2026-08-24 investigating `migrate-repo-store*` failures that pass cleanly
    // in isolation.
    //
    // Issue #274 fixed the root cause: every fixture root now comes from
    // `uniqueTmpRoot` (src/test-setup.ts), and src/fixture-roots.test.ts fails
    // if a fixed root comes back. Turning this back on is therefore now
    // possible, but it is a separate deliberate change — cross-file
    // parallelism exposes any other shared state (ports, env, docker names)
    // that has never had to be correct, and it needs its own soak.
    //
    // Tests within a file still run concurrently; only cross-file parallelism
    // is off. Measured cost: ~9 minutes for the full suite.
    fileParallelism: false,
  },
});
