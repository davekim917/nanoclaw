import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('swr', () => {
  const mutate = vi.fn();
  const useSWR = vi.fn(() => ({ data: undefined, mutate }));
  return { default: useSWR };
});

vi.mock('../lib/sse.ts', () => {
  const handlers: Map<string, Set<(p: unknown) => void>> = new Map();
  return {
    subscribe: vi.fn((kind: string, handler: (p: unknown) => void) => {
      if (!handlers.has(kind)) handlers.set(kind, new Set());
      handlers.get(kind)!.add(handler);
      return () => handlers.get(kind)?.delete(handler);
    }),
    startSSE: vi.fn(),
    __emitEvent: (kind: string, payload: unknown) => {
      for (const h of handlers.get(kind) ?? []) h(payload);
    },
  };
});

vi.mock('../lib/api.js', () => ({
  listScheduled: vi.fn(),
  listGroups: vi.fn().mockResolvedValue({ groups: [] }),
}));

// The drawer is exercised in its own test file; stub it here so a row click
// only has to flip open state we can observe via a data attribute.
vi.mock('./ScheduledDrawer.js', () => ({
  ScheduledDrawer: ({ rowKey, onClose }: { rowKey: string; onClose: () => void }) => (
    <div data-testid="drawer" data-row-key={rowKey}>
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

import { ScheduledBoard, filterRows } from './ScheduledBoard.js';
import useSWR from 'swr';
import type { ScheduledRow, ScheduledSnapshot } from '../lib/api.js';

const mockAuthMe = {
  user_id: 'u1',
  scopes: { role: 'owner', allowed_group_ids: [], no_filter: true },
};
const noop = () => {};

function stubViewport(mobile: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: mobile && /max-width:\s*899px/.test(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function row(overrides: Partial<ScheduledRow> = {}): ScheduledRow {
  return {
    key: 'K-' + (overrides.series_id ?? 'S'),
    series_id: 'S',
    agent_group_id: 'ag-1',
    agent_group_name: 'Example Agent',
    provider: 'claude',
    channel_name: '#general',
    channel_type: 'discord',
    thread_id: null,
    kind: 'recurring',
    cron: '0 9 * * *',
    next_fire_utc: '2026-06-14T09:00:00Z',
    next_fire_local: '2026-06-14 02:00 PDT',
    health: 'healthy',
    module_owner: null,
    quiet_status: false,
    flag_intent: null,
    script_host: false,
    last_fires: [],
    available_verbs: ['edit', 'pause', 'cancel'],
    ...overrides,
  };
}

function snapshot(rows: ScheduledRow[], extra: Partial<ScheduledSnapshot> = {}): ScheduledSnapshot {
  return {
    rows,
    degraded: false,
    counts: {},
    assembled_at: '2026-06-13T00:00:00Z',
    ...extra,
  };
}

function mockData(snap: ScheduledSnapshot, mutate = vi.fn()) {
  vi.mocked(useSWR).mockImplementation((key: unknown) => {
    // The groups key is a bare string; the scheduled key is a tuple.
    if (typeof key === 'string' && key.includes('groups')) {
      return { data: { groups: [] }, mutate } as unknown as ReturnType<typeof useSWR>;
    }
    return { data: snap, mutate } as unknown as ReturnType<typeof useSWR>;
  });
}

describe('ScheduledBoard', () => {
  beforeEach(() => stubViewport(false));
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // ─── E1 — health strip ───

  it('test_strip_renders_counts: strip shows each health count', () => {
    mockData(
      snapshot([], {
        counts: { stalled: 1, late: 2, healthy: 5, unknown: 1, unreadable: 1, paused: 0, one_off: 0 },
      }),
    );
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    const strip = container.querySelector('.nc-sched-strip')!;
    expect(strip).toBeTruthy();
    // distinct unknown and unreadable counts both present (S14)
    const unknownCell = strip.querySelector('.nc-sched-pill.unknown .n')!;
    const unreadableCell = strip.querySelector('.nc-sched-pill.unreadable .n')!;
    expect(unknownCell.textContent).toBe('1');
    expect(unreadableCell.textContent).toBe('1');
    expect(strip.querySelector('.nc-sched-pill.stalled .n')!.textContent).toBe('1');
    expect(strip.querySelector('.nc-sched-pill.healthy .n')!.textContent).toBe('5');
  });

  it('test_unhealthy_sorted_first: stalled appears before healthy in the list', () => {
    mockData(
      snapshot([
        row({ series_id: 'healthy-1', health: 'healthy', cron: '0 9 * * *' }),
        row({ series_id: 'stalled-1', health: 'stalled', cron: '0 10 * * *' }),
      ]),
    );
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    const rowEls = Array.from(container.querySelectorAll('.nc-sched-row'));
    const keys = rowEls.map((el) => el.getAttribute('data-series-id'));
    expect(keys.indexOf('stalled-1')).toBeLessThan(keys.indexOf('healthy-1'));
  });

  it('test_stalled_enumerated_inline_first: stalled rows are listed in the strip, ahead of the sections', () => {
    mockData(
      snapshot([row({ series_id: 'stalled-77', health: 'stalled' })], {
        counts: { stalled: 1 },
      }),
    );
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    const stalledList = container.querySelector('.nc-sched-stalled-inline')!;
    expect(stalledList).toBeTruthy();
    expect(within(stalledList as HTMLElement).getByText(/stalled-77|S/)).toBeTruthy();
  });

  it('test_degraded_indicator: degraded:true renders a degraded indicator', () => {
    mockData(snapshot([], { degraded: true }));
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    expect(container.querySelector('.nc-sched-degraded')).toBeTruthy();
  });

  it('does not render a degraded indicator when degraded:false', () => {
    mockData(snapshot([], { degraded: false }));
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    expect(container.querySelector('.nc-sched-degraded')).toBeNull();
  });

  it('test_synthetic_repair_rows_in_stalled: move_restore_failed health renders in the stalled section', () => {
    mockData(
      snapshot([row({ series_id: 'repair-1', health: 'stalled', available_verbs: ['cancel'] })]),
    );
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    // A stalled row is present in the body and surfaced inline at the top.
    expect(container.querySelector('.nc-sched-row[data-series-id="repair-1"]')).toBeTruthy();
    expect(container.querySelector('.nc-sched-stalled-inline')).toBeTruthy();
  });

  // ─── E2 — grouped list ───

  it('test_row_shows_utc_and_local: a row renders both UTC and service-local next fire', () => {
    mockData(
      snapshot([
        row({
          series_id: 'dual',
          next_fire_utc: '2026-06-14T09:00:00Z',
          next_fire_local: '2026-06-14 02:00 PDT',
        }),
      ]),
    );
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    const rowEl = container.querySelector('.nc-sched-row[data-series-id="dual"]')!;
    expect(rowEl.textContent).toContain('2026-06-14T09:00:00Z');
    expect(rowEl.textContent).toContain('2026-06-14 02:00 PDT');
  });

  it('test_module_badge_rendered: module_owner set → owner badge visible', () => {
    mockData(snapshot([row({ series_id: 'mod', module_owner: 'memory' })]));
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    const rowEl = container.querySelector('.nc-sched-row[data-series-id="mod"]')!;
    const badge = rowEl.querySelector('.nc-sched-badge.module')!;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('memory');
  });

  it('renders a thread-bound badge for thread_loop rows', () => {
    mockData(snapshot([row({ series_id: 'tl', kind: 'thread_loop' })]));
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    const rowEl = container.querySelector('.nc-sched-row[data-series-id="tl"]')!;
    expect(rowEl.querySelector('.nc-sched-badge.thread')).toBeTruthy();
  });

  it('test_row_click_opens_drawer: clicking a row opens the drawer with that row key', async () => {
    mockData(snapshot([row({ series_id: 'click', key: 'KEY-CLICK' })]));
    render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    const rowEl = document.querySelector('.nc-sched-row[data-series-id="click"]') as HTMLElement;
    await userEvent.click(rowEl);
    const drawer = screen.getByTestId('drawer');
    expect(drawer.getAttribute('data-row-key')).toBe('KEY-CLICK');
  });

  it('groups rows under collapsible agent-group sections', () => {
    mockData(
      snapshot([
        row({ series_id: 'a1', agent_group_id: 'ag-1', agent_group_name: 'Example Agent' }),
        row({ series_id: 'b1', agent_group_id: 'ag-2', agent_group_name: 'Example Assistant' }),
      ]),
    );
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    const sections = container.querySelectorAll('.nc-sched-section');
    expect(sections.length).toBe(2);
  });

  // ─── E3 — filters + search ───

  it('test_ownership_filter_module: ownership=module shows only module rows', async () => {
    mockData(
      snapshot([
        row({ series_id: 'op', module_owner: null }),
        row({ series_id: 'mo', module_owner: 'memory' }),
      ]),
    );
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    await userEvent.selectOptions(container.querySelector('select.nc-sched-ownership')!, 'module');
    expect(container.querySelector('.nc-sched-row[data-series-id="mo"]')).toBeTruthy();
    expect(container.querySelector('.nc-sched-row[data-series-id="op"]')).toBeNull();
  });

  it('test_health_filter_stalled: health=stalled shows only stalled rows', async () => {
    mockData(
      snapshot([
        row({ series_id: 'h', health: 'healthy' }),
        row({ series_id: 's', health: 'stalled' }),
      ]),
    );
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    await userEvent.selectOptions(container.querySelector('select.nc-sched-health')!, 'stalled');
    expect(container.querySelector('.nc-sched-row[data-series-id="s"]')).toBeTruthy();
    expect(container.querySelector('.nc-sched-row[data-series-id="h"]')).toBeNull();
  });

  it('test_search_matches_on_row_fields_instantly: name/series_id filter with zero latency', async () => {
    // The INSTANT client haystack path (name/group/channel/cron). Prompt/script
    // search is server-side (covered by filterRows unit tests + the search
    // endpoint tests) and unions in via promptMatchKeys; this asserts the
    // zero-latency on-row match that needs no round-trip.
    mockData(
      snapshot([
        row({ series_id: 'morning-briefing', agent_group_name: 'Example Agent' }),
        row({ series_id: 'nightly-synth', agent_group_name: 'Example Agent' }),
      ]),
    );
    const { container } = render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    await userEvent.type(container.querySelector('input.nc-sched-search')!, 'briefing');
    await waitFor(() =>
      expect(container.querySelector('.nc-sched-row[data-series-id="morning-briefing"]')).toBeTruthy(),
    );
    expect(container.querySelector('.nc-sched-row[data-series-id="nightly-synth"]')).toBeNull();
  });

  // ─── SWR + SSE wiring ───

  it('subscribes to session_event and invalidates on emit (debounced)', async () => {
    const mutate = vi.fn();
    mockData(snapshot([]), mutate);
    render(<ScheduledBoard authMe={mockAuthMe} route="scheduled" onRouteChange={noop} />);
    const sseModule = await import('../lib/sse.ts');
    const emitEvent = (sseModule as unknown as { __emitEvent: (k: string, p: unknown) => void }).__emitEvent;
    emitEvent('session_event', { kind: 'inbound' });
    emitEvent('session_event', { kind: 'outbound' });
    emitEvent('session_event', { kind: 'container_state' });
    await waitFor(() => expect(mutate).toHaveBeenCalled(), { timeout: 1000 });
    expect(mutate.mock.calls.length).toBe(1);
  });
});

// ── filterRows — prompt/title search union (pure unit) ───────────────────────
describe('filterRows — prompt/title search', () => {
  it('test_filterrows_includes_prompt_match_key_when_on_row_haystack_misses', () => {
    const rows = [
      row({ series_id: 'morning-brief', key: 'K1', agent_group_name: 'Example Agent', channel_name: '#ops', cron: '0 9 * * *' }),
      row({ series_id: 'nightly-synth', key: 'K2', agent_group_name: 'Example Agent', channel_name: '#ops', cron: '0 22 * * *' }),
    ];
    // 'zebra' matches NEITHER row's on-row fields; the server reports K1 matches
    // (its prompt body contains zebra). K1 is included via promptMatchKeys; K2 not.
    const out = filterRows(rows, { ownership: 'all', health: 'all', search: 'zebra', promptMatchKeys: new Set(['K1']) });
    expect(out.map((r) => r.key)).toEqual(['K1']);
  });

  it('test_filterrows_on_row_match_works_without_server_keys', () => {
    const rows = [row({ series_id: 'morning-brief', key: 'K1' }), row({ series_id: 'nightly', key: 'K2' })];
    // No promptMatchKeys (search endpoint hasn't resolved) — the on-row haystack
    // still matches 'morning' instantly. Graceful degradation, not a hard dep.
    const out = filterRows(rows, { ownership: 'all', health: 'all', search: 'morning' });
    expect(out.map((r) => r.key)).toEqual(['K1']);
  });

  it('test_filterrows_excludes_rows_matching_neither_haystack_nor_keys', () => {
    const rows = [row({ series_id: 'alpha', key: 'K1' }), row({ series_id: 'beta', key: 'K2' })];
    const out = filterRows(rows, { ownership: 'all', health: 'all', search: 'zzz', promptMatchKeys: new Set(['K9']) });
    expect(out).toEqual([]);
  });

  it('test_filterrows_prompt_match_still_respects_ownership_and_health_facets', () => {
    // A prompt match must NOT resurrect a row excluded by a facet — the facet
    // checks run before the search clause, so the union can't bypass them.
    const rows = [row({ series_id: 'x', key: 'K1', module_owner: 'memory', health: 'healthy' })];
    const out = filterRows(rows, {
      ownership: 'operator', // K1 is module-owned → excluded by the ownership facet
      health: 'all',
      search: 'zebra',
      promptMatchKeys: new Set(['K1']),
    });
    expect(out).toEqual([]);
  });
});
