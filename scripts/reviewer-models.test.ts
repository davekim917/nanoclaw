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

import { assertConcreteModelId, computeReviewerModelIds, main, renderReviewerModelsFile } from './reviewer-models.js';

describe('computeReviewerModelIds', () => {
  it('lists the frontier models plus prior receipt compatibility, deduplicated and sorted', () => {
    const ids = computeReviewerModelIds();
    expect(ids).toEqual([
      'claude-fable-5-1',
      'claude-opus-5',
      'deepseek-v4.1-flash',
      'gpt-5.6-sol',
      'gpt-6-astra',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    // Sanity: every id is non-empty and none is a cheap/fast/small tier's model.
    //
    // `flash` USED TO BE in this alternation and is deliberately not any more.
    // It is a vendor's latency brand, not a capability tier: DeepSeek v4.1-flash
    // and Gemini 3.8-flash are frontier-class, comparable to Opus and Sol, while
    // `gemini-3.5-flash-lite` is not — and `lite` still catches that one. A
    // substring of a marketing name is a poor proxy for capability, so the
    // markers kept here are the ones that still name a genuinely smaller tier in
    // this fleet's vocabulary (operator correction, 2026-09-22).
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).not.toMatch(/sonnet|haiku|luna|terra|mini|nano|lite/i);
    }
  });

  // MUTATION-SENSITIVE, deliberately. Asserting that the committed ids happen
  // to satisfy `assertConcreteModelId` proves nothing about the code: delete
  // both guard loops and that assertion stays green, because the real ids are
  // valid either way. The roster is hand-maintained now, so the guard RUNNING
  // is the only thing that stops an alias being typed in — so these drive the
  // function with a roster it must refuse. Deleting either loop turns the
  // matching case red.
  it('refuses an alias typed into the frontier roster', () => {
    expect(() => computeReviewerModelIds(['opus'], ['claude-fable-5-1'])).toThrow(/FRONTIER_MODELS/);
  });

  it('refuses an alias typed into the receipt-compatibility roster', () => {
    expect(() => computeReviewerModelIds(['claude-opus-5'], ['inherit'])).toThrow(/COMPATIBLE_RECEIPT_MODELS/);
  });

  it('deduplicates and sorts across the two rosters', () => {
    expect(computeReviewerModelIds(['b-2', 'a-1'], ['a-1', 'c-3'])).toEqual(['a-1', 'b-2', 'c-3']);
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
