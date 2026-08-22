import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import userEvent from '@testing-library/user-event';
import type { ThreadSummary } from '../../lib/api.js';

/**
 * The ownerless row's verb.
 *
 * An adversarial review found the affordance dead: the row carried an
 * `assignable_agents` list and a composer, but the send behind it routes
 * through the thread-message path, which parses a channel out of the thread id
 * — and an ownerless row's id is a board dedupe key, not a thread id. It could
 * only ever 409.
 *
 * These bind the fix: an ownerless row gets the ASSIGN path, a row with a
 * session never does, and once the work is handed over the button is replaced
 * by a statement of who has it rather than staying live for a second press.
 */
const getThreadDetail = vi.fn();
const postThreadMessage = vi.fn().mockResolvedValue({ created_session: false, handoff: null });
const assignItem = vi.fn();
vi.mock('../../lib/api.js', () => ({
  getThreadDetail,
  postThreadMessage,
  assignItem,
  closeThread: vi.fn(),
  snoozeThread: vi.fn(),
  unsnoozeThread: vi.fn(),
}));

const { ThreadDetail } = await import('./ThreadDetail.js');

/** An ownerless board row: no sessions, no participants, an attention source. */
function item(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    thread_id: 'board:EXAMPLE-APP#817',
    synthetic: false,
    channel_key: 'slack:CEXAMPLE001',
    channel_name: '#example-room',
    title: "What's new digest",
    participants: [],
    assignable_agents: [
      { agent_group_id: 'ag-1', name: 'Alpha' },
      { agent_group_id: 'ag-2', name: 'Bravo' },
    ],
    last_activity_at: '2026-08-20T09:00:00.000Z',
    state: 'unassigned',
    session_ids: [],
    container_status: 'unknown',
    provider_status: null,
    current_tool: null,
    tool_started_at: null,
    reply_target_session_id: null,
    snoozed: false,
    attention_source: {
      kind: 'release-board',
      as_of: '2026-08-20T11:30:00.000Z',
      url: 'https://github.com/example-org/example-app/pull/817',
      next_action: '@releasebot ship 817',
      assigned: null,
    },
    ...over,
  };
}

/** A perfectly ordinary session-backed thread. */
function owned(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return item({
    thread_id: 'slack:CEXAMPLE001:1700000000.11',
    participants: [
      { agent_group_id: 'ag-1', name: 'Alpha', session_id: 's-alpha', avatarUrl: null, provider: 'claude' },
    ],
    assignable_agents: [{ agent_group_id: 'ag-2', name: 'Bravo' }],
    session_ids: ['s-alpha'],
    state: 'idle',
    reply_target_session_id: 's-alpha',
    ...over,
  });
}

function renderDetail(t: ThreadSummary, props: Record<string, unknown> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ThreadDetail thread={t} {...props} />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  assignItem.mockResolvedValue({ ok: true, seriesId: 'x', agent: 'Alpha', channel: '#example-room', etaSeconds: 120 });
  getThreadDetail.mockResolvedValue({ thread: item(), transcript: [] });
});

describe('the ownerless row assigns', () => {
  it('offers Assign to, not Send to — there is no thread to say anything in yet', async () => {
    renderDetail(item());
    expect(await screen.findByLabelText('Assign to')).toBeTruthy();
    expect(screen.queryByLabelText('Send to')).toBeNull();
    expect(screen.queryByLabelText('Message text')).toBeNull();
  });

  it('sends the ROW id and the chosen agent, and nothing else', async () => {
    const user = userEvent.setup();
    renderDetail(item());
    await user.selectOptions(await screen.findByLabelText('Assign to'), 'ag-2');
    await user.click(screen.getByRole('button', { name: 'assign' }));
    await waitFor(() => expect(assignItem).toHaveBeenCalledTimes(1));
    expect(assignItem).toHaveBeenCalledWith('board:EXAMPLE-APP#817', 'ag-2');
    // The message path must never be reached from here — it cannot succeed.
    expect(postThreadMessage).not.toHaveBeenCalled();
  });

  it('reports where the work landed and when to expect it', async () => {
    const user = userEvent.setup();
    renderDetail(item());
    await user.click(await screen.findByRole('button', { name: 'assign' }));
    await screen.findByText(/Assigned to Alpha in #example-room/);
  });

  it('fires onSent so the queue revalidates', async () => {
    const user = userEvent.setup();
    const onSent = vi.fn();
    renderDetail(item(), { onSent });
    await user.click(await screen.findByRole('button', { name: 'assign' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it('says so rather than offering a button when nobody is wired to the room', async () => {
    renderDetail(item({ assignable_agents: [] }));
    expect(await screen.findByText(/No agent is wired to #example-room/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'assign' })).toBeNull();
  });

  it('a session-backed thread never offers assign — it gets the reply composer', async () => {
    renderDetail(owned());
    expect(await screen.findByLabelText('Send to')).toBeTruthy();
    expect(screen.queryByLabelText('Assign to')).toBeNull();
  });

  it('a session-backed thread that somehow carries a source still gets the reply composer', async () => {
    // The predicate is structural — `session_ids` decides, not the presence of
    // a source — so a future producer that decorates an ordinary thread cannot
    // reroute its sends.
    renderDetail(owned({ attention_source: item().attention_source! }));
    expect(await screen.findByLabelText('Send to')).toBeTruthy();
    expect(screen.queryByLabelText('Assign to')).toBeNull();
  });
});

describe('once assigned, the button does not stay live', () => {
  const assigned = () =>
    item({
      attention_source: {
        ...item().attention_source!,
        assigned: { agent_group_id: 'ag-1', agent_name: 'Alpha', at: '2026-08-20T08:58:00.000Z', by: 'Olive Owner' },
      },
    });

  it('names who has it, who sent it there, and how long ago', async () => {
    renderDetail(assigned());
    expect(await screen.findByText(/Assigned to Alpha by Olive Owner/)).toBeTruthy();
  });

  it('offers no second press — the affordance is gone, not disabled-looking', async () => {
    renderDetail(assigned());
    await screen.findByText(/Assigned to Alpha/);
    expect(screen.queryByRole('button', { name: 'assign' })).toBeNull();
    expect(screen.queryByLabelText('Assign to')).toBeNull();
  });
});
