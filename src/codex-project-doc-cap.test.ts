import { describe, expect, it, vi } from 'vitest';

// Suppress the warn/error logs the cap emits; we assert on the returned doc.
vi.mock('./log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./log.js')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  CODEX_PROJECT_DOC_MAX_BYTES,
  CODEX_PROJECT_DOC_WARN_BYTES,
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

  it('degrades by dropping the largest sections until it fits, never throwing', () => {
    const head = '# Title\n\nhighest-priority rules\n';
    const small1 = `## Keep Me One\n\n${filler(2000)}`;
    const huge = `## Drop Me\n\n${filler(40 * 1024)}`; // alone exceeds the cap
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

  it('does not throw when the head alone exceeds the cap (writes oversized)', () => {
    const doc = '# Title\n\n' + filler(40 * 1024); // no ## sections to drop
    let out: string | undefined;
    expect(() => {
      out = capCodexProjectDoc(doc);
    }).not.toThrow();
    expect(out).toBe(doc); // nothing droppable — returned as-is, logged loudly
  });
});
