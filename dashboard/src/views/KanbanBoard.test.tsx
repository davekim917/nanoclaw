import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  listTasks: vi.fn(),
  authMe: vi.fn(),
  exchangeToken: vi.fn(),
  listSessions: vi.fn(),
  getTask: vi.fn(),
  postSteer: vi.fn(),
  retryTask: vi.fn(),
}));

import { KanbanBoard } from './KanbanBoard.js';
import useSWR from 'swr';

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

function task(overrides: Record<string, unknown> = {}): {
  task_id: string;
  parent_session_id: string;
  task_content: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  admitted_at: string;
} {
  return {
    task_id: 'spawn-1',
    parent_session_id: 'sess-1',
    task_content: '## Goal\nDo something important.',
    status: 'running',
    admitted_at: new Date().toISOString(),
    ...overrides,
  } as ReturnType<typeof task>;
}

describe('KanbanBoard', () => {
  beforeEach(() => stubViewport(true));
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the pulse breakdown counts', () => {
    vi.mocked(useSWR).mockReturnValue({
      data: {
        tasks: [
          task({ task_id: 'a', status: 'running' }),
          task({ task_id: 'b', status: 'failed' }),
          task({ task_id: 'c', status: 'completed' }),
        ],
      },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={noop} />);
    expect(screen.getByText('Failed', { selector: '.lbl' })).toBeInTheDocument();
    expect(screen.getByText('Running', { selector: '.lbl' })).toBeInTheDocument();
    expect(screen.getByText('Done', { selector: '.lbl' })).toBeInTheDocument();
  });

  it('renders filter chips and switches active chip on click', async () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { tasks: [task({ status: 'failed' })] },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={noop} />);
    const allChip = screen.getByRole('tab', { name: /^all/i });
    expect(allChip.getAttribute('aria-selected')).toBe('true');
    const needsChip = screen.getByRole('tab', { name: /needs me/i });
    await userEvent.click(needsChip);
    expect(needsChip.getAttribute('aria-selected')).toBe('true');
  });

  it('clicking a task card navigates to /task/<id>', async () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { tasks: [task({ task_id: 'spawn-42', status: 'running' })] },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={noop} />);
    const cards = screen.getAllByRole('button', { name: /running/i });
    const card = cards.find((el) => el.dataset.taskId === 'spawn-42');
    expect(card).toBeTruthy();
    await userEvent.click(card!);
    expect(location.hash).toBe('#/task/spawn-42');
  });

  it('SSE task_event invalidates SWR', async () => {
    const mutate = vi.fn();
    vi.mocked(useSWR).mockReturnValue({
      data: { tasks: [] },
      mutate,
    } as unknown as ReturnType<typeof useSWR>);

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={noop} />);
    const sseModule = await import('../lib/sse.ts');
    const emitEvent = (sseModule as unknown as { __emitEvent: (k: string, p: unknown) => void }).__emitEvent;
    emitEvent('task_event', { kind: 'admit', task_id: 'spawn-new' });
    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });

  it('nav link click invokes onRouteChange', async () => {
    const onRouteChange = vi.fn();
    vi.mocked(useSWR).mockReturnValue({
      data: { tasks: [] },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={onRouteChange} />);
    await userEvent.click(screen.getByRole('button', { name: /^Sessions$/i }));
    expect(onRouteChange).toHaveBeenCalledWith('sessions');
  });

  it('renders the empty state when no tasks', () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { tasks: [] },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={noop} />);
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it('desktop layout renders 3 attention columns', () => {
    stubViewport(false);
    vi.mocked(useSWR).mockReturnValue({
      data: { tasks: [task({ status: 'failed' })] },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    const { container } = render(
      <KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={noop} />
    );
    expect(screen.getByRole('heading', { name: /spawn board/i })).toBeInTheDocument();
    expect(container.querySelector('.nc-col-head.attention')).toBeTruthy();
    expect(container.querySelector('.nc-col-head.working')).toBeTruthy();
    expect(container.querySelector('.nc-col-head.done')).toBeTruthy();
  });
});
