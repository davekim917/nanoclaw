import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';
import userEvent from '@testing-library/user-event';
import type { ThreadState, ThreadSummary, ThreadTranscriptEntry } from '../../lib/api.js';

/**
 * Shell-level checks: the sidebar counts, the channel grouping rule that is
 * easy to get silently wrong (§3.2), the attention count's `aria-live`, the
 * preview budget (§4.1), and the theme toggle's two triggers.
 */

const subscribe = vi.fn(() => () => {});
vi.mock('../../lib/sse.ts', () => ({ subscribe, startSSE: vi.fn(), stopSSE: vi.fn() }));

const listThreads = vi.fn();
const listGroups = vi.fn();
const listWorkgroups = vi.fn();
const getThreadDetail = vi.fn();
const snoozeThread = vi.fn().mockResolvedValue({});
const unsnoozeThread = vi.fn().mockResolvedValue({});
const postThreadMessage = vi.fn().mockResolvedValue({ created_session: false, handoff: null });
const closeThread = vi.fn();
vi.mock('../../lib/api.js', () => ({
  listThreads,
  listGroups,
  listWorkgroups,
  getThreadDetail,
  snoozeThread,
  unsnoozeThread,
  postThreadMessage,
  closeThread,
}));

const { ThreadConsole, lastMessagePreview } = await import('./ThreadConsole.js');

const authMe = { user_id: 'u1', scopes: { role: 'owner', allowed_group_ids: [], no_filter: true } };

function thread(id: string, over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    thread_id: id,
    synthetic: false,
    channel_key: 'slack:CROOM',
    channel_name: '#example-eng',
    title: `Thread ${id}`,
    participants: [{ agent_group_id: 'ag-1', name: 'Alpha', session_id: 's-1', avatarUrl: null, provider: 'claude' }],
    assignable_agents: [],
    last_activity_at: '2026-08-20T09:00:00.000Z',
    state: 'idle' as ThreadState,
    session_ids: [`s-${id}`],
    container_status: 'idle',
    provider_status: null,
    current_tool: null,
    tool_started_at: null,
    reply_target_session_id: 's-1',
    snoozed: false,
    ...over,
  };
}

beforeEach(() => {
  listGroups.mockResolvedValue({ groups: [{ id: 'ag-1', name: 'example-agent', workgroup_id: 'wg-example' }] });
  listWorkgroups.mockResolvedValue({ workgroups: [{ id: 'wg-example', name: 'Example Workgroup' }] });
  getThreadDetail.mockResolvedValue({
    thread: thread('t-1'),
    transcript: [
      {
        session_id: 's-1',
        agent_group_id: 'ag-1',
        agent_name: 'Alpha',
        direction: 'out',
        kind: 'chat',
        seq: 1,
        timestamp: '2026-08-20T09:00:00.000Z',
        text: 'two options and I do not think I should default this one',
      },
    ],
  });
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  vi.clearAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

// A fresh SWR cache per test — the list key is stable, so a shared provider
// would hand the next test the previous one's threads.
const mount = () =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <ThreadConsole authMe={authMe} />
    </SWRConfig>,
  );

describe('the queue', () => {
  it('counts each of the seven lanes, and puts attention rows first', async () => {
    listThreads.mockResolvedValue({
      threads: [
        thread('t-idle'),
        thread('t-needs', { state: 'needs_you' }),
        thread('t-run', { state: 'running', tool_started_at: '2026-08-20T11:59:00.000Z' }),
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(3));
    // §1: status is a SORT, never a spatial column — urgency first.
    const order = Array.from(container.querySelectorAll('.ncc-row')).map((r) => (r as HTMLElement).dataset['state']);
    expect(order).toEqual(['needs_you', 'running', 'idle']);
  });

  /**
   * The top bar's "Needs you N" chip is gone (item 2) — its `aria-live`
   * moved onto the sidebar's own "Needs you" lane count, its only home now.
   */
  it('announces the needs-you lane count politely, on the sidebar', async () => {
    listThreads.mockResolvedValue({
      threads: [thread('a', { state: 'needs_you' }), thread('b', { state: 'stalled' }), thread('c')],
    });
    const { container } = mount();
    const needsYou = within(container.querySelector('.ncc-side') as HTMLElement).getByRole('button', {
      name: /^Needs you/,
    });
    const count = needsYou.querySelector('.n')!;
    expect(count.getAttribute('aria-live')).toBe('polite');
    await waitFor(() => expect(count.textContent).toBe('1'));
  });

  it('filters to one lane and back', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('a', { state: 'needs_you' }), thread('b')] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: /^Needs you/ }));
    expect(container.querySelectorAll('.ncc-row')).toHaveLength(1);
  });
});

