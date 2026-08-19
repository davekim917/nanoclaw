import { describe, it, expect } from 'vitest';
import { deriveExceptions, normalizeRoomName, SEVERITY_LABEL } from './exceptions.js';
import type { ObservatorySnapshot, ObservatoryAgent, ObservatoryClaim, ReleaseItem } from '../lib/api.js';

// Fixed clock. Every timestamp below is written relative to it by hand, so a
// slow machine can never change what this suite asserts.
const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function agent(over: Partial<ObservatoryAgent> = {}): ObservatoryAgent {
  return {
    id: 'ag-1',
    name: 'Nova',
    canonicalName: 'group-one',
    folder: 'group-one',
    provider: 'claude',
    awake: true,
    active: true,
    location: 'slack:C1',
    lastSeenAt: hoursAgo(2),
    lastSessionId: 's-1',
    holding: [],
    nextTask: null,
    avatarUrl: null,
    liveSession: null,
    ...over,
  };
}

function claim(over: Partial<ObservatoryClaim> = {}): ObservatoryClaim {
  return {
    slug: 'work-1',
    owner: 'Nova',
    note: null,
    state: 'stale',
    staleMs: 9 * 3_600_000,
    threadId: 'slack:C1:1700',
    threadUrl: 'https://example.invalid/t/1700',
    sessionId: null,
    escalated: false,
    ...over,
  };
}

function item(over: Partial<ReleaseItem> = {}): ReleaseItem {
  return { id: 'B#1', kind: 'finding', title: 'a finding', nextMover: 'agent', ...over };
}

function scene(over: Partial<ObservatorySnapshot> = {}): ObservatorySnapshot {
  return {
    workgroupId: 'wg-1',
    asOf: new Date(NOW).toISOString(),
    rooms: [
      { key: 'slack:C1', name: '#one', platform: 'slack', memberAgentIds: ['ag-1'], lastActivityAt: null, permalink: null },
      { key: 'slack:C2', name: '#two', platform: 'slack', memberAgentIds: [], lastActivityAt: null, permalink: null },
    ],
    agents: [],
    claims: [],
    releaseState: null,
    ...over,
  };
}

function release(items: ReleaseItem[]) {
  return { asOf: new Date(NOW).toISOString(), items };
}

