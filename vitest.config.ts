import { defaultExclude, defineConfig } from 'vitest/config';
import skillsConfig from './vitest.skills.config.js';

/**
 * Tests whose failure means "a committed manifest is stale", never "the code is
 * broken". Each one re-derives a checked-in artifact and compares:
 * mailbox-seam-upstream re-hashes the ported upstream files against
 * src/mailbox/UPSTREAM-MANIFEST.json, upstream-ratchet re-measures the
 * divergence numbers in src/upstream-ratchet.json, and
 * design-artifact-loop-vendor re-compares the vendored copy against
 * ~/plugins/design-artifact-loop. The fix for all three is to regenerate and
 * commit the artifact — there is nothing to debug.
 *
 * WHY THE SPLIT EXISTS: red that means "regenerate a manifest" was
 * indistinguishable from red that means "the code is broken". Both showed up as
 * the same failing `Host tests` step, so a stale-bookkeeping failure read like a
 * real regression and a real regression could hide behind an already-red run —
 * three consecutive pushes landed on a red main on 2026-09-08/09 that way.
 * Splitting them means the job name alone tells you which kind of red you have.
 *
 * src/mailbox-seam-ratchet.test.ts is deliberately NOT here: its failure means
 * someone added raw session-DB access, which is an architectural violation, not
 * stale bookkeeping.
 *
 * VITEST_LANE=drift runs exactly these; VITEST_LANE=correctness runs everything
 * else; unset (plain `pnpm test`) runs both lanes together, as before.
 */
const DRIFT_TESTS = [
  'src/mailbox-seam-upstream.test.ts',
  'src/upstream-ratchet.test.ts',
  'src/design-artifact-loop-vendor.test.ts',
  'scripts/reviewer-models-freshness.test.ts',
] as const;

const lane = process.env.VITEST_LANE;

export default defineConfig({
  test: {
    setupFiles: ['src/test-hermeticity.ts', 'src/test-setup.ts'],
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include:
      lane === 'drift'
        ? [...DRIFT_TESTS]
        : [
            'src/**/*.test.ts',
            'setup/**/*.test.ts',
            'scripts/**/*.test.ts',
            'tests/**/*.test.ts',
            'container/*.test.ts',
            ...skillsConfig.test!.include!,
          ],
    // Only the correctness lane narrows `exclude`; the other two lanes leave it
    // unset so vitest applies its own default unchanged.
    ...(lane === 'correctness' ? { exclude: [...defaultExclude, ...DRIFT_TESTS] } : {}),
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
