import { act, fireEvent, render, screen, cleanup, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { SignalOverview } from '../../../../src/dashboard/observatory-v2/types.js';
import { SignalApp } from './SignalApp.js';
import * as api from '../../lib/signal-api.js';
import * as hostApi from '../../lib/api.js';
import { startSSE, stopSSE } from '../../lib/sse.ts';
vi.mock('../../lib/signal-api.js', async (original) => ({
  ...(await original<typeof api>()),
  getSignalOverview: vi.fn(),
  getSignalDecision: vi.fn(),
  saveSignalProject: vi.fn(),
}));
vi.mock('../../lib/api.js', async (original) => ({ ...(await original<typeof hostApi>()), listThreads: vi.fn() }));
class Source {
  static latest: Source;
  handlers = new Map<string, ((event: { data: string }) => void)[]>();
  constructor() {
    Source.latest = this;
  }
  addEventListener(kind: string, handler: (event: { data: string }) => void) {
    this.handlers.set(kind, [...(this.handlers.get(kind) ?? []), handler]);
  }
  emit(kind: string) {
    for (const handler of this.handlers.get(kind) ?? []) handler({ data: '{}' });
  }
  close() {}
}
const overview = (name = 'First project'): SignalOverview => ({
  timezone: 'UTC',
  as_of: '2026-09-05T00:00:00Z',
  workgroups: [{ id: 'wg', name: 'Workspace' }],
  projects: [
    {
      id: 'p',
      workgroup_id: 'wg',
      name,
      description: 'Goal',
      repositories: [],
      channel_keys: [],
      version: 0,
      updated_at: null,
      unmapped: false,
      thread_ids: [],
      decision_ids: [],
      items: [],
    },
  ],
  decisions: [],
  agents: [],
  activity: [],
  sources: [],
  capabilities: { manage_projects: false },
  thread_coverage: [{ workgroup_id: 'wg', offset: 0, limit: 200, has_more: false, next_offset: null }],
});
const mount = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <SignalApp authMe={{ user_id: 'u', scopes: { role: 'owner', no_filter: true, allowed_group_ids: [] } }} />
    </SWRConfig>,
  );
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', Source);
  location.hash = '';
  vi.mocked(api.getSignalOverview).mockResolvedValue(overview());
  vi.mocked(hostApi.listThreads).mockResolvedValue({ threads: [] });
});
afterEach(() => {
  cleanup();
  stopSSE();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('Signal live refresh and paging', () => {
  it('shows Saturday cadence only when its configured workspace is authorized and loaded', async () => {
    vi.stubEnv('VITE_SATURDAY_RELEASE_WORKGROUP', 'private-workspace');
    mount();
    await tick();
    expect(screen.queryByRole('region', { name: 'Saturday release' })).not.toBeInTheDocument();
    cleanup();
    vi.stubEnv('VITE_SATURDAY_RELEASE_WORKGROUP', 'wg');
    mount();
    await tick();
    expect(screen.getByRole('region', { name: 'Saturday release' })).toHaveTextContent('develop → main');
    expect(screen.getByRole('region', { name: 'Saturday release' })).toHaveTextContent('0 source-reported human calls');
    expect(screen.queryByRole('button', { name: 'Review release blockers →' })).not.toBeInTheDocument();
  });
  it('hides Saturday cadence after switching to a different workspace even when the release workspace remains visible', async () => {
    vi.stubEnv('VITE_SATURDAY_RELEASE_WORKGROUP', 'release-workspace');
    const all = overview();
    all.workgroups = [
      { id: 'release-workspace', name: 'Release workspace' },
      { id: 'other-workspace', name: 'Other workspace' },
    ];
    all.projects[0]!.workgroup_id = 'other-workspace';
    const other = { ...all, projects: [...all.projects], decisions: [...all.decisions] };
    vi.mocked(api.getSignalOverview).mockImplementation((workspace) =>
      Promise.resolve(workspace === 'other-workspace' ? other : all),
    );
    mount();
    await tick();
    expect(screen.getByRole('region', { name: 'Saturday release' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), { target: { value: 'other-workspace' } });
    await tick();
    expect(screen.queryByRole('region', { name: 'Saturday release' })).not.toBeInTheDocument();
  });
  it('continues to render and refresh when accessing browser storage is denied', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('Storage access denied', 'SecurityError');
      },
    });
    try {
      mount();
      await tick();
      expect(screen.getAllByText('First project').length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole('button', { name: 'Refresh records' }));
      await tick(1001);
      expect(api.getSignalOverview).toHaveBeenCalledTimes(2);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
      else Reflect.deleteProperty(window, 'localStorage');
    }
  });
  it('replays a connection opened before mount and coalesces reconnect event bursts', async () => {
    startSSE();
    Source.latest.emit('open');
    mount();
    await tick(500);
    expect(screen.getByText(/Connected · File sources/)).toBeInTheDocument();
    const before = vi.mocked(api.getSignalOverview).mock.calls.length;
    vi.mocked(api.getSignalOverview).mockResolvedValue(overview('Updated after reconnect'));
    Source.latest.emit('error');
    await tick();
    expect(screen.getByText(/Live connection interrupted/)).toBeInTheDocument();
    await tick(1000);
    Source.latest.emit('open');
    Source.latest.emit('session_event');
    Source.latest.emit('session_event');
    Source.latest.emit('inbound_message');
    await tick(500);
    expect(vi.mocked(api.getSignalOverview).mock.calls.length).toBe(before + 1);
    expect(screen.getAllByText('Updated after reconnect').length).toBeGreaterThan(0);
  });
  it('polls file sources after 30 seconds and retains last records when refresh fails', async () => {
    mount();
    await tick();
    expect(screen.getAllByText('First project').length).toBeGreaterThan(0);
    vi.mocked(api.getSignalOverview).mockResolvedValue(overview('File changed'));
    await tick(30001);
    expect(screen.getAllByText('File changed').length).toBeGreaterThan(0);
    vi.mocked(api.getSignalOverview).mockRejectedValue(new Error('source offline'));
    await tick(30001);
    expect(screen.getByRole('alert')).toHaveTextContent('Refresh failed. Showing the last received records.');
    expect(screen.getAllByText('File changed').length).toBeGreaterThan(0);
  });
  it('merges a next workspace page and resets coverage on refresh', async () => {
    const base = overview();
    base.thread_coverage![0]!.has_more = true;
    base.thread_coverage![0]!.next_offset = 200;
    vi.mocked(api.getSignalOverview).mockResolvedValue(base);
    mount();
    await tick();
    const page = overview('Second-page project');
    page.projects[0]!.id = 'p2';
    page.thread_coverage![0]!.offset = 200;
    page.sources = [
      {
        workgroup_id: 'wg',
        source: 'threads',
        as_of: '2026-09-05T00:00:00Z',
        status: 'unavailable',
        detail: 'Thread source could not be read.',
      },
    ];
    vi.mocked(api.getSignalOverview).mockResolvedValueOnce(page);
    fireEvent.click(screen.getByRole('button', { name: 'Load more threads · Workspace' }));
    await tick();
    expect(api.getSignalOverview).toHaveBeenCalledWith('wg', 200);
    expect(screen.getAllByText('Second-page project').length).toBeGreaterThan(0);
    expect(screen.getByText('1 sources stale or unavailable — coverage is partial')).toBeInTheDocument();
    vi.mocked(api.getSignalOverview).mockResolvedValue(base);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh records' }));
    await tick(1001);
    expect(screen.queryByText('Second-page project')).not.toBeInTheDocument();
  });
  it('keeps an active tool while loading an older page, but allows a refresh to clear it', async () => {
    location.hash = '#/agents';
    const base = overview();
    base.thread_coverage![0]!.has_more = true;
    base.thread_coverage![0]!.next_offset = 200;
    base.agents = [
      {
        id: 'agent-fixture',
        workgroup_id: 'wg',
        name: 'Fixture agent',
        provider: 'codex',
        awake: true,
        active: true,
        last_seen_at: '2026-09-05T00:00:00Z',
        thread_ids: ['slack:CFIXTURE01:newer'],
        current_tool: 'write_summary',
        claims: [],
        next_task: null,
      },
    ];
    vi.mocked(api.getSignalOverview).mockResolvedValue(base);
    mount();
    await tick();
    expect(screen.getByText(/Using write_summary/)).toBeInTheDocument();

    const older = overview();
    older.agents = [{ ...base.agents[0]!, thread_ids: ['slack:CFIXTURE01:older'], current_tool: null }];
    older.thread_coverage![0]!.offset = 200;
    vi.mocked(api.getSignalOverview).mockResolvedValueOnce(older);
    fireEvent.click(screen.getByRole('button', { name: 'Load more threads · Workspace' }));
    await tick();
    expect(screen.getByText(/Using write_summary/)).toBeInTheDocument();

    const refreshed = overview();
    refreshed.agents = [{ ...base.agents[0]!, current_tool: null }];
    vi.mocked(api.getSignalOverview).mockResolvedValue(refreshed);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh records' }));
    await tick(1001);
    expect(screen.queryByText(/Using write_summary/)).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-work')).toBeInTheDocument();
  });
  it('keeps the project revision that initialized an open edit form', async () => {
    location.hash = '#/projects';
    const initial = overview('Initial project');
    initial.projects[0]!.version = 2;
    initial.capabilities.manage_projects = true;
    vi.mocked(api.getSignalOverview).mockResolvedValue(initial);
    vi.mocked(api.saveSignalProject).mockResolvedValue({});
    mount();
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Edit project mapping' }));
    const editForm = screen.getByDisplayValue('Initial project').closest('form')!;
    fireEvent.change(within(editForm).getByLabelText('Project name'), { target: { value: 'Local project edit' } });
    const refreshed = overview('Remote project edit');
    refreshed.projects[0]!.version = 3;
    refreshed.capabilities.manage_projects = true;
    vi.mocked(api.getSignalOverview).mockResolvedValue(refreshed);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh records' }));
    await tick(1001);
    fireEvent.click(within(editForm).getByRole('button', { name: 'Save project mapping' }));
    await tick();
    expect(api.saveSignalProject).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({ name: 'Local project edit', expected_version: 2 }),
    );
  });
  it('requests an off-page decision ID without highlighting another record', async () => {
    location.hash = '#/decisions/off-page';
    vi.mocked(api.getSignalDecision).mockRejectedValue(new api.SignalApiError(404, 'not_found'));
    const loaded = overview();
    loaded.decisions = [
      {
        id: 'another-decision',
        question: 'A different question',
        context: 'Different evidence',
        owner: null,
        owner_hint: null,
        state: 'open',
        source_kind: 'release-item',
        workgroup_id: 'wg',
      } as SignalOverview['decisions'][number],
    ];
    vi.mocked(api.getSignalOverview).mockResolvedValue(loaded);
    const { container } = mount();
    await tick();
    expect(api.getSignalDecision).toHaveBeenCalledWith('off-page');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load exact decision context');
    expect(screen.getByText('A different question')).toBeInTheDocument();
    expect(container.querySelector('.work-queue-row.selected')).toBeNull();
  });
});
