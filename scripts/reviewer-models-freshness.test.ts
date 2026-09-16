/**
 * Drift tripwire for container/skills/pr-review-loop/reviewer-models.txt: it is
 * generated from the roster in scripts/reviewer-models.ts, not hand-maintained
 * at the artifact. If a tier model changes there without regenerating the file,
 * the merge gate's reviewer allowlist silently goes stale — this test fails the
 * same way on the next test run instead.
 *
 * Split out from reviewer-models.test.ts (which covers correctness — the
 * roster's contents, alias rejection) on purpose: this file's ONLY failure mode is
 * "the committed artifact is stale, regenerate it" (VITEST_LANE=drift, see
 * vitest.config.ts's DRIFT_TESTS), never "the code is broken". Mixing the two
 * into one file would make a real parsing bug in reviewer-models.ts read as
 * "just regenerate" — the exact ambiguity DRIFT_TESTS exists to remove.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { computeReviewerModelIds, REVIEWER_MODELS_OUTPUT_PATH, renderReviewerModelsFile } from './reviewer-models.js';

const REGEN_HINT = 'pnpm run reviewer-models -- --write';

describe('reviewer-models.txt matches the reviewer roster', () => {
  it('the generated file is exactly what computeReviewerModelIds produces', () => {
    const ids = computeReviewerModelIds();
    const expected = renderReviewerModelsFile(ids);
    const actual = fs.existsSync(REVIEWER_MODELS_OUTPUT_PATH)
      ? fs.readFileSync(REVIEWER_MODELS_OUTPUT_PATH, 'utf8')
      : null;
    expect(actual, `reviewer-models.txt is stale or missing — regenerate: \`${REGEN_HINT}\``).toBe(expected);
  });
});
