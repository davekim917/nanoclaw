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
  listSessions: vi.fn(),
  listGroups: vi.fn(),
  archiveSession: vi.fn().mockResolvedValue({ session_id: 'sess-1', archived_at: 'now' }),
  unarchiveSession: vi.fn().mockResolvedValue({ session_id: 'sess-1' }),
}));

import { InboxBoard } from './InboxBoard.js';
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

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    container_status: 'idle',
    last_active: new Date().toISOString(),
    title: 'a session',
    attention_state: 'idle',
    archived_at: null,
    attached_task_id: null,
    ...overrides,
  };
}

describe('InboxBoard', () => {
  beforeEach(() => stubViewport(false));
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders four attention lanes', () => {
    vi.mocked(useSWR).mockReturnValue({
      data: {
        sessions: [
          session({ session_id: 'a', attention_state: 'needs_me' }),
          session({ session_id: 'b', attention_state: 'active' }),
          session({ session_id: 'c', attention_state: 'idle' }),
          session({ session_id: 'd', attention_state: 'stale' }),
        ],
      },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    const { container } = render(<InboxBoard authMe={mockAuthMe} route="inbox" onRouteChange={noop} />);
    expect(screen.getByText('Needs me', { selector: '.lbl' })).toBeInTheDocument();
    // Desktop renders all four lanes as columns; mobile collapses empties.
    expect(container.querySelectorAll('.nc-col').length).toBe(4);
  });

  it('renders pulse breakdown with attention-state counts', () => {
    vi.mocked(useSWR).mockReturnValue({
      data: {
        sessions: [
          session({ session_id: 'a', attention_state: 'needs_me' }),
          session({ session_id: 'b', attention_state: 'needs_me' }),
          session({ session_id: 'c', attention_state: 'active' }),
        ],
      },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    const { container } = render(<InboxBoard authMe={mockAuthMe} route="inbox" onRouteChange={noop} />);
    const breadcells = container.querySelectorAll('.breadcell');
    // Needs me = 2, Active = 1, Idle = 0, Stale = 0
    expect(breadcells.length).toBe(4);
    expect(breadcells[0]!.querySelector('.n')!.textContent).toBe('2'); // needs
    expect(breadcells[1]!.querySelector('.n')!.textContent).toBe('1'); // active
  });

  it('subscribes to session_event and invalidates on emit (debounced)', async () => {
    const mutate = vi.fn();
    vi.mocked(useSWR).mockReturnValue({
      data: { sessions: [] },
      mutate,
    } as unknown as ReturnType<typeof useSWR>);

    render(<InboxBoard authMe={mockAuthMe} route="inbox" onRouteChange={noop} />);
    const sseModule = await import('../lib/sse.ts');
    const emitEvent = (sseModule as unknown as { __emitEvent: (k: string, p: unknown) => void }).__emitEvent;
    // Emit a small burst — debounce should coalesce to a single mutate.
    emitEvent('session_event', { kind: 'inbound', session_id: 'sess-1', agent_group_id: 'ag-1' });
    emitEvent('session_event', { kind: 'outbound', session_id: 'sess-1', agent_group_id: 'ag-1' });
    emitEvent('session_event', { kind: 'container_state', session_id: 'sess-1', agent_group_id: 'ag-1' });
    await waitFor(() => expect(mutate).toHaveBeenCalled(), { timeout: 1000 });
    expect(mutate.mock.calls.length).toBe(1);
  });

  it('clicking a session with attached_task navigates to TaskDetail', async () => {
    vi.mocked(useSWR).mockReturnValue({
      data: {
        sessions: [
          session({ session_id: 'sess-task', attention_state: 'active', attached_task_id: 'task-99' }),
        ],
      },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    location.hash = '';
    render(<InboxBoard authMe={mockAuthMe} route="inbox" onRouteChange={noop} />);
    const cards = screen.getAllByRole('button', { name: /active/i });
    const card = cards.find((el) => el.dataset.sessionId === 'sess-task');
    expect(card).toBeTruthy();
    await userEvent.click(card!);
    expect(location.hash).toBe('#/task/task-99');
  });

  it('clicking a direct-conversation session navigates to SessionDetail', async () => {
    vi.mocked(useSWR).mockReturnValue({
      data: {
        sessions: [
          session({ session_id: 'sess-direct', attention_state: 'idle', attached_task_id: null }),
        ],
      },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    location.hash = '';
    render(<InboxBoard authMe={mockAuthMe} route="inbox" onRouteChange={noop} />);
    const cards = screen.getAllByRole('button', { name: /idle/i });
    const card = cards.find((el) => (el as HTMLElement).dataset.sessionId === 'sess-direct');
    expect(card).toBeTruthy();
    await userEvent.click(card!);
    expect(location.hash).toBe('#/session/sess-direct');
  });

  it('archive button calls archiveSession', async () => {
    const { archiveSession } = await import('../lib/api.js');
    vi.mocked(useSWR).mockReturnValue({
      data: { sessions: [session({ session_id: 'sess-arch', attention_state: 'idle' })] },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);

    render(<InboxBoard authMe={mockAuthMe} route="inbox" onRouteChange={noop} />);
    const dismiss = screen.getByRole('button', { name: /dismiss session/i });
    await userEvent.click(dismiss);
    expect(vi.mocked(archiveSession)).toHaveBeenCalledWith('sess-arch');
  });

  it('clicking the Board button (toolbar right) fires onRouteChange', async () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { sessions: [] },
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useSWR>);
    const onRouteChange = vi.fn();
    render(<InboxBoard authMe={mockAuthMe} route="inbox" onRouteChange={onRouteChange} />);
    await userEvent.click(screen.getByRole('button', { name: /← Board/i }));
    expect(onRouteChange).toHaveBeenCalledWith('board');
  });
});
