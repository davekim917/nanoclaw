#!/usr/bin/env tsx
/**
 * Reviewer-model allowlist generator.
 *
 * The 2026-09-11 operator rule: a substitute PR reviewer must run on the high
 * or frontier tier, whichever vendor — never a cheap/fast tier (worker,
 * worker-fast), never Codex luna/terra, never a flash or mini model. The
 * allowed IDs are derived, not hand-maintained, from the two places tier
 * membership is actually defined:
 *
 *   - Claude: the `model:` frontmatter of container/agents/worker-high.md and
 *     worker-frontier.md (the `[1m]` context-window suffix is stripped — the
 *     reviewer reports the bare model id from its own runtime, not the
 *     extended-context variant marker).
 *   - Codex: CODEX_WORKER_TIERS['worker-high'] and ['worker-frontier']
 *     (src/claude-agent-md.ts), imported rather than re-parsed so this never
 *     drifts from what actually ships Codex reviews.
 *
 * Output: container/skills/pr-review-loop/reviewer-models.txt — sorted, one
 * id per line, under a header. It lives in the skill directory (not
 * scripts/) because container/skills/pr-review-loop/scripts/codex-review.sh
 * reviews PRs in ANY repo it's dropped into and must find its allowlist next
 * to itself, not somewhere only this repo has.
 *
 * Modes:
 *   --write   regenerate the file from the tier config
 *   --check   fail (exit 1) if the file on disk doesn't match; the drift
 *             test (reviewer-models.test.ts) runs this on every test pass
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODEX_WORKER_TIERS } from '../src/claude-agent-md.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REVIEWER_MODELS_OUTPUT_PATH = path.join(
  REPO_ROOT,
  'container/skills/pr-review-loop/reviewer-models.txt',
);

const CLAUDE_TIER_AGENT_FILES = ['container/agents/worker-high.md', 'container/agents/worker-frontier.md'];
const CODEX_TIER_NAMES = ['worker-high', 'worker-frontier'] as const;

export const REVIEWER_MODELS_HEADER = [
  '# generated from the tier config: edit container/agents/worker-{high,frontier}.md or',
  '# CODEX_WORKER_TIERS, then run `pnpm run reviewer-models -- --write`',
  '#',
  '# One reviewer-eligible model id per line — the high and frontier tiers, whichever',
  '# vendor. container/skills/pr-review-loop/scripts/codex-review.sh reads this file to',
  '# gate `receipt` and `merge-check`. See scripts/reviewer-models.ts.',
].join('\n');

/** Pull the `model:` scalar out of a Claude subagent .md's YAML frontmatter. */
function extractModelLine(content: string): string {
  const match = content.match(/^model:\s*(\S+)\s*$/m);
  if (!match) throw new Error('no `model:` frontmatter line found');
  return match[1];
}

/** Strip the `[1m]` extended-context-window marker some Claude model ids carry. */
function stripContextWindowSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, '');
}

/** The reviewer-eligible model ids, sorted and de-duplicated. */
export function computeReviewerModelIds(repoRoot: string = REPO_ROOT): string[] {
  const claudeIds = CLAUDE_TIER_AGENT_FILES.map((rel) => {
    const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    return stripContextWindowSuffix(extractModelLine(content));
  });
  const codexIds = CODEX_TIER_NAMES.map((tier) => {
    const entry = CODEX_WORKER_TIERS[tier];
    if (!entry) throw new Error(`CODEX_WORKER_TIERS is missing "${tier}"`);
    return entry.model;
  });
  return Array.from(new Set([...claudeIds, ...codexIds])).sort();
}

export function renderReviewerModelsFile(ids: string[]): string {
  return `${REVIEWER_MODELS_HEADER}\n${ids.join('\n')}\n`;
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const check = args.includes('--check');
  if (write === check) {
    console.error('usage: reviewer-models.ts --write | --check');
    process.exit(2);
  }

  const ids = computeReviewerModelIds();
  const rendered = renderReviewerModelsFile(ids);

  if (write) {
    fs.writeFileSync(REVIEWER_MODELS_OUTPUT_PATH, rendered);
    console.log(`wrote ${path.relative(REPO_ROOT, REVIEWER_MODELS_OUTPUT_PATH)} (${ids.length} model id(s))`);
    return;
  }

  // check
  const current = fs.existsSync(REVIEWER_MODELS_OUTPUT_PATH)
    ? fs.readFileSync(REVIEWER_MODELS_OUTPUT_PATH, 'utf8')
    : null;
  if (current !== rendered) {
    console.error(
      `${path.relative(REPO_ROOT, REVIEWER_MODELS_OUTPUT_PATH)} is stale — run \`pnpm run reviewer-models -- --write\``,
    );
    process.exit(1);
  }
  console.log('reviewer-models.txt is up to date');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
