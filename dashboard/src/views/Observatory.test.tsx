import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('swr', () => {
  const mutate = vi.fn();
  const useSWR = vi.fn(() => ({ data: undefined, error: undefined, mutate }));
  return { default: useSWR };
});

vi.mock('../lib/api.js', () => ({
  listWorkgroups: vi.fn(),
  getObservatory: vi.fn(),
}));

import { Observatory, sortRooms, roomActivityClass, sortClaims } from './Observatory.js';
import useSWR from 'swr';
import type { ObservatoryRoom, ObservatoryAgent, ObservatoryClaim, ObservatorySnapshot } from '../lib/api.js';

const mockAuthMe = {
  user_id: 'u1',
  scopes: { role: 'owner', allowed_group_ids: [], no_filter: true },
};
const noop = () => {};

function room(overrides: Partial<ObservatoryRoom> = {}): ObservatoryRoom {
  return {
    key: 'r1',
    name: 'general',
    platform: 'slack',
    memberAgentIds: [],
    lastActivityAt: new Date().toISOString(),
    permalink: null,
    ...overrides,
  };
}

function agent(overrides: Partial<ObservatoryAgent> = {}): ObservatoryAgent {
  return {
    id: 'ava',
    name: 'ava',
    canonicalName: 'ava-agent',
    folder: 'ava',
    provider: 'claude',
    awake: true,
    location: null,
    lastSeenAt: new Date().toISOString(),
    holding: [],
    nextTask: null,
    ...overrides,
  };
}

