import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { SignalOverview } from '../../../../src/dashboard/observatory-v2/types.js';
import { SignalApp } from './SignalApp.js';
import * as api from '../../lib/signal-api.js';
import { startSSE, stopSSE } from '../../lib/sse.ts';
vi.mock('../../lib/signal-api.js', async (original) => ({
  ...(await original<typeof api>()),
  getSignalOverview: vi.fn(),
  getSignalDecision: vi.fn(),
}));
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
});
afterEach(() => {
  cleanup();
  stopSSE();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('Signal live refresh and paging', () => {
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
    vi.mocked(api.getSignalOverview).mockResolvedValueOnce(page);
    fireEvent.click(screen.getByRole('button', { name: 'Load more threads · Workspace' }));
    await tick();
    expect(api.getSignalOverview).toHaveBeenCalledWith('wg', 200);
    expect(screen.getAllByText('Second-page project').length).toBeGreaterThan(0);
    vi.mocked(api.getSignalOverview).mockResolvedValue(base);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh records' }));
    await tick(1001);
    expect(screen.queryByText('Second-page project')).not.toBeInTheDocument();
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
    expect(container.querySelector('.signal-decision-row.selected')).toBeNull();
  });
});
