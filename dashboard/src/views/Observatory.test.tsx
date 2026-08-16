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
}));

// The drawer is exercised by its own suite; here we only care that the floor
// opens it with the right row key.
vi.mock('./ScheduledDrawer.js', () => ({
  ScheduledDrawer: ({ rowKey }: { rowKey: string }) => <div data-testid="sched-drawer">drawer:{rowKey}</div>,
}));

import {
  Observatory,
  sortRooms,
  roomActivityClass,
  sortClaims,
  claimAgeLabel,
  groupReleaseItems,
  groupReleaseItemsByOwner,
  UNOWNED_LANE,
  releaseCounts,
  upcomingScheduled,
} from './Observatory.js';
import { RouteNav } from './BoardShell.js';
import { roomDecor, rugTone, RUG_TONES, COBWEB, BLANK_AVATAR, DESK_ON, DESK_OFF } from './office-sprites.js';
import useSWR from 'swr';
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
    const kids = Array.from(main.children);
    // The floor is the FIRST thing in the main column — the whole complaint
    // was scrolling past ten pages of board to reach it.
    expect(kids[0]!.className).toContain('nc-of-floor');
    const boards = Array.from(container.querySelectorAll('details.nc-of-board'));
    expect(boards).toHaveLength(3);
    expect(boards.every((d) => !(d as HTMLDetailsElement).open)).toBe(true);
    // and the summary strip is above the floor, outside the main column
    expect(container.querySelector('.nc-of-tally-strip')).toBeTruthy();
  });

  describe('avatar faces', () => {
    it('renders a pixelated avatar image on the chip when avatarUrl is present', () => {
      mockData(
        snapshot({
          agents: [agent({ id: 'ava', name: 'ava', avatarUrl: 'https://avatars.slack-edge.com/ava.png', awake: true })],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const img = container.querySelector('.nc-obs-chip[data-agent-id="ava"] img')! as HTMLImageElement;
      expect(img).toBeTruthy();
      expect(img.className).toContain('pixelated');
      expect(img.getAttribute('src')).toBe('https://avatars.slack-edge.com/ava.png');
    });

    it('falls back to dashed initials for the wired-member marker when avatarUrl is null', () => {
      mockData(
        snapshot({
          rooms: [room({ key: 'r1', memberAgentIds: ['kit'] })],
          agents: [agent({ id: 'kit', name: 'kit', location: null, avatarUrl: null })],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const absent = container.querySelector('.nc-obs-room-absent')!;
      expect(absent.textContent).toBe('K');
      // No avatar face for the absent member — the room's own furniture and
      // empty-desk sprites live in the same row, so assert on the avatar.
      expect(container.querySelector('.nc-obs-room-bodies .nc-obs-avatar')).toBeFalsy();
    });

    it('applies the grayscale "asleep" class to the avatar image when the agent is asleep', () => {
      mockData(
        snapshot({
          agents: [agent({ id: 'ava', name: 'ava', avatarUrl: 'https://avatars.slack-edge.com/ava.png', awake: false })],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const img = container.querySelector('.nc-obs-chip[data-agent-id="ava"] img')!;
      expect(img.className).toContain('asleep');
    });
  });

  describe('the office floor', () => {
    const decorOf = (container: HTMLElement, key: string) =>
      Array.from(container.querySelectorAll(`.nc-obs-room[data-room-key="${key}"] .nc-of-decor img`)).map((el) =>
        el.getAttribute('data-decor'),
      );

    it('room furniture is deterministic per room key, not random per render', () => {
      // Pure helper first — same key in, same furniture out.
      expect(roomDecor('slack:C123').map((d) => d.name)).toEqual(roomDecor('slack:C123').map((d) => d.name));

      mockData(snapshot({ rooms: [room({ key: 'slack:C123' }), room({ key: 'slack:C999', name: 'other' })] }));
      const first = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const second = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);

      const a = decorOf(first.container, 'slack:C123');
      expect(a.length).toBeGreaterThan(0);
      expect(a).toEqual(decorOf(second.container, 'slack:C123'));
      expect(decorOf(first.container, 'slack:C999')).toEqual(decorOf(second.container, 'slack:C999'));
      // Every piece comes from the sprite set, never an empty/undefined src.
      for (const img of Array.from(first.container.querySelectorAll('.nc-of-decor img'))) {
        expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
      }
    });

    it('an abandoned room is marked dusty and gets a cobweb sprite; a live room gets neither', () => {
      mockData(
        snapshot({
          rooms: [
            room({ key: 'old', lastActivityAt: '2020-01-01T00:00:00Z' }),
            room({ key: 'fresh', lastActivityAt: new Date().toISOString() }),
          ],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const old = container.querySelector('.nc-obs-room[data-room-key="old"]')!;
      expect(old.className).toContain('dusty');
      expect(old.querySelector('.nc-obs-room-cobweb')!.getAttribute('src')).toBe(COBWEB);

      const fresh = container.querySelector('.nc-obs-room[data-room-key="fresh"]')!;
      expect(fresh.className).not.toContain('dusty');
      expect(fresh.querySelector('.nc-obs-room-cobweb')).toBeFalsy();
    });

    it('the bullpen holds exactly the agents with no location', () => {
      mockData(
        snapshot({
          rooms: [room({ key: 'r1' })],
          agents: [
            agent({ id: 'ava', name: 'ava', location: 'r1' }),
            agent({ id: 'kit', name: 'kit', location: null }),
            agent({ id: 'zed', name: 'zed', location: null }),
          ],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const inPen = Array.from(container.querySelectorAll('.nc-of-bullpen .nc-obs-chip')).map((el) =>
        el.getAttribute('data-agent-id'),
      );
      expect(inPen).toEqual(['kit', 'zed']);
      // and the bullpen is part of the floor, not a strip above it.
      expect(container.querySelector('.nc-of-floor > .nc-of-bullpen')).toBeTruthy();
    });

    it('an agent with no avatarUrl gets the blank-avatar sprite with initials over it', () => {
      mockData(snapshot({ agents: [agent({ id: 'zed', name: 'zed rivera', avatarUrl: null })] }));
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const blank = container.querySelector('.nc-obs-chip[data-agent-id="zed"] .nc-of-blank')!;
      const img = blank.querySelector('img')!;
      expect(img.getAttribute('src')).toBe(BLANK_AVATAR);
      expect(img.className).toContain('pixelated');
      expect(blank.querySelector('.nc-of-blank-initials')!.textContent).toBe('ZR');
    });

    it('an awake agent sits at a lit desk, an asleep agent at a dark one', () => {
      mockData(
        snapshot({
          agents: [agent({ id: 'ava', name: 'ava', awake: true }), agent({ id: 'kit', name: 'kit', awake: false })],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const deskOf = (id: string) =>
        container.querySelector(`.nc-obs-chip[data-agent-id="${id}"] .nc-of-desk`)!.getAttribute('src');
      expect(deskOf('ava')).toBe(DESK_ON);
      expect(deskOf('kit')).toBe(DESK_OFF);
    });
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

    it('clicking an agent on the floor narrows the board to their desk, counts included', async () => {
      mockData(
        snapshot({
          rooms: [room({ key: 'r1' })],
          agents: [agent({ id: 'ava', name: 'ava', location: 'r1' })],
          releaseState: releaseState({
            items: [
              releaseItem({ id: 'A1', owner: 'ava', nextMover: 'agent', title: 'ava item' }),
              releaseItem({ id: 'K1', owner: 'kit', nextMover: 'agent', title: 'kit item' }),
            ],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelector('.nc-obs-release-counts')!.textContent).toBe('2 automated');

      await userEvent.click(container.querySelector('.nc-obs-room[data-room-key="r1"] .nc-obs-chip')!);
      expect(container.querySelector('.nc-obs-release-owner-filter')!.textContent).toContain('ava');
      expect(container.querySelector('.nc-obs-release-counts')!.textContent).toBe('1 automated');
      const ids = Array.from(container.querySelectorAll('.nc-obs-release-row')).map((e) =>
        e.getAttribute('data-item-id'),
      );
      expect(ids).toEqual(['A1']);

      await userEvent.click(container.querySelector('.nc-obs-release-owner-clear')!);
      expect(container.querySelector('.nc-obs-release-owner-filter')).toBeNull();
      expect(container.querySelector('.nc-obs-release-counts')!.textContent).toBe('2 automated');
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

    it('an agent popover offers its session to steer, and says so when there is none', async () => {
      mockData(
        snapshot({
          rooms: [room({ key: 'r1' })],
          agents: [
            agent({ id: 'ava', name: 'ava', location: 'r1', lastSessionId: 'sess-9' }),
            agent({ id: 'kit', name: 'kit', location: null, lastSessionId: null }),
          ],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);

      await userEvent.click(container.querySelector('.nc-obs-chip[data-agent-id="ava"]')!);
      expect(container.querySelector('.nc-obs-hover-steer')!.getAttribute('href')).toBe('#/session/sess-9');

      await userEvent.click(container.querySelector('.nc-obs-chip[data-agent-id="kit"]')!);
      expect(container.querySelector('.nc-obs-hover-nosession')).toBeTruthy();
      expect(container.querySelector('.nc-obs-hover-steer')).toBeNull();
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

  describe('open floor plan', () => {
    it('rugTone is stable per zone key and stays inside the tone set', () => {
      expect(rugTone('slack:C123')).toBe(rugTone('slack:C123'));
      for (const key of ['slack:C1', 'discord:D2', 'slack:C999', 'x']) {
        expect(rugTone(key)).toBeGreaterThanOrEqual(0);
        expect(rugTone(key)).toBeLessThan(RUG_TONES);
      }
    });

    // Renamed from "…with no wall styling left". Rooms ARE walled now: the
    // office-16 amendment adopted enclosure after three independent critics
    // read the unwalled version as a colour-block chart rather than a floor
    // plan. The name asserted a contract the body never checked; the body's
    // real subject is the zone class, its rug tone and its hanging sign.
    it('a zone carries a rug tone and a hanging sign that names the channel', () => {
      mockData(snapshot({ rooms: [room({ key: 'r1', name: 'general' })] }));
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const zone = container.querySelector('.nc-obs-room[data-room-key="r1"]')!;
      expect(zone.className).toContain('nc-of-zone');
      expect(zone.className).toMatch(/rug-[0-5]/);
      const sign = zone.querySelector('.nc-of-sign')!;
      expect(sign.tagName).toBe('BUTTON');
      expect(sign.textContent).toContain('general');
    });

    it('clicking a zone opens a detail panel with who is there, last activity and a channel link', async () => {
      const lastActivityAt = new Date(Date.now() - 3600_000).toISOString();
      mockData(
        snapshot({
          rooms: [room({ key: 'r1', name: 'general', lastActivityAt, permalink: 'https://example.com/c/general' })],
          agents: [agent({ id: 'ava', name: 'ava', location: 'r1' })],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const zone = container.querySelector('.nc-obs-room[data-room-key="r1"]')!;
      expect(zone.querySelector('.nc-of-zone-panel')).toBeFalsy();

      await userEvent.click(zone.querySelector('.nc-of-sign')! as HTMLElement);
      const panel = zone.querySelector('.nc-of-zone-panel')!;
      expect(panel.textContent).toContain('general');
      expect(panel.textContent).toContain('ava');
      expect(panel.textContent).toContain('last active');
      const link = panel.querySelector('a.nc-of-link')!;
      expect(link.getAttribute('href')).toBe('https://example.com/c/general');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.textContent).toContain('open channel');

      // Same button toggles it shut again.
      await userEvent.click(zone.querySelector('.nc-of-sign')! as HTMLElement);
      expect(zone.querySelector('.nc-of-zone-panel')).toBeFalsy();
    });

    it('a zone with no permalink shows no link affordance', async () => {
      mockData(snapshot({ rooms: [room({ key: 'r1', permalink: null })] }));
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const zone = container.querySelector('.nc-obs-room[data-room-key="r1"]')!;
      await userEvent.click(zone.querySelector('.nc-of-sign')! as HTMLElement);
      expect(zone.querySelector('.nc-of-zone-panel')).toBeTruthy();
      expect(zone.querySelector('.nc-of-zone-panel a')).toBeFalsy();
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

    it('clicking a claim still highlights the agent that owns it', async () => {
      mockData(
        snapshot({
          claims: [claim({ slug: 'c1', owner: 'ava' })],
          agents: [agent({ id: 'ava', name: 'ava', location: null })],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await userEvent.click(container.querySelector('.nc-obs-claim-toggle')! as HTMLElement);
      expect(container.querySelector('.nc-obs-chip[data-agent-id="ava"]')!.className).toContain('highlighted');
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

    it('degrades quietly when the scheduled call fails, leaving the rest of the page intact', () => {
      mockData(snapshot({ rooms: [room({ key: 'r1' })] }), undefined, { error: new Error('500') });
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      expect(container.querySelector('.nc-of-sched-empty')!.textContent).toBe("couldn't load scheduled work");
      expect(container.querySelector('.nc-obs-room[data-room-key="r1"]')).toBeTruthy();
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
