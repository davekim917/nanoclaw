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
  nudgeClaim: vi.fn(),
  steerWork: vi.fn(),
  getIssueBrief: vi.fn(),
  getSessionDetail: vi.fn(),
}));

vi.mock('./ScheduledDrawer.js', () => ({
  ScheduledDrawer: () => <div data-testid="sched-drawer" />,
}));

import { Observatory } from './Observatory.js';
import { NAV_ITEMS } from './AppNav.js';
import useSWR from 'swr';
import { assignItem, nudgeClaim } from '../lib/api.js';
import type {
  ObservatoryAgent,
  ObservatoryClaim,
  ObservatoryRoom,
  ObservatorySnapshot,
  ReleaseItem,
  ScheduledSnapshot,
} from '../lib/api.js';

const mockAuthMe = { user_id: 'u1', scopes: { role: 'owner', allowed_group_ids: [], no_filter: true } };
const noop = () => {};

// Fixed timestamps — never the wall clock.
const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function room(over: Partial<ObservatoryRoom> = {}): ObservatoryRoom {
  return { key: 'r1', name: 'general', platform: 'slack', memberAgentIds: [], lastActivityAt: null, permalink: null, ...over };
}
function agent(over: Partial<ObservatoryAgent> = {}): ObservatoryAgent {
  return {
    id: 'ava', name: 'ava', canonicalName: 'ava-agent', folder: 'ava', provider: 'claude',
    awake: true, active: true, location: null, lastSeenAt: hoursAgo(2), lastSessionId: null,
    holding: [], nextTask: null, avatarUrl: null, liveSession: null, ...over,
  };
}
function claim(over: Partial<ObservatoryClaim> = {}): ObservatoryClaim {
  return {
    slug: 'c1', owner: 'ava', note: 'doing a thing', state: 'live', staleMs: 0,
    threadId: null, threadUrl: null, sessionId: null, escalated: false, ...over,
  };
}
function releaseItem(over: Partial<ReleaseItem> = {}): ReleaseItem {
  return { id: 'B#1', kind: 'pr', title: 'some pr', nextMover: 'human', ...over };
}
function snapshot(over: Partial<ObservatorySnapshot> = {}): ObservatorySnapshot {
  return {
    workgroupId: 'wg-1', asOf: new Date(NOW).toISOString(), rooms: [], agents: [], claims: [],
    releaseState: null, ...over,
  };
}

const EMPTY_SCHED: ScheduledSnapshot = { rows: [], degraded: false, counts: {}, assembled_at: '' };

