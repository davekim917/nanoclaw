import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('swr', () => {
  const mutate = vi.fn();
  const useSWR = vi.fn(() => ({ data: undefined, mutate }));
  return { default: useSWR };
});

vi.mock('../lib/sse.ts', () => ({
  subscribe: vi.fn(() => () => {}),
  startSSE: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  getSessionDetail: vi.fn(),
  postSessionMessage: vi.fn().mockResolvedValue({ task_id: 't', message_id: 'm', echo_status: 'ok' }),
}));

import { SessionDetail } from './SessionDetail.js';
import useSWR from 'swr';

const authMe = { user_id: 'u1', scopes: { role: 'owner', allowed_group_ids: [], no_filter: true } };

const detail = {
  session: {
    session_id: 'sess-1',
    agent_group_id: 'ava',
    messaging_group_id: '#qa-room',
    thread_id: null,
    container_status: 'running',
    last_active: new Date().toISOString(),
    last_inbound_at: new Date().toISOString(),
    title: 'the flaky checkout test',
    attention_state: 'needs_me',
    archived_at: null,
    attached_task_id: null,
  },
  transcript: [
    { direction: 'in', kind: 'chat', seq: 2, timestamp: new Date().toISOString(), text: 'is it green yet?' },
  ],
};

function mountWithData(): void {
  vi.mocked(useSWR).mockReturnValue({ data: detail, mutate: vi.fn() } as never);
  render(<SessionDetail authMe={authMe} sessionId="sess-1" />);
}

describe('SessionDetail', () => {
  afterEach(() => vi.clearAllMocks());

  it('says what the session is and offers only the Observatory as a way out', () => {
    mountWithData();
    expect(screen.getByText('the flaky checkout test')).toBeTruthy();
    expect(screen.getByText('ava')).toBeTruthy();
    expect(screen.getByText('#qa-room')).toBeTruthy();
    expect(screen.getByText('sess-1')).toBeTruthy();

    const back = screen.getByRole('link', { name: /back to the observatory/i });
    expect(back.getAttribute('href')).toBe('#/observatory');
    // The steer page carries no dismiss/archive and no route into the legacy
    // boards — removing those escape hatches is the point of this page.
    expect(screen.queryByText(/dismiss|archive/i)).toBeNull();
    expect(document.querySelectorAll('a[href*="#/inbox"], a[href*="#/task"]').length).toBe(0);
  });

  it('still steers: typing and sending posts the message', async () => {
    const { postSessionMessage } = await import('../lib/api.js');
    mountWithData();
    await userEvent.type(screen.getByRole('textbox'), 'try again');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(vi.mocked(postSessionMessage)).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ text: 'try again' }),
    );
  });
});
