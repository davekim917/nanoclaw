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

  it('seats a room its wired members, not agents merely located there', () => {
    const r1 = { ...room('r1'), memberAgentIds: ['ava'] };
    const r2 = { ...room('r2'), memberAgentIds: ['kit'] };
    const d = buildOfficeData(
      [r1, r2],
      [agent('ava', { location: 'r1' }), agent('kit', { location: 'r2' }), agent('zed', { location: null })],
    );
    expect(d.rooms[0]!.agents.map((a) => a.name)).toEqual(['ava']);
    expect(d.rooms[1]!.agents.map((a) => a.name)).toEqual(['kit']);
  });

  it('a wired member who is not doing anything still sits in the room, asleep', () => {
    const r1 = { ...room('r1'), memberAgentIds: ['ava'] };
    const d = buildOfficeData([r1], [agent('ava', { awake: false, location: null })]);
    expect(d.rooms[0]!.agents.map((a) => a.name)).toEqual(['ava']);
    expect(d.rooms[0]!.agents[0]!.status).toBe('idle');
  });

  it('a working member sorts before an idle member when the seat cap bites', () => {
    const r1 = { ...room('r1'), memberAgentIds: ['ava', 'kit', 'zed'] };
    const d = buildOfficeData(
      [r1],
      [
        agent('ava', { awake: false, location: null }),
        agent('kit', { awake: true, location: 'r1' }),
        agent('zed', { awake: false, location: null }),
      ],
    );
    expect(d.rooms[0]!.agents.map((a) => a.name)).toEqual(['kit', 'ava']);
  });

  it('an agent wired to two rooms appears in both', () => {
    const r1 = { ...room('r1'), memberAgentIds: ['ava'] };
    const r2 = { ...room('r2'), memberAgentIds: ['ava'] };
    const d = buildOfficeData([r1, r2], [agent('ava', { location: 'r1' })]);
    expect(d.rooms[0]!.agents.map((a) => a.name)).toEqual(['ava']);
    expect(d.rooms[1]!.agents.map((a) => a.name)).toEqual(['ava']);
  });

  it('carries each seated agent its real avatar, and null when it has none', () => {
    const r1 = { ...room('r1'), memberAgentIds: ['ava', 'kit'] };
    const d = buildOfficeData(
      [r1],
      [agent('ava', { location: 'r1', avatarUrl: 'https://cdn.example/ava_192.png' }), agent('kit', { location: 'r1' })],
    );
    expect(d.rooms[0]!.agents.map((a) => a.avatarUrl)).toEqual(['https://cdn.example/ava_192.png', null]);
  });

  it('caps occupants at the seats the plan actually draws', () => {
    const r1 = { ...room('r1'), memberAgentIds: ['a', 'b', 'c', 'd'] };
    const crowd = ['a', 'b', 'c', 'd'].map((n) => agent(n, { location: 'r1' }));
    expect(buildOfficeData([r1], crowd).rooms[0]!.agents).toHaveLength(2);
  });

  it('publishes no open count while items carry no channel — an invented number is worse than none', () => {
    const items: ReleaseItem[] = [{ id: 'X#1', kind: 'pr', title: 't', nextMover: 'nobody' }];
    expect(buildOfficeData([room('r1')], [], items).rooms[0]!.open).toBe(0);
  });

  // `themed` is install config (see office-data.ts) — these fixtures use
  // anonymous, made-up channel names, never real ones, same reason the comp
  // harness keeps its demo names anonymous.
  it('a themed channel lands on its slot regardless of where it arrives', () => {
    const themed = { grill: 'kitchen' };
    const d = buildOfficeData([room('a'), room('b'), room('grill')], [], [], themed);
    expect(d.rooms.find((r) => r.label === '#grill')!.slot).toBe('kitchen');
  });

  it('normalizes both a leading # and a bare (no #) form to bind', () => {
    const themed = { grill: 'kitchen', studio: 'southWest' };
    const d = buildOfficeData([room('gr', '#Grill'), room('st', 'studio')], [], [], themed);
    expect(d.rooms.find((r) => r.label === '#Grill')!.slot).toBe('kitchen');
    expect(d.rooms.find((r) => r.label === '#studio')!.slot).toBe('southWest');
  });

  it('unthemed channels skip claimed slots but keep filling in order', () => {
    const themed = { grill: 'kitchen' };
    const d = buildOfficeData([room('grill'), room('a'), room('b')], [], [], themed);
    expect(d.rooms.find((r) => r.label === '#grill')!.slot).toBe('kitchen');
    const rest = SLOTS.filter((s) => s !== 'kitchen');
    expect(d.rooms.find((r) => r.label === '#a')!.slot).toBe(rest[0]);
    expect(d.rooms.find((r) => r.label === '#b')!.slot).toBe(rest[1]);
  });

  it('a duplicate themed name falls through to generic fill, not dropped', () => {
    const themed = { lobby: 'westFront' };
    const d = buildOfficeData([room('s1', 'lobby'), room('s2', 'lobby')], [], [], themed);
    expect(d.rooms).toHaveLength(2);
    expect(d.rooms.find((r) => r.label === '#lobby' && r.slot === 'westFront')).toBeTruthy();
    const other = d.rooms.find((r) => r.slot !== 'westFront');
    expect(other!.slot).not.toBe('westFront');
  });

  it('ignores a themed entry naming something that is not a real slot', () => {
    const themed = { grill: 'not-a-real-slot' };
    const d = buildOfficeData([room('grill')], [], [], themed);
    expect(d.rooms[0]!.slot).toBe(SLOTS[0]);
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