function claim(overrides: Partial<ObservatoryClaim> = {}): ObservatoryClaim {
  return {
    slug: 'c1',
    owner: 'ava',
    note: 'doing a thing',
    state: 'live',
    staleMs: 0,
    threadId: null,
    escalated: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ObservatorySnapshot> = {}): ObservatorySnapshot {
  return {
    workgroupId: 'wg-1',
    asOf: new Date().toISOString(),
    rooms: [],
    agents: [],
    claims: [],
    ...overrides,
  };
}

// The workgroups key is a bare string; the observatory key embeds the id.
function mockData(snap: ObservatorySnapshot | undefined, error: unknown = undefined) {
  vi.mocked(useSWR).mockImplementation((key: unknown) => {
    if (typeof key === 'string' && key.includes('/workgroups')) {
      return { data: { workgroups: [{ id: 'wg-1', name: 'Example Workgroup' }] }, mutate: vi.fn() } as unknown as ReturnType<
        typeof useSWR
      >;
    }
    return { data: snap, error, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>;
  });
}

describe('Observatory', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders rooms in stable platform/name order regardless of payload order', () => {
    mockData(
      snapshot({
        rooms: [
          room({ key: 'z', name: 'zeta', platform: 'discord', lastActivityAt: new Date().toISOString() }),
          room({ key: 'a', name: 'alpha', platform: 'discord', lastActivityAt: null }),
          room({ key: 'b', name: 'bravo', platform: 'slack', lastActivityAt: null }),
        ],
      }),
    );
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const keys = Array.from(container.querySelectorAll('.nc-obs-room')).map((el) => el.getAttribute('data-room-key'));
    // discord (alpha, zeta) before slack (bravo); within discord, alpha before zeta.
    expect(keys).toEqual(['a', 'z', 'b']);
  });

  it('roomActivityClass: dusty for >7d or null, lit for today', () => {
    const now = Date.parse('2026-08-14T12:00:00Z');
    expect(roomActivityClass(null, now)).toBe('dusty');
    expect(roomActivityClass('2026-08-01T00:00:00Z', now)).toBe('dusty');
    expect(roomActivityClass('2026-08-14T09:00:00Z', now)).toBe('lit');
  });

  it('applies the dusty class to a stale room and not to an active-today room', () => {
    mockData(
      snapshot({
        rooms: [
          room({ key: 'fresh', lastActivityAt: new Date().toISOString() }),
          room({ key: 'old', lastActivityAt: '2020-01-01T00:00:00Z' }),
        ],
      }),
    );
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    expect(container.querySelector('.nc-obs-room[data-room-key="fresh"]')!.className).not.toContain('dusty');
    expect(container.querySelector('.nc-obs-room[data-room-key="old"]')!.className).toContain('dusty');
  });

  it('renders an awake agent bright in its located room, and an asleep agent with 💤 in the desks strip', () => {
    mockData(
      snapshot({
        rooms: [room({ key: 'r1' })],
        agents: [
          agent({ id: 'bo', name: 'bo', location: 'r1', awake: true }),
          agent({ id: 'kit', name: 'kit', location: null, awake: false }),
        ],
      }),
    );
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const roomChip = container.querySelector('.nc-obs-room[data-room-key="r1"] .nc-obs-chip')!;
    expect(roomChip.className).toContain('awake');
    const deskChip = container.querySelector('.nc-obs-desks .nc-obs-chip')!;
    expect(deskChip.className).toContain('asleep');
    expect(deskChip.textContent).toContain('💤');
  });

  it('renders wired-but-absent members as faint initials', () => {
    mockData(
      snapshot({
        rooms: [room({ key: 'r1', memberAgentIds: ['ava', 'ghost'] })],
        agents: [agent({ id: 'ava', name: 'ava', location: 'r1' })],
      }),
    );
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    // ava is present as a body chip, not an absent initial.
    expect(container.querySelector('.nc-obs-room-bodies .nc-obs-chip')).toBeTruthy();
    const absent = container.querySelectorAll('.nc-obs-room-absent');
    expect(absent.length).toBe(1);
    expect(absent[0]!.textContent).toBe('G');
  });

  it('claims wall groups by state stale → parked → expiring → live, parked shows "needs an owner"', () => {
    mockData(
      snapshot({
        claims: [
          claim({ slug: 'live-1', state: 'live' }),
          claim({ slug: 'stale-1', state: 'stale' }),
          claim({ slug: 'parked-1', state: 'parked' }),
          claim({ slug: 'expiring-1', state: 'expiring' }),
        ],
      }),
    );
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const rows = Array.from(container.querySelectorAll('.nc-obs-claim-row'));
    expect(rows.map((r) => r.getAttribute('data-slug'))).toEqual(['stale-1', 'parked-1', 'expiring-1', 'live-1']);
    const parkedRow = container.querySelector('.nc-obs-claim-row[data-slug="parked-1"]')!;
    expect(parkedRow.textContent).toContain('needs an owner');
  });

  it('sortClaims: pure ordering helper matches the group order', () => {
    const out = sortClaims([claim({ slug: 'a', state: 'live' }), claim({ slug: 'b', state: 'stale' })]);
    expect(out.map((c) => c.slug)).toEqual(['b', 'a']);
  });

  it('sortRooms: pure ordering helper sorts by platform then name', () => {
    const out = sortRooms([
      room({ key: 'z', platform: 'discord', name: 'zeta' }),
      room({ key: 'a', platform: 'discord', name: 'alpha' }),
    ]);
    expect(out.map((r) => r.key)).toEqual(['a', 'z']);
  });

  it('flips the footer to the stale warning when a poll fails but stale data remains', () => {
    const snap = snapshot({ asOf: '2026-08-14T00:00:00Z' });
    mockData(snap, new Error('network error'));
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    expect(container.querySelector('.nc-obs-stale')).toBeTruthy();
    expect(container.querySelector('.nc-obs-footer')!.textContent).toContain('stale since');
  });

  it('shows the calm "observatory offline" placeholder when there is no data and the poll fails', () => {
    mockData(undefined, new Error('404'));
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    expect(container.querySelector('.nc-obs-offline')!.textContent).toContain('observatory offline');
  });

  it('hover card on an agent chip shows holding and nextTask', async () => {
    mockData(
      snapshot({
        agents: [
          agent({
            id: 'ava',
            name: 'ava',
            canonicalName: 'ava-agent',
            location: null,
            holding: ['claim-slug-1'],
            nextTask: { title: 'send digest', at: new Date(Date.now() + 3600_000).toISOString() },
          }),
        ],
      }),
    );
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const chip = container.querySelector('.nc-obs-chip')! as HTMLElement;
    await userEvent.hover(chip);
    const hoverCard = container.querySelector('.nc-obs-hover')!;
    expect(hoverCard.textContent).toContain('claim-slug-1');
    expect(hoverCard.textContent).toContain('send digest');
    expect(hoverCard.textContent).toContain('ava-agent');
  });
});
