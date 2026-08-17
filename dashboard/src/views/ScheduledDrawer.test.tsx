import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api.js', () => ({
  getScheduledDetail: vi.fn(),
  editScheduled: vi.fn().mockResolvedValue({ updated: true }),
  pauseScheduled: vi.fn().mockResolvedValue({ paused: true }),
  resumeScheduled: vi.fn().mockResolvedValue({ resumed: true }),
  runNowScheduled: vi.fn().mockResolvedValue({ fired: true }),
  cancelScheduled: vi.fn().mockResolvedValue({ cancelled: true }),
  moveScheduledPreview: vi.fn(),
  moveScheduled: vi.fn().mockResolvedValue({ moved: true }),
  listGroups: vi.fn().mockResolvedValue({
    groups: [
      { id: 'ag-1', name: 'Example Agent' },
      { id: 'ag-2', name: 'Other Agent' },
    ],
  }),
  listMessagingGroups: vi.fn().mockResolvedValue({
    messaging_groups: [
      { id: 'mg-1', name: '#general' },
      { id: 'mg-9', name: '#other' },
    ],
  }),
}));

import { ScheduledDrawer } from './ScheduledDrawer.js';
import * as api from '../lib/api.js';
import type { ScheduledDetail, ScheduledRow, ScheduledVerb } from '../lib/api.js';

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

function row(overrides: Partial<ScheduledRow> = {}): ScheduledRow {
  return {
    key: 'KEY',
    series_id: 'task-morning-briefing',
    agent_group_id: 'ag-1',
    agent_group_name: 'Example Agent',
    provider: 'claude',
    channel_name: '#general',
    channel_type: 'discord',
    thread_id: null,
    kind: 'recurring',
    cron: '0 9 * * *',
    next_fire_utc: '2026-06-14T09:00:00Z',
    next_fire_local: '2026-06-14 02:00 PDT',
    health: 'healthy',
    module_owner: null,
    quiet_status: false,
    flag_intent: null,
    script_host: false,
    last_fires: [],
    available_verbs: ['edit', 'pause', 'cancel'],
    ...overrides,
  };
}

function detail(overrides: Partial<ScheduledDetail> = {}, rowOverrides: Partial<ScheduledRow> = {}): ScheduledDetail {
  return {
    row: row(rowOverrides),
    prompt: 'Send the morning briefing.',
    script: null,
    history: [],
    ...overrides,
  };
}

function mockDetail(d: ScheduledDetail) {
  vi.mocked(api.getScheduledDetail).mockResolvedValue(d);
}

// SWR keeps a process-global cache keyed by the rowKey. Every test reuses
// key 'KEY', so without a fresh key the second render serves the first test's
// cached detail. Give each render a unique key so the fetcher actually runs.
let keySeq = 0;

async function renderDrawer(d: ScheduledDetail) {
  const uniqueKey = `KEY-${++keySeq}`;
  d.row.key = uniqueKey;
  mockDetail(d);
  const onMutated = vi.fn();
  const r = render(<ScheduledDrawer rowKey={uniqueKey} onClose={noop} onMutated={onMutated} />);
  // Wait for the async detail fetch to resolve and the drawer to populate.
  await waitFor(() => expect(screen.getByTestId('sched-drawer')).toBeTruthy());
  return { ...r, onMutated, rowKey: uniqueKey };
}

function verbButton(verb: ScheduledVerb): HTMLButtonElement {
  return document.querySelector(`button[data-verb="${verb}"]`) as HTMLButtonElement;
}

