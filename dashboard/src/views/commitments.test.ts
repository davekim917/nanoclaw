import { describe, it, expect } from 'vitest';
import { buildLedger, classify, dueLabel, DUE_SOON_MS } from './commitments.js';
import type { ReleaseItem } from '../lib/api.js';

const NOW = Date.parse('2026-08-16T12:00:00Z');
const HOUR = 3_600_000;

function item(id: string, o: Partial<ReleaseItem> = {}): ReleaseItem {
  return { id, kind: 'pr', title: id, nextMover: 'agent', ...o };
}
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('classify', () => {
  it('an item nobody owns is breached at birth, not a tidy backlog entry', () => {
    const c = classify(item('a', { nextMover: 'nobody', since: at(-29 * 24 * HOUR) }), NOW);
    expect(c.state).toBe('unowned');
    expect(c.msToDue).toBeNull();
    expect(dueLabel(c)).toBe('nobody owns this');
  });

  it('an owner with no deadline is undated — a promise with no clock', () => {
    expect(classify(item('a', { nextMover: 'human' }), NOW).state).toBe('undated');
    expect(dueLabel(classify(item('a', { nextMover: 'human' }), NOW))).toBe('no deadline');
  });

  it('separates breached, due-soon and on-track by the deadline', () => {
    expect(classify(item('a', { dueAt: at(-3 * HOUR) }), NOW).state).toBe('breached');
    expect(classify(item('a', { dueAt: at(DUE_SOON_MS - 1) }), NOW).state).toBe('due-soon');
    expect(classify(item('a', { dueAt: at(DUE_SOON_MS + HOUR) }), NOW).state).toBe('on-track');
  });

  it('an unparseable deadline is undated, never silently on-track', () => {
    expect(classify(item('a', { dueAt: 'whenever' }), NOW).state).toBe('undated');
  });

  it('labels overdue and upcoming spans in the largest useful unit', () => {
    expect(dueLabel(classify(item('a', { dueAt: at(-3 * HOUR) }), NOW))).toBe('3h overdue');
    expect(dueLabel(classify(item('a', { dueAt: at(-50 * HOUR) }), NOW))).toBe('2d overdue');
    expect(dueLabel(classify(item('a', { dueAt: at(40 * 60_000) }), NOW))).toBe('in 40m');
  });
});

describe('buildLedger', () => {
  it('puts breaches first, oldest first — the longest-standing lie leads', () => {
    const l = buildLedger(
      [
        item('fresh-breach', { dueAt: at(-1 * HOUR), since: at(-2 * HOUR) }),
        item('ontrack', { dueAt: at(3 * 24 * HOUR) }),
        item('old-orphan', { nextMover: 'nobody', since: at(-29 * 24 * HOUR) }),
        item('old-breach', { dueAt: at(-2 * HOUR), since: at(-10 * 24 * HOUR) }),
      ],
      NOW,
    );
    expect(l.rows.slice(0, 3).map((r) => r.item.id)).toEqual(['old-orphan', 'old-breach', 'fresh-breach']);
    expect(l.rows[3]!.item.id).toBe('ontrack');
  });

  it("a person's queue outranks everything except a breach", () => {
    const l = buildLedger(
      [
        item('agent-soon', { nextMover: 'agent', dueAt: at(1 * HOUR) }),
        item('person-later', { nextMover: 'human', dueAt: at(5 * 24 * HOUR) }),
        item('breach', { nextMover: 'agent', dueAt: at(-1 * HOUR) }),
      ],
      NOW,
    );
    expect(l.rows.map((r) => r.item.id)).toEqual(['breach', 'person-later', 'agent-soon']);
  });

  it('counts breached / needs a person / on track, with unowned inside breached', () => {
    const l = buildLedger(
      [
        item('u', { nextMover: 'nobody' }),
        item('b', { dueAt: at(-1 * HOUR) }),
        item('p', { nextMover: 'human', dueAt: at(2 * 24 * HOUR) }),
        item('o', { nextMover: 'agent', dueAt: at(2 * 24 * HOUR) }),
      ],
      NOW,
    );
    expect(l.counts).toEqual({ breached: 2, person: 1, onTrack: 1 });
  });

  it('reports deadline coverage over OWNED items only — an orphan has nothing to date', () => {
    const l = buildLedger(
      [
        item('dated', { nextMover: 'agent', dueAt: at(HOUR) }),
        item('undated', { nextMover: 'human' }),
        item('orphan', { nextMover: 'nobody' }),
      ],
      NOW,
    );
    // 2 owned, 1 of them dated → 50%. The orphan is not counted as an undated
    // promise, because it is not a promise at all.
    expect(l.datedPct).toBe(50);
    expect(l.undatedCount).toBe(1);
  });

  it('a release blocker leads the board, above an older ordinary breach', () => {
    const l = buildLedger(
      [
        item('ancient-breach', { dueAt: at(-5 * HOUR), since: at(-29 * 24 * HOUR) }),
        item('sec', { kind: 'finding', blocksRelease: true, dueAt: at(-1 * HOUR), since: at(-1 * HOUR) }),
      ],
      NOW,
    );
    expect(l.rows.map((r) => r.item.id)).toEqual(['sec', 'ancient-breach']);
  });

  it('counts p1 findings nobody has classified as release-blocking either way', () => {
    // exactOptionalPropertyTypes: the key is omitted rather than set to
    // undefined, which is also the shape the watcher actually publishes.
    const p1 = (id: string, blocks?: boolean) =>
      ({
        ...item(id, blocks === undefined ? { kind: 'finding' } : { kind: 'finding', blocksRelease: blocks }),
        meta: { severity: 'p1' },
      }) as ReleaseItem;
    const l = buildLedger([p1('a'), p1('b'), p1('c', true), item('not-a-finding')], NOW);
    // c is classified, so it is not part of the gap; the plain item is not a
    // finding and cannot be.
    expect(l.unclassifiedP1).toBe(2);
  });

  it('reports full coverage for an empty board rather than dividing by zero', () => {
    const l = buildLedger([], NOW);
    expect(l.datedPct).toBe(100);
    expect(l.counts).toEqual({ breached: 0, person: 0, onTrack: 0 });
  });

  it('sorts the non-breach tier by soonest to breach', () => {
    const l = buildLedger(
      [
        item('later', { dueAt: at(48 * HOUR) }),
        item('sooner', { dueAt: at(6 * HOUR) }),
        item('soonest', { dueAt: at(5 * HOUR) }),
      ],
      NOW,
    );
    expect(l.rows.map((r) => r.item.id)).toEqual(['soonest', 'sooner', 'later']);
  });
});
