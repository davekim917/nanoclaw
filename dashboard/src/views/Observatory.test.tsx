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
  listScheduled: vi.fn(),
  assignItem: vi.fn(),
}));

// The drawer is exercised by its own suite; here we only care that the floor
// opens it with the right row key.
vi.mock('./ScheduledDrawer.js', () => ({
  ScheduledDrawer: ({ rowKey }: { rowKey: string }) => <div data-testid="sched-drawer">drawer:{rowKey}</div>,
}));

import {
  Observatory,
  sortRooms,
  sortClaims,
  claimAgeLabel,
  groupReleaseItems,
  groupReleaseItemsByOwner,
  UNOWNED_LANE,
  releaseCounts,
  upcomingScheduled,
} from './Observatory.js';
import { RouteNav } from './BoardShell.js';
import useSWR from 'swr';
import { assignItem } from '../lib/api.js';
import type {
  ObservatoryRoom,
  ObservatoryAgent,
  ObservatoryClaim,
  ObservatorySnapshot,
  ReleaseItem,
  ReleaseState,
  ScheduledRow,
  ScheduledSnapshot,
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
    lastSessionId: null,
    holding: [],
    nextTask: null,
    avatarUrl: null,
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
    threadUrl: null,
    escalated: false,
    ...overrides,
  };
}

