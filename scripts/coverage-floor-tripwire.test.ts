import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { type Baseline, discoverRiskFiles, hasExecutableCode, readRiskGlobs } from './check-risk-coverage.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * The coverage ratchet runs only in the full suite. This holds the part of its check that needs no coverage run:
 * every risk file with executable code has a floor. A baseline of 'n/a' is no floor once the file gains code. The
 * floor's value is still the ratchet's to judge.
 */
describe('coverage-risk-baseline.json covers every risk file', () => {
  it('names each risk:high file that has executable code', () => {
    const labeler = parseYaml(fs.readFileSync(path.join(repoRoot, '.github', 'labeler.yml'), 'utf8')) as Record<
      string,
      unknown
    >;
    const { host, container } = readRiskGlobs(labeler);
    const baseline = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'coverage-risk-baseline.json'), 'utf8'),
    ) as Baseline;
    const riskFiles = discoverRiskFiles(repoRoot, [...host, ...container]);
    expect(riskFiles.length).toBeGreaterThan(100);
    const missing = riskFiles.filter(
      (file) =>
        (!Object.hasOwn(baseline.files, file) || baseline.files[file] === 'n/a') &&
        hasExecutableCode(fs.readFileSync(path.join(repoRoot, file), 'utf8')),
    );
    expect(
      missing,
      'risk file(s) with no coverage floor: add each to coverage-risk-baseline.json at the value a coverage run measures (pnpm run test:coverage:risk, or gh workflow run ci-full.yml on the branch); "untested" is only for a file with no test at all',
    ).toEqual([]);
  });
});
