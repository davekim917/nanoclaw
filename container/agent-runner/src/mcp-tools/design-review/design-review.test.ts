import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The loop root is resolved from the environment at module load — pin it to a temp
// dir BEFORE importing the module under test. CAVEAT: bun test shares one module
// registry across test files, so this pin only works while no earlier-loading test
// imports state.ts (directly or via a barrel/wrapper that pins a different root).
// If such a test is ever added, run it in a subprocess or this file breaks.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'design-review-test-'));
process.env.DESIGN_ARTIFACT_LOOP_ROOT = ROOT;

const { designReviewTools, normalizeSeverity, criticReviewedFor, nextDirective } = await import('./design-review.js');
const tool = designReviewTools[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (args: Record<string, unknown>): Promise<any> => tool.handler(args) as Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const textOf = (r: any): string => r.content[0].text as string;

describe('design_review — input validation (Codex E#1/E#2 security guards)', () => {
  it('test_rejects_dot_dot_id', async () => {
    const r = await call({ id: '..', artifactPath: `${ROOT}/anything.html` });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('id');
  });

  it('test_rejects_dotted_id', async () => {
    const r = await call({ id: 'a.b', artifactPath: `${ROOT}/a.b/x.html` });
    expect(r.isError).toBe(true);
  });

  it('test_rejects_single_dot_id', async () => {
    const r = await call({ id: '.', artifactPath: `${ROOT}/x.html` });
    expect(r.isError).toBe(true);
  });

  it('test_rejects_path_outside_run_dir', async () => {
    const r = await call({ id: 'ok', artifactPath: '/etc/passwd' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('inside');
  });

  it('test_rejects_missing_artifact', async () => {
    const r = await call({ id: 'okrun', artifactPath: `${ROOT}/okrun/nope.html` });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('not found');
  });
});

describe('normalizeSeverity — case-insensitive, never demotes (Codex P2)', () => {
  it('test_uppercase_high_preserved', () => {
    expect(normalizeSeverity('High')).toBe('high');
    expect(normalizeSeverity('HIGH')).toBe('high');
    expect(normalizeSeverity(' high ')).toBe('high');
  });
  it('test_critical_maps_up_to_high', () => {
    // a "critical"/"blocker" finding must NOT be silently demoted to medium
    expect(normalizeSeverity('critical')).toBe('high');
    expect(normalizeSeverity('Blocker')).toBe('high');
    expect(normalizeSeverity('P1')).toBe('high');
  });
  it('test_unknown_defaults_medium', () => {
    expect(normalizeSeverity('nitpick')).toBe('medium');
    expect(normalizeSeverity(undefined)).toBe('medium');
  });
  it('test_low_preserved', () => {
    expect(normalizeSeverity('LOW')).toBe('low');
  });
});

describe('criticReviewedFor — token + explicit array required (Codex P1)', () => {
  it('test_matching_token_with_empty_array_counts', () => {
    // "critic ran, found nothing" — an explicit empty array with a matching token is a valid pass
    expect(criticReviewedFor('abc', 'abc', [])).toBe(true);
    expect(criticReviewedFor('abc', 'abc', [{ severity: 'low', locus: 'x', message: 'y' }])).toBe(true);
  });
  it('test_token_only_without_array_does_not_count', () => {
    // echoing back just the token (no findings array) must NOT flip criticReviewed — the bypass
    expect(criticReviewedFor('abc', 'abc', undefined)).toBe(false);
    expect(criticReviewedFor('abc', 'abc', 'not-an-array')).toBe(false);
  });
  it('test_mismatched_or_empty_token_does_not_count', () => {
    expect(criticReviewedFor('stale', 'abc', [])).toBe(false);
    expect(criticReviewedFor('', 'abc', [])).toBe(false);
  });
});

describe('nextDirective — open findings take priority over the critic prompt (Codex P2)', () => {
  it('test_continue_with_open_findings_says_fix_not_critic', () => {
    const msg = nextDirective({ renderUnsafe: false, criticStale: false, status: 'continue', criticReviewed: false, openCount: 3, hasHigh: true });
    expect(msg).toContain('Fix the open findings');
    expect(msg).not.toContain('No deterministic findings');
  });
  it('test_continue_clean_but_uncritiqued_prompts_critic', () => {
    const msg = nextDirective({ renderUnsafe: false, criticStale: false, status: 'continue', criticReviewed: false, openCount: 0, hasHigh: false });
    expect(msg).toContain('not reviewed this version yet');
  });
  it('test_render_unsafe_directive', () => {
    const msg = nextDirective({ renderUnsafe: true, criticStale: false, status: 'continue', criticReviewed: false, openCount: 2, hasHigh: true });
    expect(msg).toContain('Render was SKIPPED');
  });
  it('test_ship_directive', () => {
    expect(nextDirective({ renderUnsafe: false, criticStale: false, status: 'shipped-with-disclosures', criticReviewed: true, openCount: 0, hasHigh: false })).toContain('Shippable');
  });

  // Codex P2 (round 6): blocked directive states the REAL reason, not always "HIGH findings"
  it('test_blocked_high_directive_mentions_high', () => {
    const msg = nextDirective({ renderUnsafe: false, criticStale: false, status: 'blocked', criticReviewed: true, openCount: 1, hasHigh: true });
    expect(msg).toContain('HIGH');
  });
  it('test_blocked_no_critic_directive_explains_critic', () => {
    // clean/medium-only at cap, never critic-reviewed → explain the critic, not phantom HIGHs
    const msg = nextDirective({ renderUnsafe: false, criticStale: false, status: 'blocked', criticReviewed: false, openCount: 0, hasHigh: false });
    expect(msg).toContain('critic never reviewed');
    expect(msg).not.toContain('HIGH findings');
  });
});