function schedRow(overrides: Partial<ScheduledRow> = {}): ScheduledRow {
  return {
    key: 'k1',
    series_id: 's1',
    agent_group_id: 'ava',
    agent_group_name: 'ava',
    provider: 'claude',
    channel_name: 'general',
    channel_type: 'slack',
    thread_id: null,
    kind: 'recurring',
    cron: '0 9 * * *',
    next_fire_utc: new Date(Date.now() + 3600_000).toISOString(),
    next_fire_local: null,
    health: 'healthy',
    module_owner: null,
    quiet_status: false,
    flag_intent: null,
    script_host: false,
    last_fires: [],
    available_verbs: [],
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

// The workgroups key is a bare string; the observatory key embeds the id, and
// the scheduled section polls its own key off the same 15s cycle.
function mockData(
  snap: ObservatorySnapshot | undefined,
  error: unknown = undefined,
  sched: { data?: ScheduledSnapshot; error?: unknown } = { data: { rows: [], degraded: false, counts: {}, assembled_at: '' } },
) {
  vi.mocked(useSWR).mockImplementation((key: unknown) => {
    if (typeof key === 'string' && key.includes('/workgroups')) {
      return { data: { workgroups: [{ id: 'wg-1', name: 'Example Workgroup' }] }, mutate: vi.fn() } as unknown as ReturnType<
        typeof useSWR
      >;
    }
    if (typeof key === 'string' && key.includes('/scheduled')) {
      return { data: sched.data, error: sched.error, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>;
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

  it('the claims wall carries no fixed/sticky positioning class and stays in normal flow', () => {
    mockData(snapshot({ claims: [claim({ slug: 'c1' })] }));
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const wall = container.querySelector('.nc-obs-claims')!;
    expect(wall.className).not.toMatch(/fixed|sticky/);
    // Was `.nc-obs-main > .nc-obs-claims`. The wall now sits one level deeper,
    // inside its collapsed <details>, so the direct-child selector no longer
    // holds. The CONTRACT it protected is unchanged and still asserted: this
    // panel is in normal document flow inside the main column, never a fixed
    // side rail that ignores page scroll.
    expect(container.querySelector('.nc-obs-main .nc-obs-claims')).toBeTruthy();
  });

  it('puts the office above the boards, and leaves every board closed', () => {
    mockData(
      snapshot({
        rooms: [room({ key: 'r1' })],
        claims: [claim({ slug: 'c1' })],
        releaseState: releaseState({ items: [releaseItem({ id: 'A1' })] }),
      }),
    );
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    const main = container.querySelector('.nc-obs-main')!;
    // The office comes BEFORE every board in document order — the whole
    // complaint was scrolling past ten pages of board to reach it. Asserted on
    // order rather than on being the first child, because on a wide screen the
    // floor and the boards are two columns.
    const map = container.querySelector('.nc-of-mapcard')!;
    const firstBoard = container.querySelector('details.nc-of-board')!;
    expect(main.contains(map)).toBe(true);
    expect(map.compareDocumentPosition(firstBoard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('office-map')).toBeTruthy();
    const boards = Array.from(container.querySelectorAll('details.nc-of-board')) as HTMLDetailsElement[];
    expect(boards).toHaveLength(4);
    // "Needs attention" is deliberately the ONE board that opens itself. A
    // breach list behind a disclosure is a dead end with a chevron on it —
    // the whole point is that it cannot be not-seen. Everything else stays
    // closed so the office is still reachable without scrolling.
    expect(boards[0]!.querySelector('summary')!.textContent).toContain('Needs attention');
    expect(boards[0]!.open).toBe(true);
    expect(boards.slice(1).every((d) => !d.open)).toBe(true);
    // and the summary strip is above the floor, outside the main column
    expect(container.querySelector('.nc-of-tally-strip')).toBeTruthy();
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
      ).toBe('1 blocking · 2 automated');
    });

    it('groupReleaseItemsByOwner: whoever holds a blocker leads, and the ownerless lane is pinned last', () => {
      const lanes = groupReleaseItemsByOwner([
        releaseItem({ id: 'U1', nextMover: 'nobody' }),
        releaseItem({ id: 'U2', nextMover: 'nobody' }),
        releaseItem({ id: 'U3', nextMover: 'nobody' }),
        releaseItem({ id: 'A1', owner: 'ava', nextMover: 'agent' }),
        releaseItem({ id: 'A2', owner: 'ava', nextMover: 'agent' }),
        releaseItem({ id: 'K1', owner: 'kit', nextMover: 'human', blocksRelease: true }),
      ]);
      // kit holds the only blocker so leads despite carrying least; the three
      // ownerless items lose the count tiebreak because they are a backlog.
      expect(lanes.map((l) => l.owner)).toEqual(['kit', 'ava', UNOWNED_LANE]);
    });

    it('groupReleaseItemsByOwner: a lane reads now → next → stuck, blockers above all', () => {
      const [lane] = groupReleaseItemsByOwner([
        releaseItem({ id: 'N1', owner: 'ava', nextMover: 'nobody' }),
        releaseItem({ id: 'H1', owner: 'ava', nextMover: 'human' }),
        releaseItem({ id: 'A1', owner: 'ava', nextMover: 'agent' }),
        releaseItem({ id: 'B1', owner: 'ava', nextMover: 'nobody', blocksRelease: true }),
      ]);
      expect(lane!.items.map((i) => i.id)).toEqual(['B1', 'A1', 'H1', 'N1']);
    });

    it('by-agent view groups the same items into per-owner lanes', async () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'A1', owner: 'ava', nextMover: 'agent', title: 'ava item' }),
              releaseItem({ id: 'K1', owner: 'kit', nextMover: 'human', title: 'kit item' }),
            ],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelectorAll('.nc-obs-release-lane')).toHaveLength(0);

      const byAgent = Array.from(container.querySelectorAll('.nc-obs-release-view')).find(
        (b) => b.textContent === 'By agent',
      )!;
      await userEvent.click(byAgent);
      const lanes = Array.from(container.querySelectorAll('.nc-obs-release-lane-owner')).map((e) => e.textContent);
      expect(lanes).toEqual(['ava', 'kit']);
      // the status-view headings are gone, not merely hidden
      expect(container.querySelector('.nc-obs-release-group')).toBeNull();
    });

  

    it('the dependency view states coverage first and marks undeclared items as not-independent', async () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'A1', dependsOn: [], title: 'declared independent' }),
              releaseItem({ id: 'A2', dependsOn: ['A1'], title: 'blocked by A1' }),
              releaseItem({ id: 'A3', title: 'never declared' }),
            ],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const tab = Array.from(container.querySelectorAll('.nc-obs-release-view')).find(
        (b) => b.textContent === 'What unblocks what',
      )!;
      await userEvent.click(tab);

      expect(container.querySelector('.nc-obs-dep-coverage')!.textContent).toContain('67%');
      expect(container.querySelector('.nc-obs-dep-coverage')!.className).toContain('partial');

      // A1 and A3 are both layer 0; only A3 may carry the undeclared treatment,
      // which is the distinction the whole view exists to preserve.
      const a1 = container.querySelector('.nc-obs-dep-node[data-node-id="A1"]')!;
      const a3 = container.querySelector('.nc-obs-dep-node[data-node-id="A3"]')!;
      expect(a1.className).not.toContain('undeclared');
      expect(a3.className).toContain('undeclared');
      expect(a3.textContent).toContain('deps not declared');

      // and the ranking answers the actual question
      expect(container.querySelector('.nc-obs-dep-rank-row')!.textContent).toContain('A1');
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
      expect(labels).toEqual(['Waiting on a person', 'Agents are handling it', 'Nobody is on this']);
      const subs = Array.from(
        container.querySelectorAll('.nc-obs-release-group:not(.blockers) .nc-obs-release-group-sub'),
      ).map((el) => el.textContent);
      expect(subs).toEqual([
        'nothing moves until someone decides or approves',
        'being worked automatically right now',
        'no owner, no progress — it stays stuck until someone picks it up',
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
      expect(container.querySelector('.nc-obs-release-counts')!.textContent).toBe('1 blocking · 2 automated');
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

    it('clicking a tally filters the board to that group, clicking it again clears', async () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'H1', nextMover: 'human' }),
              releaseItem({ id: 'A1', nextMover: 'agent' }),
            ],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const humanTally = container.querySelector('[data-tally="human"]')! as HTMLElement;
      expect(container.querySelectorAll('.nc-obs-release-group').length).toBe(2);

      await userEvent.click(humanTally);
      expect(humanTally.getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelector('[data-item-id="H1"]')).toBeTruthy();
      expect(container.querySelector('[data-item-id="A1"]')).toBeFalsy();

      await userEvent.click(humanTally);
      expect(humanTally.getAttribute('aria-pressed')).toBe('false');
      expect(container.querySelector('[data-item-id="A1"]')).toBeTruthy();
    });

    it('the ALL reset clears an active tally filter', async () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'H1', nextMover: 'human' }),
              releaseItem({ id: 'A1', nextMover: 'agent' }),
            ],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await userEvent.click(container.querySelector('[data-tally="human"]')! as HTMLElement);
      expect(container.querySelector('[data-item-id="A1"]')).toBeFalsy();

      await userEvent.click(container.querySelector('.nc-of-tally-all')! as HTMLElement);
      expect(container.querySelector('[data-item-id="A1"]')).toBeTruthy();
    });

    it('expanding an item row reveals its full why and a labelled link out', async () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            items: [
              releaseItem({
                id: 'H1',
                kind: 'pr',
                nextMover: 'human',
                why: 'waiting on a second approval',
                url: 'https://example.com/pr/1',
              }),
            ],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const row = container.querySelector('[data-item-id="H1"]')!;
      expect(row.querySelector('.nc-obs-release-row-why')).toBeFalsy();

      await userEvent.click(row.querySelector('.nc-obs-release-row-toggle')! as HTMLElement);
      expect(row.querySelector('.nc-obs-release-row-why')!.textContent).toBe('waiting on a second approval');
      const out = row.querySelector('.nc-obs-release-row-detail .nc-of-link')!;
      expect(out.textContent).toContain('open PR');
      expect(out.getAttribute('target')).toBe('_blank');
      expect(out.getAttribute('rel')).toBe('noopener noreferrer');
    });
  });


  describe('the queue', () => {
    // 62 rows rendered at once is the wall of list the floor exists to replace.
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => releaseItem({ id: `XZO#${i}`, title: `item ${i}` }));

    it('shows one screen of the ranked queue and says how much is behind the fold', async () => {
      mockData(snapshot({ releaseState: releaseState({ items: many(20) }) }));
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelectorAll('.nc-obs-ledger-row')).toHaveLength(15);
      const more = container.querySelector('.nc-obs-ledger-more')!;
      expect(more.textContent).toBe('show the other 5');

      await userEvent.click(more as HTMLElement);
      expect(container.querySelectorAll('.nc-obs-ledger-row')).toHaveLength(20);
      expect(container.querySelector('.nc-obs-ledger-more')).toBeFalsy();
    });

    it('offers no fold when the whole queue already fits', () => {
      mockData(snapshot({ releaseState: releaseState({ items: many(4) }) }));
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelectorAll('.nc-obs-ledger-row')).toHaveLength(4);
      expect(container.querySelector('.nc-obs-ledger-more')).toBeFalsy();
    });

    it('carries the same five columns on every row, so the list reads down', () => {
      mockData(
        snapshot({
          releaseState: releaseState({
            items: [releaseItem({ id: 'XZO#9', title: 'a thing', owner: 'ava', kind: 'finding', blocksRelease: true })],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const btn = container.querySelector('.nc-obs-ledger-btn')!;
      // The lead column holds exactly one token on every row; "blocks release"
      // is an orthogonal fact and rides the title line.
      expect(btn.querySelector('.nc-obs-ledger-lead')!.children).toHaveLength(1);
      expect(btn.querySelector('.nc-obs-ledger-due')).toBeTruthy();
      expect(btn.querySelector('.nc-obs-ledger-title .nc-obs-ledger-blocks')!.textContent).toBe('blocks release');
      expect(btn.querySelector('.nc-obs-ledger-title')!.textContent).toContain('a thing');
      expect(btn.querySelector('.nc-obs-ledger-owner')!.textContent).toBe('ava');
      expect(btn.querySelector('.nc-obs-ledger-kind')!.textContent).toBe('finding');
      expect(btn.querySelector('.nc-obs-ledger-age')).toBeTruthy();
    });

    it('renders an ownerless row without collapsing its columns', () => {
      mockData(snapshot({ releaseState: releaseState({ items: [releaseItem()] }) }));
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const btn = container.querySelector('.nc-obs-ledger-btn')!;
      expect(btn.querySelector('.nc-obs-ledger-owner')!.textContent).toBe('—');
      expect(btn.querySelector('.nc-obs-ledger-blocks')).toBeFalsy();
    });
  });

  describe('the headline as the queue filter', () => {
    // "30 need a person" with no way to see WHICH thirty was the gap: the most
    // decision-relevant slice had no entry point into the list.
    const mixed = () => [
      // unowned is nextMover 'nobody' — NOT merely a missing owner.
      releaseItem({ id: 'U1', title: 'unowned one', nextMover: 'nobody' }),
      releaseItem({ id: 'U2', title: 'unowned two', nextMover: 'nobody' }),
      releaseItem({ id: 'P1', title: 'a person owes this', owner: 'kit', nextMover: 'human' }),
      releaseItem({ id: 'M1', title: 'an agent is on it', owner: 'ava', nextMover: 'agent' }),
    ];
    const view = () => {
      mockData(snapshot({ releaseState: releaseState({ items: mixed() }) }));
      return render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    };
    const titles = (c: HTMLElement) =>
      Array.from(c.querySelectorAll('.nc-obs-ledger-title')).map((e) => e.textContent);

    it('lists everything that is not moving on its own until a slice is picked', () => {
      const { container } = view();
      expect(titles(container)).toEqual(['unowned one', 'unowned two', 'a person owes this']);
    });

    it('narrows the queue to the slice that was clicked, and names it in the header', async () => {
      const { container } = view();
      await userEvent.click(container.querySelector('.nc-of-slice')! as HTMLElement);
      expect(titles(container)).toEqual(['a person owes this']);
      expect(container.querySelector('.nc-of-board-n')!.textContent).toBe('need a person · 1 of 4');
    });

    it('picking "moving" WIDENS the queue — that slice is hidden by default', async () => {
      const { container } = view();
      const moving = container.querySelectorAll('.nc-of-slice')[1]!;
      await userEvent.click(moving as HTMLElement);
      expect(titles(container)).toEqual(['an agent is on it']);
    });

    it('clicking the same slice again clears it, and so does "show all"', async () => {
      const { container } = view();
      const person = container.querySelector('.nc-of-slice')! as HTMLElement;
      await userEvent.click(person);
      expect(person.getAttribute('aria-pressed')).toBe('true');
      await userEvent.click(person);
      expect(titles(container)).toHaveLength(3);

      await userEvent.click(container.querySelector('.nc-of-hero')! as HTMLElement);
      expect(titles(container)).toEqual(['unowned one', 'unowned two']);
      await userEvent.click(container.querySelector('.nc-of-clearfilter')! as HTMLElement);
      expect(titles(container)).toHaveLength(3);
    });

    it('clearing the filter does not collapse the board it filters', async () => {
      const { container } = view();
      await userEvent.click(container.querySelector('.nc-of-hero')! as HTMLElement);
      const board = container.querySelector('details.nc-of-board') as HTMLDetailsElement;
      await userEvent.click(container.querySelector('.nc-of-clearfilter')! as HTMLElement);
      expect(board.open).toBe(true);
    });
  });

  describe('assigning from the queue', () => {
    const mockAssign = vi.mocked(assignItem);

    const boardWithChannel = () =>
      mockData(
        snapshot({
          agents: [agent({ id: 'ag-ava', name: 'ava' })],
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'X#1', title: 'routable', nextMover: 'nobody', channel: '#general' }),
              releaseItem({ id: 'X#2', title: 'unroutable', nextMover: 'nobody' }),
            ],
          }),
        }),
      );
    const expandRow = async (c: HTMLElement, id: string) =>
      userEvent.click(c.querySelector(`[data-ledger-id="${id}"] .nc-obs-ledger-btn`)! as HTMLElement);

    it('an owner sees the control on a channel-bearing row, and not on one without', async () => {
      boardWithChannel();
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await expandRow(container, 'X#1');
      expect(container.querySelector('.nc-obs-assign')).toBeTruthy();
      await expandRow(container, 'X#2');
      // v2 routes by the item's channel or not at all — no channel, no control.
      expect(container.querySelector('.nc-obs-assign')).toBeFalsy();
    });

    it('a member never sees the control — the server is the gate, this is the hint', async () => {
      boardWithChannel();
      const memberMe = { user_id: 'u2', scopes: { role: 'member', allowed_group_ids: [], no_filter: false } };
      const { container } = render(<Observatory authMe={memberMe} route="observatory" onRouteChange={noop} />);
      await expandRow(container, 'X#1');
      expect(container.querySelector('.nc-obs-assign')).toBeFalsy();
    });

    it('sends ids only, and reports where the work was tasked', async () => {
      boardWithChannel();
      mockAssign.mockResolvedValue({ ok: true, seriesId: 's1', channel: '#general', agent: 'ava' });
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await expandRow(container, 'X#1');
      await userEvent.selectOptions(container.querySelector('.nc-obs-assign select')! as HTMLElement, 'ag-ava');
      await userEvent.click(container.querySelector('.nc-obs-assign button')! as HTMLElement);

      expect(mockAssign).toHaveBeenCalledWith('wg-1', 'X#1', 'ag-ava');
      expect(container.querySelector('.nc-obs-assign-done')!.textContent).toBe(
        'assigned — ava was tasked in #general',
      );
    });

    it('a wiring rejection explains itself instead of failing mute', async () => {
      boardWithChannel();
      mockAssign.mockRejectedValue({ status: 409, error: 'agent_not_wired_to_channel' });
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await expandRow(container, 'X#1');
      await userEvent.selectOptions(container.querySelector('.nc-obs-assign select')! as HTMLElement, 'ag-ava');
      await userEvent.click(container.querySelector('.nc-obs-assign button')! as HTMLElement);
      expect(container.querySelector('.nc-obs-assign-err')!.textContent).toContain('not wired to #general');
    });
  });

  describe('the room sheet', () => {
    // Steering used to mean leaving the floor for a separate page. It now
    // opens over the floor, in the room the agent is standing in.
    function floor() {
      mockData(
        snapshot({
          rooms: [room({ key: 'r1', name: 'general' }), room({ key: 'r2', name: 'quiet' })],
          agents: [
            agent({ id: 'ava', name: 'ava', location: 'r1', holding: ['#12'], lastSessionId: 's-1' }),
            agent({ id: 'kit', name: 'kit', location: 'r1', lastSessionId: null }),
            agent({ id: 'zed', name: 'zed', location: 'r2', lastSessionId: 's-3' }),
          ],
        }),
      );
      return render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    }
    const open = async (c: HTMLElement, label: string) => {
      const chip = Array.from(c.querySelectorAll('.nc-of-teleport .nc-of-chip')).find((b) =>
        b.textContent?.includes(label),
      );
      await userEvent.click(chip! as HTMLElement);
    };

    it('is closed until a room is picked', () => {
      const { container } = floor();
      expect(container.querySelector('.nc-of-sheet')).toBeFalsy();
    });

    it('lists only that room\'s occupants, with what each is holding', async () => {
      const { container } = floor();
      await open(container, '#general');
      const who = Array.from(container.querySelectorAll('.nc-of-sheet-who')).map((e) => e.textContent);
      expect(who).toEqual(['ava', 'kit']);
      expect(container.querySelector('.nc-of-sheet-holding')!.textContent).toBe('holding #12');
    });

    it('offers steer as a session link, and says so plainly when there is no session', async () => {
      const { container } = floor();
      await open(container, '#general');
      const rows = container.querySelectorAll('.nc-of-sheet-list li');
      expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('#/session/s-1');
      expect(rows[1]!.querySelector('a')).toBeFalsy();
      expect(rows[1]!.querySelector('.nc-of-sheet-nosession')).toBeTruthy();
    });

    it('closes on the sheet\'s own control, which also clears the queue filter', async () => {
      const { container } = floor();
      await open(container, '#general');
      await userEvent.click(container.querySelector('.nc-of-sheet-x')! as HTMLElement);
      expect(container.querySelector('.nc-of-sheet')).toBeFalsy();
      expect(container.querySelector('.nc-of-chip.on')).toBeFalsy();
    });
  });

  describe('claim rows', () => {
    it('expanding a claim reveals its note and a thread link when threadUrl is present', async () => {
      mockData(
        snapshot({
          claims: [claim({ slug: 'c1', note: 'holding the migration', threadUrl: 'https://example.com/t/1' })],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const row = container.querySelector('.nc-obs-claim-row[data-slug="c1"]')!;
      expect(row.querySelector('.nc-obs-claim-detail')).toBeFalsy();

      await userEvent.click(row.querySelector('.nc-obs-claim-toggle')! as HTMLElement);
      expect(row.querySelector('.nc-obs-claim-note')!.textContent).toBe('holding the migration');
      const link = row.querySelector('.nc-obs-claim-detail a')!;
      expect(link.getAttribute('href')).toBe('https://example.com/t/1');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.textContent).toContain('open thread');
    });

    it('a claim with no threadUrl expands without any link', async () => {
      mockData(snapshot({ claims: [claim({ slug: 'c1', threadUrl: null })] }));
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const row = container.querySelector('.nc-obs-claim-row[data-slug="c1"]')!;
      await userEvent.click(row.querySelector('.nc-obs-claim-toggle')! as HTMLElement);
      expect(row.querySelector('.nc-obs-claim-detail')).toBeTruthy();
      expect(row.querySelector('.nc-obs-claim-detail a')).toBeFalsy();
    });

  
  });

  describe("what's scheduled", () => {
    it('upcomingScheduled: keeps only this floor\'s agent groups, soonest first, capped', () => {
      const t = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
      const rows = [
        schedRow({ key: 'b', agent_group_id: 'ava', next_fire_utc: t(60) }),
        schedRow({ key: 'x', agent_group_id: 'outsider', next_fire_utc: t(1) }),
        schedRow({ key: 'a', agent_group_id: 'kit', next_fire_utc: t(10) }),
        schedRow({ key: 'n', agent_group_id: 'kit', next_fire_utc: null }),
      ];
      expect(upcomingScheduled(rows, ['ava', 'kit']).map((r) => r.key)).toEqual(['a', 'b']);
      expect(upcomingScheduled(rows, ['ava', 'kit'], 1).map((r) => r.key)).toEqual(['a']);
    });

    it('renders only rows for agent groups on this floor', () => {
      mockData(
        snapshot({ agents: [agent({ id: 'ava', name: 'ava' })] }),
        undefined,
        {
          data: {
            rows: [
              // 90m out, so the "1h" bucket holds however long the render takes.
              schedRow({
                key: 'mine',
                agent_group_id: 'ava',
                agent_group_name: 'ava',
                channel_name: 'general',
                next_fire_utc: new Date(Date.now() + 90 * 60_000).toISOString(),
              }),
              schedRow({ key: 'theirs', agent_group_id: 'outsider', agent_group_name: 'outsider' }),
            ],
            degraded: false,
            counts: {},
            assembled_at: '',
          },
        },
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const keys = Array.from(container.querySelectorAll('.nc-of-sched-row')).map((el) =>
        el.getAttribute('data-sched-key'),
      );
      expect(keys).toEqual(['mine']);
      const row = container.querySelector('.nc-of-sched-row[data-sched-key="mine"]')!;
      expect(row.textContent).toContain('ava');
      expect(row.textContent).toContain('repeating job');
      expect(row.textContent).toContain('in 1h');
      expect(row.textContent).toContain('general');
    });

    it('opens the detail drawer for a row — the capability the deleted Scheduled tab used to own', async () => {
      mockData(snapshot({ agents: [agent({ id: 'ava', name: 'ava' })] }), undefined, {
        data: {
          rows: [
            schedRow({
              key: 'mine',
              agent_group_id: 'ava',
              next_fire_utc: new Date(Date.now() + 600_000).toISOString(),
            }),
          ],
          degraded: false,
          counts: {},
          assembled_at: '',
        },
      });
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelector('[data-testid="sched-drawer"]')).toBeNull();
      await userEvent.click(container.querySelector('.nc-of-sched-row .nc-of-sched-open')!);
      expect(container.querySelector('[data-testid="sched-drawer"]')!.textContent).toBe('drawer:mine');
    });

    it('shows the empty state when nothing on this floor is scheduled', () => {
      mockData(snapshot({ agents: [agent({ id: 'ava' })] }), undefined, {
        data: {
          rows: [schedRow({ key: 'theirs', agent_group_id: 'outsider' })],
          degraded: false,
          counts: {},
          assembled_at: '',
        },
      });
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelector('.nc-of-sched-empty')!.textContent).toBe('nothing scheduled');
    });

  
  });

  describe('RouteNav', () => {
    it('offers the Observatory only — inbox, workgroup and the scheduled board are gone', () => {
      const { container } = render(<RouteNav route="observatory" onRouteChange={noop} />);
      const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
      expect(labels).toEqual(['Observatory']);
    });
  });
});
