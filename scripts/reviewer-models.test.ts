/**
 * Correctness tests for the reviewer-model roster. Failure here means the code
 * or the roster is broken, not that a committed artifact is stale — the pure
 * freshness/drift check lives separately in reviewer-models-freshness.test.ts
 * (VITEST_LANE=drift), so the two failure modes never get conflated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertConcreteModelId,
  computeReviewerModelIds,
  main,
  renderReviewerModelsFile,
} from './reviewer-models.js';

describe('computeReviewerModelIds', () => {
  it('lists the frontier models plus prior receipt compatibility, deduplicated and sorted', () => {
    const ids = computeReviewerModelIds();
    expect(ids).toEqual(['claude-fable-5-1', 'claude-opus-5', 'gpt-5.6-sol', 'gpt-6-astra']);
    expect(new Set(ids).size).toBe(ids.length);
    // Sanity: every id is non-empty and none is a cheap/fast/small tier's model.
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).not.toMatch(/sonnet|haiku|luna|terra|mini|nano|lite|flash/i);
    }
  });

  it('runs every listed id through the concrete-id guard', () => {
    // The roster is hand-maintained now, so the guard running over it is the
    // only thing stopping an alias being typed in. Asserted by exercising the
    // guard on each id rather than trusting the happy path above — a guard
    // that is never reached passes exactly the same way.
    for (const id of computeReviewerModelIds()) {
      expect(() => assertConcreteModelId(id, 'roster')).not.toThrow();
    }
  });
});

describe('assertConcreteModelId', () => {
  it.each(['opus', 'sonnet', 'inherit'])('refuses a bare alias "%s" with no version number', (alias) => {
    expect(() => assertConcreteModelId(alias, 'fixture')).toThrow(/not a concrete versioned model id/);
  });

  it('refuses an id carrying a trailing comment', () => {
    expect(() => assertConcreteModelId('claude-opus-5 # pinned', 'fixture')).toThrow(/is not a bare model id/);
  });

  it('refuses an id that is several space-separated words', () => {
    expect(() => assertConcreteModelId('claude opus 5', 'fixture')).toThrow(/is not a bare model id/);
  });

  it('refuses an id with the [1m] context-window suffix left on', () => {
    // The receipt gate tolerates a `[1m]` suffix on the reviewer's first word,
    // but the ALLOWLIST holds bare ids — a suffixed entry here would never be
    // what the gate compares against.
    expect(() => assertConcreteModelId('claude-opus-5[1m]', 'fixture')).toThrow(/is not a bare model id/);
  });

  it('accepts a bare versioned id', () => {
    expect(() => assertConcreteModelId('gpt-5.6-sol', 'fixture')).not.toThrow();
  });
});

describe('main', () => {
  let dir: string;
  let out: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-models-cli-'));
    out = path.join(dir, 'reviewer-models.txt');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--write renders the roster to the output path', () => {
    expect(main(['--write'], out)).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(renderReviewerModelsFile(computeReviewerModelIds()));
  });

  it('--check passes on a file --write just produced', () => {
    main(['--write'], out);
    expect(main(['--check'], out)).toBe(0);
  });

  it('--check fails on a stale file', () => {
    fs.writeFileSync(out, 'stale\n');
    expect(main(['--check'], out)).toBe(1);
  });

  it('--check fails when the file is missing entirely, never reads absence as a pass', () => {
    expect(main(['--check'], out)).toBe(1);
  });

  it('refuses both modes at once and neither mode, with the usage exit code', () => {
    expect(main([], out)).toBe(2);
    expect(main(['--write', '--check'], out)).toBe(2);
    // Neither call may have written anything.
    expect(fs.existsSync(out)).toBe(false);
  });
});
