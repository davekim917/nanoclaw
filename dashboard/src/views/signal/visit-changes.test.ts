import { describe, expect, it } from 'vitest';
import { decisionVisitChange, readVisitBaseline, saveVisitBaseline } from './visit-changes';
const stamp = {
  id: 'decision-a',
  evidence_hash: 'content-a',
  version: 1,
  state: 'open' as const,
  dispatch_state: 'not_requested' as const,
};
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
describe('decision changes since the previous visit', () => {
  it('keeps reviewers and workspace baselines separate and never stores source prose', () => {
    const s = storage();
    saveVisitBaseline(s, 'reviewer-a', 'workspace-a', [{ ...stamp, ...{ question: 'private source text' } }]);
    expect(readVisitBaseline(s, 'reviewer-b', 'workspace-a')).toBeNull();
    expect(readVisitBaseline(s, 'reviewer-a', 'workspace-b')).toBeNull();
    expect([...s.values.values()].join('')).not.toContain('private source text');
    expect(decisionVisitChange(stamp, readVisitBaseline(s, 'reviewer-a', 'workspace-a'))).toBeNull();
  });
  it('distinguishes first visit, newly observed work, material changes, and delivery updates', () => {
    expect(decisionVisitChange(stamp, null)).toBeNull();
    const before = { seenAt: '2026-09-01T00:00:00.000Z', decisions: [stamp] };
    expect(decisionVisitChange({ ...stamp, id: 'decision-b' }, before)).toBe('new');
    expect(decisionVisitChange({ ...stamp, evidence_hash: 'content-b' }, before)).toBe('changed');
    expect(decisionVisitChange({ ...stamp, dispatch_state: 'sent' }, before)).toBe('changed');
    expect(decisionVisitChange(stamp, before)).toBeNull();
  });
  it('retains previously observed records when a limited or partial response omits them', () => {
    const s = storage();
    saveVisitBaseline(s, 'reviewer-a', 'workspace-a', [stamp]);
    saveVisitBaseline(s, 'reviewer-a', 'workspace-a', [{ ...stamp, id: 'decision-b' }]);
    expect(decisionVisitChange(stamp, readVisitBaseline(s, 'reviewer-a', 'workspace-a'))).toBeNull();
  });
  it('does not break the review experience when browser storage is malformed or denied', () => {
    expect(readVisitBaseline({ getItem: () => '{broken', setItem: () => {} }, 'a', 'b')).toBeNull();
    const denied = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readVisitBaseline(denied, 'a', 'b')).toBeNull();
    expect(() => saveVisitBaseline(denied, 'a', 'b', [stamp])).not.toThrow();
  });
});
