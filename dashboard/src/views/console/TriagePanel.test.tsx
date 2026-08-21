import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import userEvent from '@testing-library/user-event';
import type { ThreadSummary } from '../../lib/api.js';

/**
 * Triage mode (DESIGN §11) — one thread, one verdict key (S), auto-advance.
 * A and E were both retired keys (see the tests below) — neither one is a
 * verdict, so removing them is not one either.
 *
 * The failure this file exists to catch is SKIPPING. A verdict removes the
 * thread from the live queue, so a mode that re-indexed against the live list
 * would advance past the very next thread every single time and the operator
 * would never know. The snapshot taken at entry is what prevents that, and
 * `advances to the next thread, never past it` is the assertion that pins it.
 */

const getThreadDetail = vi.fn();
const snoozeThread = vi.fn().mockResolvedValue({});
const unsnoozeThread = vi.fn().mockResolvedValue({});
const postThreadMessage = vi.fn().mockResolvedValue({});
vi.mock('../../lib/api.js', () => ({
  getThreadDetail,
  snoozeThread,
  unsnoozeThread,
  postThreadMessage,
}));

const { TriagePanel } = await import('./TriagePanel.js');

function thread(n: number, over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    thread_id: `slack:CTESTCHAN01:170000000${n}.11`,
    synthetic: false,
    channel_key: 'slack:CTESTCHAN01',
    channel_name: '#example-eng',
    title: `Thread ${n}`,
    participants: [
      { agent_group_id: 'ag-1', name: 'Alpha', session_id: `s-${n}`, avatarUrl: null, provider: 'claude' },
    ],
    assignable_agents: [],
    last_activity_at: '2026-08-20T09:00:00.000Z',
    state: 'needs_you',
    session_ids: [`s-${n}`],
    container_status: 'idle',
    provider_status: null,
    current_tool: null,
    tool_started_at: null,
    reply_target_session_id: `s-${n}`,
    snoozed: false,
    ...over,
  };
}

function renderTriage(snapshot: ThreadSummary[], live: ThreadSummary[] = snapshot) {
  const onExit = vi.fn();
  const onChanged = vi.fn();
  const utils = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TriagePanel snapshot={snapshot} threads={live} onExit={onExit} onChanged={onChanged} />
    </SWRConfig>,
  );
  return { ...utils, onExit, onChanged };
}

const panel = (): HTMLElement => screen.getByLabelText('Triage');

beforeEach(() => {
  snoozeThread.mockClear();
  postThreadMessage.mockClear();
  getThreadDetail.mockImplementation((id: string) =>
    Promise.resolve({ thread: thread(1, { thread_id: id }), transcript: [] }),
  );
});

describe('position', () => {
  it('opens on the first thread of the frozen queue', async () => {
    renderTriage([thread(1), thread(2), thread(3)]);
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(await screen.findByText('Thread 1')).toBeTruthy();
  });

  it('draws one rail cell per thread, with the current one marked', () => {
    const { container } = renderTriage([thread(1), thread(2), thread(3)]);
    expect(container.querySelectorAll('.ncc-triage-dot')).toHaveLength(3);
    expect(container.querySelectorAll('.ncc-triage-dot.now')).toHaveLength(1);
  });
});

