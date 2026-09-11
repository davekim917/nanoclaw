/**
 * Correctness tests for the reviewer-model derivation logic. Failure here
 * means the code is broken, not that a committed artifact is stale — the
 * pure freshness/drift check lives separately in
 * reviewer-models-freshness.test.ts (VITEST_LANE=drift), so the two failure
 * modes never get conflated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { computeReviewerModelIds } from './reviewer-models.js';

describe('computeReviewerModelIds', () => {
  it('derives exactly the high and frontier tier models, deduplicated and sorted', () => {
    const ids = computeReviewerModelIds();
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    // Sanity: every id is non-empty and none is a cheap/fast/small tier's model.
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).not.toMatch(/sonnet|haiku|luna|terra|mini|nano|lite|flash/i);
    }
  });
});

// Fixture repos for extractModelLine's edge cases: a real repoRoot's worker-high.md
// and worker-frontier.md are byte-fixed, so a folded-block or quoted `model:` line
// can only be exercised against a throwaway fixture tree.
const roots: string[] = [];

function writeFixtureRepo(overrides: { workerHigh?: string; workerFrontier?: string }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-models-fixture-'));
  roots.push(root);
  const dir = path.join(root, 'container/agents');
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = (name: string, model: string) =>
    `---\nname: ${name}\ndescription: d\nmodel: ${model}\neffort: high\n---\n\nbody\n`;
  fs.writeFileSync(
    path.join(dir, 'worker-high.md'),
    overrides.workerHigh ?? frontmatter('worker-high', 'claude-opus-5[1m]'),
  );
  fs.writeFileSync(
    path.join(dir, 'worker-frontier.md'),
    overrides.workerFrontier ?? frontmatter('worker-frontier', 'claude-fable-5-1[1m]'),
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('extractModelLine edge cases', () => {
  it('reads a folded block-scalar `model: |` line', () => {
    const root = writeFixtureRepo({
      workerHigh: '---\nname: worker-high\ndescription: d\nmodel: |\n  claude-opus-5[1m]\neffort: high\n---\n\nbody\n',
    });
    expect(computeReviewerModelIds(root)).toContain('claude-opus-5');
  });

  it('reads a double-quoted `model: "..."` line, unquoted', () => {
    const root = writeFixtureRepo({
      workerHigh: '---\nname: worker-high\ndescription: d\nmodel: "claude-opus-5[1m]"\neffort: high\n---\n\nbody\n',
    });
    expect(computeReviewerModelIds(root)).toContain('claude-opus-5');
  });

  it.each(['opus', 'sonnet', 'inherit'])('refuses a bare alias "%s" with no version number', (alias) => {
    const root = writeFixtureRepo({
      workerHigh: `---\nname: worker-high\ndescription: d\nmodel: ${alias}\neffort: high\n---\n\nbody\n`,
    });
    expect(() => computeReviewerModelIds(root)).toThrow(/not a concrete versioned model id/);
  });

  it('refuses a model line carrying a trailing comment (extractScalar reads it as part of the value)', () => {
    const root = writeFixtureRepo({
      workerHigh: '---\nname: worker-high\ndescription: d\nmodel: claude-opus-5[1m] # pinned\neffort: high\n---\n\nbody\n',
    });
    expect(() => computeReviewerModelIds(root)).toThrow(/is not a bare model id/);
  });

  it('refuses a model line that is several space-separated words, not one id', () => {
    const root = writeFixtureRepo({
      workerHigh: '---\nname: worker-high\ndescription: d\nmodel: claude opus 5\neffort: high\n---\n\nbody\n',
    });
    expect(() => computeReviewerModelIds(root)).toThrow(/is not a bare model id/);
  });
});
