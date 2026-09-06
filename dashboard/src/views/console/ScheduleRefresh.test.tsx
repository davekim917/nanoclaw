import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import * as api from '../../lib/api.js';
import type { ScheduledRow } from '../../lib/api.js';
import { ScheduleLens } from './ScheduleLens.js';
import { ScheduledDrawer } from '../ScheduledDrawer.js';

vi.mock('../../lib/api.js', async (original) => ({
  ...(await original<typeof api>()),
  listScheduled: vi.fn(),
  getScheduledDetail: vi.fn(),
}));
const row: ScheduledRow = {
  key: 'daily',
  series_id: 'daily',
  agent_group_id: 'ag',
  agent_group_name: 'Agent',
  provider: null,
  channel_name: null,
  channel_type: null,
  thread_id: null,
  kind: 'recurring',
  cron: '0 9 * * *',
  next_fire_utc: '2026-09-07T09:00:00Z',
  next_fire_local: null,
  health: 'healthy',
  module_owner: null,
  quiet_status: false,
  flag_intent: null,
  script_host: false,
  last_fires: [],
  available_verbs: ['pause', 'cancel'],
};
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Schedule background refresh', () => {
  it('removes externally cancelled work while open, and stops polling on unmount', async () => {
    vi.mocked(api.listScheduled).mockResolvedValue({
      rows: [row],
      counts: {},
      degraded: false,
      assembled_at: '2026-09-06T12:00:00Z',
    });
    const mounted = render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ScheduleLens agentGroupIds={null} groups={[]} />
      </SWRConfig>,
    );
    await tick();
    expect(screen.getByRole('button', { name: 'Open scheduled job daily' })).toBeInTheDocument();
    vi.mocked(api.listScheduled).mockResolvedValue({
      rows: [],
      counts: {},
      degraded: false,
      assembled_at: '2026-09-06T12:00:30Z',
    });
    await tick(29_000);
    expect(api.listScheduled).toHaveBeenCalledTimes(1);
    await tick(1_001);
    expect(screen.queryByRole('button', { name: 'Open scheduled job daily' })).not.toBeInTheDocument();
    expect(screen.getAllByText('nothing scheduled').length).toBeGreaterThan(0);
    mounted.unmount();
    const calls = vi.mocked(api.listScheduled).mock.calls.length;
    await tick(60_000);
    expect(api.listScheduled).toHaveBeenCalledTimes(calls);
  });

  it('updates drawer actions when a background failure auto-pauses the series', async () => {
    vi.mocked(api.getScheduledDetail).mockResolvedValue({ row, prompt: 'Check records', script: null, history: [] });
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ScheduledDrawer rowKey="daily" onClose={() => {}} onMutated={() => {}} />
      </SWRConfig>,
    );
    await tick();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    vi.mocked(api.getScheduledDetail).mockResolvedValue({
      row: { ...row, health: 'paused', available_verbs: ['resume', 'cancel'] },
      prompt: 'Check records',
      script: null,
      history: [],
    });
    await tick(30_001);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
  });
});