describe('verdicts advance by exactly one', () => {
  it('S snoozes the current thread and lands on the NEXT one, never past it', async () => {
    const user = userEvent.setup();
    const snapshot = [thread(1), thread(2), thread(3)];
    // The live list has already dropped the snoozed row, which is what a real
    // revalidation does. Re-indexing against it would skip Thread 2 entirely.
    const { rerender, onChanged } = renderTriage(snapshot);
    panel().focus();
    await user.keyboard('s');
    await waitFor(() => expect(snoozeThread).toHaveBeenCalledWith(snapshot[0]!.thread_id));
    expect(onChanged).toHaveBeenCalled();

    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <TriagePanel snapshot={snapshot} threads={[thread(2), thread(3)]} onExit={vi.fn()} onChanged={vi.fn()} />
      </SWRConfig>,
    );
    expect(screen.getByText('2 / 3')).toBeTruthy();
    expect(await screen.findByText('Thread 2')).toBeTruthy();
  });

  /**
   * E used to dismiss the thread by archiving every session on it. That verb
   * is gone — archiving hid a thread without stopping the agent, so the work
   * kept running unattended.
   */
  it('E is not bound to anything — no verdict fires and the position holds', async () => {
    const user = userEvent.setup();
    renderTriage([thread(1), thread(2)]);
    panel().focus();
    await user.keyboard('e');
    expect(snoozeThread).not.toHaveBeenCalled();
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  /**
   * A used to focus the composer and nothing else. It is gone too — same
   * reading as E above, and for a different reason: a tap on the row (or the
   * composer itself) already moves focus there, so the button and key never
   * did anything a click could not already do.
   */
  it('A is not bound to anything — no verdict fires, no focus move, and the position holds', async () => {
    const user = userEvent.setup();
    renderTriage([thread(1), thread(2)]);
    panel().focus();
    await user.keyboard('a');
    expect(snoozeThread).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(panel());
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('offers no close/dismiss or answer button, and the key hint carries only snooze and exit', async () => {
    renderTriage([thread(1)]);
    // `find`, not `get`: it lets the detail pane's transcript fetch settle
    // inside act rather than landing after the test has ended.
    await screen.findByRole('button', { name: /S · snooze/ });
    expect(screen.queryByRole('button', { name: /close|dismiss/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /answer/i })).toBeNull();
    expect(screen.getByText('S snooze · Esc exit')).toBeTruthy();
  });

  it('reports the end of the queue rather than wrapping', async () => {
    const user = userEvent.setup();
    renderTriage([thread(1)]);
    panel().focus();
    await user.keyboard('s');
    await waitFor(() => expect(screen.getByText(/queue clear/i)).toBeTruthy());
  });

  it('announces each move on an aria-live region', async () => {
    const user = userEvent.setup();
    const { container } = renderTriage([thread(1), thread(2)]);
    panel().focus();
    await user.keyboard('s');
    const live = container.querySelector('.ncc-triage-live')!;
    await waitFor(() => expect(live.textContent).toContain('Snoozed'));
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toContain('2 of 2');
  });
});

describe('the keyboard rules that ship broken silently', () => {
  it('leaves the browser its own shortcuts', async () => {
    const user = userEvent.setup();
    renderTriage([thread(1), thread(2)]);
    panel().focus();
    await user.keyboard('{Control>}s{/Control}');
    await user.keyboard('{Meta>}e{/Meta}');
    await user.keyboard('{Alt>}a{/Alt}');
    expect(snoozeThread).not.toHaveBeenCalled();
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('does not turn typing into a verdict', async () => {
    const user = userEvent.setup();
    renderTriage([thread(1), thread(2)]);
    await user.type(await screen.findByLabelText('Message text'), 'ship the aes patch');
    expect(snoozeThread).not.toHaveBeenCalled();
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('Escape leaves the mode, even from inside the composer', async () => {
    const user = userEvent.setup();
    const { onExit } = renderTriage([thread(1)]);
    (await screen.findByLabelText('Message text')).focus();
    await user.keyboard('{Escape}');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('arrows walk the queue without a verdict', async () => {
    const user = userEvent.setup();
    renderTriage([thread(1), thread(2), thread(3)]);
    panel().focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByText('3 / 3')).toBeTruthy();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByText('2 / 3')).toBeTruthy();
    expect(snoozeThread).not.toHaveBeenCalled();
  });
});

/* ─── Shared refusal wording ───────────────────────────────────────────────── */

describe('a refused verdict is explained in the operator’s words', () => {
  it('says the same thing the queue and the composer say about the same refusal', async () => {
    snoozeThread.mockRejectedValueOnce({ status: 429, error: 'rate_limit_exceeded', retry_after: 4 });
    renderTriage([thread(1), thread(2)]);
    await userEvent.click(screen.getByRole('button', { name: /S · snooze/ }));
    await waitFor(() => expect(screen.getByText(/Could not snooze — too fast — try again in 4s\./)).toBeTruthy());
    // A refused verdict must not advance — the thread has not been triaged.
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });
});
