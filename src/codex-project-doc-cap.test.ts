import { describe, expect, it, vi } from 'vitest';

// Suppress the warn/error logs the cap emits; we assert on the returned doc.
vi.mock('./log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./log.js')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  CODEX_PROJECT_DOC_MAX_BYTES,
  CODEX_PROJECT_DOC_WARN_BYTES,
  PROTECTED_SECTION_MARKER,
  capCodexProjectDoc,
} from './codex-project-doc-cap.js';

const bytes = (s: string): number => Buffer.byteLength(s, 'utf-8');
const filler = (n: number): string => 'x'.repeat(n);

describe('capCodexProjectDoc', () => {
  it('returns content unchanged when under the cap', () => {
    const doc = '# Title\n\nsome rules\n\n## Section A\n\nbody';
    expect(capCodexProjectDoc(doc)).toBe(doc);
  });

  it('returns content unchanged when near (but under) the cap', () => {
    const doc = '# Title\n\n' + filler(CODEX_PROJECT_DOC_WARN_BYTES + 100);
    expect(bytes(doc)).toBeGreaterThanOrEqual(CODEX_PROJECT_DOC_WARN_BYTES);
    expect(bytes(doc)).toBeLessThanOrEqual(CODEX_PROJECT_DOC_MAX_BYTES);
    expect(capCodexProjectDoc(doc)).toBe(doc);
  });

  it('degrades by dropping the section(s) needed to fit, keeping the head and the rest, never throwing', () => {
    const head = '# Title\n\nhighest-priority rules\n';
    const small1 = `## Keep Me One\n\n${filler(2000)}`;
    const huge = `## Drop Me\n\n${filler(40 * 1024)}`; // only its removal fits
    const small2 = `## Keep Me Two\n\n${filler(2000)}`;
    const doc = [head, small1, huge, small2].join('\n');
    expect(bytes(doc)).toBeGreaterThan(CODEX_PROJECT_DOC_MAX_BYTES);

    const out = capCodexProjectDoc(doc);

    expect(bytes(out)).toBeLessThanOrEqual(CODEX_PROJECT_DOC_MAX_BYTES);
    expect(out).toContain('## Omitted for size');
    expect(out).toContain('Drop Me'); // named in the omission note
    expect(out).not.toContain(filler(40 * 1024)); // huge body actually removed
    expect(out).toContain('highest-priority rules'); // head preserved
    expect(out).toContain('Keep Me One'); // smaller sections preserved
    expect(out).toContain('Keep Me Two');
  });

  it('drops the smallest section that makes it fit, not the largest', () => {
    // Both sections individually fit when removed, but the guard must prefer
    // the SMALLEST sufficient drop — losing the least content. Regression for
    // the real-world case: main-codex needed to shed ~240 bytes, and the old
    // "drop largest" evicted the 4.7KB self-mod section instead of a small one.
    const head = '# Title\n\nrules\n';
    const big = `## Keep Big\n\n${'x'.repeat(24 * 1024)}`;
    const small = `## Drop Small\n\n${'y'.repeat(9 * 1024)}`;
    const doc = [head, big, small].join('\n'); // ~33KB, over the cap
    expect(bytes(doc)).toBeGreaterThan(CODEX_PROJECT_DOC_MAX_BYTES);

    const out = capCodexProjectDoc(doc);

    expect(bytes(out)).toBeLessThanOrEqual(CODEX_PROJECT_DOC_MAX_BYTES);
    expect(out).toContain('## Keep Big'); // larger section preserved...
    expect(out).toContain('x'.repeat(24 * 1024)); // ...with its body intact
    expect(out).not.toContain('y'.repeat(9 * 1024)); // smaller section dropped
    expect(out).toContain('Drop Small'); // named in the omission note
  });

  it('spends unmarked sections before a PROTECTED_SECTION_MARKER one, even when the marked section is the smaller sufficient drop', () => {
    // Discriminating case: BOTH removals individually fit, and the guarded
    // section is the SMALLER one — so the smallest-sufficient rule alone would
    // evict it. Precedence must outrank size. This is the production failure:
    // `Credential Security` (small) was dropped while `Admin CLI (ncl)` (large,
    // and rediscoverable via `ncl help`) survived.
    const head = '# Title\n\nrules\n';
    const guarded = `## Guarded\n\n${PROTECTED_SECTION_MARKER}\n${'g'.repeat(9 * 1024)}`;
    const droppable = `## Droppable\n\n${'d'.repeat(24 * 1024)}`;
    const doc = [head, guarded, droppable].join('\n');
    expect(bytes(doc)).toBeGreaterThan(CODEX_PROJECT_DOC_MAX_BYTES);

    const out = capCodexProjectDoc(doc);

    expect(bytes(out)).toBeLessThanOrEqual(CODEX_PROJECT_DOC_MAX_BYTES);
    expect(out).toContain('## Guarded'); // marked section survives...
    expect(out).toContain('g'.repeat(9 * 1024)); // ...with its body intact
    expect(out).not.toContain('d'.repeat(24 * 1024)); // unmarked one paid instead
    expect(out).toContain('Droppable'); // named in the omission note
  });

  it('drops marked sections as a last resort rather than throwing, once no unmarked section is left', () => {
    const head = '# Title\n\nrules\n';
    const a = `## Guarded A\n\n${PROTECTED_SECTION_MARKER}\n${'a'.repeat(20 * 1024)}`;
    const b = `## Guarded B\n\n${PROTECTED_SECTION_MARKER}\n${'b'.repeat(20 * 1024)}`;
    const doc = [head, a, b].join('\n');

    let out: string | undefined;
    expect(() => {
      out = capCodexProjectDoc(doc);
    }).not.toThrow();
    expect(bytes(out!)).toBeLessThanOrEqual(CODEX_PROJECT_DOC_MAX_BYTES);
    expect(out).toContain('## Omitted for size');
  });

  it('does not throw when the head alone exceeds the cap (writes oversized)', () => {
    const doc = '# Title\n\n' + filler(40 * 1024); // no ## sections to drop
    let out: string | undefined;
    expect(() => {
      out = capCodexProjectDoc(doc);
    }).not.toThrow();
    expect(out).toBe(doc); // nothing droppable — returned as-is, logged loudly
  });
});
