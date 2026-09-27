/**
 * Scales an explicit per-test/hook timeout the way vitest.config.ts scales the global ones under `--coverage`, which
 * slows the whole worker several-fold. An explicit timeout IGNORES the global `testTimeout`, so it must opt in here.
 * vitest.config.ts sets `NANOCLAW_COVERAGE_TIMEOUT_MULTIPLIER` only under `--coverage`; unset, this multiplies by 1.
 */
export function scaledTimeout(ms: number): number {
  const raw = process.env.NANOCLAW_COVERAGE_TIMEOUT_MULTIPLIER;
  if (!raw) return ms;
  const multiplier = Number(raw);
  return Number.isFinite(multiplier) && multiplier > 0 ? ms * multiplier : ms;
}
