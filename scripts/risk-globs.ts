/**
 * Host/container split of `.github/labeler.yml`'s `risk:high` globs, for the coverage
 * ratchet (docs/specs/risk-based-review/plan.md, "Tests on risky paths").
 *
 * Reuses `globsForRiskHigh` (scripts/review-outcomes.ts) rather than re-deriving the
 * risk:high glob list a third time — that function already owns "read risk:high out of
 * a parsed labeler.yml payload" (scripts/labeler-config.test.ts's `globsFor` is its own
 * copy, deliberately, because that script has to replay an arbitrary `--repo`'s
 * labeler.yml fetched over the network; the coverage ratchet only ever reads this
 * checkout's own `.github/labeler.yml`, so importing is safe here).
 *
 * The host/container split matters because the two lanes' coverage tools are entirely
 * separate: host risk files are `.ts` under `src/`/`scripts/` that vitest (Node) can
 * import and instrument; container risk files live under `container/agent-runner/` and
 * only run under Bun (bun:sqlite, Bun-only APIs) — vitest can't load them at all.
 * Everything else risk:high covers — `.github/**`, `.husky/**`, shell scripts,
 * `pnpm-workspace.yaml`, `container/Dockerfile`, docs — is config or prose with no line
 * coverage to measure, on either side, so both splits drop it.
 */

/** True for a risk:high glob that names `.ts` source under `src/` or `scripts/`. */
function isHostCodeGlob(glob: string): boolean {
  const underHostTree = glob.startsWith('src/') || glob.startsWith('scripts/');
  const targetsTsFiles = glob.endsWith('.ts') || glob.endsWith('/**');
  return underHostTree && targetsTsFiles;
}

export function hostRiskGlobs(riskHighGlobs: readonly string[]): string[] {
  return riskHighGlobs.filter(isHostCodeGlob);
}

export function containerRiskGlobs(riskHighGlobs: readonly string[]): string[] {
  return riskHighGlobs.filter((glob) => glob.startsWith('container/agent-runner/'));
}