function mockData(snap: ObservatorySnapshot | undefined) {
  vi.mocked(useSWR).mockImplementation((key: unknown) => {
    if (typeof key === 'string' && key.includes('/workgroups')) {
      return { data: { workgroups: [{ id: 'wg-1', name: 'Example Workgroup' }] }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>;
    }
    if (typeof key === 'string' && key.includes('/scheduled')) {
      return { data: EMPTY_SCHED, error: undefined, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>;
    }
    return { data: snap, error: undefined, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>;
  });
}

/** The one viewport switch the shell reads. */
function viewport(isMobile: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: isMobile,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  viewport(false);
  // jsdom has no rAF scheduling worth waiting on, and no layout to scroll.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('scrollTo', vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const view = () => render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);

describe('the exception feed', () => {
  it('renders an explicit all-clear when nothing needs a person, and no cards', () => {
    mockData(snapshot({ agents: [agent()], claims: [claim()] }));
    const { container } = view();
    expect(container.querySelector('[data-testid="exceptions-all-clear"]')).toBeTruthy();
    expect(container.querySelectorAll('.tm-exc')).toHaveLength(0);
  });

  it('renders one card per exception, worst first, with its severity on the card', () => {
    mockData(
      snapshot({
        rooms: [room()],
        claims: [claim({ slug: 'stuck', state: 'stale', staleMs: 9 * 3_600_000, threadId: 'slack:r1:9' })],
        releaseState: {
          asOf: new Date(NOW).toISOString(),
          items: [
            releaseItem({ id: 'B#2', nextMover: 'agent', meta: { bucket: 'decision' }, channel: '#general' }),
            releaseItem({ id: 'B#1', nextMover: 'human', since: hoursAgo(3), url: 'https://example.invalid/1' }),
          ],
        },
      }),
    );
    const { container } = view();
    expect(container.querySelector('[data-testid="exceptions-all-clear"]')).toBeNull();
    expect(Array.from(container.querySelectorAll('.tm-exc')).map((c) => c.getAttribute('data-severity'))).toEqual([
      'hands',
      'decision',
      'parked',
    ]);
    // The feed sits above the floor and everything else on the page.
    const feed = container.querySelector('[data-section="exceptions"]')!;
    const floor = container.querySelector('.nc-of-left')!;
    expect(feed.compareDocumentPosition(floor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders an em dash rather than an invented age when the item carries no timestamp', () => {
    mockData(
      snapshot({
        releaseState: { asOf: new Date(NOW).toISOString(), items: [releaseItem({ id: 'B#1', nextMover: 'human' })] },
      }),
    );
    const { container } = view();
    expect(container.querySelector('.tm-exc .tm-exc-meta')!.textContent).toBe('—');
  });

  it('sends a card action to the existing endpoint, with that row’s own ids', async () => {
    mockData(
      snapshot({
        rooms: [room({ key: 'r1', name: 'general', memberAgentIds: ['ava'] })],
        agents: [agent()],
        claims: [
          claim({
            slug: 'stuck',
            state: 'stale',
            staleMs: 9 * 3_600_000,
            threadId: 'slack:r1:9',
            threadUrl: 'https://example.invalid/t/9',
          }),
        ],
        releaseState: {
          asOf: new Date(NOW).toISOString(),
          items: [releaseItem({ id: 'B#2', nextMover: 'agent', meta: { bucket: 'decision' }, channel: 'general' })],
        },
      }),
    );
    vi.mocked(assignItem).mockResolvedValue({ ok: true, seriesId: null, channel: 'general', agent: 'ava' });
    vi.mocked(nudgeClaim).mockResolvedValue({ ok: true, seriesId: null, threadUrl: null });
    const { container } = view();

    const decisionCard = container.querySelector('.tm-exc[data-exception="B#2"]')!;
    await userEvent.selectOptions(decisionCard.querySelector('.nc-obs-actions-who')!, 'ava');
    await userEvent.click(
      Array.from(decisionCard.querySelectorAll('button')).find((b) => b.textContent?.includes('task it in'))!,
    );
    expect(assignItem).toHaveBeenCalledWith('wg-1', 'B#2', 'ava');

    const claimCard = container.querySelector('.tm-exc[data-exception="stuck"]')!;
    await userEvent.selectOptions(claimCard.querySelector('.nc-obs-actions-who')!, 'ava');
    await userEvent.click(
      Array.from(claimCard.querySelectorAll('button')).find((b) => b.textContent === 'push it forward')!,
    );
    expect(nudgeClaim).toHaveBeenCalledWith('wg-1', 'stuck', 'ava');
  });

  it('offers a blocked agent its drawer, and disables the button with a reason when there is nothing live to steer', async () => {
    const stalled = releaseItem({ id: 'B#5', nextMover: 'agent', owner: 'ava', dueAt: hoursAgo(9), channel: 'general' });
    mockData(
      snapshot({
        rooms: [room({ key: 'r1', name: 'general', memberAgentIds: ['ava'] })],
        agents: [agent({ location: 'r1' })],
        releaseState: { asOf: new Date(NOW).toISOString(), items: [stalled] },
      }),
    );
    const { container } = view();
    const button = container.querySelector('.tm-exc[data-exception="ava"] [data-action="steer"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('no live session to steer into');
    expect(container.querySelector('[data-testid="agent-drawer"]')).toBeNull();
  });

  it('opens the agent drawer when the agent does have a live session', async () => {
    const stalled = releaseItem({ id: 'B#5', nextMover: 'agent', owner: 'ava', dueAt: hoursAgo(9), channel: 'general' });
    mockData(
      snapshot({
        rooms: [room({ key: 'r1', name: 'general', memberAgentIds: ['ava'] })],
        agents: [
          agent({ location: 'r1', liveSession: { channelKey: 'r1', sessionId: 's-9', threadUrl: null, lastOutboundAt: null } }),
        ],
        releaseState: { asOf: new Date(NOW).toISOString(), items: [stalled] },
      }),
    );
    const { container } = view();
    const button = container.querySelector('.tm-exc[data-exception="ava"] [data-action="steer"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await userEvent.click(button);
    expect(container.querySelector('[data-testid="agent-drawer"]')).toBeTruthy();
  });
});

describe('room signals on the floor', () => {
  const floorWith = (signals?: ObservatorySnapshot['signals']) =>
    mockData(
      snapshot({
        rooms: [room({ key: 'r1', name: 'one' }), room({ key: 'r2', name: 'two' })],
        ...(signals ? { signals } : {}),
      }),
    );

  it('draws smoke in the room whose signal is live, and nowhere else', () => {
    floorWith([
      { room: 'r2', vignette: 'smoke', active: true },
      { room: 'r1', vignette: 'smoke', active: false },
    ]);
    const { container } = view();
    expect(container.querySelectorAll('[data-vignette="smoke"]')).toHaveLength(1);
    expect(container.querySelector('[data-room="r2"] [data-vignette="smoke"]')).toBeTruthy();
    expect(container.querySelector('[data-room="r1"] [data-vignette="smoke"]')).toBeNull();
  });

  it('draws nothing when every bound room is quiet, and nothing when nothing is bound', () => {
    floorWith([{ room: 'r2', vignette: 'smoke', active: false }]);
    const quiet = view();
    expect(quiet.container.querySelectorAll('[data-vignette="smoke"]')).toHaveLength(0);
    quiet.unmount();

    floorWith();
    const unbound = view();
    expect(unbound.container.querySelectorAll('[data-vignette="smoke"]')).toHaveLength(0);
  });

  it('ignores a live signal naming a room this floor does not have', () => {
    floorWith([{ room: 'not-a-room-here', vignette: 'smoke', active: true }]);
    const { container } = view();
    expect(container.querySelector('[data-testid="floor-plan"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-vignette="smoke"]')).toHaveLength(0);
  });
});

describe('the shell nav', () => {
  const populated = () =>
    mockData(
      snapshot({
        rooms: [room()],
        agents: [agent()],
        releaseState: { asOf: new Date(NOW).toISOString(), items: [releaseItem({ since: hoursAgo(1) })] },
      }),
    );

  it('is a bottom tab bar on a phone, carrying the four destinations, Overview active', () => {
    viewport(true);
    populated();
    const { container } = view();
    const bar = container.querySelector('[data-testid="app-tabbar"]')!;
    expect(bar).toBeTruthy();
    expect(container.querySelector('[data-testid="app-sidebar"]')).toBeNull();
    expect(Array.from(bar.querySelectorAll('button')).map((b) => b.getAttribute('data-nav'))).toEqual(
      NAV_ITEMS.map((i) => i.key),
    );
    expect(bar.querySelector('[data-nav="overview"]')!.getAttribute('aria-current')).toBe('page');
    expect(bar.querySelector('[data-nav="office"]')!.getAttribute('aria-current')).toBeNull();
    // The fixed bar must not sit on top of the last row of the page.
    expect(container.querySelector('.nc-frame')!.className).toContain('tm-has-tabbar');
  });

  it('is a sidebar on a desktop, with the same four destinations and no tab bar', () => {
    populated();
    const { container } = view();
    const side = container.querySelector('[data-testid="app-sidebar"]')!;
    expect(side).toBeTruthy();
    expect(container.querySelector('[data-testid="app-tabbar"]')).toBeNull();
    expect(Array.from(side.querySelectorAll('button')).map((b) => b.getAttribute('data-nav'))).toEqual(
      NAV_ITEMS.map((i) => i.key),
    );
    expect(side.textContent).toContain('Example Workgroup');
  });

  it('moves the active state, and leaves the page for the inbox rather than faking one', async () => {
    populated();
    const onRouteChange = vi.fn();
    const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={onRouteChange} />);
    const side = container.querySelector('[data-testid="app-sidebar"]')!;

    await userEvent.click(side.querySelector('[data-nav="office"]')!);
    expect(side.querySelector('[data-nav="office"]')!.getAttribute('aria-current')).toBe('page');
    expect(side.querySelector('[data-nav="overview"]')!.getAttribute('aria-current')).toBeNull();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    // Scheduled lives under the job board, so going there switches the view.
    await userEvent.click(side.querySelector('[data-nav="scheduled"]')!);
    expect(container.querySelector('[data-section="schedule"]')).toBeTruthy();

    await userEvent.click(side.querySelector('[data-nav="inbox"]')!);
    expect(onRouteChange).toHaveBeenCalledWith('inbox');
  });
});

describe('touch targets', () => {
  it('gives every exception-card action and every nav destination a 44px floor', () => {
    viewport(true);
    mockData(
      snapshot({
        rooms: [room()],
        releaseState: {
          asOf: new Date(NOW).toISOString(),
          items: [releaseItem({ id: 'B#1', nextMover: 'human', url: 'https://example.invalid/1', since: hoursAgo(1) })],
        },
      }),
    );
    const { container } = view();
    const targets = Array.from(
      container.querySelectorAll('.tm-exc-actions .tm-btn, [data-testid="app-tabbar"] button'),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t.className).toContain('tm-tap');
  });
});
