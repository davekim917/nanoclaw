import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../../src/test-hermeticity.js';
import { globsForRiskHigh, matchesAnyGlob } from '../review-outcomes.js';

enforceHermeticity();

const ROOT = path.join(import.meta.dirname, '..', '..');

describe('the hygiene checks cannot be weakened without review', () => {
  const riskHigh = globsForRiskHigh(parse(fs.readFileSync(path.join(ROOT, '.github', 'labeler.yml'), 'utf8')));

  it.each([
    'scripts/hygiene/run.ts',
    'scripts/hygiene/comments.ts',
    'knip.json',
    'container/agent-runner/knip.json',
    '.jscpd.json',
    '.github/workflows/ci.yml',
    '.github/workflows/ci-full.yml',
    '.github/host-ci.sh',
  ])('%s is risk:high', (file) => {
    expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
    expect(matchesAnyGlob(file, riskHigh)).toBe(true);
  });
});
