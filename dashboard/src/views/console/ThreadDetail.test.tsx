import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import userEvent from '@testing-library/user-event';
import type { ThreadSummary } from '../../lib/api.js';

/**
 * The reply-target seam (DESIGN §10.3).
 *
 * A thread is N sessions and the steer path writes into exactly ONE inbound
 * queue, so these tests bind the two things that make the composer honest:
 * the default target is the agent whose state drove the row's urgency, and the
 * send carries whichever session the operator actually chose.
 */

const getThreadDetail = vi.fn();
const postSessionMessage = vi.fn().mockResolvedValue({});
vi.mock('../../lib/api.js', () => ({
  getThreadDetail,
  postSessionMessage,
  archiveSession: vi.fn(),
  snoozeThread: vi.fn(),
  unsnoozeThread: vi.fn(),
}));

const { ThreadDetail } = await import('./ThreadDetail.js');

function thread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    thread_id: 'slack:CTESTCHAN01:1700000000.11',
    synthetic: false,
    channel_key: 'slack:CTESTCHAN01',
    channel_name: '#example-eng',
    title: 'Which OAuth flow for the retry path?',
    participants: [
      { agent_group_id: 'ag-1', name: 'Alpha', session_id: 's-alpha', avatarUrl: null, provider: 'claude' },
      { agent_group_id: 'ag-2', name: 'Bravo', session_id: 's-bravo', avatarUrl: null, provider: 'codex' },
    ],
    last_activity_at: '2026-08-20T09:00:00.000Z',
    state: 'needs_you',
    session_ids: ['s-alpha', 's-bravo'],
    container_status: 'idle',
    provider_status: null,
    current_tool: null,
    tool_started_at: null,
    // The state's driver is the SECOND participant here on purpose: picking
    // `participants[0]` would pass a weaker test and send the operator's answer
    // to an agent that never asked.
    reply_target_session_id: 's-bravo',
    snoozed: false,
    ...over,
  };
}

function renderDetail(t: ThreadSummary | null, props: Record<string, unknown> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ThreadDetail thread={t} {...props} />
    </SWRConfig>,
  );
}

beforeEach(() => {
  postSessionMessage.mockClear();
  getThreadDetail.mockResolvedValue({ thread: thread(), transcript: [] });
});

describe('the reply target is the request, not decoration', () => {
  it('defaults to the agent whose state drove the row', async () => {
    renderDetail(thread());
    const select = (await screen.findByLabelText('Reply goes to')) as HTMLSelectElement;
    expect(select.value).toBe('s-bravo');
  });

  it('falls back to the most recent participant when the server names no target', async () => {
    renderDetail(thread({ reply_target_session_id: null }));
    const select = (await screen.findByLabelText('Reply goes to')) as HTMLSelectElement;
    expect(select.value).toBe('s-alpha');
  });

  it('lists every participant, and no broadcast option', async () => {
    renderDetail(thread());
    const select = (await screen.findByLabelText('Reply goes to')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Alpha', 'Bravo']);
  });

  it('sends to the chosen session, not the default one', async () => {
    const user = userEvent.setup();
    renderDetail(thread());
    await user.selectOptions(await screen.findByLabelText('Reply goes to'), 's-alpha');
    await user.type(screen.getByLabelText('Reply text'), 'use the device flow');
    await user.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(postSessionMessage).toHaveBeenCalledTimes(1));
    expect(postSessionMessage.mock.calls[0]![0]).toBe('s-alpha');
    expect(postSessionMessage.mock.calls[0]![1].text).toBe('use the device flow');
  });

  it('fires onSent once the reply lands, so the caller can advance', async () => {
    const user = userEvent.setup();
    const onSent = vi.fn();
    renderDetail(thread(), { onSent });
    await user.type(await screen.findByLabelText('Reply text'), 'ack');
    await user.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it('says so rather than offering a queue when no agent is on the thread', async () => {
    renderDetail(thread({ participants: [], session_ids: [] }));
    expect(await screen.findByText(/no inbound queue to reply into/i)).toBeTruthy();
    expect(screen.queryByLabelText('Reply goes to')).toBeNull();
  });

  it('does not send an empty reply', async () => {
    const user = userEvent.setup();
    renderDetail(thread());
    await user.type(await screen.findByLabelText('Reply text'), '   ');
    expect((screen.getByRole('button', { name: 'send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(postSessionMessage).not.toHaveBeenCalled();
  });
});