describe('ScheduledDrawer', () => {
  beforeEach(() => stubViewport(false));
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // ─── E4 — buttons driven solely by available_verbs (single source) ───

  it('test_buttons_from_available_verbs: only verbs in available_verbs are enabled', async () => {
    await renderDrawer(detail({}, { available_verbs: ['edit', 'cancel'] }));

    expect(verbButton('edit').disabled).toBe(false);
    expect(verbButton('cancel').disabled).toBe(false);
    // Not in available_verbs → rendered but disabled.
    expect(verbButton('run_now').disabled).toBe(true);
    expect(verbButton('move').disabled).toBe(true);
    expect(verbButton('pause').disabled).toBe(true);
    expect(verbButton('resume').disabled).toBe(true);
  });

  it('test_available_verbs_consumed_not_recomputed: a stalled row with cancel-only still disables run_now', async () => {
    // If the drawer re-derived the matrix it might "know" stalled rows can
    // run-now; it must NOT — it obeys available_verbs verbatim.
    await renderDrawer(detail({}, { health: 'stalled', available_verbs: ['cancel'] }));
    expect(verbButton('cancel').disabled).toBe(false);
    expect(verbButton('run_now').disabled).toBe(true);
    expect(verbButton('edit').disabled).toBe(true);
  });

  it('pause click calls pauseScheduled and onMutated', async () => {
    const { onMutated, rowKey } = await renderDrawer(detail({}, { available_verbs: ['pause'] }));
    await userEvent.click(verbButton('pause'));
    expect(vi.mocked(api.pauseScheduled)).toHaveBeenCalledWith(rowKey);
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  // ─── E4 — module-owned edit reseed warning (D2) ───

  it('test_module_edit_warns: module-owned row edit shows the reseed-overwrite warning naming the owner', async () => {
    await renderDrawer(detail({}, { module_owner: 'memory', available_verbs: ['edit'] }));
    await userEvent.click(verbButton('edit'));
    const warn = screen.getByTestId('reseed-warning');
    expect(warn.textContent).toMatch(/memory/);
    expect(warn.textContent).toMatch(/overwrite|reseed/i);
  });

  it('a non-module row edit shows no reseed warning', async () => {
    await renderDrawer(detail({}, { module_owner: null, available_verbs: ['edit'] }));
    await userEvent.click(verbButton('edit'));
    expect(screen.queryByTestId('reseed-warning')).toBeNull();
  });

  it('clicking Edit scrolls the edit panel into view', async () => {
    const scrollIntoView = vi.fn();
    // jsdom has no layout engine, so Element.scrollIntoView doesn't exist by
    // default — stub it to observe the panel calling it on mount.
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderDrawer(detail({}, { available_verbs: ['edit'] }));
    await userEvent.click(verbButton('edit'));
    await screen.findByTestId('sched-edit-form');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' });
  });

  // ─── E4 — run-now near-slot residual confirm (F3) ───

  it('test_runnow_near_slot_confirm: a row needing force prompts the residual confirm; confirming sends force:true', async () => {
    const { rowKey } = await renderDrawer(detail({}, { available_verbs: ['run_now'], health: 'healthy' }));
    await userEvent.click(verbButton('run_now'));
    // The confirm copy must name the residual "next occurrence may still fire".
    const confirm = screen.getByTestId('runnow-confirm');
    expect(confirm.textContent).toMatch(/next occurrence may still fire/i);
    await userEvent.click(within(confirm).getByRole('button', { name: /run anyway|confirm/i }));
    expect(vi.mocked(api.runNowScheduled)).toHaveBeenCalledWith(rowKey, { force: true });
  });

  // ─── E4 — move credential-delta confirm (D8/SEC-2/W2) ───

  it('test_move_confirm_shows_delta: move preview shows gains/losses + unattended caveat; execute echoes deltaHash', async () => {
    vi.mocked(api.moveScheduledPreview).mockResolvedValue({
      wiringOk: true,
      gains: ['Datafold-ExampleRetail'],
      losses: ['Linear'],
      crossWorkgroup: true,
      scriptPresent: true,
      environmentDeltaChecked: false,
      deltaHash: 'HASH-1',
    });
    const { rowKey } = await renderDrawer(detail({}, { available_verbs: ['move'], health: 'paused' }));
    await userEvent.click(verbButton('move'));

    // Target pickers are dropdowns of the real agent/messaging groups, not
    // free text — wait for the option lists to load, then select from them.
    await screen.findByRole('option', { name: 'Other Agent' });
    await userEvent.selectOptions(screen.getByLabelText(/target agent group/i), 'ag-2');
    await userEvent.selectOptions(screen.getByLabelText(/target messaging group/i), 'mg-9');
    await userEvent.click(screen.getByRole('button', { name: /preview/i }));

    const confirm = await screen.findByTestId('move-confirm');
    expect(confirm.textContent).toContain('Datafold-ExampleRetail'); // gains NAME
    expect(confirm.textContent).toContain('Linear'); // losses NAME
    // unattended-script caveat (D8)
    expect(confirm.textContent).toMatch(/unattended/i);
    // environmentDeltaChecked:false static caveat (W2)
    expect(confirm.textContent).toMatch(/environment|not checked|wider/i);

    await userEvent.click(within(confirm).getByRole('button', { name: /confirm move|move/i }));
    expect(vi.mocked(api.moveScheduled)).toHaveBeenCalledWith(rowKey, {
      targetAgentGroupId: 'ag-2',
      targetMessagingGroupId: 'mg-9',
      confirmedDeltaHash: 'HASH-1',
    });
  });

  it('test_move_targets_are_dropdowns: options come from the API and Preview stays disabled until both are picked', async () => {
    await renderDrawer(detail({}, { available_verbs: ['move'] }));
    await userEvent.click(verbButton('move'));

    const agSelect = screen.getByLabelText(/target agent group/i);
    const mgSelect = screen.getByLabelText(/target messaging group/i);
    expect(agSelect.tagName).toBe('SELECT');
    expect(mgSelect.tagName).toBe('SELECT');
    await screen.findByRole('option', { name: 'Other Agent' });
    expect(screen.getByRole('option', { name: '#other' })).toBeTruthy();

    const preview = screen.getByRole('button', { name: /preview/i });
    expect(preview).toBeDisabled();

    await userEvent.selectOptions(agSelect, 'ag-2');
    expect(preview).toBeDisabled(); // still missing the messaging group
    await userEvent.selectOptions(mgSelect, 'mg-9');
    expect(preview).not.toBeDisabled();
  });

  // ─── E4 — cancel end-series confirm ───

  it('cancel prompts an end-series confirm before calling cancelScheduled', async () => {
    const { rowKey } = await renderDrawer(detail({}, { available_verbs: ['cancel'] }));
    await userEvent.click(verbButton('cancel'));
    const confirm = screen.getByTestId('cancel-confirm');
    expect(confirm.textContent).toMatch(/end the series|cannot be undone|end series/i);
    await userEvent.click(within(confirm).getByRole('button', { name: /end series|confirm/i }));
    expect(vi.mocked(api.cancelScheduled)).toHaveBeenCalledWith(rowKey);
  });

  // ─── E4 — mobile read-only ───

  it('test_mobile_drawer_readonly: on mobile the edit form is absent but verb buttons remain', async () => {
    stubViewport(true);
    await renderDrawer(detail({}, { available_verbs: ['edit', 'pause', 'cancel'] }));
    // verb buttons present
    expect(verbButton('edit')).toBeTruthy();
    expect(verbButton('cancel')).toBeTruthy();
    // edit form omitted on mobile (v1)
    expect(screen.queryByTestId('sched-edit-form')).toBeNull();
  });

  // ─── detail content ───

  it('renders the prompt, script, and fire history', async () => {
    await renderDrawer(
      detail({
        prompt: 'Daily standup digest.',
        script: 'echo hi',
        history: [
          { id: 'f1', ts: '2026-06-12T09:00:00Z', outcome: 'ran' },
          { id: 'f2', ts: '2026-06-11T09:00:00Z', outcome: 'completed (no chat output)' },
        ],
      }),
    );
    const drawer = screen.getByTestId('sched-drawer');
    expect(drawer.textContent).toContain('Daily standup digest.');
    expect(drawer.textContent).toContain('echo hi');
    expect(drawer.textContent).toContain('ran');
    expect(drawer.textContent).toContain('completed (no chat output)');
  });

  it('renders the audit tail when present', async () => {
    await renderDrawer(
      detail({
        audit_tail: [{ id: 1, ts: '2026-06-12T00:00:00Z', actor: 'u1', action: 'pause' }],
      }),
    );
    expect(screen.getByTestId('sched-audit-tail')).toBeTruthy();
  });

  // ─── edit form: cron is omitted for a one-off (row.cron === null) ───
  // A one-off row has no cron → the cron field is empty → submitting cron:'' would
  // hit the backend's empty-cron guard (400 bad_cron) and block the prompt/script
  // edit. The form must OMIT cron when empty so the edit succeeds.

  it('test_edit_one_off_omits_cron: a one-off edit submits no cron field', async () => {
    await renderDrawer(
      detail({ script: 'echo x' }, { kind: 'one_off', cron: null, available_verbs: ['edit', 'cancel'] }),
    );
    await userEvent.click(verbButton('edit'));
    const form = await screen.findByTestId('sched-edit-form');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.editScheduled).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.editScheduled).mock.calls[0][1];
    expect(body).not.toHaveProperty('cron');
    expect(body).toMatchObject({ prompt: 'Send the morning briefing.', script: 'echo x' });
  });

  it('test_edit_recurring_includes_cron: a recurring edit still submits its cron', async () => {
    // default row is recurring with cron '0 9 * * *' — the omit-when-empty logic
    // must NOT drop a real cron.
    await renderDrawer(detail({}, { available_verbs: ['edit', 'pause', 'cancel'] }));
    await userEvent.click(verbButton('edit'));
    const form = await screen.findByTestId('sched-edit-form');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.editScheduled).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.editScheduled).mock.calls[0][1]).toMatchObject({ cron: '0 9 * * *' });
  });
});
