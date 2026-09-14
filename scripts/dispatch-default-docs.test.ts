/**
 * Drift tripwire for the dispatch-default policy as it is written in prose.
 *
 * The worker roster has two tiers: the DEFAULT worker (`worker-frontier`'s own
 * model on each provider) and the ESCALATION tier, chosen by judgment shape or
 * on explicit human request. Both tiers are real, so no doc can be checked by
 * "does it mention Fable" alone — Fable/Astra legitimately appear as the
 * escalation and as prior-receipt-compatible reviewer ids.
 *
 * What DOES fail loudly is an escalation-tier model described as the thing
 * substantive work goes to. PR #813 flipped the roster from Fable/Astra at
 * medium to Opus/Sol at high in `container/agents/worker-frontier.md` and
 * `CODEX_WORKER_MODELS`, and three doc surfaces kept the old sentence
 * ("Substantive work favors Fable/Astra at medium", "Medium is the default
 * effort") — code and prose disagreed, and every agent reads the prose.
 *
 * So: in each policy doc below, every PARAGRAPH that names an escalation-tier
 * model must also carry a marker that frames it as escalation or as receipt
 * compatibility. Paragraph granularity, not line, because these files are
 * hard-wrapped and the marker routinely lands on the next line.
 *
 * Both tiers are DERIVED, never hardcoded (the `drift tests` class in
 * docs/review-notes.md): the defaults come from the frontier config, and the
 * escalation tier is the reviewer allowlist minus those defaults. Flipping the
 * roster again therefore re-points this check automatically.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CODEX_WORKER_MODELS } from '../src/claude-agent-md.js';

import { computeReviewerModelIds } from './reviewer-models.js';

const REPO_ROOT = path.join(__dirname, '..');
const FRONTIER_DEF = path.join(REPO_ROOT, 'container/agents/worker-frontier.md');

/**
 * Dispatch-policy prose. `container/skills/smoke-test/SKILL.md` is deliberately
 * absent: the QA lane keeps its own pinned model/effort and is not governed by
 * the general worker default (docs/review-policy.md — QA/release owners retain
 * their separate contracts).
 */
const POLICY_DOCS = [
  'docs/frontier-worker-trial.md',
  'docs/review-policy.md',
  'container/skills/pr-review-loop/SKILL.md',
  'container/agents/worker-frontier.md',
];

/** Words that frame an escalation-tier mention as something other than the default. */
const ESCALATION_MARKERS = [
  'escalation',
  'escalate',
  'compatibility',
  'compatible',
  'prior',
  'retired',
  'example',
  'not dispatch defaults',
];

/** Short tier names that appear in prose alongside the bare model ids. */
const FRIENDLY: Record<string, string[]> = {
  'claude-fable-5-1': ['Fable'],
  'claude-opus-5': ['Opus'],
  'gpt-6-astra': ['Astra'],
  'gpt-5.6-sol': ['Sol'],
};

function stripContextWindowSuffix(id: string): string {
  return id.replace(/\[1m\]$/i, '');
}

/** The Claude default: `worker-frontier`'s own `model:` frontmatter. */
function claudeDefaultId(): string {
  const content = fs.readFileSync(FRONTIER_DEF, 'utf8').replace(/\r\n?/g, '\n');
  const match = /^model:\s*(\S+)\s*$/m.exec(content.slice(0, content.indexOf('\n---', 4)));
  if (!match) throw new Error(`no model: frontmatter in ${FRONTIER_DEF}`);
  return stripContextWindowSuffix(match[1]);
}

/** Paragraphs = blank-line-separated blocks, so a hard-wrapped sentence stays whole. */
function paragraphs(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
}

describe('dispatch-default policy prose tracks the frontier config', () => {
  const defaults = new Set([claudeDefaultId(), CODEX_WORKER_MODELS['worker-frontier']]);
  const escalation = computeReviewerModelIds().filter((id) => !defaults.has(id));

  it('derives a non-empty escalation tier distinct from the defaults', () => {
    expect(defaults.size).toBe(2);
    expect(escalation.length).toBeGreaterThan(0);
    for (const id of escalation) expect(defaults.has(id)).toBe(false);
  });

  it.each(POLICY_DOCS)('%s frames every escalation-tier mention as escalation', (rel) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const offenders: string[] = [];
    for (const block of paragraphs(text)) {
      const lower = block.toLowerCase();
      const names = escalation.flatMap((id) => [id, ...(FRIENDLY[id] ?? [])]);
      const hit = names.find((name) => lower.includes(name.toLowerCase()));
      if (!hit) continue;
      if (ESCALATION_MARKERS.some((m) => lower.includes(m))) continue;
      offenders.push(`names "${hit}" as an unqualified default: ${block.slice(0, 160).replace(/\n/g, ' ')}`);
    }
    expect(
      offenders,
      `${rel} describes an escalation-tier model as the dispatch default. The defaults are ` +
        `${[...defaults].join(' / ')} — update the prose, or mark the mention as escalation/compatibility.`,
    ).toEqual([]);
  });
});
