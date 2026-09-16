#!/usr/bin/env tsx
/**
 * Reviewer-model allowlist generator.
 *
 * Who may write a review receipt: the frontier model for each provider, plus
 * prior ids kept eligible so unchanged exact-head receipts don't expire.
 *
 * This list used to be DERIVED — from `container/agents/worker-frontier.md`'s
 * `model:` frontmatter and `CODEX_WORKER_MODELS`. Both are gone: delegation is
 * a set of effort shims that carry `model: inherit`, and an alias is exactly
 * what `assertConcreteModelId` refuses, so there is no longer a live config
 * that names a concrete frontier model. The ids are therefore stated here.
 * `assertConcreteModelId` still runs over them, so this file cannot be edited
 * into naming an alias, and the generated artifact is still checked for drift
 * (reviewer-models-freshness.test.ts).
 *
 * Output: container/skills/pr-review-loop/reviewer-models.txt — sorted, one
 * id per line, under a header. It lives in the skill directory (not
 * scripts/) because container/skills/pr-review-loop/scripts/codex-review.sh
 * reviews PRs in ANY repo it's dropped into and must find its allowlist next
 * to itself, not somewhere only this repo has.
 *
 * Modes:
 *   --write   regenerate the file from the ids below
 *   --check   fail (exit 1) if the file on disk doesn't match; the drift
 *             test (reviewer-models-freshness.test.ts) runs this on every
 *             test pass
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REVIEWER_MODELS_OUTPUT_PATH = path.join(REPO_ROOT, 'container/skills/pr-review-loop/reviewer-models.txt');

/**
 * The frontier model per provider — who reviews today. Changing a tier means
 * editing this list and running `pnpm run reviewer-models -- --write`.
 */
const FRONTIER_MODELS = ['claude-opus-5', 'gpt-5.6-sol'];

// Receipt compatibility only: these models remain eligible so an unchanged
// exact-head receipt does not expire when dispatch defaults change.
const COMPATIBLE_RECEIPT_MODELS = ['claude-fable-5-1', 'gpt-6-astra'];

export const REVIEWER_MODELS_HEADER = [
  '# generated from the reviewer roster in scripts/reviewer-models.ts — edit the',
  '# ids there, then run `pnpm run reviewer-models -- --write`',
  '#',
  '# One reviewer-eligible model id per line — the frontier model for each',
  '# vendor, plus prior Fable/Astra receipt compatibility (not dispatch defaults).',
  '# container/skills/pr-review-loop/scripts/codex-review.sh reads this file to',
  '# gate `receipt` and `merge-check`. See scripts/reviewer-models.ts.',
].join('\n');

/**
 * Refuse anything that isn't a bare model id, in two ways:
 *
 * 1. A bare alias ("opus", "sonnet", "inherit") standing in for a real model
 *    id — those resolve to whatever the runtime's current default is, so "who
 *    is allowed to review" would silently follow that default around instead
 *    of naming a fixed model. Every real id here (Claude or Codex) carries a
 *    version number, so requiring a digit is enough to catch an alias without
 *    hardcoding the alias list.
 * 2. A shape that isn't purely `[A-Za-z0-9._-]+` — a trailing comment, extra
 *    words, or a `[1m]` context-window marker left on. Any of those would pass
 *    check 1 and then silently fail to match anything's first word at review
 *    time, costing that model reviewer eligibility with the drift test still
 *    green.
 */
export function assertConcreteModelId(id: string, source: string): void {
  if (!/[0-9]/.test(id)) {
    throw new Error(
      `${source}: "${id}" is not a concrete versioned model id — bare aliases like "opus", "sonnet", or "inherit" are not allowed here`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(
      `${source}: "${id}" is not a bare model id — expected only letters, digits, '.', '_', '-' (no comments, extra words, or a [1m] suffix)`,
    );
  }
}

/** The reviewer-eligible model ids, sorted and de-duplicated. */
export function computeReviewerModelIds(): string[] {
  for (const id of FRONTIER_MODELS) assertConcreteModelId(id, 'FRONTIER_MODELS');
  for (const id of COMPATIBLE_RECEIPT_MODELS) assertConcreteModelId(id, 'COMPATIBLE_RECEIPT_MODELS');
  return Array.from(new Set([...FRONTIER_MODELS, ...COMPATIBLE_RECEIPT_MODELS])).sort();
}

export function renderReviewerModelsFile(ids: string[]): string {
  return `${REVIEWER_MODELS_HEADER}\n${ids.join('\n')}\n`;
}

/**
 * The CLI, as a pure function of its arguments and its output path: returns the
 * process exit code instead of calling `process.exit`, so both modes and both
 * failure shapes are reachable from a test against a temp file. Only the guard
 * below turns the code into an exit.
 */
export function main(
  args: string[] = process.argv.slice(2),
  outputPath: string = REVIEWER_MODELS_OUTPUT_PATH,
): number {
  const write = args.includes('--write');
  const check = args.includes('--check');
  if (write === check) {
    console.error('usage: reviewer-models.ts --write | --check');
    return 2;
  }

  const ids = computeReviewerModelIds();
  const rendered = renderReviewerModelsFile(ids);

  if (write) {
    fs.writeFileSync(outputPath, rendered);
    console.log(`wrote ${path.relative(REPO_ROOT, outputPath)} (${ids.length} model id(s))`);
    return 0;
  }

  // check
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
  if (current !== rendered) {
    console.error(`${path.relative(REPO_ROOT, outputPath)} is stale — run \`pnpm run reviewer-models -- --write\``);
    return 1;
  }
  console.log('reviewer-models.txt is up to date');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
