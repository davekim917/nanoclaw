import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkCeilings } from './check-instruction-ceilings.js';
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
