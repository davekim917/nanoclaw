/**
 * Scales an explicit per-test/per-hook timeout the same way vitest.config.ts scales the
 * global `testTimeout`/`hookTimeout` under `--coverage`.
 *
 * coverage-v8 starts V8's precise/detailed coverage profiler for the WHOLE worker, not
 * just risk:high files (see scripts/check-risk-coverage.ts's file header), so a
 * CPU-heavy test can take several times longer under `--coverage` than normally — this
 * repo has a real, measured case (a TypeScript-compiler-driven test,
 * src/db/transaction-closures.test.ts, went from single-digit seconds to ~10-18s under
 * coverage, close to or past the previous fixed timeout). vitest.config.ts's scaled
 * global `testTimeout` covers a test that uses vitest's default; a test with its OWN
 * explicit timeout (`it(name, fn, ms)` or `{ timeout: ms }`) IGNORES the global
 * `testTimeout` entirely (vitest semantics), so it needs to opt into the same scaling
 * itself — that's what this wraps.
 *
 * vitest.config.ts sets `NANOCLAW_COVERAGE_TIMEOUT_MULTIPLIER` in the test process's env
 * ONLY when `--coverage` is requested, to the same multiplier it uses for the global
 * timeouts — this function and that config share one source of truth for the number,
 * not two independently-maintained ones. Unset (a plain `vitest run`), this is a
 * multiply-by-1 no-op.
 */
export function scaledTimeout(ms: number): number {
  const raw = process.env.NANOCLAW_COVERAGE_TIMEOUT_MULTIPLIER;
  if (!raw) return ms;
  const multiplier = Number(raw);
  return Number.isFinite(multiplier) && multiplier > 0 ? ms * multiplier : ms;
}
