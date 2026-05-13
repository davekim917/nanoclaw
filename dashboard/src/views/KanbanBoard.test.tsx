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
  listGroups: vi.fn(),
  authMe: vi.fn(),
  exchangeToken: vi.fn(),
  listSessions: vi.fn(),
  getTask: vi.fn(),
  postSteer: vi.fn(),
  retryTask: vi.fn(),
  archiveTask: vi.fn().mockResolvedValue({ task_id: 'spawn-1' }),
  unarchiveTask: vi.fn().mockResolvedValue({ task_id: 'spawn-1' }),
  bulkArchive: vi.fn().mockResolvedValue({ archived: 0 }),
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

  it('mobile nav (Board / Inbox) invokes onRouteChange', async () => {
    // C8: mobile primary nav is now Board + Inbox (Sessions demoted to a
    // small debug link rendered from the InboxBoard pulse-meta strip).
    const onRouteChange = vi.fn();
    vi.mocked(useSWR).mockReturnValue({
      data: { tasks: [] },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={onRouteChange} />);
    await userEvent.click(screen.getByRole('button', { name: /^Inbox$/i }));
    expect(onRouteChange).toHaveBeenCalledWith('inbox');
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
    expect(container.querySelector('.nc-col-head.attention')).toBeTruthy();
    expect(container.querySelector('.nc-col-head.working')).toBeTruthy();
    expect(container.querySelector('.nc-col-head.done')).toBeTruthy();
  });

  it('renders a dismiss button on terminal cards that calls archiveTask', async () => {
    const { archiveTask } = await import('../lib/api.js');
    vi.mocked(useSWR).mockReturnValue({
      data: { tasks: [task({ task_id: 'spawn-fail', status: 'failed' })] },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={noop} />);
    const dismiss = screen.getByRole('button', { name: /dismiss task/i });
    await userEvent.click(dismiss);
    expect(vi.mocked(archiveTask)).toHaveBeenCalledWith('spawn-fail');
  });

  it('does not render dismiss button on running tasks', () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { tasks: [task({ status: 'running' })] },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={noop} />);
    expect(screen.queryByRole('button', { name: /dismiss task/i })).toBeNull();
  });

  it('Show archived toggle flips SWR fetch to include_archived=1', async () => {
    const { listTasks } = await import('../lib/api.js');
    vi.mocked(useSWR).mockImplementation((_key, fetcher) => {
      // call the fetcher so we can assert what listTasks was invoked with
      if (typeof fetcher === 'function') {
        void (fetcher as () => Promise<unknown>)();
      }
      return { data: { tasks: [] }, mutate: vi.fn() } as unknown as ReturnType<typeof useSWR>;
    });

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={noop} />);
    vi.mocked(listTasks).mockClear();
    await userEvent.click(screen.getByRole('checkbox', { name: /show archived/i }));
    // After the toggle, the SWR key change re-invokes the fetcher with include_archived
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(
      expect.objectContaining({ include_archived: true }),
    );
  });

  it('group title shows "Agent Board" by default and the group name when filter is selected', async () => {
    localStorage.clear();
    // Two-key SWR mock: tasks vs groups. Cache keys are the first arg to useSWR.
    vi.mocked(useSWR).mockImplementation((key) => {
      const tag = Array.isArray(key) ? key[0] : key;
      if (tag === '/dashboard/api/groups') {
        return {
          data: { groups: [{ id: 'ag-1', name: 'illysium' }, { id: 'ag-2', name: 'axie-dev' }] },
          mutate: vi.fn(),
        } as unknown as ReturnType<typeof useSWR>;
      }
      return {
        data: { tasks: [] },
        mutate: vi.fn(),
      } as unknown as ReturnType<typeof useSWR>;
    });

    render(<KanbanBoard authMe={mockAuthMe} route="board" onRouteChange={noop} />);
    // Default: brand label reads the fallback
    expect(screen.getByText('Agent Board')).toBeInTheDocument();

    // Open menu, pick illysium
    await userEvent.click(screen.getByRole('button', { name: /Agent Board/i }));
    await userEvent.click(screen.getByRole('option', { name: /^illysium$/i }));

    // Header morphs to the group name, fallback no longer in the doc (or only
    // in the menu, which is now closed)
    expect(screen.getByRole('button', { name: /illysium/i })).toBeInTheDocument();

    // localStorage was written
    expect(localStorage.getItem('nc:dash:group_filter:u1')).toBe('ag-1');
    localStorage.clear();
  });
});
