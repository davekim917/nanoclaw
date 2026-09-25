import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { matchesAnyGlob } from './review-outcomes.js';

/**
 * Drift guard for .github/labeler.yml: `risk:high` is documented as the union of
 * every dimension label's globs (risk:guard, risk:message-path, ...), and the
 * merge gate (container/skills/pr-review-loop/scripts/codex-review.sh) matches only
 * `risk:high`'s globs. If someone adds a path to a dimension label without adding it to
 * risk:high, or vice versa, the two silently drift apart and a reviewer's
 * dimension-scoped view stops matching what actually triggers review.
 *
 * Deliberately not pinned here: the risk:high glob list itself. Dropping a path from
 * it edits labeler.yml, which sits under `.github/**`, and the merge gate reads its globs
 * from the base branch, as the labeler does, so that PR is reviewed.
 */

const LABELER_PATH = path.join(__dirname, '..', '.github', 'labeler.yml');

type LabelerConfig = Record<string, unknown>;

/**
 * The globs of `label`, which must be written in the one shape this file uses: a single
 * rule holding a single `any-glob-to-any-file` entry. Anything else throws instead of
 * being modeled: the labeler ANDs top-level rules (actions/labeler README, "From a
 * boolean logic perspective"), so a union over several rules would describe a label
 * the labeler never applies.
 */
function globsFor(config: LabelerConfig, label: string): string[] {
  const rules = config[label];
  const rule = Array.isArray(rules) && rules.length === 1 ? rules[0] : undefined;
  const entries = isSingleKey(rule, 'changed-files') ? rule['changed-files'] : undefined;
  const entry = Array.isArray(entries) && entries.length === 1 ? entries[0] : undefined;
  const globs = isSingleKey(entry, 'any-glob-to-any-file') ? entry['any-glob-to-any-file'] : undefined;
  // The labeler takes a bare string as a one-glob list (actions/labeler README, "Basic Examples").
  if (typeof globs === 'string') return [globs];
  if (Array.isArray(globs) && globs.every((glob) => typeof glob === 'string')) return globs;
  throw new Error(`labeler.yml "${label}" must be exactly: - changed-files: - any-glob-to-any-file: [globs]`);
}

function isSingleKey(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.keys(value).join() === key;
}

describe('labeler.yml dimension labels stay in sync with risk:high', () => {
  const raw = fs.readFileSync(LABELER_PATH, 'utf8');
  const config = parse(raw) as LabelerConfig;

  const highGlobs = new Set(globsFor(config, 'risk:high'));
  const dimensionLabels = Object.keys(config).filter((label) => label.startsWith('risk:') && label !== 'risk:high');

  it('defines dimension labels', () => {
    expect(dimensionLabels.length).toBeGreaterThan(0);
  });

  it.each(dimensionLabels)('%s globs are a subset of risk:high', (label) => {
    const dimGlobs = globsFor(config, label);
    expect(dimGlobs.length).toBeGreaterThan(0);
    for (const glob of dimGlobs) {
      expect(highGlobs.has(glob), `${label} glob "${glob}" is missing from risk:high`).toBe(true);
    }
  });

  it('every risk:high glob appears under at least one dimension label', () => {
    const dimGlobs = new Set(dimensionLabels.flatMap((label) => globsFor(config, label)));
    for (const glob of highGlobs) {
      expect(dimGlobs.has(glob), `risk:high glob "${glob}" is not covered by any risk:<dimension> label`).toBe(true);
    }
  });

  // scripts/check-risk-coverage.ts fails closed on a missing baseline, but nothing stops
  // a PR from deleting tests and committing a lower `--write`d baseline over the old one
  // if this file itself were not gated — docs/specs/risk-based-review/plan.md, "Tests on
  // risky paths".
  it('protects the coverage ratchet baseline (coverage-risk-baseline.json)', () => {
    expect(highGlobs.has('coverage-risk-baseline.json')).toBe(true);
    expect(globsFor(config, 'risk:gates')).toContain('coverage-risk-baseline.json');
  });

  // A PR that loosens the test-weakening trigger, or turns it off, is itself reviewed.
  it.each(['container/skills/pr-review-loop/scripts/test-weakening.mjs', '.github/pr-review-loop.json'])(
    'protects the test-weakening trigger and its opt-in: %s',
    (file) => {
      expect(matchesAnyGlob(file, [...highGlobs])).toBe(true);
      expect(matchesAnyGlob(file, globsFor(config, 'risk:gates'))).toBe(true);
    },
  );
});

describe('globsFor', () => {
  const rule = (globs: unknown) => [{ 'changed-files': [{ 'any-glob-to-any-file': globs }] }];

  it('reads a glob list', () => {
    expect(globsFor({ l: rule(['a/**', 'b.ts']) }, 'l')).toEqual(['a/**', 'b.ts']);
  });

  it('reads a bare string as one glob, not its characters', () => {
    expect(globsFor({ l: rule('docs/**') }, 'l')).toEqual(['docs/**']);
  });

  it.each([
    ['a missing label', {}],
    ['two top-level rules, which the labeler ANDs', { l: [...rule(['a']), ...rule(['b'])] }],
    [
      'two changed-files entries',
      { l: [{ 'changed-files': [{ 'any-glob-to-any-file': ['a'] }, { 'all-globs-to-all-files': ['b'] }] }] },
    ],
    ['an any: wrapper', { l: [{ any: [{ 'changed-files': [{ 'any-glob-to-any-file': ['a'] }] }] }] }],
    [
      'a branch rule beside changed-files',
      { l: [{ 'changed-files': [{ 'any-glob-to-any-file': ['a'] }], 'head-branch': ['x'] }] },
    ],
    ['a different match option', { l: [{ 'changed-files': [{ 'all-globs-to-any-file': ['a'] }] }] }],
  ])('throws on %s', (_name, config) => {
    expect(() => globsFor(config, 'l')).toThrow(/must be exactly/);
  });
});