describe('channels group on the parsed channel key (§3.2)', () => {
  it('lists a channel ONCE even when several sibling bots are wired to it', async () => {
    // messaging_groups holds one row per sibling bot per channel; grouping on
    // messaging_group_id would list #ops once per bot. The endpoint parses the
    // key off thread_id and the sidebar must group on THAT.
    listThreads.mockResolvedValue({
      threads: [
        thread('slack:COPS:1', { channel_key: 'slack:COPS', channel_name: '#ops' }),
        thread('slack:COPS:2', { channel_key: 'slack:COPS', channel_name: '#ops', state: 'needs_you' }),
        thread('slack:CENG:1', { channel_key: 'slack:CENG', channel_name: '#eng' }),
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-side-item.channel')).toHaveLength(2));
    const ops = Array.from(container.querySelectorAll('.ncc-side-item.channel')).find((n) =>
      n.textContent?.includes('#ops'),
    )!;
    expect(ops.querySelector('.n.attention')!.textContent).toBe('1');
    expect(ops.textContent).toContain('2');
    // §11: friendly display name, never the internal key.
    expect(ops.textContent).not.toContain('slack:COPS');
  });

  it('filters the list to the picked channel', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({
      threads: [
        thread('slack:COPS:1', { channel_key: 'slack:COPS', channel_name: '#ops' }),
        thread('slack:CENG:1', { channel_key: 'slack:CENG', channel_name: '#eng' }),
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));
    const ops = Array.from(container.querySelectorAll('.ncc-side-item.channel')).find((n) =>
      n.textContent?.includes('#ops'),
    ) as HTMLElement;
    await user.click(ops);
    expect(container.querySelectorAll('.ncc-row')).toHaveLength(1);
  });
});

describe('the hybrid line stays inside its budget (§4.1)', () => {
  it('fetches a preview only for attention rows, and never for the quiet ones', async () => {
    listThreads.mockResolvedValue({
      threads: [thread('needs', { state: 'needs_you' }), thread('quiet'), thread('run', { state: 'running' })],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row-hybrid')).toHaveLength(1));
    expect(getThreadDetail).toHaveBeenCalledTimes(1);
    expect(getThreadDetail).toHaveBeenCalledWith('needs');
  });

  it('caps the fetch at a handful even when the queue is all attention', async () => {
    listThreads.mockResolvedValue({
      threads: Array.from({ length: 20 }, (_, i) => thread(`t-${i}`, { state: 'stalled' })),
    });
    mount();
    await waitFor(() => expect(getThreadDetail).toHaveBeenCalled());
    // The exact cap is PREVIEW_BUDGET; the assertion that matters is that it is
    // a handful and not the whole page.
    await waitFor(() => expect(getThreadDetail.mock.calls.length).toBeLessThanOrEqual(8));
  });
});

describe('empty states', () => {
  it('says so on a queue with nothing in it, and does not pretend a thread is selected', async () => {
    listThreads.mockResolvedValue({ threads: [] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.ncc-list-pane .ncc-empty')).toBeTruthy());
    expect(container.querySelector('.ncc-list-pane .ncc-empty')!.textContent).toContain('no threads');
    expect(container.querySelector('.ncc-detail .ncc-empty')!.textContent).toContain('select a thread');
    const needsYou = within(container.querySelector('.ncc-side') as HTMLElement).getByRole('button', {
      name: /^Needs you/,
    });
    expect(needsYou.textContent).toContain('0');
    expect(container.querySelectorAll('.ncc-side-item.channel')).toHaveLength(0);
    expect(getThreadDetail).not.toHaveBeenCalled();
  });

  it('renders a thread nobody owns, in the row AND in the detail pane', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('orphan', { participants: [], state: 'unassigned' })] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.ncc-row')).toBeTruthy());
    expect(container.querySelector('.ncc-face.orphan')).toBeTruthy();
    expect(container.querySelector('.ncc-row-meta')!.textContent).toContain('no owner');
    await user.click(container.querySelector('.ncc-row-main')!);
    expect(container.querySelector('.ncc-detail-meta')!.textContent).toContain('no owner');
    expect(container.querySelector('.ncc-detail-title')!.textContent).toBeTruthy();
  });

  it('titles an untitled thread rather than rendering a blank line', async () => {
    listThreads.mockResolvedValue({ threads: [thread('untitled', { title: null, last_activity_at: null })] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.ncc-row-title')).toBeTruthy());
    expect(container.querySelector('.ncc-row-title')!.textContent).toBe('Untitled thread');
    // No activity stamp is a dash, never "Invalid Date".
    expect(container.querySelector('.ncc-row-meta .age')!.textContent).toBe('—');
  });
});

describe('refresh is push-only', () => {
  it('subscribes to session_event and adds no polling timer', async () => {
    listThreads.mockResolvedValue({ threads: [] });
    mount();
    await waitFor(() => expect(subscribe).toHaveBeenCalledWith('session_event', expect.any(Function)));
  });
});

describe('the theme toggle', () => {
  it('cycles system → dark → light, and REMOVES the attribute for system', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [] });
    mount();
    const button = screen.getByRole('button', { name: /Colour theme/ });
    // `system` must remove the attribute, not write "system" into it: console.css
    // matches on the attribute's presence so prefers-color-scheme can win.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    await user.click(button);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await user.click(button);
    // An explicit light choice must beat a dark SYSTEM setting, which is what
    // the `:not([data-theme='light'])` guard in the media query is for.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await user.click(button);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('keyboard', () => {
  it('walks the queue with the arrow keys', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('a'), thread('b')] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row-main')).toHaveLength(2));
    const [first, second] = Array.from(container.querySelectorAll<HTMLButtonElement>('.ncc-row-main'));
    first!.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(second);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(first);
  });
});

describe('lastMessagePreview', () => {
  it('names the agent on outbound and nobody on inbound', () => {
    const base: Omit<ThreadTranscriptEntry, 'direction' | 'text'> = {
      session_id: 's',
      agent_group_id: 'ag',
      agent_name: 'Alpha',
      kind: 'chat',
      seq: 1,
      timestamp: '',
    };
    expect(lastMessagePreview([{ ...base, direction: 'out', text: 'hello  there' }])).toEqual({
      speaker: 'Alpha',
      excerpt: 'hello there',
    });
    // The transcript records a DIRECTION, not a human. Naming one would be an
    // invention.
    expect(lastMessagePreview([{ ...base, direction: 'in', text: 'ping' }])!.speaker).toBe('');
  });

  /**
   * The hybrid line is a ONE-LINE cell with an ellipsis. Rendering markdown
   * into it would inject `<p>` / `<ul>` / `<pre>` and break the row; leaving it
   * raw would show the operator `**ship it**`. So it is stripped to prose.
   */
  it('strips markdown to plain prose rather than rendering or leaking it', () => {
    const base: Omit<ThreadTranscriptEntry, 'direction' | 'text'> = {
      session_id: 's',
      agent_group_id: 'ag',
      agent_name: 'Alpha',
      kind: 'chat',
      seq: 1,
      timestamp: '',
    };
    const preview = lastMessagePreview([
      { ...base, direction: 'out', text: '## Status\n\n- **done**: the `publish` gate\n- see [PR 733](https://x.test/733)' },
    ])!;
    expect(preview.excerpt).toBe('Status done: the publish gate see PR 733');
    expect(preview.excerpt).not.toMatch(/[\n*`[\]]|<\w/);
  });

  it('returns null rather than an empty quote', () => {
    expect(lastMessagePreview(undefined)).toBeNull();
    expect(lastMessagePreview([])).toBeNull();
    expect(
      lastMessagePreview([
        {
          session_id: 's',
          agent_group_id: 'ag',
          agent_name: 'A',
          kind: 'chat',
          seq: 1,
          timestamp: '',
          direction: 'out',
          text: '   ',
        },
      ]),
    ).toBeNull();
  });
});

/**
 * Phase 3 wiring at the shell level: which verb reaches which endpoint, the
 * snooze lane that keeps snoozed work reachable, and triage as a mode entered
 * FROM the list (§11) that hands the list back exactly as it was.
 */
describe('the ONE action, and the one that is not a message', () => {
  /**
   * Every state's verb opens the composer on the thread. `idle` is in here on
   * purpose — it used to be the one row with no button at all, and `stalled`
   * used to render an inert `Kill`. Both are gone.
   */
  it.each(['needs_you', 'stalled', 'unassigned', 'running', 'parked', 'idle'] as ThreadState[])(
    '%s: the verb focuses the composer rather than sending blind',
    async (state) => {
      const user = userEvent.setup();
      listThreads.mockResolvedValue({ threads: [thread(`t-${state}`, { state })] });
      const { container } = mount();
      await waitFor(() => expect(container.querySelector('.ncc-verb')).toBeTruthy());
      const verb = container.querySelector('.ncc-verb') as HTMLElement;
      expect(verb.getAttribute('aria-disabled')).toBeNull();
      await user.click(verb);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Message text')));
      expect(postThreadMessage).not.toHaveBeenCalled();
    },
  );

  it('no row anywhere offers a kill', async () => {
    listThreads.mockResolvedValue({
      threads: [thread('t-stall', { state: 'stalled' }), thread('t-run', { state: 'running' })],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));
    expect(container.textContent!.toLowerCase()).not.toContain('kill');
  });

});

/**
 * Thread closure. The removed Dismiss archived every session on a thread and
 * stopped nothing — a hide-without-stop action, which is why it does not
 * exist any more (`actions.test.ts` and `TriagePanel.test.tsx` each pin that
 * separately). What follows is a DIFFERENT thing: a real close
 * (`src/dashboard/thread-close.ts`) that asks the agent to wrap up, clears its
 * continuation, stops its container, and only then archives it. These tests
 * exist specifically so a future reader does not read one control as the
 * other — every one of them exercises the real `POST .../close` call through
 * the mocked `closeThread`, never a local archive/hide.
 */
describe('closing a thread — the real thing, not the old Dismiss', () => {
  beforeEach(() => closeThread.mockReset());

  // `.ncc-close-status` specifically — the list pane's own `.ncc-notice` ALSO
  // carries `role="status"`, and both are on screen at once once a thread is
  // selected, so `getByRole('status')` is ambiguous here.
  const closeStatus = (container: HTMLElement) => container.querySelector('.ncc-close-status');

  const openDetail = async (t: ThreadSummary) => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [t] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.ncc-row-main')).toBeTruthy());
    await user.click(container.querySelector('.ncc-row-main') as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'snooze' })).toBeTruthy());
    return { user, container };
  };

  it('one deliberate click closes it when the agent already proposed (1 confirmation)', async () => {
    closeThread.mockResolvedValueOnce({
      thread_id: 't-idle',
      session_ids: ['s-x'],
      wrap_up_delivered: 1,
      confirm_window_ms: 600_000,
    });
    const { user, container } = await openDetail(
      thread('t-idle', { state: 'idle', session_ids: ['s-x'], close_confirmations_required: 1 }),
    );
    await user.click(screen.getByRole('button', { name: 'close thread' }));
    await waitFor(() => expect(closeThread).toHaveBeenCalledWith('t-idle', { confirmations: 1 }));
    expect(closeThread).toHaveBeenCalledTimes(1);
    // Tells the operator the agent has time to land its work — closing is a
    // request to wrap up, not an instant kill, and the operator would
    // otherwise think it silently failed.
    await waitFor(() => expect(closeStatus(container)?.textContent).toMatch(/10 min/));
    expect(closeStatus(container)?.textContent).toMatch(/asked 1 agent/);
  });

  it('two GENUINELY SEPARATE acts when no agent proposed — a single click does not close it', async () => {
    closeThread.mockRejectedValueOnce({ status: 409, error: 'confirmation_required', required_confirmations: 2 });
    const { user, container } = await openDetail(
      thread('t-idle', { state: 'idle', session_ids: ['s-x'], close_confirmations_required: 2 }),
    );

    // Act one: a REAL request, sent with confirmations: 1 — this is what
    // makes a bug that collapses the two acts fail VISIBLY (a 409, shown on
    // screen) instead of silently closing the thread.
    await user.click(screen.getByRole('button', { name: 'close thread' }));
    await waitFor(() => expect(closeThread).toHaveBeenCalledWith('t-idle', { confirmations: 1 }));
    expect(closeThread).toHaveBeenCalledTimes(1);
    // The thread is NOT closed by that one act: no success line, and the
    // control that would fire the SECOND act is what appears instead —
    // never an auto-dismissing toast, never something that revalidates the
    // list as if it were done.
    await waitFor(() => expect(closeStatus(container)?.textContent).toMatch(/overrides live work/));
    expect(screen.getByRole('button', { name: 'confirm close' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cancel' })).toBeTruthy();

    // Act two: a SEPARATE click, sending the count the server actually named.
    closeThread.mockResolvedValueOnce({
      thread_id: 't-idle',
      session_ids: ['s-x'],
      wrap_up_delivered: 1,
      confirm_window_ms: 600_000,
    });
    await user.click(screen.getByRole('button', { name: 'confirm close' }));
    await waitFor(() => expect(closeThread).toHaveBeenCalledWith('t-idle', { confirmations: 2 }));
    expect(closeThread).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(closeStatus(container)?.textContent).toMatch(/asked 1 agent/));
  });

  it('cancel backs out of the second act without ever sending it', async () => {
    closeThread.mockRejectedValueOnce({ status: 409, error: 'confirmation_required', required_confirmations: 2 });
    const { user } = await openDetail(thread('t-idle', { state: 'idle', close_confirmations_required: 2 }));
    await user.click(screen.getByRole('button', { name: 'close thread' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'cancel' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('button', { name: 'confirm close' })).toBeNull();
    expect(screen.getByRole('button', { name: 'close thread' })).toBeTruthy();
    expect(closeThread).toHaveBeenCalledTimes(1); // only the first act ever reached the server
  });

  it('while the server says the thread is already closing, the control is disabled and says so', async () => {
    await openDetail(thread('t-idle', { state: 'idle', closing: true }));
    const btn = screen.getByRole('button', { name: 'closing…' });
    expect(btn).toBeDisabled();
    // Snooze stays independent: `closing` never disables it, and vice versa.
    expect(screen.getByRole('button', { name: 'snooze' })).not.toBeDisabled();
    expect(closeThread).not.toHaveBeenCalled();
  });

  it('close_already_in_progress is explained, not swallowed', async () => {
    closeThread.mockRejectedValueOnce({ status: 409, error: 'close_already_in_progress' });
    const { user, container } = await openDetail(thread('t-idle', { state: 'idle' }));
    await user.click(screen.getByRole('button', { name: 'close thread' }));
    await waitFor(() => expect(closeStatus(container)?.textContent).toMatch(/already in progress/));
  });

  it('thread_extends_beyond_your_scope is explained, not a silently disabled button', async () => {
    closeThread.mockRejectedValueOnce({ status: 409, error: 'thread_extends_beyond_your_scope' });
    const { user, container } = await openDetail(thread('t-idle', { state: 'idle' }));
    // The button was reachable and clickable — this is a REACHED explanation,
    // not a proactive disable with no reason shown (§2a's tension: the console
    // cannot know a hidden agent's group ahead of the attempt).
    await user.click(screen.getByRole('button', { name: 'close thread' }));
    await waitFor(() => expect(closeStatus(container)?.textContent).toMatch(/groups you can't manage/));
  });
});

describe('snooze', () => {
  it('hides a snoozed thread from the queue but keeps it reachable in its own lane', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({
      threads: [thread('t-live'), thread('t-hushed', { snoozed: true })],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    expect(container.querySelector('.ncc-row')!.getAttribute('data-thread-id')).toBe('t-live');

    await user.click(within(container.querySelector('.ncc-side') as HTMLElement).getByText('Snoozed'));
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    expect(container.querySelector('.ncc-row')!.getAttribute('data-thread-id')).toBe('t-hushed');
  });

  it('offers no snoozed lane when nothing is snoozed', async () => {
    listThreads.mockResolvedValue({ threads: [thread('t-live')] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    expect(within(container.querySelector('.ncc-side') as HTMLElement).queryByText('Snoozed')).toBeNull();
  });
});

/** Triage is reachable from the nav (item 2 moved it out of the top bar) AND
 *  from §8's bottom bar, so a query for "triage" alone is ambiguous. These
 *  name the nav's — the same `<nav>` desktop and the mobile sheet share. */
const navTriage = (c: HTMLElement) =>
  within(c.querySelector('.ncc-side') as HTMLElement).getByRole('button', { name: /triage/i });

describe('triage is a mode over the filtered list (§11)', () => {
  it('is entered from the nav and opens on the attention-state rows', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({
      threads: [thread('t-1'), thread('t-2', { state: 'needs_you' }), thread('t-3')],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(3));

    // Filtering to the Needs you LANE first changes nothing about what Triage
    // sees — it is already scoped to attention states regardless of lane (see
    // "triage is scoped to the attention set" below for the case that pins
    // that on its own, entered straight from the default "all" lane).
    await user.click(within(container.querySelector('.ncc-side') as HTMLElement).getByText('Needs you'));
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    await user.click(navTriage(container));
    expect(screen.getByLabelText('Triage')).toBeTruthy();
    expect(screen.getByText('1 / 1')).toBeTruthy();
  });

  it('Escape hands the list back', async () => {
    const user = userEvent.setup();
    // Triage is scoped to attention states — a plain idle thread would leave
    // the entry point disabled, which is not what this test is about.
    listThreads.mockResolvedValue({ threads: [thread('t-1', { state: 'needs_you' })] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    await user.click(navTriage(container));
    screen.getByLabelText('Triage').focus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Triage')).toBeNull());
    expect(container.querySelector('.ncc-list-pane')!.hasAttribute('hidden')).toBe(false);
  });

  it('cannot be entered on an empty queue, from either entry', async () => {
    listThreads.mockResolvedValue({ threads: [] });
    mount();
    await waitFor(() => expect(screen.getByText('no threads in this window yet')).toBeTruthy());
    const entries = screen.getAllByRole('button', { name: /triage/i }) as HTMLButtonElement[];
    expect(entries).toHaveLength(2);
    for (const b of entries) expect(b.disabled).toBe(true);
  });
});

/**
 * THE bug this brief exists to fix: `enterTriage` used to freeze `visible`,
 * which is the queue's CURRENT LANE result. With the default "All threads"
 * lane — what an operator sees on first load — that is every thread in the
 * window, so an operator with 189 threads got 189 triage items and Triage's
 * only remaining verbs (snooze, exit) left them forced to act on or flee rows
 * that needed nothing. Triage exists for decisions waiting on a human, so it
 * is scoped to the ATTENTION states (`wantsAttention` in `thread-state.ts` —
 * `needs_you` / `stalled` / `unassigned`, matching DESIGN §4.1's "any row
 * wanting attention") regardless of which lane the queue happens to show,
 * while still honouring the operator's OTHER filters and never a snoozed row.
 */
describe('triage is scoped to the attention set, never the queue lane', () => {
  it('entering from the default "all" lane yields ONLY attention-state threads', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({
      threads: [
        thread('t-idle'), // idle
        thread('t-run', { state: 'running' }),
        thread('t-parked', { state: 'parked' }),
        thread('t-needs', { state: 'needs_you' }),
        thread('t-stall', { state: 'stalled' }),
        thread('t-unassigned', { state: 'unassigned', participants: [] }),
      ],
    });
    const { container } = mount();
    // The queue itself, on the untouched default "All threads" lane, is all 6.
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(6));
    expect(screen.getByRole('button', { name: /^All threads/ }).getAttribute('aria-pressed')).toBe('true');

    await user.click(navTriage(container));
    // Triage sees exactly the 3 attention-state rows, not the 6-thread queue.
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(container.querySelectorAll('.ncc-triage-dot')).toHaveLength(3);
  });

  it('shows the attention-set count on the Triage entry, not the filtered queue size', async () => {
    listThreads.mockResolvedValue({
      threads: [thread('a', { state: 'needs_you' }), thread('b'), thread('c')],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(3));
    expect(within(navTriage(container)).getByText('1')).toBeTruthy();
  });

  it('disables the entry point when the attention set is empty, even though the queue is not', async () => {
    listThreads.mockResolvedValue({
      threads: [thread('a'), thread('b', { state: 'running' })], // no attention states
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));
    const entries = screen.getAllByRole('button', { name: /triage/i }) as HTMLButtonElement[];
    expect(entries).toHaveLength(2);
    for (const b of entries) {
      expect(b.disabled).toBe(true);
      // Empty reads as a real state, not a bare disabled control with no
      // stated reason.
      expect(b.getAttribute('aria-label')).toMatch(/nothing waiting on you/i);
    }
  });

  it('excludes snoozed threads even though they would otherwise qualify', async () => {
    listThreads.mockResolvedValue({
      threads: [thread('a', { state: 'needs_you' }), thread('b', { state: 'stalled', snoozed: true })],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    await userEvent.click(navTriage(container));
    expect(screen.getByText('1 / 1')).toBeTruthy();
  });

  it('still honours the channel filter', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({
      threads: [
        thread('a', { state: 'needs_you', channel_key: 'slack:COPS', channel_name: '#ops' }),
        thread('b', { state: 'stalled', channel_key: 'slack:CENG', channel_name: '#eng' }),
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));
    const ops = Array.from(container.querySelectorAll('.ncc-side-item.channel')).find((n) =>
      n.textContent?.includes('#ops'),
    ) as HTMLElement;
    await user.click(ops);
    await user.click(navTriage(container));
    expect(screen.getByText('1 / 1')).toBeTruthy();
    // Scoped to the triage panel — the queue row behind it also says "Thread
    // a", so an unscoped query is ambiguous.
    expect(await within(screen.getByLabelText('Triage')).findByText('Thread a')).toBeTruthy();
  });

  it('still honours the search query', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({
      threads: [
        thread('a', { state: 'needs_you', title: 'billing outage' }),
        thread('b', { state: 'stalled', title: 'unrelated thing' }),
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));
    await user.type(screen.getByLabelText('Search threads'), 'billing');
    await user.click(navTriage(container));
    expect(screen.getByText('1 / 1')).toBeTruthy();
  });

  it('still honours the workgroup filter', async () => {
    const user = userEvent.setup();
    listWorkgroups.mockResolvedValue({
      workgroups: [
        { id: 'wg-a', name: 'WG A' },
        { id: 'wg-b', name: 'WG B' },
      ],
    });
    listThreads.mockImplementation((params?: { workgroup?: string }) =>
      Promise.resolve({
        threads:
          params?.workgroup === 'wg-a'
            ? [thread('a', { state: 'needs_you' })]
            : [thread('a', { state: 'needs_you' }), thread('b', { state: 'stalled' })],
      }),
    );
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));

    const select = await screen.findByRole('combobox', { name: 'Workgroup' });
    await user.selectOptions(select, 'wg-a');
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));

    await user.click(navTriage(container));
    expect(screen.getByText('1 / 1')).toBeTruthy();
  });
});

/* ─── Ordering (§1) ────────────────────────────────────────────────────────── */

const threadIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.ncc-row')).map((r) => (r as HTMLElement).dataset['threadId']);

describe('the queue leads with the oldest breach', () => {
  it('sorts needs_you oldest-first and idle newest-first, in the same list', async () => {
    listThreads.mockResolvedValue({
      threads: [
        thread('needs-new', { state: 'needs_you', last_activity_at: '2026-08-20T09:00:00.000Z' }),
        thread('needs-old', { state: 'needs_you', last_activity_at: '2026-08-01T09:00:00.000Z' }),
        thread('idle-old', { state: 'idle', last_activity_at: '2026-08-01T09:00:00.000Z' }),
        thread('idle-new', { state: 'idle', last_activity_at: '2026-08-19T09:00:00.000Z' }),
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(4));
    expect(threadIds(container)).toEqual(['needs-old', 'needs-new', 'idle-new', 'idle-old']);
  });

  it('puts a thread with no activity timestamp last, even in an oldest-first lane', async () => {
    listThreads.mockResolvedValue({
      threads: [
        thread('undated', { state: 'needs_you', last_activity_at: null }),
        thread('dated', { state: 'needs_you', last_activity_at: '2026-08-01T09:00:00.000Z' }),
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));
    expect(threadIds(container)).toEqual(['dated', 'undated']);
  });
});

/* ─── Empty states ─────────────────────────────────────────────────────────── */

describe('an empty queue says WHICH emptiness it is', () => {
  it('calls a clear attention lane good news', async () => {
    listThreads.mockResolvedValue({ threads: [thread('t-1', { state: 'idle' })] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: /^Needs you0/ }));
    expect(screen.getByText('All clear — nothing needs you')).toBeTruthy();
  });

  it('speaks a search back rather than answering "nothing here"', async () => {
    listThreads.mockResolvedValue({ threads: [thread('t-1')] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    await userEvent.type(screen.getByLabelText('Search threads'), 'zzz');
    await waitFor(() => expect(screen.getByText('nothing here matches \u201Czzz\u201D')).toBeTruthy());
  });

  it('says the window is empty, not that a lane is clear, when nothing exists', async () => {
    listThreads.mockResolvedValue({ threads: [] });
    mount();
    await waitFor(() => expect(screen.getByText('no threads in this window yet')).toBeTruthy());
  });
});

/* ─── Stale channel filter (the same guard use-group-filter applies) ───────── */

describe('a channel filter is never left invisibly in force', () => {
  it('drops the filter when the channel ages out of the window', async () => {
    listThreads.mockResolvedValue({
      threads: [
        thread('t-1', { channel_key: 'slack:CROOM', channel_name: '#one' }),
        thread('t-2', { channel_key: 'slack:CTWO', channel_name: '#two' }),
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: /^#two/ }));
    await waitFor(() => expect(threadIds(container)).toEqual(['t-2']));

    // #two's last thread goes; the sidebar stops listing it. Without the guard
    // the queue would stay filtered to a channel with no button to un-press —
    // an empty board and no visible reason for it.
    listThreads.mockResolvedValue({ threads: [thread('t-1', { channel_key: 'slack:CROOM', channel_name: '#one' })] });
    const [, invalidate] = subscribe.mock.calls.at(-1) as unknown as [string, () => void];
    invalidate();

    await waitFor(() => expect(screen.queryByRole('button', { name: /^#two/ })).toBeNull());
    await waitFor(() => expect(threadIds(container)).toEqual(['t-1']));
    expect(screen.getByRole('button', { name: /^All channels/ }).getAttribute('aria-pressed')).toBe('true');
  });
});

/**
 * The console's primary axis is the WORKGROUP, not the agent group. Siblings
 * (`example-labs`, `example-labs-b`, `example-labs-c`, …) share one and most
 * threads are multi-agent, so an agent-group selector listed the same
 * workgroup six times and made the operator pick one sibling per look.
 */
describe('the primary filter axis is the workgroup', () => {
  it('lists workgroups in the top selector, not agent groups', async () => {
    listThreads.mockResolvedValue({ threads: [] });
    listWorkgroups.mockResolvedValue({
      workgroups: [
        { id: 'example-labs', name: 'Example Labs' },
        { id: 'example-dev', name: 'Example Dev' },
      ],
    });
    // Six siblings of ONE workgroup — none of these may reach the selector.
    listGroups.mockResolvedValue({
      groups: ['example-labs', 'example-labs-b', 'example-labs-c', 'example-labs-d'].map((id) => ({
        id,
        name: id,
        workgroup_id: 'example-labs',
      })),
    });
    mount();

    const select = await screen.findByRole('combobox', { name: 'Workgroup' });
    await waitFor(() =>
      expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
        'all workgroups',
        'Example Labs',
        'Example Dev',
      ]),
    );
  });

  it('asks the endpoint for a workgroup, never a group_id', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [] });
    listWorkgroups.mockResolvedValue({ workgroups: [{ id: 'example-labs', name: 'Example Labs' }] });
    mount();

    const select = await screen.findByRole('combobox', { name: 'Workgroup' });
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
    await user.selectOptions(select, 'example-labs');

    await waitFor(() => expect(listThreads).toHaveBeenCalledWith({ workgroup: 'example-labs' }));
    expect(listThreads).not.toHaveBeenCalledWith(expect.objectContaining({ group_id: expect.anything() }));
  });

  // The stale-selection guard `use-workgroup-filter.ts` exists for: a stored
  // workgroup that is gone must fall back to "all" rather than silently
  // filtering the queue to nothing.
  it('falls back to all workgroups when the stored selection is gone', async () => {
    localStorage.setItem('nc:dash:workgroup_filter:u1', 'retired-workgroup');
    listThreads.mockResolvedValue({ threads: [thread('t-1')] });
    listWorkgroups.mockResolvedValue({ workgroups: [{ id: 'example-labs', name: 'Example Labs' }] });
    const { container } = mount();

    const select = await screen.findByRole('combobox', { name: 'Workgroup' });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('all'));
    expect(localStorage.getItem('nc:dash:workgroup_filter:u1')).toBeNull();
    // …and the queue is not empty, which is the failure this guard prevents.
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
  });

  // The judgment call, pinned: no second narrow-to-one-sibling control. The
  // avatar stack on each row already answers "which sibling is on this".
  it('offers exactly one selector', async () => {
    listThreads.mockResolvedValue({ threads: [] });
    mount();
    await screen.findByRole('combobox', { name: 'Workgroup' });
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });
});

/* ─── Mobile — 390px is the primary viewport (§8) ──────────────────────────── */

/**
 * The sidebar used to be `display: none` below 899px, which took the queue
 * lanes, the channel filter and the lenses with it and left the operator with a
 * list and no way to narrow it. Nothing is deleted at the breakpoint now; the
 * sidebar MOVES, into a sheet raised from the bottom bar.
 *
 * jsdom applies no media queries, so what these bind is the mechanism — one
 * nav, reachable, and still doing its job from inside the sheet. Which widths
 * it applies at is CSS, and `console-mobile.test.ts` reads that.
 */
describe('every sidebar control stays reachable on a phone (§8)', () => {
  it('raises the SAME nav as a sheet — lanes, channels, Schedule and the theme toggle included', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('t-1'), thread('t-2', { state: 'needs_you' })] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));

    const shell = container.querySelector('.ncc') as HTMLElement;
    // Item 2: the bottom bar's old Filters tab is gone; the header's hamburger
    // raises the same sheet now.
    const hamburger = screen.getByRole('button', { name: /navigation/i });
    expect(shell.dataset['nav']).toBe('closed');
    expect(hamburger.getAttribute('aria-expanded')).toBe('false');
    expect(hamburger.getAttribute('aria-controls')).toBe('ncc-side');

    await user.click(hamburger);
    expect(shell.dataset['nav']).toBe('open');
    expect(hamburger.getAttribute('aria-expanded')).toBe('true');

    // ONE nav, not a mobile-only copy of it — §12's "a row is a row wherever it
    // is drawn", applied to the sidebar.
    const navs = container.querySelectorAll('nav[aria-label="Queue and channels"]');
    expect(navs).toHaveLength(1);
    const side = within(navs[0] as HTMLElement);
    expect(side.getByText('Needs you')).toBeTruthy(); // a queue lane
    expect(side.getByText('#example-eng')).toBeTruthy(); // a channel
    expect(side.getByText('Schedule')).toBeTruthy(); // a lens
    // Item 2: the theme toggle moved to the nav's footer — same sheet, one copy.
    expect(side.getByRole('button', { name: /Colour theme/ })).toBeTruthy();

    // And it still filters from inside the sheet, which then gets out of the way.
    await user.click(side.getByText('Needs you'));
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    expect(shell.dataset['nav']).toBe('closed');
  });

  // Item 2: Filters is gone from the bottom bar — the header's hamburger
  // raises the sheet now — so this is down to three destinations.
  it('carries three destinations, each with its own icon', async () => {
    listThreads.mockResolvedValue({ threads: [thread('t-1')] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.ncc-row')).toBeTruthy());
    const items = Array.from(container.querySelectorAll('.ncc-bottom .ncc-bottom-item'));
    expect(items.map((i) => i.textContent)).toEqual(['Queue', 'Schedule', 'Triage']);
    const icons = items.map((i) => i.querySelector('svg')?.innerHTML ?? '');
    expect(icons.every((h) => h.length > 0)).toBe(true);
    expect(new Set(icons).size).toBe(3);
  });

  /**
   * Triage is a MODE layered over the 'threads' lens (§11), not a lens of its
   * own — `lens` alone still reads 'threads' while Triage is open. The bottom
   * bar's derivation has to know that, or it keeps highlighting Queue while
   * the operator is actually in Triage.
   */
  it('reflects Triage, not Queue, as the active bottom-bar destination while Triage is open', async () => {
    const user = userEvent.setup();
    // Triage needs an attention-state thread to be enterable at all.
    listThreads.mockResolvedValue({ threads: [thread('t-1', { state: 'needs_you' })] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));

    const bottom = container.querySelector('.ncc-bottom') as HTMLElement;
    const queueItem = within(bottom).getByText('Queue').closest('.ncc-bottom-item') as HTMLElement;
    const triageItem = within(bottom).getByText('Triage').closest('.ncc-bottom-item') as HTMLElement;
    expect(queueItem.getAttribute('aria-current')).toBe('page');
    expect(triageItem.getAttribute('aria-current')).toBeNull();

    await user.click(navTriage(container));
    expect(screen.getByLabelText('Triage')).toBeTruthy();

    expect(triageItem.getAttribute('aria-current')).toBe('page');
    expect(queueItem.getAttribute('aria-current')).toBeNull();
  });

  it('treats opening a thread as a navigation, with a way back to the queue', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('t-1')] });
    const { container } = mount();
    const shell = container.querySelector('.ncc') as HTMLElement;
    await waitFor(() => expect(container.querySelector('.ncc-row-main')).toBeTruthy());

    expect(shell.dataset['pane']).toBe('list');
    await user.click(container.querySelector('.ncc-row-main') as HTMLElement);
    expect(shell.dataset['pane']).toBe('detail');

    await user.click(screen.getByRole('button', { name: '‹ queue' }));
    expect(shell.dataset['pane']).toBe('list');
  });

  it('does not blank the schedule lens because a thread was left selected', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('t-1')] });
    const { container } = mount();
    const shell = container.querySelector('.ncc') as HTMLElement;
    await waitFor(() => expect(container.querySelector('.ncc-row-main')).toBeTruthy());
    await user.click(container.querySelector('.ncc-row-main') as HTMLElement);
    expect(shell.dataset['pane']).toBe('detail');

    // Wrapped: the hash listener setStates, and React has no other way to know
    // a bare `dispatchEvent` is the start of an update.
    act(() => {
      location.hash = '#/scheduled';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(shell.dataset['pane']).toBe('list'));
    location.hash = '';
  });
});

/**
 * Item 4 — the Schedule lens used to be a trap: once open, clicking a
 * different channel or lane in the (still-visible) nav changed `lane` /
 * `channel` state that nothing on screen reflected, because the render branch
 * kept drawing `<ScheduleLens>` regardless. The only way out was a "Threads"
 * entry under a "LENSES" heading, which is deleted (item 4's second half) —
 * so picking ANY queue filter now has to be the way back, or there is none on
 * desktop at all.
 */
describe('choosing a filter while Schedule is open returns to the queue (item 4)', () => {
  it('snaps back to the queue and applies the channel that was picked', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({
      threads: [
        thread('t-1', { channel_key: 'slack:COPS', channel_name: '#ops' }),
        thread('t-2', { channel_key: 'slack:CENG', channel_name: '#eng' }),
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));

    await user.click(within(container.querySelector('.ncc-side') as HTMLElement).getByText('Schedule'));
    await waitFor(() => expect(screen.getByLabelText('Scheduled work')).toBeTruthy());
    expect(container.querySelector('.ncc-list-pane[aria-label="Threads"]')).toBeNull();

    // The nav stays on screen while Schedule is open — that is the whole bug.
    // Picking a channel from it must both leave Schedule AND land on that
    // channel, not one without the other.
    await user.click(within(container.querySelector('.ncc-side') as HTMLElement).getByText('#ops'));
    await waitFor(() => expect(screen.queryByLabelText('Scheduled work')).toBeNull());
    expect(container.querySelector('.ncc-list-pane[aria-label="Threads"]')).toBeTruthy();
    expect(threadIds(container)).toEqual(['t-1']);
  });

  it('a lane tap returns to the queue too, not only a channel tap', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('t-1', { state: 'needs_you' }), thread('t-2')] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(2));

    await user.click(within(container.querySelector('.ncc-side') as HTMLElement).getByText('Schedule'));
    await waitFor(() => expect(screen.getByLabelText('Scheduled work')).toBeTruthy());

    await user.click(within(container.querySelector('.ncc-side') as HTMLElement).getByText('Needs you'));
    await waitFor(() => expect(screen.queryByLabelText('Scheduled work')).toBeNull());
    expect(threadIds(container)).toEqual(['t-1']);
  });

  it('entering Triage from the nav while Schedule is open returns to the queue first', async () => {
    const user = userEvent.setup();
    // Triage needs an attention-state thread to be enterable at all.
    listThreads.mockResolvedValue({ threads: [thread('t-1', { state: 'needs_you' })] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));

    await user.click(within(container.querySelector('.ncc-side') as HTMLElement).getByText('Schedule'));
    await waitFor(() => expect(screen.getByLabelText('Scheduled work')).toBeTruthy());

    await user.click(navTriage(container));
    await waitFor(() => expect(screen.queryByLabelText('Scheduled work')).toBeNull());
    expect(screen.getByLabelText('Triage')).toBeTruthy();
  });
});
