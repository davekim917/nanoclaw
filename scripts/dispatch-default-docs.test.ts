/**
 * Drift tripwire for the dispatch-default policy as it is written in prose.
 *
 * PR #813 flipped the worker roster from Fable/Astra at medium to Opus/Sol at
 * high in `container/agents/worker-frontier.md` and `CODEX_WORKER_MODELS`, and
 * three doc surfaces kept the old sentence. Code and prose disagreed, and every
 * agent reads the prose.
 *
 * The check is one POSITIVE assertion, not a search for stale wording. Each
 * dispatch-policy doc must carry the same anchor sentence, and that sentence is
 * BUILT from the frontier config — the def's `effort:` and `model:` frontmatter
 * plus `CODEX_WORKER_MODELS['worker-frontier']`. Change the roster and every
 * doc missing the new sentence fails by name.
 *
 * Deliberately NOT a keyword or paragraph scan. A negative gate ("this doc
 * mentions Fable without the word escalation") is wrong in both directions: it
 * blocks a legitimate sentence like "Use Astra only when a human asks", and it
 * waves through "Fable/Astra are the defaults; Opus/Sol were the prior ones"
 * because the word "prior" appears — while "Medium is the default effort",
 * naming no model at all, stays invisible to it.
 *
 * The limit of a positive anchor, stated plainly: it guarantees each doc states
 * the CURRENT default, not that the doc contains no sentence contradicting it.
 * A contradiction added alongside an intact anchor passes here and is review's
 * job. What cannot happen any more is the #813 failure — the roster moving
 * while a doc's default sentence silently stays behind.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CODEX_WORKER_MODELS } from '../src/claude-agent-md.js';

const REPO_ROOT = path.join(__dirname, '..');
const FRONTIER_DEF = 'container/agents/worker-frontier.md';

/**
 * Dispatch-policy prose. `container/skills/smoke-test/SKILL.md` is deliberately
 * absent: the QA lane keeps its own pinned model/effort and is not governed by
 * the general worker default (docs/review-policy.md — QA/release owners retain
 * their separate contracts).
 */
const POLICY_DOCS = ['docs/frontier-worker-trial.md', 'docs/review-policy.md', 'container/skills/pr-review-loop/SKILL.md'];

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
}

/** Pull one scalar out of the frontier def's YAML frontmatter. */
function frontmatter(field: string): string {
  const content = read(FRONTIER_DEF);
  if (!content.startsWith('---\n')) throw new Error(`${FRONTIER_DEF}: no frontmatter block`);
  const end = content.indexOf('\n---', 4);
  if (end < 0) throw new Error(`${FRONTIER_DEF}: unterminated frontmatter block`);
  const match = new RegExp(`^${field}:[ \\t]*(\\S.*?)[ \\t]*$`, 'm').exec(content.slice(4, end));
  if (!match) throw new Error(`${FRONTIER_DEF}: no \`${field}:\` frontmatter line`);
  return match[1];
}

const stripContextWindowSuffix = (id: string): string => id.replace(/\[1m\]$/i, '');

describe('dispatch-default policy prose tracks the frontier config', () => {
  const effort = frontmatter('effort');
  const claudeId = stripContextWindowSuffix(frontmatter('model'));
  const codexId = CODEX_WORKER_MODELS['worker-frontier'];
  const anchor =
    `${effort.charAt(0).toUpperCase()}${effort.slice(1)} is the default worker effort; ` +
    `the default worker is \`${claudeId}\` on Claude and \`${codexId}\` on Codex.`;

  it('the frontier def describes the same effort it pins', () => {
    // `description` is what reaches the Codex twin (src/claude-agent-md.ts
    // retargetRunsOnSentence rewrites only the model half of it), so a
    // description that names a different effort than `effort:` ships a lie.
    expect(frontmatter('description')).toContain(`at ${effort} effort`);
  });

  it.each(POLICY_DOCS)('%s carries the current default-worker sentence', (rel) => {
    expect(
      read(rel),
      `${rel} is missing the anchor sentence for the current roster. Add it verbatim:\n\n  ${anchor}\n`,
    ).toContain(anchor);
  });
});
