/**
 * Host/container split of `.github/labeler.yml`'s `risk:high` globs, for the coverage ratchet.
 * The two lanes' coverage tools are separate: host files are `.ts` under `src/`/`scripts/` that
 * vitest instruments; container files run only under Bun, which vitest can't load.
 */

/** True for a risk:high glob that names `.ts` source under `src/` or `scripts/`. */
function isHostCodeGlob(glob: string): boolean {
  const underHostTree = glob.startsWith('src/') || glob.startsWith('scripts/');
  const targetsTsFiles = glob.endsWith('.ts') || glob.endsWith('/**');
  return underHostTree && targetsTsFiles;
}

function isContainerCodeGlob(glob: string): boolean {
  return glob.startsWith('container/agent-runner/');
}

export function hostRiskGlobs(riskHighGlobs: readonly string[]): string[] {
  return riskHighGlobs.filter(isHostCodeGlob);
}

export function containerRiskGlobs(riskHighGlobs: readonly string[]): string[] {
  return riskHighGlobs.filter(isContainerCodeGlob);
}

/**
 * Config or prose with no line coverage on either side. Listed explicitly, not "anything else",
 * so a new risk:high glob that SHOULD carry coverage fails loudly instead of silently vanishing
 * from `coverage.include`.
 */
const KNOWN_NON_CODE_GLOBS: ReadonlySet<string> = new Set([
  'pnpm-workspace.yaml',
  'container/Dockerfile',
  'container/build.sh',
  'scripts/deploy.sh',
  'scripts/git-safety*.sh',
  'scripts/lib/secret-scan.sh',
  'scripts/wiki-pre-push-hook*.sh',
  '.github/**',
  '.husky/**',
  '.public-boundary-allowlist.json',
  '.public-boundary-baseline.json',
  'container/skills/pr-review-loop/**',
  // Hygiene-check policy (knip and jscpd configuration); the checker itself is scripts/hygiene/**.
  'knip.json',
  '.jscpd.json',
  // The QA release gate: Bash and Python only, which neither lane's coverage tool instruments.
  'container/skills/smoke-test/**',
  'docs/review-policy.md',
  // Agent definitions: .md frontmatter/prose, not instrumented source.
  'container/agents/**',
  // Executable agent/tool config other tools read, not source this repo's suites instrument.
  '.claude/**',
  '.mcp.json',
  '.claude.json',
  '.ripgreprc',
  '.gitmodules',
  // The coverage baseline: risk:high so a PR can't delete tests and the evidence together.
  'coverage-risk-baseline.json',
]);

/**
 * Every glob must be host code, container code, or a KNOWN_NON_CODE_GLOBS entry. Throws rather
 * than warns: the fix belongs in this file's classification.
 */
export function assertFullyClassified(riskHighGlobs: readonly string[]): void {
  const unclassified = riskHighGlobs.filter(
    (glob) => !isHostCodeGlob(glob) && !isContainerCodeGlob(glob) && !KNOWN_NON_CODE_GLOBS.has(glob),
  );
  if (unclassified.length > 0) {
    throw new Error(
      `scripts/risk-globs.ts: risk:high glob(s) neither host code, container code, nor a known non-code path — ` +
        `they would silently drop out of coverage.include: ${unclassified.join(', ')}. Add them to ` +
        `KNOWN_NON_CODE_GLOBS if they truly carry no line coverage, or fix isHostCodeGlob/isContainerCodeGlob.`,
    );
  }
}

/** `hostRiskGlobs`/`containerRiskGlobs`, having first asserted every glob is accounted for. */
export function splitRiskGlobs(riskHighGlobs: readonly string[]): { host: string[]; container: string[] } {
  assertFullyClassified(riskHighGlobs);
  return { host: hostRiskGlobs(riskHighGlobs), container: containerRiskGlobs(riskHighGlobs) };
}