describe('deriveExceptions', () => {
  it('classes a blocked agent, a decision item, an escalated item and a stale claim, worst first', () => {
    const blocking = item({
      id: 'B#9',
      title: 'owned and overdue',
      nextMover: 'agent',
      owner: 'Nova',
      since: hoursAgo(30),
      dueAt: hoursAgo(20),
      channel: '#one',
    });
    const decision = item({
      id: 'B#2',
      title: 'needs a product call',
      nextMover: 'agent',
      meta: { bucket: 'decision' },
      since: hoursAgo(6),
      channel: '#two',
    });
    const escalated = item({
      id: 'B#3',
      title: 'escalated twice',
      nextMover: 'agent',
      meta: { bucket: 'escalated' },
      since: hoursAgo(4),
    });
    const out = deriveExceptions(
      scene({
        agents: [agent()],
        claims: [claim()],
        releaseState: release([blocking, decision, escalated]),
      }),
      NOW,
    );

    // `blocking` is agent-owned and past its due date, so the ledger reads Nova
    // as blocked — that is the hands-needed card, and the item itself is not
    // one (its next mover is an agent and it carries no exception bucket).
    expect(out.map((e) => [e.severity, e.key])).toEqual([
      ['hands', 'ag-1'],
      ['decision', 'B#2'],
      ['parked', 'work-1'],
      ['parked', 'B#3'],
    ]);
    expect(out[0]!.source).toBe('agent');
    expect(out[0]!.title).toBe('Nova is blocked');
    expect(SEVERITY_LABEL[out[0]!.severity]).toBe('Hands needed');
    // Within `parked`, the older one leads: the claim is 9h stale, the item 4h.
    expect(out[2]!.ageMs).toBe(9 * 3_600_000);
    expect(out[3]!.ageMs).toBe(4 * 3_600_000);
  });

  it('puts an item whose next mover is a person in hands, above a decision', () => {
    const out = deriveExceptions(
      scene({
        releaseState: release([
          item({ id: 'B#2', nextMover: 'agent', meta: { bucket: 'decision' }, since: hoursAgo(9) }),
          item({ id: 'B#1', nextMover: 'human', since: hoursAgo(1) }),
        ]),
      }),
      NOW,
    );
    expect(out.map((e) => e.severity)).toEqual(['hands', 'decision']);
  });

  it('gives an item that matches two classes the higher severity, once', () => {
    const out = deriveExceptions(
      scene({ releaseState: release([item({ id: 'B#1', nextMover: 'human', meta: { bucket: 'escalated' } })]) }),
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('hands');
  });

  it('sorts an unknown age last within its class, never as zero', () => {
    const out = deriveExceptions(
      scene({
        releaseState: release([
          item({ id: 'B#1', nextMover: 'human' }), // no `since` at all
          item({ id: 'B#2', nextMover: 'human', since: 'not a date' }),
          item({ id: 'B#3', nextMover: 'human', since: hoursAgo(1) }),
          // Stamped in the FUTURE, so its age is negative. An unknown age must
          // still sort below it — treating null as zero would float it above.
          item({ id: 'B#4', nextMover: 'human', since: hoursAgo(-1) }),
        ]),
      }),
      NOW,
    );
    expect(out.map((e) => e.key)).toEqual(['B#3', 'B#4', 'B#1', 'B#2']);
    expect(out[2]!.ageMs).toBeNull();
    expect(out[3]!.ageMs).toBeNull();
  });

  it('is stable: reordering the input does not reorder the feed', () => {
    const a = item({ id: 'B#1', nextMover: 'human', since: hoursAgo(3) });
    const b = item({ id: 'B#2', nextMover: 'human', since: hoursAgo(3) });
    const forward = deriveExceptions(scene({ releaseState: release([a, b]) }), NOW).map((e) => e.key);
    const backward = deriveExceptions(scene({ releaseState: release([b, a]) }), NOW).map((e) => e.key);
    expect(forward).toEqual(['B#1', 'B#2']);
    expect(backward).toEqual(forward);
  });

  it('resolves a room from the item channel, the claim thread, and the agent seat', () => {
    const out = deriveExceptions(
      scene({
        agents: [agent({ id: 'ag-2', name: 'Vega', location: 'slack:C2' })],
        claims: [claim({ threadId: 'slack:C1:1700' })],
        releaseState: release([
          item({ id: 'B#1', nextMover: 'human', channel: 'One' }), // hash-less, mixed case
          item({ id: 'B#4', nextMover: 'human', channel: '#nowhere' }),
          // Makes Vega blocked, so the agent card exists.
          item({ id: 'B#5', nextMover: 'agent', owner: 'Vega', dueAt: hoursAgo(9) }),
        ]),
      }),
      NOW,
    );
    const byKey = new Map(out.map((e) => [e.key, e.roomKey]));
    expect(byKey.get('B#1')).toBe('slack:C1');
    expect(byKey.get('B#4')).toBeNull();
    expect(byKey.get('work-1')).toBe('slack:C1');
    expect(byKey.get('ag-2')).toBe('slack:C2');
  });

  it('offers only the actions whose ids are actually present', () => {
    const out = deriveExceptions(
      scene({
        agents: [
          agent({ id: 'ag-1', name: 'Nova' }),
          agent({
            id: 'ag-2',
            name: 'Vega',
            liveSession: { channelKey: 'slack:C1', sessionId: 's-9', threadUrl: null, lastOutboundAt: null },
          }),
        ],
        claims: [claim({ slug: 'no-thread', threadId: null }), claim({ slug: 'has-thread' })],
        releaseState: release([
          item({ id: 'B#2', nextMover: 'agent', meta: { bucket: 'decision' }, channel: '#one' }),
          item({ id: 'B#7', nextMover: 'human', url: 'https://example.invalid/i/7' }),
          item({ id: 'B#8', nextMover: 'human' }), // no url — nothing to offer
          item({ id: 'B#5', nextMover: 'agent', owner: 'Nova', dueAt: hoursAgo(9) }),
          item({ id: 'B#6', nextMover: 'agent', owner: 'Vega', dueAt: hoursAgo(9) }),
        ]),
      }),
      NOW,
    );
    const byKey = new Map(out.map((e) => [e.key, e.actions]));
    expect(byKey.get('B#2')).toEqual([{ kind: 'assign', itemId: 'B#2', channel: '#one' }]);
    expect(byKey.get('B#7')).toEqual([{ kind: 'open', url: 'https://example.invalid/i/7' }]);
    expect(byKey.get('B#8')).toEqual([]);
    expect(byKey.get('no-thread')).toEqual([{ kind: 'nudge', slug: 'no-thread', threadId: null }]);
    expect(byKey.get('has-thread')).toEqual([{ kind: 'nudge', slug: 'has-thread', threadId: 'slack:C1:1700' }]);
    // A blocked agent with no live session still gets the card; the button is
    // what the renderer disables, not the derivation.
    expect(byKey.get('ag-1')).toEqual([{ kind: 'steer', agentId: 'ag-1', sessionId: null }]);
    expect(byKey.get('ag-2')).toEqual([{ kind: 'steer', agentId: 'ag-2', sessionId: 's-9' }]);
  });

  it('returns nothing for a calm floor, and never throws on an absent release desk', () => {
    expect(deriveExceptions(scene(), NOW)).toEqual([]);
    expect(deriveExceptions(scene({ agents: [agent()], claims: [claim({ state: 'live' })] }), NOW)).toEqual([]);
  });

  it('normalizes a room name the way the themed floor does', () => {
    expect(normalizeRoomName('  #Dispatch ')).toBe('dispatch');
    expect(normalizeRoomName('dispatch')).toBe('dispatch');
  });
});
