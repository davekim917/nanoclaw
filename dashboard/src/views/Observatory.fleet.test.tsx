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

vi.mock('./ScheduledDrawer.js', () => ({ ScheduledDrawer: () => <div data-testid="sched-drawer" /> }));

import { Observatory, agentActivityLine } from './Observatory.js';
import useSWR from 'swr';
import type { ObservatoryAgent, ObservatoryRoom, ObservatorySnapshot, ScheduledSnapshot } from '../lib/api.js';

const mockAuthMe = { user_id: 'u1', scopes: { role: 'owner', allowed_group_ids: [], no_filter: true } };
const noop = () => {};
const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function room(over: Partial<ObservatoryRoom> = {}): ObservatoryRoom {
  return { key: 'r1', name: 'general', platform: 'slack', memberAgentIds: [], lastActivityAt: null, permalink: null, ...over };
}
function agent(over: Partial<ObservatoryAgent> = {}): ObservatoryAgent {
  return {
    id: 'ag-1', name: 'Nova', canonicalName: 'example-group-one', folder: 'example-group-one',
    provider: 'claude', awake: true, active: true, location: 'r1', lastSeenAt: hoursAgo(1),
    lastSessionId: null, holding: [], nextTask: null, avatarUrl: null, liveSession: null, ...over,
  };
}
function snapshot(over: Partial<ObservatorySnapshot> = {}): ObservatorySnapshot {
  return {
    workgroupId: 'wg-1', asOf: new Date(NOW).toISOString(), rooms: [room()], agents: [], claims: [],
    releaseState: null, ...over,
  };
}
const EMPTY_SCHED: ScheduledSnapshot = { rows: [], degraded: false, counts: {}, assembled_at: '' };

function mockData(snap: ObservatorySnapshot) {
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

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const view = () => render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);

describe('the fleet list', () => {
  it('shows the persona name as the label and never the infrastructure one', () => {
    mockData(snapshot({ agents: [agent()] }));
    const { container } = view();
    const row = container.querySelector('.tm-fleet-row[data-agent="ag-1"]')!;
    expect(row.querySelector('.tm-fleet-name')!.textContent).toBe('Nova');
    expect(row.textContent).not.toContain('example-group-one');
  });

  it('falls back to a neutral mark rather than an invented face, and requests no external image', () => {
    mockData(snapshot({ agents: [agent({ avatarUrl: null })] }));
    const { container } = view();
    const row = container.querySelector('.tm-fleet-row[data-agent="ag-1"]')!;
    expect(row.querySelector('img')).toBeNull();
    const mark = row.querySelector('[data-fallback="true"]')!;
    expect(mark).toBeTruthy();
    expect(mark.textContent).toBe('N');
  });

  it('uses the real platform avatar when there is one', () => {
    mockData(snapshot({ agents: [agent({ avatarUrl: 'https://example.invalid/a_72.png' })] }));
    const { container } = view();
    const img = container.querySelector('.tm-fleet-row img') as HTMLImageElement;
    // faceSrc rewrites the platform's size suffix; nothing else is touched.
    expect(img.getAttribute('src')).toBe('https://example.invalid/a_48.png');
    expect(container.querySelector('.tm-fleet-row [data-fallback="true"]')).toBeNull();
  });

  it('drops an avatar URL that is not a plain https or data image', () => {
    mockData(snapshot({ agents: [agent({ avatarUrl: 'javascript:alert(1)' })] }));
    const { container } = view();
    expect(container.querySelector('.tm-fleet-row img')).toBeNull();
    expect(container.querySelector('.tm-fleet-row [data-fallback="true"]')).toBeTruthy();
  });

  it('carries the agent state as a word and as a dot, from the same source the floor uses', () => {
    mockData(
      snapshot({
        agents: [agent({ id: 'ag-1', name: 'Nova', location: 'r1', active: true })],
        rooms: [room({ memberAgentIds: ['ag-1'] })],
      }),
    );
    const { container } = view();
    const row = container.querySelector('.tm-fleet-row[data-agent="ag-1"]')!;
    expect(row.querySelector('.tm-fleet-status')!.textContent).toBe('working');
    expect(row.querySelector('.tm-avatar-dot')!.getAttribute('data-status')).toBe('working');
  });

  it('says how many agents there are and how many are actually active', () => {
    mockData(
      snapshot({
        agents: [agent({ id: 'a', name: 'Nova' }), agent({ id: 'b', name: 'Vega', active: false, awake: true })],
      }),
    );
    const { container } = view();
    expect(container.querySelector('[data-section="fleet"] .tm-eyebrow')!.textContent).toBe(
      'Fleet — 2 agents · 1 active',
    );
  });

  it('renders an em dash rather than a zero when an agent has never been seen', () => {
    mockData(snapshot({ agents: [agent({ lastSeenAt: null })] }));
    const { container } = view();
    expect(container.querySelector('.tm-fleet-time')!.textContent).toBe('—');
  });

  it('opens the agent drawer from a fleet row, in the room the agent is seated in', async () => {
    mockData(snapshot({ agents: [agent({ location: 'r1' })], rooms: [room({ memberAgentIds: ['ag-1'] })] }));
    const { container } = view();
    expect(container.querySelector('[data-testid="agent-drawer"]')).toBeNull();
    await userEvent.click(container.querySelector('.tm-fleet-open')!);
    const drawer = container.querySelector('[data-testid="agent-drawer"]')!;
    expect(drawer).toBeTruthy();
    expect(drawer.querySelector('h3')!.textContent).toBe('Nova in #general');
  });

  it('gives every fleet row a 44px hit floor', () => {
    mockData(snapshot({ agents: [agent()] }));
    const { container } = view();
    expect(container.querySelector('.tm-fleet-open')!.className).toContain('tm-tap');
  });
});

describe('agentActivityLine', () => {
  const noRoom = () => null;
  const named = (key: string) => (key === 'r1' ? '#general' : null);

  it('leads with held work, because a claim is a promise and a thread is not', () => {
    expect(agentActivityLine(agent({ holding: ['work-1'] }), noRoom)).toBe('holding work-1');
    expect(agentActivityLine(agent({ holding: ['work-1', 'work-2', 'work-3'] }), noRoom)).toBe(
      'holding work-1 +2 more',
    );
  });

  it('names the live room, and says "last spoke" once the pulse has gone', () => {
    const live = { channelKey: 'r1', sessionId: 's', threadUrl: null, lastOutboundAt: null };
    expect(agentActivityLine(agent({ liveSession: live, active: true }), named)).toBe('live in #general');
    expect(agentActivityLine(agent({ liveSession: live, active: false }), named)).toBe('last spoke in #general');
    // A room this floor does not show is not named — it is not invented either.
    expect(agentActivityLine(agent({ liveSession: live, active: true }), noRoom)).toBe('live in a thread');
  });

  it('says nothing is happening rather than calling an awake container busy', () => {
    expect(agentActivityLine(agent({ awake: true, active: true, liveSession: null }), named)).toBe('no active task');
  });
});
