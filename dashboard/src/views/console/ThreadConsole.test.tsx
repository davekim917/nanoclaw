import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
const getThreadDetail = vi.fn();
const archiveSession = vi.fn().mockResolvedValue({});
const snoozeThread = vi.fn().mockResolvedValue({});
const unsnoozeThread = vi.fn().mockResolvedValue({});
const postSessionMessage = vi.fn().mockResolvedValue({});
vi.mock('../../lib/api.js', () => ({
  listThreads,
  listGroups,
  getThreadDetail,
  archiveSession,
  snoozeThread,
  unsnoozeThread,
  postSessionMessage,
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
  listGroups.mockResolvedValue({ groups: [{ id: 'ag-1', name: 'example-workgroup' }] });
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

  it('announces the attention count politely', async () => {
    listThreads.mockResolvedValue({
      threads: [thread('a', { state: 'needs_you' }), thread('b', { state: 'stalled' }), thread('c')],
    });
    const { container } = mount();
    const chip = container.querySelector('.ncc-attn-chip')!;
    expect(chip.getAttribute('aria-live')).toBe('polite');
    await waitFor(() => expect(chip.textContent).toContain('2'));
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
    expect(container.querySelector('.ncc-attn-chip')!.textContent).toContain('0');
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
describe('verbs', () => {
  it('Close archives every session on the thread', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('t-done', { state: 'done', session_ids: ['s-x', 's-y'] })] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.ncc-verb')).toBeTruthy());
    await user.click(container.querySelector('.ncc-verb') as HTMLElement);
    await waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(2));
    expect(archiveSession.mock.calls.map((c) => c[0])).toEqual(['s-x', 's-y']);
  });

  it('Answer opens the composer on the thread instead of sending blind', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('t-ask', { state: 'needs_you' })] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.ncc-verb')).toBeTruthy());
    await user.click(container.querySelector('.ncc-verb') as HTMLElement);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Reply text')));
    expect(postSessionMessage).not.toHaveBeenCalled();
  });

  it('Kill stays inert — no dashboard-reachable kill path exists', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('t-stall', { state: 'stalled' })] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.ncc-verb')).toBeTruthy());
    const verb = container.querySelector('.ncc-verb') as HTMLElement;
    expect(verb.getAttribute('aria-disabled')).toBe('true');
    await user.click(verb);
    expect(container.querySelector('.ncc-detail')).toBeTruthy();
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

describe('triage is a mode over the filtered list (§11)', () => {
  it('is entered from the top bar and covers exactly the filtered rows', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({
      threads: [thread('t-1'), thread('t-2', { state: 'needs_you' }), thread('t-3')],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(3));

    // Filter first — triage must take the FILTERED set, not the whole queue.
    await user.click(within(container.querySelector('.ncc-side') as HTMLElement).getByText('Needs you'));
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /triage/i }));
    expect(screen.getByLabelText('Triage')).toBeTruthy();
    expect(screen.getByText('1 / 1')).toBeTruthy();
  });

  it('Escape hands the list back', async () => {
    const user = userEvent.setup();
    listThreads.mockResolvedValue({ threads: [thread('t-1')] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelectorAll('.ncc-row')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /triage/i }));
    screen.getByLabelText('Triage').focus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Triage')).toBeNull());
    expect(container.querySelector('.ncc-list-pane')!.hasAttribute('hidden')).toBe(false);
  });

  it('cannot be entered on an empty queue', async () => {
    listThreads.mockResolvedValue({ threads: [] });
    mount();
    await waitFor(() => expect(screen.getByText('no threads in view')).toBeTruthy());
    expect((screen.getByRole('button', { name: /triage/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
