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
  claimSummary,
  groupReleaseItems,
  releaseCounts,
  jobTabItems,
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

/** Click a segment of the top-bar control — the only way to a non-default view. */
async function segment(c: HTMLElement, view: 'overview' | 'board' | 'claims' | 'schedule') {
  await userEvent.click(c.querySelector(`.nc-of-seg-btn[data-view="${view}"]`)! as HTMLElement);
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

  describe('the segmented views', () => {
    const full = () =>
      mockData(
        snapshot({
          rooms: [room({ key: 'r1' })],
          claims: [claim({ slug: 'c1' })],
          releaseState: releaseState({ items: [releaseItem({ id: 'A1', nextMover: 'nobody' })] }),
        }),
      );

    it('opens on the overview: the headline, the office, and the queue', () => {
      full();
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelector('.nc-of-seg-btn[data-view="overview"]')!.getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelector('.nc-of-head')).toBeTruthy();
      expect(container.querySelector('office-map')).toBeTruthy();
      expect(container.querySelector('[data-section="queue"]')).toBeTruthy();
      expect(container.querySelector('[data-section="board"]')).toBeFalsy();
    });

    it('the office and the headline survive every segment — only the region below swaps', async () => {
      full();
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      for (const [view, section] of [
        ['board', 'board'],
        ['claims', 'claims'],
        ['schedule', 'schedule'],
      ] as const) {
        await segment(container, view);
        expect(container.querySelector('office-map')).toBeTruthy();
        expect(container.querySelector('.nc-of-head')).toBeTruthy();
        expect(container.querySelector(`[data-section="${section}"]`)).toBeTruthy();
        expect(container.querySelector('[data-section="queue"]')).toBeFalsy();
      }
    });

    it('the job board carries the claims and schedule cards beneath it, two up', async () => {
      full();
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await segment(container, 'board');
      const twoup = container.querySelector('.nc-of-twoup')!;
      expect(twoup.querySelector('[data-section="claims"]')).toBeTruthy();
      expect(twoup.querySelector('[data-section="schedule"]')).toBeTruthy();
      // and the table is above them
      const table = container.querySelector('[data-section="board"]')!;
      expect(table.compareDocumentPosition(twoup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('the office comes before the content region in document order, on every view', async () => {
      full();
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const main = container.querySelector('.nc-obs-main')!;
      const map = container.querySelector('.nc-of-mapcard')!;
      expect(main.contains(map)).toBe(true);
      await segment(container, 'board');
      const board = container.querySelector('[data-section="board"]')!;
      expect(map.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('the bar states the context of the view you are on', async () => {
      full();
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const meta = () => container.querySelector('.nc-of-bar-count')!.textContent;
      expect(meta()).toBe('0 agents · 1 channels');
      await segment(container, 'board');
      expect(meta()).toBe('1 unowned');
      await segment(container, 'claims');
      expect(meta()).toBe('1 held');
    });
  });

  describe('work claims', () => {
    const withClaims = (claims: ObservatoryClaim[]) => {
      mockData(snapshot({ claims }));
      return render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    };
    const openClaims = async (c: HTMLElement) => segment(c, 'claims');

    it('orders stale → parked → expiring → live, and says which need an owner', async () => {
      const { container } = withClaims([
        claim({ slug: 'live-1', state: 'live' }),
        claim({ slug: 'stale-1', state: 'stale' }),
        claim({ slug: 'parked-1', state: 'parked' }),
        claim({ slug: 'expiring-1', state: 'expiring' }),
      ]);
      await openClaims(container);
      const rows = Array.from(container.querySelectorAll('.nc-obs-claim-row'));
      expect(rows.map((r) => r.getAttribute('data-slug'))).toEqual(['stale-1', 'parked-1', 'expiring-1', 'live-1']);
      const parkedRow = container.querySelector('.nc-obs-claim-row[data-slug="parked-1"]')!;
      expect(parkedRow.textContent).toContain('needs an owner');
    });

    it('the card head counts the states in operator language', async () => {
      const { container } = withClaims([
        claim({ slug: 'live-1', state: 'live' }),
        claim({ slug: 'stale-1', state: 'stale' }),
        claim({ slug: 'parked-1', state: 'parked' }),
      ]);
      await openClaims(container);
      expect(container.querySelector('[data-section="claims"] .nc-of-card-meta')!.textContent).toBe(
        '1 abandoned · 1 needs an owner · 1 held',
      );
    });

    it('claimSummary: pure helper omits zero terms', () => {
      expect(claimSummary([claim({ state: 'live' }), claim({ slug: 'b', state: 'live' })])).toBe('2 held');
      expect(claimSummary([])).toBe('nothing claimed');
    });

    it('renders an age line for each claim state, red once the deadline is gone', async () => {
      const { container } = withClaims([
        claim({ slug: 'live-1', state: 'live', staleMs: -3_600_000 }),
        claim({ slug: 'stale-1', state: 'stale', staleMs: 7_200_000 }),
        claim({ slug: 'expiring-1', state: 'expiring', staleMs: 1_800_000 }),
        claim({ slug: 'parked-1', state: 'parked', staleMs: 5_400_000 }),
      ]);
      await openClaims(container);
      const age = (slug: string) =>
        container.querySelector(`.nc-obs-claim-row[data-slug="${slug}"] .nc-obs-claim-age`)!;
      expect(age('live-1').textContent).toContain('left');
      expect(age('stale-1').textContent).toContain('past deadline');
      expect(age('expiring-1').textContent).toContain('past deadline');
      expect(age('parked-1').textContent).toBe('parked 1h ago');
      expect(age('stale-1').className).toContain('stop');
      expect(age('expiring-1').className).toContain('warn');
      expect(age('live-1').className).not.toContain('stop');
    });

    it('claimAgeLabel: pure helper matches the per-state phrasing', () => {
      const now = Date.parse('2026-08-14T12:00:00Z');
      expect(claimAgeLabel(claim({ state: 'live', staleMs: -3_600_000 }), now)).toBe('1h left');
      expect(claimAgeLabel(claim({ state: 'stale', staleMs: 7_200_000 }), now)).toBe('2h past deadline');
      expect(claimAgeLabel(claim({ state: 'parked', staleMs: 1_800_000 }), now)).toBe('parked 30m ago');
    });

    it('renders "owner unknown" in italics when the owner is unresolved, not a literal name', async () => {
      const { container } = withClaims([claim({ slug: 'c1', state: 'live', owner: 'unknown' })]);
      await openClaims(container);
      const ownerEl = container.querySelector('.nc-obs-claim-owner')!;
      expect(ownerEl.querySelector('em')!.textContent).toBe('owner unknown');
      expect(ownerEl.textContent).not.toBe('unknown');
    });

    it('the claims card stays in normal flow inside the main column, never a fixed rail', async () => {
      const { container } = withClaims([claim({ slug: 'c1' })]);
      await openClaims(container);
      const card = container.querySelector('[data-section="claims"]')!;
      expect(card.className).not.toMatch(/fixed|sticky/);
      expect(container.querySelector('.nc-obs-main [data-section="claims"]')).toBeTruthy();
    });

    it('expanding a claim reveals its note and a thread link when threadUrl is present', async () => {
      const { container } = withClaims([
        claim({ slug: 'c1', note: 'holding the migration', threadUrl: 'https://example.com/t/1' }),
      ]);
      await openClaims(container);
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
      const { container } = withClaims([claim({ slug: 'c1', threadUrl: null })]);
      await openClaims(container);
      const row = container.querySelector('.nc-obs-claim-row[data-slug="c1"]')!;
      await userEvent.click(row.querySelector('.nc-obs-claim-toggle')! as HTMLElement);
      expect(row.querySelector('.nc-obs-claim-detail')).toBeTruthy();
      expect(row.querySelector('.nc-obs-claim-detail a')).toBeFalsy();
    });

    it('sortClaims: pure ordering helper matches the row order', () => {
      const out = sortClaims([claim({ slug: 'a', state: 'live' }), claim({ slug: 'b', state: 'stale' })]);
      expect(out.map((c) => c.slug)).toEqual(['b', 'a']);
    });
  });

  describe('page chrome', () => {
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
  });

  describe('the job board', () => {
    const board = async (items: ReleaseItem[], rs: Partial<ReleaseState> | null = {}) => {
      mockData(snapshot({ releaseState: rs === null ? null : releaseState({ items, ...rs }) }));
      const out = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await segment(out.container, 'board');
      return out;
    };
    const ts = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

    it('jobTabItems: queue is whoever is not an agent, in flight is the agent, blockers cross both', () => {
      const items = [
        releaseItem({ id: 'H1', nextMover: 'human' }),
        releaseItem({ id: 'N1', nextMover: 'nobody' }),
        releaseItem({ id: 'A1', nextMover: 'agent' }),
        releaseItem({ id: 'B1', nextMover: 'agent', blocksRelease: true }),
      ];
      expect(jobTabItems(items, 'queue').map((i) => i.id)).toEqual(['H1', 'N1']);
      expect(jobTabItems(items, 'flight').map((i) => i.id)).toEqual(['A1', 'B1']);
      expect(jobTabItems(items, 'blocking').map((i) => i.id)).toEqual(['B1']);
    });

    it('jobTabItems: newest promise first', () => {
      const items = [
        releaseItem({ id: 'OLD', nextMover: 'human', since: ts(48) }),
        releaseItem({ id: 'NEW', nextMover: 'human', since: ts(1) }),
        releaseItem({ id: 'MID', nextMover: 'human', since: ts(9) }),
      ];
      expect(jobTabItems(items, 'queue').map((i) => i.id)).toEqual(['NEW', 'MID', 'OLD']);
    });

    it('the tabs carry their own counts and each names what it is showing', async () => {
      const { container } = await board([
        releaseItem({ id: 'H1', nextMover: 'human' }),
        releaseItem({ id: 'N1', nextMover: 'nobody' }),
        releaseItem({ id: 'A1', nextMover: 'agent' }),
        releaseItem({ id: 'B1', nextMover: 'agent', blocksRelease: true }),
      ]);
      const tab = (k: string) => container.querySelector(`.nc-of-tab[data-tab="${k}"]`)!;
      expect(tab('queue').textContent).toBe('Queue 2');
      expect(tab('flight').textContent).toBe('In flight 2');
      expect(tab('blocking').textContent).toBe('Blocks release 1');
      expect(container.querySelector('.nc-of-tab-hint')!.textContent).toBe(
        'unclaimed and claimed work, newest promise first',
      );
    });

    it('picking a tab swaps the rows and the sentence under the count', async () => {
      const { container } = await board([
        releaseItem({ id: 'H1', nextMover: 'human', title: 'a person owes this' }),
        releaseItem({ id: 'A1', nextMover: 'agent', title: 'an agent is on it' }),
      ]);
      const ids = () =>
        Array.from(container.querySelectorAll('.nc-obs-ledger-row')).map((r) => r.getAttribute('data-ledger-id'));
      expect(ids()).toEqual(['H1']);

      await userEvent.click(container.querySelector('.nc-of-tab[data-tab="flight"]')! as HTMLElement);
      expect(ids()).toEqual(['A1']);
      expect(container.querySelector('.nc-of-tab-hint')!.textContent).toBe('items an agent is actively moving');
      expect(container.querySelector('.nc-of-tab[data-tab="flight"]')!.getAttribute('aria-pressed')).toBe('true');
    });

    it('every row carries the same six columns, so the table reads down', async () => {
      const { container } = await board([
        releaseItem({
          id: 'XZO#9',
          title: 'a thing',
          owner: 'ava',
          kind: 'finding',
          nextMover: 'nobody',
          channel: '#qa-room',
          blocksRelease: true,
        }),
      ]);
      const btn = container.querySelector('.nc-obs-ledger-btn')!;
      expect(btn.querySelector('.nc-obs-ledger-id')!.textContent).toBe('XZO#9');
      expect(btn.querySelector('.nc-obs-ledger-title .nc-obs-ledger-blocks')!.textContent).toBe('blocks release');
      expect(btn.querySelector('.nc-obs-ledger-title')!.textContent).toContain('a thing');
      // The state cell is a dot plus the ledger's own word for the state.
      expect(btn.querySelector('.nc-obs-ledger-state')!.textContent).toBe('nobody owns this');
      expect(btn.querySelector('.nc-obs-ledger-state .nc-obs-dot')).toBeTruthy();
      expect(btn.querySelector('.nc-obs-ledger-state')!.className).toContain('unowned');
      expect(btn.querySelector('.nc-obs-ledger-owner')!.textContent).toBe('ava');
      expect(btn.querySelector('.nc-obs-ledger-room')!.textContent).toBe('#qa-room');
      expect(btn.querySelector('.nc-obs-ledger-age')).toBeTruthy();
      // and the header names those columns in the same order
      expect(
        Array.from(container.querySelectorAll('.nc-obs-ledger-head > span')).map((s) => s.textContent),
      ).toEqual(['Id', 'Title', 'State', 'Owner', 'Room', 'Age']);
    });

    it('an ownerless, roomless row shows an em dash rather than collapsing its columns', async () => {
      const { container } = await board([releaseItem({ nextMover: 'nobody' })]);
      const btn = container.querySelector('.nc-obs-ledger-btn')!;
      expect(btn.querySelector('.nc-obs-ledger-owner')!.textContent).toBe('—');
      expect(btn.querySelector('.nc-obs-ledger-room')!.textContent).toBe('—');
      expect(btn.querySelector('.nc-obs-ledger-blocks')).toBeFalsy();
    });

    it('expanding a row reveals its why and a labelled link out', async () => {
      const { container } = await board([
        releaseItem({
          id: 'N1',
          kind: 'pr',
          nextMover: 'nobody',
          why: 'waiting on a second approval',
          url: 'https://example.com/pr/1',
        }),
      ]);
      const row = container.querySelector('[data-ledger-id="N1"]')!;
      expect(row.querySelector('.nc-obs-ledger-detail')).toBeFalsy();

      await userEvent.click(row.querySelector('.nc-obs-ledger-btn')! as HTMLElement);
      expect(row.querySelector('.nc-obs-ledger-detail')!.textContent).toContain('waiting on a second approval');
      const out = row.querySelector('.nc-obs-ledger-detail .nc-of-link')!;
      expect(out.textContent).toContain('open PR');
      expect(out.getAttribute('target')).toBe('_blank');
      expect(out.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('renders the moratorium banner and hold chips', async () => {
      const { container } = await board([], { release: { moratorium: true, holds: [{ kind: 'freeze', reason: 'release day' }] } });
      expect(container.querySelector('.nc-obs-release-moratorium')!.textContent).toContain(
        'release-day moratorium active',
      );
      const hold = container.querySelector('.nc-obs-release-hold')!;
      expect(hold.textContent).toContain('freeze');
      expect(hold.textContent).toContain('release day');
    });

    it('an absent release desk and an empty one say different things', async () => {
      const absent = await board([], null);
      expect(absent.container.querySelector('.nc-obs-ledger-empty')!.textContent).toBe(
        'no release desk — the release watcher has not published release-state.json yet',
      );
      absent.unmount();

      const empty = await board([]);
      expect(empty.container.querySelector('.nc-obs-ledger-empty')!.textContent).toBe(
        'nothing open — clear to ship pending the usual gates',
      );
    });

    it('pages exactly like the queue, and a new tab starts folded again', async () => {
      const { container } = await board([
        ...Array.from({ length: 20 }, (_, i) => releaseItem({ id: `Q#${i}`, nextMover: 'nobody' })),
        ...Array.from({ length: 20 }, (_, i) => releaseItem({ id: `F#${i}`, nextMover: 'agent' })),
      ]);
      const rows = () => container.querySelectorAll('.nc-obs-ledger-row').length;
      expect(rows()).toBe(15);
      await userEvent.click(container.querySelector('.nc-obs-ledger-more')! as HTMLElement);
      expect(rows()).toBe(20);

      await userEvent.click(container.querySelector('.nc-of-tab[data-tab="flight"]')! as HTMLElement);
      expect(rows()).toBe(15);
    });

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

    it('is the same table as the job board, with no column header of its own', () => {
      mockData(snapshot({ releaseState: releaseState({ items: many(2) }) }));
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelector('.nc-obs-ledger-btn .nc-obs-ledger-state')).toBeTruthy();
      // The card is titled "Needs attention"; a second row of column names on
      // top of that reads as two headings for one list.
      expect(container.querySelector('.nc-obs-ledger-head')).toBeFalsy();
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

    it('narrows the queue to the slice that was clicked, and names it in the card head', async () => {
      const { container } = view();
      await userEvent.click(container.querySelector('.nc-of-slice')! as HTMLElement);
      expect(titles(container)).toEqual(['a person owes this']);
      expect(container.querySelector('.nc-of-card-meta')!.textContent).toBe('need a person · 1 of 4');
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

    it('the slice filters the job board too — one filter, one denominator', async () => {
      const { container } = view();
      await userEvent.click(container.querySelector('.nc-of-slice')! as HTMLElement);
      await segment(container, 'board');
      // "need a person" narrows the whole page to the human-mover item.
      expect(container.querySelector('.nc-of-tab[data-tab="queue"]')!.textContent).toBe('Queue 3');
    });
  });

  describe('assigning from a row', () => {
    const mockAssign = vi.mocked(assignItem);

    const boardWithChannel = () =>
      mockData(
        snapshot({
          agents: [agent({ id: 'ag-ava', name: 'ava' })],
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'X#1', title: 'routable', nextMover: 'nobody', channel: '#general' }),
              releaseItem({ id: 'X#2', title: 'unroutable', nextMover: 'nobody' }),
              releaseItem({ id: 'X#3', title: 'yours', nextMover: 'human', owner: 'kit', channel: '#dispatch' }),
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

    it('an item a PERSON owes says where to answer it instead of offering to route it away', async () => {
      boardWithChannel();
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await expandRow(container, 'X#3');
      expect(container.querySelector('.nc-obs-assign')).toBeFalsy();
      expect(container.querySelector('.nc-obs-needsyou')!.textContent).toBe(
        'this needs you — answer in #dispatch →',
      );
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
          claims: [
            claim({ slug: 'migration', owner: 'ava', threadUrl: 'https://example.com/thread/1' }),
            claim({ slug: 'orphan', owner: 'ava', threadUrl: null }),
          ],
          agents: [
            agent({ id: 'ava', name: 'ava', location: 'r1', holding: ['migration', 'orphan'] }),
            agent({ id: 'kit', name: 'kit', location: 'r1', holding: [] }),
            agent({ id: 'zed', name: 'zed', location: 'r2', holding: [] }),
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

    it('lists only that room\'s occupants, one row per thing each is holding', async () => {
      const { container } = floor();
      await open(container, '#general');
      const who = Array.from(container.querySelectorAll('.nc-of-sheet-who')).map((e) => e.textContent);
      expect(who).toEqual(['ava', 'kit']);
      const held = Array.from(container.querySelectorAll('.nc-of-sheet-held-slug')).map((e) => e.textContent);
      expect(held).toEqual(['migration', 'orphan']);
    });

    it('steers the work: each held claim links into its own thread', async () => {
      const { container } = floor();
      await open(container, '#general');
      const rows = container.querySelectorAll('.nc-of-sheet-list li');
      const held = rows[0]!.querySelectorAll('.nc-of-sheet-held-row');
      const link = held[0]!.querySelector('a')!;
      expect(link.getAttribute('href')).toBe('https://example.com/thread/1');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.textContent).toContain('steer in thread');
    });

    it('a held claim with no thread says so instead of offering a dead link', async () => {
      const { container } = floor();
      await open(container, '#general');
      const held = container.querySelectorAll('.nc-of-sheet-list li')[0]!.querySelectorAll('.nc-of-sheet-held-row');
      expect(held[1]!.querySelector('a')).toBeFalsy();
      expect(held[1]!.querySelector('.nc-of-sheet-nothread')!.textContent).toBe('no thread recorded');
    });

    it('an occupant holding nothing gets no steer affordance at all', async () => {
      const { container } = floor();
      await open(container, '#general');
      const idle = container.querySelectorAll('.nc-of-sheet-list li')[1]!;
      expect(idle.querySelector('.nc-of-sheet-who')!.textContent).toBe('kit');
      expect(idle.textContent).toContain('holding nothing');
      expect(idle.querySelector('a')).toBeFalsy();
      expect(idle.querySelector('.nc-of-sheet-held')).toBeFalsy();
    });

    it('closes on the sheet\'s own control, which also clears the queue filter', async () => {
      const { container } = floor();
      await open(container, '#general');
      await userEvent.click(container.querySelector('.nc-of-sheet-x')! as HTMLElement);
      expect(container.querySelector('.nc-of-sheet')).toBeFalsy();
      expect(container.querySelector('.nc-of-chip.on')).toBeFalsy();
    });
  });

  describe('scheduled jobs', () => {
    const withRows = async (rows: ScheduledRow[], schedError?: unknown) => {
      mockData(snapshot({ agents: [agent({ id: 'ava', name: 'ava' })] }), undefined, {
        ...(schedError
          ? { error: schedError }
          : { data: { rows, degraded: false, counts: {}, assembled_at: '' } }),
      });
      const out = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await segment(out.container, 'schedule');
      return out;
    };

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

    it('renders only rows for agent groups on this floor: name, cron, next fire', async () => {
      const { container } = await withRows([
        // 90m out, so the "1h" bucket holds however long the render takes.
        schedRow({
          key: 'mine',
          series_id: 'task-nightly-smoke',
          agent_group_id: 'ava',
          agent_group_name: 'ava',
          channel_name: 'general',
          next_fire_utc: new Date(Date.now() + 90 * 60_000).toISOString(),
        }),
        schedRow({ key: 'theirs', agent_group_id: 'outsider', agent_group_name: 'outsider' }),
      ]);
      const keys = Array.from(container.querySelectorAll('.nc-of-sched-row')).map((el) =>
        el.getAttribute('data-sched-key'),
      );
      expect(keys).toEqual(['mine']);
      const row = container.querySelector('.nc-of-sched-row[data-sched-key="mine"]')!;
      expect(row.querySelector('.nc-of-sched-id')!.textContent).toBe('task-nightly-smoke');
      expect(row.querySelector('.nc-of-sched-who')!.textContent).toBe('ava in general');
      expect(row.querySelector('.nc-of-sched-cron')!.textContent).toBe('0 9 * * *');
      expect(row.querySelector('.nc-of-sched-when')!.textContent).toBe('in 1h');
    });

    it('a series with no cron says what kind of job it is — monospace stays for the cron', async () => {
      const { container } = await withRows([
        schedRow({ key: 'mine', agent_group_id: 'ava', kind: 'one_off', cron: null }),
      ]);
      const cron = container.querySelector('.nc-of-sched-cron')!;
      expect(cron.textContent).toBe('one-time job');
      expect(cron.className).not.toContain('mono');
    });

    it('opens the detail drawer for a row — the capability the deleted Scheduled tab used to own', async () => {
      const { container } = await withRows([
        schedRow({ key: 'mine', agent_group_id: 'ava', next_fire_utc: new Date(Date.now() + 600_000).toISOString() }),
      ]);
      expect(container.querySelector('[data-testid="sched-drawer"]')).toBeNull();
      await userEvent.click(container.querySelector('.nc-of-sched-row .nc-of-sched-open')!);
      expect(container.querySelector('[data-testid="sched-drawer"]')!.textContent).toBe('drawer:mine');
    });

    it('shows the empty state when nothing on this floor is scheduled', async () => {
      const { container } = await withRows([schedRow({ key: 'theirs', agent_group_id: 'outsider' })]);
      expect(container.querySelector('.nc-obs-ledger-empty')!.textContent).toBe('nothing scheduled');
      expect(container.querySelector('[data-section="schedule"] .nc-of-card-meta')!.textContent).toBe(
        'nothing scheduled',
      );
    });

    it('says so when the endpoint itself failed, rather than claiming nothing is scheduled', async () => {
      const { container } = await withRows([], new Error('boom'));
      expect(container.querySelector('.nc-obs-ledger-empty')!.textContent).toBe("couldn't load scheduled work");
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
