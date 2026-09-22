/**
 * `@vitest/coverage-v8` (package.json devDependencies) is a `vitest` peer, not an
 * independent package — it must stay EXACT-PINNED to the SAME version as `vitest`
 * itself (currently 4.1.10 for both; see docs/dependency-updates.md). Bumping `vitest`
 * without bumping `@vitest/coverage-v8` to match (or vice versa) risks a version
 * mismatch the coverage machinery below silently tolerates at install time but not at
 * run time.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { defaultExclude, defineConfig } from 'vitest/config';

import { globsForRiskHigh } from './scripts/review-outcomes.js';
import { splitRiskGlobs } from './scripts/risk-globs.js';
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
] as const;

const lane = process.env.VITEST_LANE;

/**
 * `coverage.include` scopes what gets REPORTED to the risk:high paths this vitest run
 * can actually import — `.ts` under `src/`/`scripts/` (see scripts/risk-globs.ts for
 * the host/container split; container/agent-runner is Bun-only and covered separately
 * by `bun test --coverage`). It does NOT scope instrumentation: coverage-v8 starts
 * V8's precise/detailed coverage profiler for the whole worker regardless of `include`
 * (`Profiler.startPreciseCoverage({ callCount: true, detailed: true })`,
 * node_modules/@vitest/coverage-v8/dist/index.js) and applies `include`/`exclude` only
 * once building the report — see scripts/check-risk-coverage.ts's file header and
 * ci-full.yml for what that overhead meant for one CPU-heavy, unrelated test. Derived at run
 * time from `.github/labeler.yml` rather than hardcoded, so the coverage ratchet's
 * scope can never silently drift from the review gate's scope
 * (docs/specs/risk-based-review/plan.md, "Tests on risky paths").
 *
 * Called lazily, only when `coverage.enabled` below is actually true — not eagerly as
 * part of this config object — so a malformed `.github/labeler.yml` (or an unrecognized
 * risk:high glob; see splitRiskGlobs) fails only a coverage run, never a plain
 * `vitest run`, which would otherwise break EVERY lane on every config load.
 */
function readHostRiskGlobs(): string[] {
  const labelerPath = path.join(import.meta.dirname, '.github', 'labeler.yml');
  const config = parseYaml(fs.readFileSync(labelerPath, 'utf8')) as Record<string, unknown>;
  const { host } = splitRiskGlobs(globsForRiskHigh(config));
  // host only guarantees ".ts under src/ or scripts/" as a directory (a glob ending
  // `/**` matches every file in that tree, README.md and *.md skill docs included) —
  // narrow each directory glob to `.ts` files specifically, or vitest's coverage-v8
  // provider tries to parse those non-TS files as source and logs a "Failed to parse
  // ... Excluding it from coverage" warning per file (harmless, but noisy: every
  // module directory under risk:high carries at least one .md).
  return host.map((glob) => (glob.endsWith('/**') ? `${glob}/*.ts` : glob));
}

/**
 * `vitest run --coverage` and `--coverage.<option>=...` both enable coverage (vitest
 * CLI: any `--coverage*` flag sets `coverage.enabled`); this repo's own coverage
 * entrypoints (`pnpm run test:coverage:risk`, scripts/check-risk-coverage.ts's usage
 * text) only ever pass the bare `--coverage` form. Checked directly against argv,
 * ahead of vitest parsing its own CLI flags, purely to decide whether
 * `readHostRiskGlobs()` — which reads and parses a file, and can throw — is worth
 * calling; getting this detection wrong only means paying that one extra read on a
 * plain run, never a correctness issue for coverage.include itself.
 */
const coverageRequested = process.argv.some((arg) => arg === '--coverage' || arg.startsWith('--coverage.'));

/**
 * coverage-v8's whole-worker instrumentation (see readHostRiskGlobs's comment above)
 * slows every test's CPU-bound work under `--coverage`, generically — not just the one
 * test this was first caught on. Measured on this host: the two heaviest cases in
 * src/db/transaction-closures.test.ts (a full ts.Program built inside the test body)
 * went from a few hundred ms uninstrumented to 8.4s/10.0s under coverage; CI's own run
 * (PR #662) measured one of the two at 18.1s, up from a normal 5.1s. 4x — not 3x —
 * is what actually covers that CI number: 3 × vitest's 5000ms default testTimeout is
 * 15000ms, less than the 18100ms CI observed, which would have reproduced the exact
 * timeout this exists to prevent. `hookTimeout` gets the same multiplier for
 * consistency, though nothing here specifically implicated hooks.
 *
 * `NANOCLAW_COVERAGE_TIMEOUT_MULTIPLIER` carries this same number into the test
 * process's env (ONLY when coverage is requested) so src/test-timeout-scale.ts's
 * `scaledTimeout()` — for the handful of tests with their OWN explicit timeout, which
 * vitest lets override `testTimeout` entirely and therefore never inherits this config
 * block's scaling on its own — can apply the identical multiplier instead of a second,
 * separately-maintained number.
 */
const COVERAGE_TIMEOUT_MULTIPLIER = 4;

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
    // if a fixed root comes back.
    //
    // Turning it on was measured, not assumed (PR #873, 2026-09-17, on CI's
    // hosted runner: 2 vCPU, 7.9 GB): serial takes 17–18 min for 519 files;
    // `fileParallelism: true` took 27 min with `--coverage` and 16 min
    // without, plus one contention timeout. The suite is CPU-bound, so two
    // workers on two cores inflate each other's times (individual files ran
    // 10–20x slower) and the second worker buys nothing. Leave this off until
    // the runner has more cores than vitest would use as workers; re-measure
    // there before flipping it.
    fileParallelism: false,
    // Scaled under --coverage only (see COVERAGE_TIMEOUT_MULTIPLIER above) — a plain
    // `vitest run` gets vitest's own unmodified defaults (5000/10000), not these.
    testTimeout: coverageRequested ? 5000 * COVERAGE_TIMEOUT_MULTIPLIER : undefined,
    hookTimeout: coverageRequested ? 10000 * COVERAGE_TIMEOUT_MULTIPLIER : undefined,
    env: coverageRequested ? { NANOCLAW_COVERAGE_TIMEOUT_MULTIPLIER: String(COVERAGE_TIMEOUT_MULTIPLIER) } : {},
    // `coverage.enabled` defaults to false — this block only takes effect when a
    // caller passes `--coverage` (scripts/check-risk-coverage.ts, the `pnpm run
    // test:coverage:risk` script, or CI's coverage step), so a plain `vitest run`
    // stays exactly as fast as before this block existed.
    coverage: {
      provider: 'v8',
      // Setting `include` is what makes vitest REPORT every matching file, even one
      // no test ever touched, at 0% (vitest docs, CoverageOptions.include: "By
      // default only files covered by tests are included" — the opposite is true
      // once `include` is set). Verified against a real run: scoping `include` to
      // this repo's risk:high host globs and running only two unrelated test files
      // still produced entries for every risk file, not just the ones those two
      // files happened to import. See readHostRiskGlobs's own comment: this is a
      // reporting scope, not an instrumentation one — the coverage profiler's CPU
      // overhead still applies to the whole run either way.
      include: coverageRequested ? readHostRiskGlobs() : [],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
