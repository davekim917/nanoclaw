import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
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

// The drawer is exercised by its own suite; here we only care that the floor
// opens it with the right row key.
vi.mock('./ScheduledDrawer.js', () => ({
  ScheduledDrawer: ({ rowKey }: { rowKey: string }) => <div data-testid="sched-drawer">drawer:{rowKey}</div>,
}));

import {
  Observatory,
  upcomingScheduled,
  decisionRows,
  shipInstruction,
  shipAddressee,
  _resetBriefCacheForTesting,
} from './Observatory.js';
import { buildLedger } from './commitments.js';
import { RouteNav } from './BoardShell.js';
import useSWR from 'swr';
import { assignItem, getIssueBrief, getSessionDetail, steerWork } from '../lib/api.js';
import type {
  ObservatoryRoom,
  ObservatoryAgent,
  ObservatoryClaim,
  ObservatorySnapshot,
  ReleaseItem,
  ReleaseState,
  ScheduledRow,
  ScheduledSnapshot,
  SessionDetailResponse,
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
    active: true,
    location: null,
    lastSeenAt: new Date().toISOString(),
    lastSessionId: null,
    holding: [],
    nextTask: null,
    avatarUrl: null,
    liveSession: null,
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
    sessionId: null,
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
async function segment(c: HTMLElement, view: 'overview' | 'decisions' | 'board') {
  await userEvent.click(c.querySelector(`.nc-of-seg-btn[data-view="${view}"]`)! as HTMLElement);
}


// ── Split from Observatory.test.tsx on 2026-08-18 ────────────────────────────
// One file's ~119 full-page jsdom renders outgrew a single vitest worker's
// heap (OOM at ~95 renders; jsdom retains across tests). Vitest gives each
// FILE a fresh worker, so the render-heavy action/drawer/decisions suites live
// here. Same harness on both sides — if you change a fixture, change both.

describe('Observatory — actions and sheets', () => {
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
    _resetBriefCacheForTesting();
  });

  describe('the decisions view', () => {
    const mockSteer = vi.mocked(steerWork);

    // One of each shape the real board publishes: a release blocker, an
    // ordinary ship instruction, a prose-only ask, and an item no person owes.
    const decisions = () => [
      releaseItem({
        id: 'XZO#912',
        title: 'ready to ship',
        nextMover: 'human',
        owner: 'kit',
        channel: '#dispatch',
        nextAction: 'kit or robin records @ava ship 912 -- ready, ships on a human word',
      }),
      releaseItem({
        id: 'XZO#804',
        title: 'the blocker',
        nextMover: 'human',
        owner: 'robin',
        channel: '#dispatch',
        blocksRelease: true,
        nextAction: 'robin picks accept-as-is vs. authenticated-endpoint -- stalled 21h',
      }),
      releaseItem({ id: 'XZO#7', title: 'an agent is on it', nextMover: 'agent', owner: 'ava', channel: '#dispatch' }),
    ];
    const open = async (items: ReleaseItem[] = decisions()) => {
      mockData(
        snapshot({
          agents: [agent({ id: 'ag-ava', name: 'ava' })],
          releaseState: releaseState({ items }),
        }),
      );
      const r = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await segment(r.container, 'decisions');
      return r;
    };
    const ids = (c: HTMLElement) =>
      Array.from(c.querySelectorAll('[data-section="decisions"] .nc-obs-ledger-row')).map((r) =>
        r.getAttribute('data-ledger-id'),
      );
    const expandRow = async (c: HTMLElement, id: string) =>
      userEvent.click(c.querySelector(`[data-ledger-id="${id}"] .nc-obs-ledger-btn`)! as HTMLElement);
    const composer = (c: HTMLElement) => c.querySelector('.nc-obs-steer textarea') as HTMLTextAreaElement | null;

    it('shows only human-mover items, in the ledger order — the blocker leads', async () => {
      const { container } = await open();
      expect(ids(container)).toEqual(['XZO#804', 'XZO#912']);
      // The segment states the same count it is showing.
      expect(container.querySelector('.nc-of-seg-btn[data-view="decisions"] .nc-of-tab-n')!.textContent).toBe('2');
      expect(container.querySelector('.nc-of-bar-count')!.textContent).toBe('2 awaiting a person');
    });

    it('states the ask on the row, before anything is expanded', async () => {
      const { container } = await open();
      expect(
        Array.from(container.querySelectorAll('.nc-obs-decide-ask')).map((e) => e.textContent),
      ).toEqual([
        'robin picks accept-as-is vs. authenticated-endpoint -- stalled 21h',
        'kit or robin records @ava ship 912 -- ready, ships on a human word',
      ]);
      // And is not then repeated inside the row it already sits above.
      await expandRow(container, 'XZO#912');
      expect(container.querySelector('.nc-obs-ledger-next')).toBeFalsy();
    });

    it('expanding prefills the composer with the instruction alone, not the prose around it', async () => {
      const { container } = await open();
      await expandRow(container, 'XZO#912');
      expect(composer(container)!.value).toBe('@ava ship 912');
    });

    it('an ask with no instruction to relay opens an empty box rather than a paraphrase', async () => {
      const { container } = await open();
      await expandRow(container, 'XZO#804');
      expect(composer(container)!.value).toBe('');
    });

    it('a chip fills the box and nothing else — the send is still a separate press', async () => {
      mockSteer.mockResolvedValue({ ok: true, seriesId: 's7', threadUrl: null });
      const { container } = await open();
      await expandRow(container, 'XZO#804');
      await userEvent.click(container.querySelector('[data-chip="approve as proposed"]')! as HTMLElement);
      expect(composer(container)!.value).toBe('approve as proposed');
      expect(mockSteer).not.toHaveBeenCalled();

      // "no" is left mid-sentence for the operator to finish.
      await userEvent.click(container.querySelector('[data-chip="no — …"]')! as HTMLElement);
      expect(composer(container)!.value).toBe('no — ');

      await userEvent.selectOptions(container.querySelector('.nc-obs-actions-who')! as HTMLElement, 'ag-ava');
      await userEvent.click(
        Array.from(container.querySelectorAll('.nc-obs-steer button')).find((x) => x.textContent === 'send')! as HTMLElement,
      );
      expect(mockSteer).toHaveBeenCalledWith('wg-1', { itemId: 'XZO#804' }, 'ag-ava', 'no —', '#dispatch');
    });

    it('a member gets the row and no prefilled box — the composer is still gated', async () => {
      mockData(
        snapshot({
          agents: [agent({ id: 'ag-ava', name: 'ava' })],
          releaseState: releaseState({ items: decisions() }),
        }),
      );
      const memberMe = { user_id: 'u2', scopes: { role: 'member', allowed_group_ids: [], no_filter: false } };
      const { container } = render(<Observatory authMe={memberMe} route="observatory" onRouteChange={noop} />);
      await segment(container, 'decisions');
      await expandRow(container, 'XZO#912');
      expect(container.querySelector('.nc-obs-decide-ask')).toBeTruthy();
      expect(composer(container)).toBeFalsy();
    });

    it('says so plainly when nothing is waiting on a person', async () => {
      const { container } = await open([
        releaseItem({ id: 'XZO#7', title: 'an agent is on it', nextMover: 'agent', owner: 'ava' }),
      ]);
      expect(container.querySelector('[data-section="decisions"] .nc-obs-ledger-empty')!.textContent).toBe(
        'nothing needs a human right now',
      );
      expect(container.querySelector('.nc-of-seg-btn[data-view="decisions"] .nc-of-tab-n')!.textContent).toBe('0');
    });

    it('shipInstruction: the relayable words only, across the shapes the board writes', () => {
      expect(shipInstruction('kit/robin record @nova ship 869; ava presses the merge')).toBe('@nova ship 869');
      expect(shipInstruction('robin records @nova ship pipeline 23 -- mechanically ready')).toBe(
        '@nova ship pipeline 23',
      );
      expect(shipInstruction('robin or kit answers/acts -- see why')).toBeNull();
      expect(shipInstruction(undefined)).toBeNull();
    });

    // obs.D.2 → obs.D.4 — the board named an exact instruction, so the row
    // offers it as ONE CLICK that sends (operator ruling, 2026-08-18: "clicking
    // should be 1 click instead of it opening up the row and having to click
    // send again"). The addressee must resolve for the button to fire; an
    // unresolvable handle opens the row instead.
    const shipBtn = (c: HTMLElement, id: string) =>
      c.querySelector(`[data-ledger-id="${id}"] .nc-obs-ship`) as HTMLElement | null;

    it('offers the instruction as a button, and only where one parses', async () => {
      const { container } = await open();
      expect(shipBtn(container, 'XZO#912')!.textContent).toBe('send: @ava ship 912');
      // Prose-only ask — nothing to relay, so nothing to one-tap.
      expect(shipBtn(container, 'XZO#804')).toBeFalsy();
    });

    it('one click sends ids and the exact text through the same steer endpoint', async () => {
      mockSteer.mockResolvedValue({ ok: true, seriesId: 's7', threadUrl: 'https://example.com/t/1' });
      const { container } = await open();
      await userEvent.click(shipBtn(container, 'XZO#912')!);
      expect(mockSteer).toHaveBeenCalledWith('wg-1', { itemId: 'XZO#912' }, 'ag-ava', '@ava ship 912', '#dispatch');
      // The click reports its result in place — sent note + thread link — and
      // the button is gone so it cannot double-fire.
      expect(container.querySelector('[data-ledger-id="XZO#912"] .nc-obs-actions-done')!.textContent).toContain(
        'sent — ava was asked in the thread',
      );
      expect(shipBtn(container, 'XZO#912')).toBeFalsy();
      // One click means SENT, not opened: no composer appeared.
      expect(composer(container)).toBeFalsy();
    });

    it('a failed send says so on the row and keeps the button for a retry', async () => {
      mockSteer.mockRejectedValue(new Error('boom'));
      const { container } = await open();
      await userEvent.click(shipBtn(container, 'XZO#912')!);
      expect(container.querySelector('[data-ledger-id="XZO#912"] .nc-obs-actions-err')).toBeTruthy();
      expect(shipBtn(container, 'XZO#912')).toBeTruthy();
    });

    it('expanding a row reads the linked issue: body, labels, and the latest comments', async () => {
      vi.mocked(getIssueBrief).mockResolvedValue({
        state: 'open',
        labels: ['needs-product-decision', 'p2'],
        body: 'QA saw Brand Executive read as national. Expected: tier from tenant config, not display name.',
        bodyTruncated: false,
        comments: [{ author: 'desk', at: new Date().toISOString(), body: 'proposed default: derive from tenant tier' }],
        commentCount: 4,
        fetchedAt: new Date().toISOString(),
      });
      const { container } = await open([
        releaseItem({
          id: 'XZO#803',
          nextMover: 'human',
          owner: 'robin',
          channel: '#dispatch',
          url: 'https://github.com/example-org/example-repo/issues/803',
          nextAction: 'robin answers/acts -- see why',
        }),
      ]);
      await expandRow(container, 'XZO#803');
      await act(async () => {});
      expect(vi.mocked(getIssueBrief)).toHaveBeenCalledWith('wg-1', 'XZO#803');
      const brief = container.querySelector('.nc-obs-brief')!;
      expect(brief.textContent).toContain('Expected: tier from tenant config');
      expect(brief.textContent).toContain('needs-product-decision');
      expect(brief.textContent).toContain('proposed default: derive from tenant tier');
      // 4 total, 1 shown — the pane says what it is hiding.
      expect(brief.textContent).toContain('3 earlier — latest 1 shown');
    });

    it('a brief that cannot be read degrades to the issue link, never a broken pane', async () => {
      vi.mocked(getIssueBrief).mockRejectedValue(new Error('502'));
      const { container } = await open([
        releaseItem({
          id: 'XZO#803',
          nextMover: 'human',
          owner: 'robin',
          channel: '#dispatch',
          url: 'https://github.com/example-org/example-repo/issues/803',
        }),
      ]);
      await expandRow(container, 'XZO#803');
      await act(async () => {});
      expect(container.querySelector('.nc-obs-brief-empty')!.textContent).toContain('couldn’t read the issue');
    });

    it('an item with no url gets no brief pane — nothing to read', async () => {
      const { container } = await open();
      await expandRow(container, 'XZO#912');
      await act(async () => {});
      expect(vi.mocked(getIssueBrief)).not.toHaveBeenCalled();
      expect(container.querySelector('.nc-obs-brief, .nc-obs-brief-empty')).toBeFalsy();
    });

    it('an instruction addressed to nobody on this floor opens the row instead of firing', async () => {
      const { container } = await open([
        releaseItem({
          id: 'XZO#913',
          nextMover: 'human',
          owner: 'kit',
          channel: '#dispatch',
          nextAction: 'kit records @nova ship 913 -- nova is not on this floor',
        }),
      ]);
      await userEvent.click(shipBtn(container, 'XZO#913')!);
      expect(mockSteer).not.toHaveBeenCalled();
      expect(composer(container)).toBeTruthy();
    });

    it('a member is offered no button — same gate as every other control', async () => {
      mockData(
        snapshot({
          agents: [agent({ id: 'ag-ava', name: 'ava' })],
          releaseState: releaseState({ items: decisions() }),
        }),
      );
      const memberMe = { user_id: 'u2', scopes: { role: 'member', allowed_group_ids: [], no_filter: false } };
      const { container } = render(<Observatory authMe={memberMe} route="observatory" onRouteChange={noop} />);
      await segment(container, 'decisions');
      expect(container.querySelector('.nc-obs-decide-ask')).toBeTruthy();
      expect(container.querySelector('.nc-obs-ship')).toBeFalsy();
    });

    it('shipAddressee: a handle nobody on this floor answers to picks nobody', () => {
      const agents = [{ id: 'ag-ava', name: 'ava' }];
      expect(shipAddressee('@ava ship 912', agents)).toBe('ag-ava');
      expect(shipAddressee('@nova ship 912', agents)).toBeNull();
      expect(shipAddressee(null, agents)).toBeNull();
    });

    it('decisionRows: keeps a BREACHED decision, which the headline slice drops', () => {
      const overdue = releaseItem({
        id: 'XZO#1',
        nextMover: 'human',
        owner: 'robin',
        dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      });
      const onTrack = releaseItem({ id: 'XZO#2', nextMover: 'human', owner: 'robin' });
      const rows = decisionRows([onTrack, overdue]);
      expect(rows.map((r) => r.item.id)).toEqual(['XZO#1', 'XZO#2']);
      expect(buildLedger([onTrack, overdue]).counts.person).toBe(1);
    });

    it('decisionRows: a ship-bearing ask leads its tier, but never outranks a breach', () => {
      // The real-data shape that buried the button: the ship ask is undated,
      // and OLDER undated prose asks sat ahead of it, pushing it off page one.
      const mk = (id: string, ageH: number, nextAction?: string) =>
        releaseItem({
          id,
          nextMover: 'human',
          owner: 'robin',
          ...(nextAction ? { nextAction } : {}),
          since: new Date(Date.now() - ageH * 3_600_000).toISOString(),
        });
      const breached = releaseItem({
        id: 'XZO#0',
        nextMover: 'human',
        owner: 'robin',
        dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      });
      const rows = decisionRows([
        mk('XZO#1', 200, 'kit or robin answers/acts -- see why'),
        mk('XZO#2', 100, 'robin picks a colour'),
        breached,
        mk('XZO#3', 55, 'robin records @ava ship pipeline 23 -- mechanically ready'),
      ]);
      expect(rows.map((r) => r.item.id)).toEqual(['XZO#0', 'XZO#3', 'XZO#1', 'XZO#2']);
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
      expect(container.querySelector('.nc-obs-actions-who')).toBeTruthy();
      await expandRow(container, 'X#2');
      // v2 routes by the item's channel or not at all — no channel, nowhere to
      // land, so the row states that rather than offering a doomed control.
      expect(container.querySelector('.nc-obs-actions-who')).toBeFalsy();
      expect(container.querySelector('.nc-obs-actions .nc-of-sheet-nothread')).toBeTruthy();
    });

    it('an item a PERSON owes says where to answer it instead of offering to route it away', async () => {
      boardWithChannel();
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await expandRow(container, 'X#3');
      // The board says a PERSON owes this, so no agent is offered to take it —
      // the row still carries the thread/steer grammar every other row has.
      expect(
        Array.from(container.querySelectorAll('.nc-obs-actions button')).some((x) =>
          x.textContent?.startsWith('task it in'),
        ),
      ).toBe(false);
      // No room on this floor carries a permalink, so it stays a sentence —
      // and loses the arrow, which now belongs to the link that has somewhere
      // to go. Dead text wearing a "→" is the thing this fixed.
      const needsYou = container.querySelector('.nc-obs-needsyou')!;
      expect(needsYou.textContent).toBe('this needs you — answer in #dispatch');
      expect(needsYou.querySelector('a')).toBeFalsy();
    });

    it('and takes you there when that room has a permalink', async () => {
      mockData(
        snapshot({
          rooms: [room({ key: 'r9', name: '#dispatch', permalink: 'https://acme.slack.com/archives/C0AAA' })],
          agents: [agent({ id: 'ag-ava', name: 'ava' })],
          releaseState: releaseState({
            items: [releaseItem({ id: 'X#3', title: 'yours', nextMover: 'human', owner: 'kit', channel: '#dispatch' })],
          }),
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await expandRow(container, 'X#3');
      const link = container.querySelector('.nc-obs-needsyou a')!;
      expect(link.getAttribute('href')).toBe('https://acme.slack.com/archives/C0AAA');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.textContent).toContain('answer in #dispatch');
    });

    it('a member never sees the control — the server is the gate, this is the hint', async () => {
      boardWithChannel();
      const memberMe = { user_id: 'u2', scopes: { role: 'member', allowed_group_ids: [], no_filter: false } };
      const { container } = render(<Observatory authMe={memberMe} route="observatory" onRouteChange={noop} />);
      await expandRow(container, 'X#1');
      expect(container.querySelector('.nc-obs-actions-who')).toBeFalsy();
      expect(container.querySelector('.nc-obs-actions-steer')).toBeFalsy();
    });

    it('sends ids only, and reports where the work was tasked', async () => {
      boardWithChannel();
      mockAssign.mockResolvedValue({ ok: true, seriesId: 's1', channel: '#general', agent: 'ava' });
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await expandRow(container, 'X#1');
      await userEvent.selectOptions(container.querySelector('.nc-obs-actions-who')! as HTMLElement, 'ag-ava');
      await userEvent.click(
        Array.from(container.querySelectorAll('.nc-obs-actions button')).find((x) =>
          x.textContent?.startsWith('task it in'),
        )! as HTMLElement,
      );

      expect(mockAssign).toHaveBeenCalledWith('wg-1', 'X#1', 'ag-ava');
      expect(container.querySelector('.nc-obs-actions-done')!.textContent).toBe(
        'assigned — ava was tasked in #general',
      );
    });

    it('a wiring rejection explains itself instead of failing mute', async () => {
      boardWithChannel();
      mockAssign.mockRejectedValue({ status: 409, error: 'agent_not_wired_to_channel' });
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await expandRow(container, 'X#1');
      await userEvent.selectOptions(container.querySelector('.nc-obs-actions-who')! as HTMLElement, 'ag-ava');
      await userEvent.click(
        Array.from(container.querySelectorAll('.nc-obs-actions button')).find((x) =>
          x.textContent?.startsWith('task it in'),
        )! as HTMLElement,
      );
      expect(container.querySelector('.nc-obs-actions-err')!.textContent).toContain('not wired to #general');
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
      expect(link.textContent).toContain('open thread');
    });

    it('a held claim with no thread says so instead of offering a dead link', async () => {
      const { container } = floor();
      await open(container, '#general');
      const held = container.querySelectorAll('.nc-of-sheet-list li')[0]!.querySelectorAll('.nc-of-sheet-held-row');
      expect(held[1]!.querySelector('a')).toBeFalsy();
      expect(held[1]!.querySelector('.nc-of-sheet-nothread')!.textContent).toBe('no thread recorded');
    });

    it('shows each occupant the face the floor draws them with, and invents none', async () => {
      mockData(
        snapshot({
          rooms: [room({ key: 'r1', name: 'general' })],
          agents: [
            agent({ id: 'ava', name: 'ava', location: 'r1', avatarUrl: 'https://cdn.example/ava_192.png' }),
            agent({ id: 'kit', name: 'kit', location: 'r1' }),
          ],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await open(container, '#general');
      const who = container.querySelectorAll('.nc-of-sheet-who');
      expect(who[0]!.querySelector('img')!.getAttribute('src')).toBe('https://cdn.example/ava_192.png');
      expect(who[1]!.querySelector('img')).toBeFalsy();
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

    // obs.10 established that clicking a person on the floor picks the person,
    // not the room. obs.C.14 changed WHAT that opens: the agent drawer, not
    // the room sheet — so a person click must leave the sheet untouched.
    it('a click on an agent opens the agent drawer, not the room sheet', async () => {
      const { container } = floor();
      const map = container.querySelector('office-map')!;
      await act(async () => {
        map.dispatchEvent(
          new CustomEvent('agent-select', { detail: { name: 'kit', room: 'westFront' }, bubbles: true }),
        );
      });
      expect(container.querySelector('[data-testid="agent-drawer"]')).toBeTruthy();
      expect(container.querySelector('.nc-of-sheet')).toBeFalsy();
    });

    /* obs.C.3 — the test above hand-dispatches `agent-select`, so it stayed
     * green while a click on the person reached nothing at all. This one goes
     * through the map's own shadow DOM: the face-bearing label over an agent's
     * head is the part that reads as "the person", and clicking it has to pick
     * them, not fall through to the floor. */
    it('a click on the face label over an agent picks that agent', async () => {
      // the floor seats a room's WIRED members, so this fixture wires them
      mockData(
        snapshot({
          rooms: [room({ key: 'r1', name: 'general', memberAgentIds: ['ava', 'kit'] })],
          agents: [agent({ id: 'ava', name: 'ava', location: 'r1' }), agent({ id: 'kit', name: 'kit', location: 'r1' })],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      const map = container.querySelector('office-map') as HTMLElement;
      // the element defers its first paint to idle/intersection; nudge it.
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const sr = map.shadowRoot!;
      const pads = Array.from(sr.querySelectorAll('.ahit'));
      expect(pads.length).toBe(2);
      const labels = Array.from(sr.querySelectorAll('.bub[data-agent]')) as HTMLElement[];
      expect(labels.map((l) => l.dataset.agent)).toEqual(['ava', 'kit']);

      let detail: { name: string; room: string } | null = null;
      map.addEventListener('agent-select', (e) => {
        detail = (e as CustomEvent<{ name: string; room: string }>).detail;
      });
      const label = labels[1]!;
      (label.querySelector('.face') ?? label).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      expect(detail).toEqual({ name: 'kit', room: label.dataset.room });
      // the generous budget is the map's FIRST paint: it concatenates and
      // percent-encodes the whole world SVG, which costs ~15s under jsdom.
    }, 45000);

    it('picking a room by hand carries no agent emphasis', async () => {
      const { container } = floor();
      await open(container, '#general');
      expect(container.querySelector('.nc-of-sheet-list li.on')).toBeFalsy();
    });

    it('closes on the sheet\'s own control, which also clears the queue filter', async () => {
      const { container } = floor();
      await open(container, '#general');
      await userEvent.click(container.querySelector('.nc-of-sheet-x')! as HTMLElement);
      expect(container.querySelector('.nc-of-sheet')).toBeFalsy();
      expect(container.querySelector('.nc-of-chip.on')).toBeFalsy();
    });
  });

  describe('the agent drawer', () => {
    // Two rooms so the suite can exercise "clicked in her own room" against
    // "clicked in a room she is wired to but isn't live in" — the whole
    // point of obs.C.17. Keys use the real two-segment channelType:channel
    // shape (matching messaging_groups.platform_id) because that is also
    // what a claim's threadId encodes, and the room-attribution match is a
    // literal string comparison between the two.
    function drawerFloor(ava: Partial<ObservatoryAgent> = {}) {
      mockData(
        snapshot({
          rooms: [
            room({ key: 'slack:C0AAA', name: 'general', permalink: 'https://acme.slack.com/archives/C0AAA' }),
            room({ key: 'slack:C0BBB', name: 'ops', permalink: 'https://acme.slack.com/archives/C0BBB' }),
          ],
          claims: [
            claim({
              slug: 'migration',
              owner: 'ava',
              state: 'live',
              threadId: 'slack:C0AAA:1.1',
              threadUrl: 'https://example.com/thread/1',
            }),
            claim({
              slug: 'stuck-one',
              owner: 'ava',
              state: 'parked',
              threadId: 'slack:C0AAA:1.2',
              threadUrl: 'https://example.com/thread/2',
            }),
            // No thread recorded at all — genuinely unattributable to any
            // room, so it must always land in "elsewhere", not "general".
            claim({ slug: 'no-thread-claim', owner: 'ava', state: 'live', threadId: null, threadUrl: null }),
          ],
          agents: [
            agent({
              id: 'ava',
              name: 'ava',
              location: 'slack:C0AAA',
              holding: ['migration', 'stuck-one', 'no-thread-claim'],
              nextTask: { title: 'ship the release notes', at: new Date(Date.now() + 3_600_000).toISOString() },
              liveSession: {
                channelKey: 'slack:C0AAA',
                sessionId: 'sess-1',
                threadUrl: 'https://example.com/live-thread',
                lastOutboundAt: new Date().toISOString(),
              },
              ...ava,
            }),
            agent({ id: 'kit', name: 'kit', location: null, holding: [], awake: false, active: false }),
          ],
          releaseState: releaseState({
            items: [
              releaseItem({
                id: 'XZO#1',
                owner: 'ava',
                nextMover: 'agent',
                dueAt: new Date(Date.now() - 3_600_000).toISOString(),
                channel: '#general',
              }),
            ],
          }),
        }),
      );
      return render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
    }

    // office-data.ts fills slots in arrival order, so the fixture's first
    // room ('general') lands on 'westFront' and the second ('ops') on
    // 'eastFront' — SLOTS[0] and SLOTS[1].
    const clickAgentIn = async (container: HTMLElement, name: string, slot: string) => {
      const map = container.querySelector('office-map')!;
      await act(async () => {
        map.dispatchEvent(new CustomEvent('agent-select', { detail: { name, room: slot }, bubbles: true }));
      });
    };
    const clickAgent = (container: HTMLElement, name: string) => clickAgentIn(container, name, 'westFront');

    it('is closed until a person is picked', () => {
      const { container } = drawerFloor();
      expect(container.querySelector('[data-testid="agent-drawer"]')).toBeFalsy();
    });

    it('clicked in her own room: live thread first, then what is actually hers here', async () => {
      const { container } = drawerFloor();
      await clickAgent(container, 'ava'); // westFront → #general, where ava is live
      const drawer = container.querySelector('[data-testid="agent-drawer"]')!;
      expect(drawer.querySelector('h3')!.textContent).toBe('ava in #general');
      // ava owns a breached item, which outranks "awake" in the office's own
      // state vocabulary — the header agrees with the "needs a human" section.
      expect(drawer.querySelector('.nc-agent-drawer-state')!.textContent).toContain('blocked');
      // standing in its room, linked via the room's own permalink
      const roomLink = drawer.querySelector('.nc-agent-drawer-where a')! as HTMLAnchorElement;
      expect(roomLink.getAttribute('href')).toBe('https://acme.slack.com/archives/C0AAA');

      // working on now: the live thread leads, then the next task, then the
      // healthy claim that is actually attributable to THIS room
      const working = drawer.querySelector('[data-section="working-now"]')!;
      const liveLink = working.querySelector('.nc-agent-drawer-live a')! as HTMLAnchorElement;
      expect(liveLink.getAttribute('href')).toBe('https://example.com/live-thread');
      expect(working.textContent).toContain('ship the release notes');
      expect(working.querySelector('.nc-of-sheet-held-slug')!.textContent).toBe('migration');
      expect(working.textContent).not.toContain('stuck-one');
      expect(working.textContent).not.toContain('no-thread-claim');

      // needs a human: the parked claim (same room) and the agent's own
      // breached item (#general) — not the thread-less claim, which has no
      // room to attribute to.
      const attention = drawer.querySelector('[data-section="needs-human"]')!;
      expect(attention.textContent).toContain('stuck-one');
      expect(attention.textContent).toContain('XZO#1');
      expect(attention.textContent).not.toContain('no-thread-claim');

      // elsewhere: only the thread-less claim — everything else was hers,
      // here.
      const elsewhere = drawer.querySelector('[data-section="elsewhere"]')!;
      expect(elsewhere.querySelector('summary')!.textContent).toBe('elsewhere (1)');
      expect(elsewhere.textContent).toContain('no-thread-claim');
    });

    // The live report was the floor, but the drawer told the same lie in
    // words: a seat whose last word was hours old still read "live here".
    it('a stale seat says it is stale, and still links the thread', async () => {
      const { container } = drawerFloor({ active: false });
      await clickAgent(container, 'ava');
      const live = container.querySelector('.nc-agent-drawer-live')!;
      expect(live.textContent).toContain('last spoke here');
      expect(live.textContent).not.toContain('live here');
      expect(live.querySelector('a')!.getAttribute('href')).toBe('https://example.com/live-thread');
    });

    it('clicked in a DIFFERENT room she is wired to: an honest empty view, not her global ledger', async () => {
      const { container } = drawerFloor();
      await clickAgentIn(container, 'ava', 'eastFront'); // → #ops, where ava has never worked
      const drawer = container.querySelector('[data-testid="agent-drawer"]')!;
      expect(drawer.querySelector('h3')!.textContent).toBe('ava in #ops');

      const working = drawer.querySelector('[data-section="working-now"]')!;
      expect(working.textContent).toContain('no live thread here');
      expect(working.textContent).not.toContain('migration');

      // nothing of ava's attributes to #ops — the section says so honestly
      // rather than falling back to her global "needs a human" list.
      expect(drawer.querySelector('[data-section="needs-human"]')!.textContent).toContain(
        'nothing needs a human right now',
      );

      // every real piece of her work is still reachable, just folded away —
      // migration + stuck-one + no-thread-claim + XZO#1.
      const elsewhere = drawer.querySelector('[data-section="elsewhere"]')!;
      expect(elsewhere.querySelector('summary')!.textContent).toBe('elsewhere (4)');
      expect(elsewhere.textContent).toContain('migration');
      expect(elsewhere.textContent).toContain('stuck-one');
      expect(elsewhere.textContent).toContain('XZO#1');
    });

    it('an idle agent shows an honest empty room view, not the old global fallback text', async () => {
      const { container } = drawerFloor();
      await clickAgent(container, 'kit'); // westFront → #general — kit has never been there
      const drawer = container.querySelector('[data-testid="agent-drawer"]')!;
      expect(drawer.querySelector('h3')!.textContent).toBe('kit in #general');
      expect(drawer.querySelector('.nc-agent-drawer-state')!.textContent).toContain('idle');
      expect(drawer.querySelector('[data-section="working-now"]')!.textContent).toContain('no live thread here');
      expect(drawer.querySelector('[data-section="needs-human"]')!.textContent).toContain(
        'nothing needs a human right now',
      );
      // kit holds and owns nothing anywhere, so there is nothing to fold away.
      expect(drawer.querySelector('[data-section="elsewhere"]')).toBeFalsy();
    });

    it('a room that fails to resolve falls back to the agent-only view', async () => {
      const { container } = drawerFloor();
      // 'kitchen' is a real slot, but drawerFloor only seats two rooms
      // (westFront, eastFront) — nothing occupies it, so officeData has no
      // room to hand back and roomKey stays null.
      await clickAgentIn(container, 'ava', 'kitchen');
      const drawer = container.querySelector('[data-testid="agent-drawer"]')!;
      expect(drawer.querySelector('h3')!.textContent).toBe('ava');
      expect(drawer.textContent).toContain('not seated on the floor');
      expect(drawer.querySelector('[data-section="working-now"]')!.textContent).toContain('nothing queued right now');
    });

    it('closes on its own ✕', async () => {
      const { container } = drawerFloor();
      await clickAgent(container, 'ava');
      await userEvent.click(container.querySelector('[data-testid="agent-drawer"] .nc-sched-drawer-close')! as HTMLElement);
      expect(container.querySelector('[data-testid="agent-drawer"]')).toBeFalsy();
    });

    it('closes on Escape', async () => {
      const { container } = drawerFloor();
      await clickAgent(container, 'ava');
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(container.querySelector('[data-testid="agent-drawer"]')).toBeFalsy();
    });

    it('closes on a click outside', async () => {
      const { container } = drawerFloor();
      await clickAgent(container, 'ava');
      await act(async () => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(container.querySelector('[data-testid="agent-drawer"]')).toBeFalsy();
    });

    it('the drawer and the room sheet track independently', async () => {
      const { container } = drawerFloor();
      const chip = Array.from(container.querySelectorAll('.nc-of-teleport .nc-of-chip')).find((b) =>
        b.textContent?.includes('#general'),
      );
      await userEvent.click(chip! as HTMLElement);
      expect(container.querySelector('.nc-of-sheet')).toBeTruthy();
      // opening the drawer over it (a programmatic agent-select, not a real
      // click, so it never triggers the drawer's own click-outside close)
      // leaves the room sheet exactly as it was
      await clickAgent(container, 'ava');
      expect(container.querySelector('[data-testid="agent-drawer"]')).toBeTruthy();
      expect(container.querySelector('.nc-of-sheet')).toBeTruthy();
      // closing the drawer on its own control never touches the room sheet
      await userEvent.click(
        container.querySelector('[data-testid="agent-drawer"] .nc-sched-drawer-close')! as HTMLElement,
      );
      expect(container.querySelector('[data-testid="agent-drawer"]')).toBeFalsy();
      expect(container.querySelector('.nc-of-sheet')).toBeTruthy();
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
      await segment(out.container, 'board');
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

    // obs.10 — the API row carries the agent group's CODE name; the snapshot
    // knows the persona. Same id on both sides, so the row says the name the
    // operator uses.
    it('names the persona, not the group code name, when the id is on this floor', async () => {
      const { container } = await withRows([
        schedRow({ key: 'mine', agent_group_id: 'ava', agent_group_name: 'ava-agent' }),
      ]);
      expect(container.querySelector('.nc-of-sched-who')!.textContent).toBe('ava in general');
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
      // Scoped: the job board above carries its own empty line now.
      expect(container.querySelector('[data-section="schedule"] .nc-obs-ledger-empty')!.textContent).toBe(
        'nothing scheduled',
      );
      expect(container.querySelector('[data-section="schedule"] .nc-of-card-meta')!.textContent).toBe(
        'nothing scheduled',
      );
    });

    it('says so when the endpoint itself failed, rather than claiming nothing is scheduled', async () => {
      const { container } = await withRows([], new Error('boom'));
      expect(container.querySelector('[data-section="schedule"] .nc-obs-ledger-empty')!.textContent).toBe(
        "couldn't load scheduled work",
      );
    });
  });

  /* obs.C.26 — a claim slug is a code name. Opening the composer opens the
   * conversation with it, so an operator reads what happened before answering
   * it. One component, so every surface that steers gets the pane. */
  describe('the thread in view when you steer', () => {
    const mockDetail = vi.mocked(getSessionDetail);
    const detail = (texts: string[]): SessionDetailResponse =>
      ({
        session: {},
        // The endpoint returns newest-first; the pane must show oldest-first.
        transcript: texts.map((text, i) => ({
          direction: i % 2 === 0 ? 'out' : 'in',
          kind: 'chat',
          seq: texts.length - i,
          timestamp: new Date(Date.now() - i * 60_000).toISOString(),
          text,
        })),
      }) as unknown as SessionDetailResponse;

    /** The claims card, with one claim per session id the test needs. */
    const card = async (claims: ObservatoryClaim[]) => {
      mockData(
        snapshot({
          rooms: [room({ key: 'slack:C1', name: '#qa-room', memberAgentIds: ['ag-ava'] })],
          agents: [agent({ id: 'ag-ava', name: 'ava', holding: claims.map((c) => c.slug) })],
          claims,
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await segment(container, 'board');
      return container;
    };
    const stale = (over: Partial<ObservatoryClaim>) =>
      claim({ state: 'stale', owner: 'ava', threadId: 'slack:C1:1.2', threadUrl: 'https://x/t', ...over });

    /** Expand the row, pick the agent, press steer — the real path to the box. */
    const steerOpen = async (c: HTMLElement, slug: string) => {
      const row = c.querySelector(`.nc-obs-claim-row[data-slug="${slug}"]`)! as HTMLElement;
      await userEvent.click(row.querySelector('.nc-obs-claim-toggle')! as HTMLElement);
      await userEvent.selectOptions(row.querySelector('.nc-obs-actions-who')! as HTMLSelectElement, 'ag-ava');
      await userEvent.click(row.querySelector('.nc-obs-actions-steer')! as HTMLElement);
      return row;
    };

    it('shows the conversation above the box, oldest last-said at the bottom', async () => {
      mockDetail.mockResolvedValue(detail(['and here is the answer', 'what is the state of this?']));
      const c = await card([stale({ slug: 'sc-1', sessionId: 'sess-card' })]);
      const row = await steerOpen(c, 'sc-1');
      const pane = row.querySelector('.nc-obs-steer-thread')!;
      expect(pane).toBeTruthy();
      expect(Array.from(pane.querySelectorAll('.nc-transcript-text')).map((e) => e.textContent?.trim())).toEqual([
        'what is the state of this?',
        'and here is the answer',
      ]);
      // The box it is above is still the same composer.
      expect(row.querySelector('.nc-obs-steer textarea')).toBeTruthy();
    });

    it('fetches nothing until the composer is asked for, and not again when it re-opens', async () => {
      mockDetail.mockResolvedValue(detail(['hello']));
      const c = await card([stale({ slug: 'sc-2', sessionId: 'sess-reopen' })]);
      const row = c.querySelector('.nc-obs-claim-row[data-slug="sc-2"]')! as HTMLElement;
      await userEvent.click(row.querySelector('.nc-obs-claim-toggle')! as HTMLElement);
      // The row is open and the thread has NOT been read.
      expect(mockDetail).not.toHaveBeenCalled();

      await userEvent.selectOptions(row.querySelector('.nc-obs-actions-who')! as HTMLSelectElement, 'ag-ava');
      await userEvent.click(row.querySelector('.nc-obs-actions-steer')! as HTMLElement);
      expect(mockDetail).toHaveBeenCalledTimes(1);
      expect(mockDetail).toHaveBeenCalledWith('sess-reopen');

      // Collapse and re-open: same pane, no second read.
      await userEvent.click(row.querySelector('.nc-obs-actions-steer')! as HTMLElement);
      expect(row.querySelector('.nc-obs-steer-thread')).toBeFalsy();
      await userEvent.click(row.querySelector('.nc-obs-actions-steer')! as HTMLElement);
      expect(row.querySelector('.nc-obs-steer-thread')).toBeTruthy();
      expect(mockDetail).toHaveBeenCalledTimes(1);
    });

    it('says it could not read the thread rather than showing an empty one', async () => {
      mockDetail.mockRejectedValue({ status: 404, error: 'session_not_found' });
      const c = await card([stale({ slug: 'sc-3', sessionId: 'sess-err' })]);
      const row = await steerOpen(c, 'sc-3');
      expect(row.querySelector('.nc-obs-steer-thread')).toBeFalsy();
      expect(row.querySelector('.nc-obs-steer-nopane')!.textContent).toBe('couldn’t load the conversation');
    });

    /** The room sheet — the other surface the same component renders on. */
    const sheet = async (claims: ObservatoryClaim[]) => {
      mockData(
        snapshot({
          rooms: [room({ key: 'r1', name: 'general', memberAgentIds: ['ava'] })],
          claims,
          agents: [agent({ id: 'ava', name: 'ava', location: 'r1', holding: claims.map((c) => c.slug) })],
        }),
      );
      const { container } = render(<Observatory authMe={mockAuthMe} route="observatory" onRouteChange={noop} />);
      await userEvent.click(
        Array.from(container.querySelectorAll('.nc-of-teleport .nc-of-chip')).find((b) =>
          b.textContent?.includes('#general'),
        )! as HTMLElement,
      );
      return container;
    };

    it('a claim with no conversation yet says so, and still lets you open one', async () => {
      // No thread, viewed in a room — the send OPENS the first thread there,
      // so there is nothing to preview and the row must say that, not sit blank.
      const c = await sheet([claim({ slug: 'fresh', owner: 'ava', threadId: null, threadUrl: null, sessionId: null })]);
      const held = c.querySelector('.nc-of-sheet-held-row')! as HTMLElement;
      await userEvent.selectOptions(held.querySelector('.nc-obs-actions-who')! as HTMLSelectElement, 'ava');
      await userEvent.click(held.querySelector('.nc-obs-actions-steer')! as HTMLElement);
      expect(mockDetail).not.toHaveBeenCalled();
      expect(held.querySelector('.nc-obs-steer-thread')).toBeFalsy();
      expect(held.querySelector('.nc-obs-steer-nopane')!.textContent).toBe(
        'no conversation yet — this opens the first one',
      );
      expect(held.querySelector('.nc-obs-steer-target')!.textContent).toBe('opens a new thread in #general');
      expect(held.querySelector('.nc-obs-steer textarea')).toBeTruthy();
    });

    it('the room sheet gets the same pane — it is the same component', async () => {
      mockDetail.mockResolvedValue(detail(['in the room']));
      const container = await sheet([
        claim({ slug: 'migration', owner: 'ava', threadUrl: 'https://x/t', sessionId: 'sess-sheet' }),
      ]);
      const held = container.querySelector('.nc-of-sheet-held-row')! as HTMLElement;
      await userEvent.selectOptions(held.querySelector('.nc-obs-actions-who')! as HTMLSelectElement, 'ava');
      await userEvent.click(held.querySelector('.nc-obs-actions-steer')! as HTMLElement);
      expect(mockDetail).toHaveBeenCalledWith('sess-sheet');
      expect(held.querySelector('.nc-obs-steer-thread .nc-transcript-text')!.textContent!.trim()).toBe('in the room');
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
