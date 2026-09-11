/**
 * Drift guard for container/skills/pr-review-loop/reviewer-models.txt: it is generated
 * from the tier config (container/agents/worker-{high,frontier}.md `model:` frontmatter
 * and CODEX_WORKER_TIERS), not hand-maintained. If a tier model changes without
 * regenerating the file, the merge gate's reviewer allowlist silently goes stale —
 * this test fails the same way on the next test run instead.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  computeReviewerModelIds,
  REVIEWER_MODELS_OUTPUT_PATH,
  renderReviewerModelsFile,
} from './reviewer-models.js';

const REGEN_HINT = 'pnpm run reviewer-models -- --write';

describe('reviewer-models.txt matches the tier config', () => {
  it('the generated file is exactly what computeReviewerModelIds produces', () => {
    const ids = computeReviewerModelIds();
    const expected = renderReviewerModelsFile(ids);
    const actual = fs.existsSync(REVIEWER_MODELS_OUTPUT_PATH)
      ? fs.readFileSync(REVIEWER_MODELS_OUTPUT_PATH, 'utf8')
      : null;
    expect(actual, `reviewer-models.txt is stale or missing — regenerate: \`${REGEN_HINT}\``).toBe(expected);
  });

  it('derives exactly the high and frontier tier models, deduplicated and sorted', () => {
    const ids = computeReviewerModelIds();
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    // Sanity: every id is non-empty and none is a cheap/fast tier's model.
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).not.toMatch(/sonnet|haiku|luna|terra|flash|mini/i);
    }
  });
});
