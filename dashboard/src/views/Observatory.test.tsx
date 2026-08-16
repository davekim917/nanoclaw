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

import {
  Observatory,
  sortRooms,
  roomActivityClass,
  sortClaims,
  claimAgeLabel,
  groupReleaseItems,
  releaseCounts,
} from './Observatory.js';
import useSWR from 'swr';
import type {
  ObservatoryRoom,
  ObservatoryAgent,
  ObservatoryClaim,
  ObservatorySnapshot,
  ReleaseItem,
  ReleaseState,
} from '../lib/api.js';

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
    releaseState: null,
    ...overrides,
  };
}

function releaseItem(overrides: Partial<ReleaseItem> = {}): ReleaseItem {
  return {
    id: 'XZO#1',
    kind: 'pr',
    title: 'some pr',
    nextMover: 'human',
    ...overrides,
  };
}

function releaseState(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    asOf: new Date().toISOString(),
    items: [],
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
          agent({ id: 'ava', name: 'ava', location: 'r1', awake: true }),
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

  it('opens a popover on click and closes it on outside click', async () => {
    mockData(snapshot({ agents: [agent({ id: 'ava', name: 'ava', location: null })] }));
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const chip = container.querySelector('.nc-obs-chip[data-agent-id="ava"]')! as HTMLElement;
    expect(container.querySelector('.nc-obs-hover')).toBeFalsy();

    await userEvent.click(chip);
    expect(container.querySelector('.nc-obs-hover')).toBeTruthy();

    // Outside click (the frame itself, not any chip) closes it.
    await userEvent.click(container.querySelector('.nc-frame')!);
    expect(container.querySelector('.nc-obs-hover')).toBeFalsy();
  });

  it('only one popover is open at a time — clicking a second chip closes the first', async () => {
    mockData(
      snapshot({
        agents: [agent({ id: 'ava', name: 'ava', location: null }), agent({ id: 'kit', name: 'kit', location: null })],
      }),
    );
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const avaChip = container.querySelector('.nc-obs-chip[data-agent-id="ava"]')! as HTMLElement;
    const kitChip = container.querySelector('.nc-obs-chip[data-agent-id="kit"]')! as HTMLElement;

    await userEvent.click(avaChip);
    expect(avaChip.querySelector('.nc-obs-hover')).toBeTruthy();

    await userEvent.click(kitChip);
    expect(avaChip.querySelector('.nc-obs-hover')).toBeFalsy();
    expect(kitChip.querySelector('.nc-obs-hover')).toBeTruthy();
    expect(container.querySelectorAll('.nc-obs-hover').length).toBe(1);
  });

  it('claim group subtitles render the exact operator-facing language for every state', () => {
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
    const subs = Array.from(container.querySelectorAll('.nc-obs-claim-group-sub')).map((el) => el.textContent);
    expect(subs).toContain('abandoned — past its deadline, nobody is coming back');
    expect(subs).toContain('deliberately handed off — free for anyone to take');
    expect(subs).toContain('past its deadline but inside the grace window');
    expect(subs).toContain('actively held — leave it alone');
  });

  it('renders an age line for each claim state', () => {
    mockData(
      snapshot({
        claims: [
          claim({ slug: 'live-1', state: 'live', staleMs: -3_600_000 }),
          claim({ slug: 'stale-1', state: 'stale', staleMs: 7_200_000 }),
          claim({ slug: 'expiring-1', state: 'expiring', staleMs: 1_800_000 }),
          claim({ slug: 'parked-1', state: 'parked', staleMs: 5_400_000 }),
        ],
      }),
    );
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const ageFor = (slug: string) => container.querySelector(`.nc-obs-claim-row[data-slug="${slug}"] .nc-obs-claim-age`)!.textContent;
    expect(ageFor('live-1')).toContain('left');
    expect(ageFor('stale-1')).toContain('past deadline');
    expect(ageFor('expiring-1')).toContain('past deadline');
    expect(ageFor('parked-1')).toBe('parked 1h ago');
  });

  it('claimAgeLabel: pure helper matches the per-state phrasing', () => {
    const now = Date.parse('2026-08-14T12:00:00Z');
    expect(claimAgeLabel(claim({ state: 'live', staleMs: -3_600_000 }), now)).toBe('1h left');
    expect(claimAgeLabel(claim({ state: 'stale', staleMs: 7_200_000 }), now)).toBe('2h past deadline');
    expect(claimAgeLabel(claim({ state: 'parked', staleMs: 1_800_000 }), now)).toBe('parked 30m ago');
  });

  it('renders "owner unknown" in italics when the owner is unresolved, not a literal name', () => {
    mockData(snapshot({ claims: [claim({ slug: 'c1', state: 'live', owner: 'unknown' })] }));
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const ownerEl = container.querySelector('.nc-obs-claim-owner')!;
    expect(ownerEl.querySelector('em')!.textContent).toBe('owner unknown');
    expect(ownerEl.textContent).not.toBe('unknown');
  });

  it('the claims wall carries no fixed/sticky positioning class and lives inside the main grid', () => {
    mockData(snapshot({ claims: [claim({ slug: 'c1' })] }));
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const wall = container.querySelector('.nc-obs-claims')!;
    expect(wall.className).not.toMatch(/fixed|sticky/);
    expect(container.querySelector('.nc-obs-main > .nc-obs-claims')).toBeTruthy();
  });

  describe('Release Desk', () => {
    it('groupReleaseItems: dedupes a blocksRelease item out of its mover group', () => {
      const g = groupReleaseItems([
        releaseItem({ id: 'B1', nextMover: 'human', blocksRelease: true }),
        releaseItem({ id: 'H1', nextMover: 'human' }),
      ]);
      expect(g.blockers.map((i) => i.id)).toEqual(['B1']);
      expect(g.human.map((i) => i.id)).toEqual(['H1']);
    });

    it('releaseCounts: omits zero terms', () => {
      expect(
        releaseCounts([
          releaseItem({ id: 'B1', nextMover: 'agent', blocksRelease: true }),
          releaseItem({ id: 'A1', nextMover: 'agent' }),
          releaseItem({ id: 'A2', nextMover: 'agent' }),
        ]),
      ).toBe('1 holding release · 2 in flight');
    });

    it('blockers group renders first and dedupes a blocksRelease item out of its mover group', () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'B1', nextMover: 'human', blocksRelease: true, title: 'blocked pr' }),
              releaseItem({ id: 'H1', nextMover: 'human', title: 'human item' }),
            ],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const groups = Array.from(container.querySelectorAll('.nc-obs-release-group'));
      expect(groups[0]!.className).toContain('blockers');
      const b1Rows = container.querySelectorAll('[data-item-id="B1"]');
      expect(b1Rows.length).toBe(1);
      expect(groups[0]!.contains(b1Rows[0]!)).toBe(true);
    });

    it('renders the three mover groups in order with the exact subtitles', () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'N1', nextMover: 'nobody' }),
              releaseItem({ id: 'A1', nextMover: 'agent' }),
              releaseItem({ id: 'H1', nextMover: 'human' }),
            ],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const labels = Array.from(
        container.querySelectorAll('.nc-obs-release-group:not(.blockers) .nc-obs-release-group-label'),
      ).map((el) => el.textContent);
      expect(labels).toEqual(['Your move', "In agents' hands", "Nobody's — at risk"]);
      const subs = Array.from(
        container.querySelectorAll('.nc-obs-release-group:not(.blockers) .nc-obs-release-group-sub'),
      ).map((el) => el.textContent);
      expect(subs).toEqual([
        'waiting on a person; nothing proceeds until they act',
        "autonomously handled; watch, don't touch",
        'no owner and no motion; these rot unless someone takes them',
      ]);
    });

    it('bolds the owner in the "Your move" group', () => {
      mockData(
        snapshot({
          releaseState: releaseState({ items: [releaseItem({ id: 'H1', nextMover: 'human', owner: 'kit' })] }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const row = container.querySelector('[data-item-id="H1"]')!;
      expect(row.querySelector('strong')!.textContent).toBe('kit');
    });

    it('renders the moratorium banner and hold chips', () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            release: { moratorium: true, holds: [{ kind: 'freeze', reason: 'release day' }] },
            items: [],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelector('.nc-obs-release-moratorium')!.textContent).toContain(
        'release-day moratorium active',
      );
      const hold = container.querySelector('.nc-obs-release-hold')!;
      expect(hold.textContent).toContain('freeze');
      expect(hold.textContent).toContain('release day');
    });

    it('shows the no-desk line when releaseState is null', () => {
      mockData(snapshot({ releaseState: null }));
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelector('.nc-obs-release-empty')!.textContent).toBe(
        'no release desk — the release watcher has not published release-state.json yet',
      );
    });

    it('shows the clear-to-ship line when items is empty', () => {
      mockData(snapshot({ releaseState: releaseState({ items: [] }) }));
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelector('.nc-obs-release-empty')!.textContent).toBe(
        'nothing open — clear to ship pending the usual gates',
      );
    });

    it('counts line is correct and omits zero terms', () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'B1', nextMover: 'agent', blocksRelease: true }),
              releaseItem({ id: 'A1', nextMover: 'agent' }),
              releaseItem({ id: 'A2', nextMover: 'agent' }),
            ],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelector('.nc-obs-release-counts')!.textContent).toBe('1 holding release · 2 in flight');
    });

    it('renders a link for items with a url, plain text for items without', () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'H1', nextMover: 'human', url: 'https://example.com/pr/1' }),
              releaseItem({ id: 'H2', nextMover: 'human' }),
            ],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const linked = container.querySelector('[data-item-id="H1"] .nc-obs-release-row-id')!;
      expect(linked.tagName).toBe('A');
      expect(linked.getAttribute('href')).toBe('https://example.com/pr/1');
      const unlinked = container.querySelector('[data-item-id="H2"] .nc-obs-release-row-id')!;
      expect(unlinked.tagName).toBe('SPAN');
    });
  });
});
