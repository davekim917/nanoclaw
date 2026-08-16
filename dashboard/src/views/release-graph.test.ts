import { describe, it, expect } from 'vitest';
import { buildReleaseGraph, unblockRanking, depsDeclared } from './release-graph.js';
import type { ReleaseItem } from '../lib/api.js';

function item(id: string, overrides: Partial<ReleaseItem> = {}): ReleaseItem {
  return { id, kind: 'pr', title: id, nextMover: 'agent', ...overrides };
}

describe('buildReleaseGraph', () => {
  it('layers a chain by longest path, so a node sits behind its deepest blocker', () => {
    // c ← b ← a  plus  c ← a directly: c must land at layer 2, not 1.
    const g = buildReleaseGraph([
      item('a', { dependsOn: [] }),
      item('b', { dependsOn: ['a'] }),
      item('c', { dependsOn: ['a', 'b'] }),
    ]);
    expect(g.layers.map((l) => l.map((n) => n.item.id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('separates "declared none" from "never declared" — both would be layer 0', () => {
    const g = buildReleaseGraph([item('declared', { dependsOn: [] }), item('silent')]);
    expect(g.byId.get('declared')!.depsKnown).toBe(true);
    expect(g.byId.get('silent')!.depsKnown).toBe(false);
    // both are layer 0, which is exactly why depsKnown has to carry the difference
    expect(g.byId.get('declared')!.layer).toBe(0);
    expect(g.byId.get('silent')!.layer).toBe(0);
    expect(g.declaredPct).toBe(50);
    expect(g.undeclaredCount).toBe(1);
  });

  it('reports 100% declared coverage for an empty board rather than dividing by zero', () => {
    const g = buildReleaseGraph([]);
    expect(g.declaredPct).toBe(100);
    expect(g.layers).toEqual([[]]);
  });

  it('drops a dependency on something not on the board, and says so', () => {
    const g = buildReleaseGraph([item('a', { dependsOn: ['GONE#1'] })]);
    expect(g.byId.get('a')!.blockedBy).toEqual([]);
    expect(g.byId.get('a')!.layer).toBe(0);
    expect(g.danglingRefs).toEqual([{ from: 'a', to: 'GONE#1' }]);
  });

  it('survives a cycle, names every id on it, and still lays the board out', () => {
    const g = buildReleaseGraph([
      item('a', { dependsOn: ['b'] }),
      item('b', { dependsOn: ['a'] }),
      item('c', { dependsOn: [] }),
    ]);
    expect(g.cycles.sort()).toEqual(['a', 'b']);
    expect(g.byId.get('a')!.inCycle).toBe(true);
    expect(g.byId.get('c')!.inCycle).toBe(false);
    // layout still produced something finite for every node
    expect(g.layers.flat()).toHaveLength(3);
  });

  it('ignores a self-reference instead of calling it a one-node cycle', () => {
    const g = buildReleaseGraph([item('a', { dependsOn: ['a'] })]);
    expect(g.cycles).toEqual([]);
    expect(g.byId.get('a')!.blockedBy).toEqual([]);
  });

  it('de-duplicates a repeated dependency', () => {
    const g = buildReleaseGraph([item('a', { dependsOn: [] }), item('b', { dependsOn: ['a', 'a'] })]);
    expect(g.byId.get('b')!.blockedBy).toEqual(['a']);
  });

  it('counts transitive downstream items once, not once per path', () => {
    //      b ─┐
    // a ←─┤   ├─→ d      d depends on b and c; both depend on a.
    //      c ─┘          a unblocks b, c and d = 3, not 4.
    const g = buildReleaseGraph([
      item('a', { dependsOn: [] }),
      item('b', { dependsOn: ['a'] }),
      item('c', { dependsOn: ['a'] }),
      item('d', { dependsOn: ['b', 'c'] }),
    ]);
    expect(g.byId.get('a')!.unblocks).toBe(3);
    expect(g.byId.get('b')!.unblocks).toBe(1);
    expect(g.byId.get('d')!.unblocks).toBe(0);
  });
});

describe('unblockRanking', () => {
  it('ranks by downstream impact and drops the zeros', () => {
    const g = buildReleaseGraph([
      item('root', { dependsOn: [] }),
      item('mid', { dependsOn: ['root'] }),
      item('leaf', { dependsOn: ['mid'] }),
      item('lonely', { dependsOn: [] }),
    ]);
    expect(unblockRanking(g).map((n) => n.item.id)).toEqual(['root', 'mid']);
  });

  it('breaks an impact tie towards the item that blocks the release', () => {
    const g = buildReleaseGraph([
      item('plain', { dependsOn: [] }),
      item('blocker', { dependsOn: [], blocksRelease: true }),
      item('x', { dependsOn: ['plain'] }),
      item('y', { dependsOn: ['blocker'] }),
    ]);
    expect(unblockRanking(g).map((n) => n.item.id)).toEqual(['blocker', 'plain']);
  });
});

describe('depsDeclared', () => {
  it('treats an explicit empty array as declared and a missing field as not', () => {
    expect(depsDeclared(item('a', { dependsOn: [] }))).toBe(true);
    expect(depsDeclared(item('a'))).toBe(false);
  });
});
