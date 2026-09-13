#!/usr/bin/env tsx
/**
 * Reviewer-model allowlist generator.
 *
 * Review eligibility follows the single native frontier worker for each
 * provider: Claude frontmatter (without the context-window suffix), and the
 * Codex converter's model map. Independent review requires a fresh context.
 *
 * Output: container/skills/pr-review-loop/reviewer-models.txt — sorted, one
 * id per line, under a header. It lives in the skill directory (not
 * scripts/) because container/skills/pr-review-loop/scripts/codex-review.sh
 * reviews PRs in ANY repo it's dropped into and must find its allowlist next
 * to itself, not somewhere only this repo has.
 *
 * Modes:
 *   --write   regenerate the file from the frontier config
 *   --check   fail (exit 1) if the file on disk doesn't match; the drift
 *             test (reviewer-models-freshness.test.ts) runs this on every
 *             test pass
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODEX_WORKER_MODELS, extractScalar } from '../src/claude-agent-md.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REVIEWER_MODELS_OUTPUT_PATH = path.join(REPO_ROOT, 'container/skills/pr-review-loop/reviewer-models.txt');

const CLAUDE_AGENT_FILES = ['container/agents/worker-frontier.md'];
const CODEX_WORKER_NAMES = ['worker-frontier'] as const;
// Receipt compatibility only: these models remain eligible so an unchanged
// exact-head receipt does not expire when dispatch defaults change.
const COMPATIBLE_RECEIPT_MODELS = ['claude-opus-5', 'gpt-5.6-sol'];

export const REVIEWER_MODELS_HEADER = [
  '# generated from the frontier config: edit container/agents/worker-frontier.md or',
  '# CODEX_WORKER_MODELS, then run `pnpm run reviewer-models -- --write`',
  '#',
  '# One reviewer-eligible model id per line — the native frontier worker, whichever',
  '# vendor, plus prior Opus/Sol receipt compatibility (not dispatch defaults).',
  '# container/skills/pr-review-loop/scripts/codex-review.sh reads this file to',
  '# gate `receipt` and `merge-check`. See scripts/reviewer-models.ts.',
].join('\n');

/**
 * Slice the raw frontmatter block out of a Claude subagent .md, the same way
 * parseClaudeAgentMd does (src/claude-agent-md.ts:72-77) — duplicated rather
 * than imported because that function only returns name/description/body,
 * never the frontmatter itself, and `model` isn't one of the three.
 */
function frontmatterOf(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error('no frontmatter block (must start with `---`)');
  const rest = normalized.slice('---\n'.length);
  const endIdx = rest.indexOf('\n---');
  if (endIdx < 0) throw new Error('no closing `---` for the frontmatter block');
  return rest.slice(0, endIdx);
}

/** Pull the `model:` scalar out of a Claude subagent .md's YAML frontmatter. */
function extractModelLine(content: string): string {
  const model = extractScalar(frontmatterOf(content), 'model');
  if (!model) throw new Error('no `model:` frontmatter line found');
  return model;
}

/** Strip the `[1m]` extended-context-window marker some Claude model ids carry. */
function stripContextWindowSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, '');
}

/**
 * Refuse anything that isn't a bare model id, in two ways:
 *
 * 1. A bare alias ("opus", "sonnet", "inherit") standing in for a real model
 *    id — those resolve to whatever the runtime's current default is, so "who
 *    is allowed to review" would silently follow that default around instead
 *    of naming a fixed model. Every real id here (Claude or Codex) carries a
 *    version number, so requiring a digit is enough to catch an alias without
 *    hardcoding the alias list.
 * 2. A shape that isn't purely `[A-Za-z0-9._-]+` — extractScalar is NOT a
 *    full YAML parser (its own doc comment says so), so `model: claude-opus-5
 *    # pinned` reads back the trailing ` # pinned` as part of the value, and
 *    `model: claude opus 5` reads back as three space-separated words. Both
 *    contain a digit and would pass check 1, then silently fail to match
 *    anything's first word at review time — Opus loses reviewer eligibility
 *    with the drift test still green. Requiring the id to be nothing but
 *    id-shaped characters (checked AFTER the `[1m]` suffix is stripped)
 *    catches both.
 */
function assertConcreteModelId(id: string, source: string): void {
  if (!/[0-9]/.test(id)) {
    throw new Error(
      `${source}: "${id}" is not a concrete versioned model id — bare aliases like "opus", "sonnet", or "inherit" are not allowed here`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(
      `${source}: "${id}" is not a bare model id — expected only letters, digits, '.', '_', '-' (no comments, extra words, or other trailing text) after stripping any [1m] suffix`,
    );
  }
}

/** The reviewer-eligible model ids, sorted and de-duplicated. */
export function computeReviewerModelIds(repoRoot: string = REPO_ROOT): string[] {
  const claudeIds = CLAUDE_AGENT_FILES.map((rel) => {
    const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const id = stripContextWindowSuffix(extractModelLine(content));
    assertConcreteModelId(id, rel);
    return id;
  });
  const codexIds = CODEX_WORKER_NAMES.map((name) => {
    const entry = CODEX_WORKER_MODELS[name];
    if (!entry) throw new Error(`CODEX_WORKER_MODELS is missing "${name}"`);
    assertConcreteModelId(entry, `CODEX_WORKER_MODELS['${name}']`);
    return entry;
  });
  return Array.from(new Set([...claudeIds, ...codexIds, ...COMPATIBLE_RECEIPT_MODELS])).sort();
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
