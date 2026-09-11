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
 * Everything else `risk:high` covers — `.github/**`, `.husky/**`, shell scripts,
 * `pnpm-workspace.yaml`, `container/Dockerfile`, docs, and the baseline file itself
 * (added to risk:high so deleting it, or gaming it, requires review) — is config or
 * prose with no line coverage to measure, on either side. Listed explicitly, rather
 * than "anything neither host nor container", so a genuinely new risk:high glob that
 * SHOULD carry coverage (say, a `.ts` file added outside `src/`/`scripts/`, or a `.tsx`
 * that `isHostCodeGlob`'s extension check doesn't recognize) fails loudly instead of
 * silently vanishing from `coverage.include` — see `assertFullyClassified` below.
 */
const KNOWN_NON_CODE_GLOBS: ReadonlySet<string> = new Set([
  'pnpm-workspace.yaml',
  'container/Dockerfile',
  'container/build.sh',
  'scripts/deploy.sh',
  'scripts/git-safety*.sh',
  // scripts/wiki-autopush.sh is gone (removed from risk:high upstream) — deliberately
  // not left here as a stale entry; an unclassified glob should still throw if this
  // path ever comes back under a different name.
  'scripts/lib/secret-scan.sh',
  'scripts/wiki-pre-push-hook*.sh',
  '.github/**',
  '.husky/**',
  '.public-boundary-allowlist.json',
  'container/skills/pr-review-loop/**',
  'docs/review-policy.md',
  // The worker-tier agent definitions the reviewer-model allowlist generator
  // (scripts/reviewer-models.ts) derives Claude ids from — .md frontmatter/prose,
  // not source either lane's test suite instruments.
  'container/agents/**',
  // Executable agent/tool config added to risk:high by #660 — a hook, an
  // auto-trusted MCP server, Claude Code's own trust state, a ripgrep config, and a
  // submodule URL (see .github/labeler.yml's own comment on this block). None of
  // these is source this repo's own test suites instrument; they are config other
  // tools read.
  '.claude/**',
  '.mcp.json',
  '.claude.json',
  '.ripgreprc',
  '.gitmodules',
  // The coverage baseline itself: docs/specs/risk-based-review/plan.md, "Tests on
  // risky paths" — a PR that deletes tests should not also get to delete the
  // evidence, so this file is on risk:high, but it carries no line coverage.
  'coverage-risk-baseline.json',
]);

/**
 * Every `risk:high` glob must be host code, container code, or a KNOWN_NON_CODE_GLOBS
 * entry — anything else is a genuinely unrecognized shape (a new extension, a new
 * top-level directory) that would otherwise silently drop out of coverage scope. Throws
 * rather than warns: `.github/labeler.yml` changes are already review-gated (risk:gates),
 * so the fix belongs in this file's classification, not a log line nobody reads.
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
