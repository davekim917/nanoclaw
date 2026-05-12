import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('swr', () => {
  const useSWR = vi.fn();
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
  getTask: vi.fn(),
  postSteer: vi.fn(),
  retryTask: vi.fn(),
  authMe: vi.fn(),
  exchangeToken: vi.fn(),
  listTasks: vi.fn(),
  listSessions: vi.fn(),
}));

import { TaskDetail } from './TaskDetail.js';
import useSWR from 'swr';
import { postSteer } from '../lib/api.js';

const mockAuthMe = {
  user_id: 'u1',
  scopes: { role: 'owner', allowed_group_ids: [], no_filter: true },
};

const baseTask = {
  task_id: 'spawn-99-abcd-1234-efgh',
  parent_session_id: 'sess-1',
  task_content: '## Goal\nResolve **XZO-99** — fix the thing.\n\n## Inputs\n- Repo: foo',
  status: 'running' as const,
  admitted_at: '2026-05-01T10:00:00Z',
  started_at: '2026-05-01T10:00:01Z',
};

const baseTranscript = [
  { id: 'msg-1', seq: 1, kind: 'chat', timestamp: '2026-05-01T10:00:00Z', content: { text: 'hi' }, direction: 'inbound' as const, source: 'dashboard' as const },
  { id: 'msg-2', seq: 2, kind: 'chat', timestamp: '2026-05-01T10:00:01Z', content: { text: 'hello' }, direction: 'outbound' as const, source: 'agent' as const },
];

describe('TaskDetail', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the task crumb and derived goal title', () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { task: baseTask, transcript: baseTranscript },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99-abcd-1234-efgh" />);
    expect(screen.getByText(/spawn-99-abcd-1234/)).toBeInTheDocument();
    expect(screen.getByText(/fix the thing/i)).toBeInTheDocument();
    expect(screen.getByText('XZO-99')).toBeInTheDocument();
  });

  it('expands transcript section and shows messages when toggled', async () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { task: baseTask, transcript: baseTranscript },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99-abcd-1234-efgh" />);
    expect(screen.queryByText('hi')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Transcript/i }));
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('submits steer with a UUIDv4 idempotency_key', async () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { task: baseTask, transcript: baseTranscript },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);
    vi.mocked(postSteer).mockResolvedValue({
      task_id: 'spawn-99-abcd-1234-efgh',
      message_id: 'msg-1',
      echo_status: 'pending',
    });

    render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99-abcd-1234-efgh" />);
    await userEvent.type(screen.getByPlaceholderText(/steer/i), 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(postSteer).toHaveBeenCalledOnce());
    const [tid, body] = vi.mocked(postSteer).mock.calls[0] as [
      string,
      { idempotency_key: string; text: string },
    ];
    expect(tid).toBe('spawn-99-abcd-1234-efgh');
    expect(body.text).toBe('hello');
    expect(body.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('disables submit when empty', () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { task: baseTask, transcript: baseTranscript },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);
    render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99-abcd-1234-efgh" />);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('disables submit and shows red counter when over 4000 chars', () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { task: baseTask, transcript: baseTranscript },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);
    render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99-abcd-1234-efgh" />);
    const textarea = screen.getByPlaceholderText(/steer/i);
    fireEvent.change(textarea, { target: { value: 'a'.repeat(4001) } });
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    expect(screen.getByText(/4001\s*\/\s*4000/)).toBeInTheDocument();
  });

  it('shows rate-limited message with retry-after seconds', async () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { task: baseTask, transcript: baseTranscript },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);
    vi.mocked(postSteer).mockRejectedValue({
      status: 429,
      error: 'rate_limit_exceeded',
      retry_after: 5,
    });

    render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99-abcd-1234-efgh" />);
    await userEvent.type(screen.getByPlaceholderText(/steer/i), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/rate limited.*5s/i);
    });
  });

  it('generates a fresh UUID after a 422 idempotency conflict', async () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { task: baseTask, transcript: baseTranscript },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);
    vi.mocked(postSteer)
      .mockRejectedValueOnce({
        status: 422,
        error: 'mismatched_idempotency_payload',
      })
      .mockResolvedValueOnce({
        task_id: 'spawn-99-abcd-1234-efgh',
        message_id: 'msg-2',
        echo_status: 'pending',
      });

    render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99-abcd-1234-efgh" />);
    await userEvent.type(screen.getByPlaceholderText(/steer/i), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/idempotency conflict/i);
    });
    await userEvent.type(screen.getByPlaceholderText(/steer/i), 'retry');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(postSteer).toHaveBeenCalledTimes(2));

    const key1 = (vi.mocked(postSteer).mock.calls[0] as [string, { idempotency_key: string }])[1].idempotency_key;
    const key2 = (vi.mocked(postSteer).mock.calls[1] as [string, { idempotency_key: string }])[1].idempotency_key;
    expect(key1).not.toBe(key2);
  });

  it('inbound_message SSE invalidates SWR when task_id matches', async () => {
    const mutate = vi.fn();
    vi.mocked(useSWR).mockReturnValue({
      data: { task: baseTask, transcript: baseTranscript },
      mutate,
    } as unknown as ReturnType<typeof useSWR>);

    render(<TaskDetail authMe={mockAuthMe} taskId="spawn-99-abcd-1234-efgh" />);
    const sseModule = await import('../lib/sse.ts');
    const emitEvent = (sseModule as unknown as { __emitEvent: (k: string, p: unknown) => void }).__emitEvent;
    emitEvent('inbound_message', { task_id: 'spawn-99-abcd-1234-efgh' });
    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });

  it('shows retry button for failed task and not for running task', () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { task: baseTask, transcript: baseTranscript },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);
    const { rerender } = render(
      <TaskDetail authMe={mockAuthMe} taskId="spawn-99-abcd-1234-efgh" />
    );
    expect(screen.queryByRole('button', { name: /retry task/i })).toBeNull();

    vi.mocked(useSWR).mockReturnValue({
      data: { task: { ...baseTask, status: 'failed', failed_at: '2026-05-01T10:01:00Z' }, transcript: baseTranscript },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);
    rerender(<TaskDetail authMe={mockAuthMe} taskId="spawn-99-abcd-1234-efgh" />);
    expect(screen.getByRole('button', { name: /retry task/i })).toBeInTheDocument();
  });
});
