import { describe, it, expect } from 'vitest';
import { buildOfficeData, agentLook, agentState, roomState, SLOTS } from './office-data.js';
import type { ObservatoryRoom, ObservatoryAgent, ReleaseItem } from '../lib/api.js';

function room(key: string, name = key): ObservatoryRoom {
  return { key, name, platform: 'slack', memberAgentIds: [], lastActivityAt: null, permalink: null };
}
function agent(id: string, o: Partial<ObservatoryAgent> = {}): ObservatoryAgent {
  return {
    id, name: id, canonicalName: id, folder: id, provider: 'claude', awake: true,
    location: null, lastSeenAt: null, lastSessionId: null, holding: [], nextTask: null, avatarUrl: null, ...o,
  };
}

describe('buildOfficeData', () => {
  it('fills slots in the order rooms arrive, so a channel keeps its place', () => {
    const d = buildOfficeData([room('a'), room('b'), room('c')], []);
    expect(d.rooms.map((r) => r.slot)).toEqual([SLOTS[0], SLOTS[1], SLOTS[2]]);
    expect(d.rooms.map((r) => r.label)).toEqual(['#a', '#b', '#c']);
  });

  it('reports channels past the last slot as overflow rather than dropping them', () => {
    const many = Array.from({ length: SLOTS.length + 2 }, (_, i) => room(`r${i}`));
    const d = buildOfficeData(many, []);
    expect(d.rooms).toHaveLength(SLOTS.length);
    expect(d.overflow).toEqual([`r${SLOTS.length}`, `r${SLOTS.length + 1}`]);
  });

  it('does not prefix a channel name that already carries its #', () => {
    expect(buildOfficeData([room('k', '#already')], []).rooms[0]!.label).toBe('#already');
  });

  it('seats agents in the room they are located in, and nobody in rooms they are not', () => {
    const d = buildOfficeData(
      [room('r1'), room('r2')],
      [agent('ava', { location: 'r1' }), agent('kit', { location: 'r2' }), agent('zed', { location: null })],
    );
    expect(d.rooms[0]!.agents.map((a) => a.name)).toEqual(['ava']);
    expect(d.rooms[1]!.agents.map((a) => a.name)).toEqual(['kit']);
  });

  it('caps occupants at the seats the plan actually draws', () => {
    const crowd = ['a', 'b', 'c', 'd'].map((n) => agent(n, { location: 'r1' }));
    expect(buildOfficeData([room('r1')], crowd).rooms[0]!.agents).toHaveLength(2);
  });

  it('publishes no open count while items carry no channel — an invented number is worse than none', () => {
    const items: ReleaseItem[] = [{ id: 'X#1', kind: 'pr', title: 't', nextMover: 'nobody' }];
    expect(buildOfficeData([room('r1')], [], items).rooms[0]!.open).toBe(0);
  });
});

describe('agentState', () => {
  it('blocked outranks awake — an agent holding failed work is the thing being looked for', () => {
    expect(agentState(agent('ava', { awake: true }), new Set(['ava']))).toBe('blocked');
  });
  it('awake is working, asleep is idle', () => {
    expect(agentState(agent('ava', { awake: true }), new Set())).toBe('working');
    expect(agentState(agent('ava', { awake: false }), new Set())).toBe('idle');
  });
});

describe('roomState', () => {
  const a = (status: 'blocked' | 'working' | 'idle') => ({ name: 'x', status, shirt: '', shirtHi: '', hair: '' }) as never;
  it('takes the worst state present', () => {
    expect(roomState([a('working'), a('blocked')], 0)).toBe('blocked');
    expect(roomState([a('idle'), a('working')], 0)).toBe('working');
  });
  it('an empty room with open work is waiting, an empty room with none is idle', () => {
    expect(roomState([], 3)).toBe('waiting');
    expect(roomState([], 0)).toBe('idle');
  });
});

describe('agentLook', () => {
  it('is stable per id, so an agent always looks like itself', () => {
    expect(agentLook('ava')).toEqual(agentLook('ava'));
  });
  it('gives different agents different shirts more often than not', () => {
    const shirts = new Set(['ava', 'kit', 'zed', 'cy', 'bo'].map((i) => agentLook(i).shirt));
    expect(shirts.size).toBeGreaterThan(1);
  });
});
