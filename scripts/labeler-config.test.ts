import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard for .github/labeler.yml: `risk:high` is documented as the union of
 * every dimension label's globs (risk:guard, risk:message-path, ...), and the
 * merge gate (container/skills/pr-review-loop/scripts/codex-review.sh) reads only
 * `risk:high`. If someone adds a path to a dimension label without adding it to
 * risk:high, or vice versa, the two silently drift apart and a reviewer's
 * dimension-scoped view stops matching what actually triggers review.
 */

const LABELER_PATH = path.join(__dirname, '..', '.github', 'labeler.yml');

interface LabelerConfig {
  [label: string]: Array<{
    'changed-files'?: Array<{ 'any-glob-to-any-file'?: string[] }>;
  }>;
}

function globsFor(config: LabelerConfig, label: string): string[] {
  const rules = config[label];
  if (!rules) throw new Error(`labeler.yml has no top-level "${label}" key`);
  const globs: string[] = [];
  for (const rule of rules) {
    for (const cf of rule['changed-files'] ?? []) {
      globs.push(...(cf['any-glob-to-any-file'] ?? []));
    }
  }
  return globs;
}

const DIMENSION_LABELS = [
  'risk:guard',
  'risk:message-path',
  'risk:sweep',
  'risk:session-db',
  'risk:self-mod',
  'risk:credential',
  'risk:migration',
  'risk:supply-chain',
  'risk:deploy',
  'risk:gates',
  'risk:runner',
];

describe('labeler.yml dimension labels stay in sync with risk:high', () => {
  const raw = fs.readFileSync(LABELER_PATH, 'utf8');
  const config = parse(raw) as LabelerConfig;

  const highGlobs = new Set(globsFor(config, 'risk:high'));

  it('defines every expected dimension label', () => {
    for (const label of DIMENSION_LABELS) {
      expect(config[label], `missing label ${label}`).toBeDefined();
    }
  });

  it.each(DIMENSION_LABELS)('%s globs are a subset of risk:high', (label) => {
    const dimGlobs = globsFor(config, label);
    expect(dimGlobs.length).toBeGreaterThan(0);
    for (const glob of dimGlobs) {
      expect(highGlobs.has(glob), `${label} glob "${glob}" is missing from risk:high`).toBe(true);
    }
  });

  it('every risk:high glob appears under at least one dimension label', () => {
    const dimGlobs = new Set(DIMENSION_LABELS.flatMap((label) => globsFor(config, label)));
    for (const glob of highGlobs) {
      expect(dimGlobs.has(glob), `risk:high glob "${glob}" is not covered by any risk:<dimension> label`).toBe(
        true,
      );
    }
  });
});
