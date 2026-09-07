import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkCeilings, parseAllowances } from './check-instruction-ceilings.js';
import { TRUNK_DOC_BYTES_CEILING } from './instruction-surface.js';

const TARGETS = [{ file: 'CLAUDE.md', ceiling: TRUNK_DOC_BYTES_CEILING, scanPatterns: true }];

let root: string;

/** Filler with no banned patterns, so size and pattern cases stay independent. */
function write(bytes: number, extra = ''): void {
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'x'.repeat(bytes) + extra);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-ceilings-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('checkCeilings', () => {
  it('passes a file at exactly its ceiling', () => {
    write(TRUNK_DOC_BYTES_CEILING);
    expect(checkCeilings(root, TARGETS, {})).toEqual([]);
  });

  it('fails a file one byte over its ceiling', () => {
    write(TRUNK_DOC_BYTES_CEILING + 1);
    const kinds = checkCeilings(root, TARGETS, {}).map((f) => f.kind);
    expect(kinds).toEqual(['over-budget']);
  });

  it('passes an over-ceiling file that has exactly enough allowance', () => {
    write(TRUNK_DOC_BYTES_CEILING + 500);
    expect(checkCeilings(root, TARGETS, { 'CLAUDE.md': 500 })).toEqual([]);
  });

  it('fails when growth exceeds the recorded allowance', () => {
    write(TRUNK_DOC_BYTES_CEILING + 501);
    const failures = checkCeilings(root, TARGETS, { 'CLAUDE.md': 500 });
    expect(failures.map((f) => f.kind)).toEqual(['over-budget']);
    expect(failures[0]?.message).toContain('over its 16884 B budget by 1 B');
  });

  // The ratchet: this is what stops a prune from being silently undone later.
  it('fails when a file is back under its ceiling but still holds an allowance', () => {
    write(TRUNK_DOC_BYTES_CEILING - 100);
    const failures = checkCeilings(root, TARGETS, { 'CLAUDE.md': 500 });
    expect(failures.map((f) => f.kind)).toEqual(['stale-allowance']);
  });

  // The ratchet has to bite on PARTIAL reductions too, not just once a file is
  // fully under its ceiling — otherwise a file trimmed from ceiling+500 to
  // ceiling+100 keeps a 500 B allowance and can silently regrow by 400 B.
  it('fails when a file shrinks but stays above its ceiling with a now-oversized allowance', () => {
    write(TRUNK_DOC_BYTES_CEILING + 100);
    const failures = checkCeilings(root, TARGETS, { 'CLAUDE.md': 500 });
    expect(failures.map((f) => f.kind)).toEqual(['stale-allowance']);
    expect(failures[0]?.message).toContain('needs 100 B of allowance');
    expect(failures[0]?.message).toContain('400 B of reclaimed headroom');
  });

  it('passes when an above-ceiling file has exactly the allowance it needs', () => {
    write(TRUNK_DOC_BYTES_CEILING + 100);
    expect(checkCeilings(root, TARGETS, { 'CLAUDE.md': 100 })).toEqual([]);
  });

  it('passes once the stale allowance is zeroed', () => {
    write(TRUNK_DOC_BYTES_CEILING - 100);
    expect(checkCeilings(root, TARGETS, { 'CLAUDE.md': 0 })).toEqual([]);
  });

  it('flags point-in-time facts even in an under-budget file', () => {
    write(100, ' shipped 2026-09-07 ');
    const kinds = checkCeilings(root, TARGETS, {}).map((f) => f.kind);
    expect(kinds).toEqual(['banned-pattern']);
  });

  it('skips targets whose file does not exist', () => {
    expect(checkCeilings(root, [{ file: 'nope.md', ceiling: 10, scanPatterns: true }], {})).toEqual([]);
  });
});

// A malformed allowance silently DISABLES this gate rather than tripping it:
// `ceiling + "1733"` concatenates and `ceiling + {}` is NaN, so every comparison
// evaluates false and an arbitrarily oversized file passes. Fail closed instead.
describe('parseAllowances', () => {
  it('accepts a well-formed policy', () => {
    expect(parseAllowances({ allowances: { 'CLAUDE.md': 1733, 'container/CLAUDE.md': 0 } })).toEqual({
      'CLAUDE.md': 1733,
      'container/CLAUDE.md': 0,
    });
  });

  it('treats a missing allowances key as no allowances', () => {
    expect(parseAllowances({ _comment: ['notes'] })).toEqual({});
  });

  it.each([
    ['a numeric string', '1733'],
    ['an object', {}],
    ['an array', []],
    ['null', null],
    ['a boolean', true],
    ['a float', 17.5],
    ['a negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s as an allowance value', (_label, value) => {
    expect(() => parseAllowances({ allowances: { 'CLAUDE.md': value } })).toThrow(/non-negative integer/);
  });

  it.each([
    ['a top-level array', []],
    ['a top-level string', 'nope'],
    ['null', null],
  ])('rejects %s as the document', (_label, doc) => {
    expect(() => parseAllowances(doc)).toThrow(/expected a JSON object/);
  });

  it('rejects a non-object allowances map', () => {
    expect(() => parseAllowances({ allowances: [1733] })).toThrow(/must be an object/);
  });

  // The concrete bypass Codex named: 30,000 B passing on a string allowance.
  it('does not let a string allowance wave through an oversized file', () => {
    expect(() => parseAllowances({ allowances: { 'CLAUDE.md': '1733' } })).toThrow();
  });
});

describe('checkCeilings edge cases', () => {
  it('treats a file with no recorded allowance as zero', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-ceilings-'));
    fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'x'.repeat(TRUNK_DOC_BYTES_CEILING + 1));
    expect(checkCeilings(d, TARGETS, {}).map((f) => f.kind)).toEqual(['over-budget']);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
