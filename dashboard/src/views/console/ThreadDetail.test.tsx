import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import userEvent from '@testing-library/user-event';
import type { ThreadSummary, ThreadTranscriptEntry } from '../../lib/api.js';

/**
 * The composer is the console's ONE action, so these tests bind the four things
 * that make it honest:
 *
 *  - the default target is the agent whose state drove the row's urgency;
 *  - the selector spans EVERY wired agent, split into on-thread and not, so
 *    Assign is reachable at all;
 *  - the send names an agent (never a session), which is what lets the server
 *    open a queue for one that has none;
 *  - what actually happened — assigned, handed over — is reported, because
 *    neither is visible anywhere else on the screen.
 */

const getThreadDetail = vi.fn();
const postThreadMessage = vi.fn().mockResolvedValue({ created_session: false, handoff: null });
vi.mock('../../lib/api.js', () => ({
  getThreadDetail,
  postThreadMessage,
  snoozeThread: vi.fn(),
  unsnoozeThread: vi.fn(),
}));

const { ThreadDetail } = await import('./ThreadDetail.js');

function thread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    thread_id: 'slack:CTESTCHAN01:1700000000.11',
    synthetic: false,
    channel_key: 'slack:CTESTCHAN01',
    channel_name: '#example-eng',
    title: 'Which OAuth flow for the retry path?',
    participants: [
      { agent_group_id: 'ag-1', name: 'Alpha', session_id: 's-alpha', avatarUrl: null, provider: 'claude' },
      { agent_group_id: 'ag-2', name: 'Bravo', session_id: 's-bravo', avatarUrl: null, provider: 'codex' },
    ],
    // Wired to the room, never spoken here. Choosing one of these is Assign.
    assignable_agents: [{ agent_group_id: 'ag-3', name: 'Charlie' }],
    last_activity_at: '2026-08-20T09:00:00.000Z',
    state: 'needs_you',
    session_ids: ['s-alpha', 's-bravo'],
    container_status: 'idle',
    provider_status: null,
    current_tool: null,
    tool_started_at: null,
    // The state's driver is the SECOND participant here on purpose: picking
    // `participants[0]` would pass a weaker test and send the operator's answer
    // to an agent that never asked.
    reply_target_session_id: 's-bravo',
    snoozed: false,
    ...over,
  };
}

function renderDetail(t: ThreadSummary | null, props: Record<string, unknown> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ThreadDetail thread={t} {...props} />
    </SWRConfig>,
  );
}

const target = () => screen.findByLabelText('Send to') as Promise<HTMLSelectElement>;

beforeEach(() => {
  postThreadMessage.mockClear();
  postThreadMessage.mockResolvedValue({ created_session: false, handoff: null });
  getThreadDetail.mockResolvedValue({ thread: thread(), transcript: [] });
});

describe('the target is the request, not decoration', () => {
  it('defaults to the agent whose state drove the row', async () => {
    renderDetail(thread());
    expect((await target()).value).toBe('ag-2');
  });

  it('falls back to the most recent participant when the server names no target', async () => {
    renderDetail(thread({ reply_target_session_id: null }));
    expect((await target()).value).toBe('ag-1');
  });

  it('does not send an empty message', async () => {
    const user = userEvent.setup();
    renderDetail(thread());
    await user.type(await screen.findByLabelText('Message text'), '   ');
    expect((screen.getByRole('button', { name: 'send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(postThreadMessage).not.toHaveBeenCalled();
  });

  it('fires onSent once the send lands, so the caller can advance', async () => {
    const user = userEvent.setup();
    const onSent = vi.fn();
    renderDetail(thread(), { onSent });
    await user.type(await screen.findByLabelText('Message text'), 'ack');
    await user.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });
});

/**
 * WHY this thread is `needs_you`, in FULL (operator report 2026-08-21). The
 * row truncates a long claim note to one line; this pane is where the
 * operator reads all of it.
 */
describe('the needs_you reason, in full (operator report 2026-08-21)', () => {
  const longNote =
    'waiting on the release owner or backup reviewer: PR #956 mechanically ready at 64c1cca1 but the consequence lane has no recorded human ship';

  it('is absent when there is no reason', () => {
    const { container } = renderDetail(thread({ needs_you_reason: null }));
    expect(container.querySelector('.ncc-detail-reason')).toBeNull();
  });

  it('renders the full, untruncated text — never just what the row shows', () => {
    const { container } = renderDetail(thread({ needs_you_reason: { cause: 'parked_note', text: longNote } }));
    expect(container.querySelector('.ncc-detail-reason')!.textContent).toBe(longNote);
  });

  it('carries the claim PARK AGE beside the reason', () => {
    // The console does NOT reconcile a claim against reality — releasing one is
    // the claim owner's job. Showing how old the claim's own statement is makes
    // a stale note legible without the console inventing a verdict.
    const { container } = renderDetail(
      thread({ needs_you_reason: { cause: 'parked_note', text: longNote, parked_ms: 20 * 3_600_000 } }),
    );
    expect(container.querySelector('.ncc-detail-parkage')!.textContent).toBe('parked 20h ago');
    expect(container.querySelector('.ncc-detail-reason')!.textContent).toContain(longNote);
  });

  it('renders no age when nothing measured one — never "parked 0s ago"', () => {
    const { container } = renderDetail(
      thread({ needs_you_reason: { cause: 'parked_note', text: longNote, parked_ms: 0 } }),
    );
    expect(container.querySelector('.ncc-detail-parkage')).toBeNull();
  });
});

/** §2/§5: an ownerless work item from a workgroup attention source. */
describe('attention-source provenance in the detail pane', () => {
  const source = {
    kind: 'release-board',
    as_of: '2026-08-20T09:00:00.000Z',
    url: 'https://github.com/example-org/example-app/pull/817',
    next_action: '@releasebot ship 817',
  };

  it('is absent on an ordinary thread', () => {
    const { container } = renderDetail(thread());
    expect(container.querySelector('.ncc-detail-source')).toBeNull();
  });

  it('names the source, its age, and what a PERSON has to do', () => {
    const { container } = renderDetail(thread({ attention_source: source }));
    const line = container.querySelector('.ncc-detail-source')!;
    expect(line.textContent).toContain('release-board');
    expect(line.textContent).toContain('old');
    expect(line.textContent).toContain('@releasebot ship 817');
  });

  it('links only when the source named a real destination — never dead text pointing nowhere', () => {
    const linked = renderDetail(thread({ attention_source: source }));
    expect(linked.container.querySelector('.ncc-detail-source a')!.getAttribute('href')).toBe(source.url);

    const bare = renderDetail(thread({ attention_source: { ...source, url: null } }));
    expect(bare.container.querySelector('.ncc-detail-source a')).toBeNull();
    expect(bare.container.querySelector('.ncc-detail-source')!.textContent).toContain('@releasebot ship 817');
  });

  it('says the source could not be read rather than implying it is fresh', () => {
    const { container } = renderDetail(thread({ attention_source: { ...source, as_of: null } }));
    expect(container.querySelector('.ncc-detail-source')!.textContent).toContain('could not be read');
  });
});

describe('the selector spans every wired agent, participants first', () => {
  it('groups on-thread agents above the ones the thread can be handed to', async () => {
    renderDetail(thread());
    const select = await target();
    const groups = Array.from(select.querySelectorAll('optgroup'));
    expect(groups.map((g) => g.getAttribute('label'))).toEqual([
      'On this thread',
      'Hand it to — not on this thread yet',
    ]);
    expect(Array.from(groups[0]!.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['Alpha', 'Bravo']);
    expect(Array.from(groups[1]!.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['Charlie']);
    // And still no broadcast option — six agents each getting "yes, go ahead"
    // is six agents acting on it.
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('offers the composer when NOBODY is on the thread but an agent is wired to it', async () => {
    renderDetail(thread({ participants: [], session_ids: [], reply_target_session_id: null }));
    const select = await target();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Charlie']);
    expect(select.querySelectorAll('optgroup')).toHaveLength(1);
  });

  it('says so only when no agent is wired to the channel at all', async () => {
    renderDetail(thread({ participants: [], session_ids: [], assignable_agents: [], reply_target_session_id: null }));
    expect(await screen.findByText(/no agent is wired to this thread’s channel/i)).toBeTruthy();
    expect(screen.queryByLabelText('Send to')).toBeNull();
  });

  it('sends to the chosen agent, not the default one', async () => {
    const user = userEvent.setup();
    renderDetail(thread());
    await user.selectOptions(await target(), 'ag-1');
    await user.type(screen.getByLabelText('Message text'), 'use the device flow');
    await user.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(postThreadMessage).toHaveBeenCalledTimes(1));
    expect(postThreadMessage.mock.calls[0]![0]).toBe('slack:CTESTCHAN01:1700000000.11');
    expect(postThreadMessage.mock.calls[0]![1].agent_group_id).toBe('ag-1');
    expect(postThreadMessage.mock.calls[0]![1].text).toBe('use the device flow');
  });

  it('assigning an agent with no session says the queue was opened', async () => {
    const user = userEvent.setup();
    postThreadMessage.mockResolvedValue({ created_session: true, handoff: null });
    renderDetail(thread());
    await user.selectOptions(await target(), 'ag-3');
    // The hint changes BEFORE the send: the operator should know a queue is
    // about to be opened, not find out afterwards.
    expect(screen.getByText(/opens its queue on the thread/i)).toBeTruthy();
    await user.type(screen.getByLabelText('Message text'), 'you own this now');
    await user.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(postThreadMessage).toHaveBeenCalledTimes(1));
    expect(postThreadMessage.mock.calls[0]![1].agent_group_id).toBe('ag-3');
    expect(await screen.findByText(/Assigned to Charlie — opened its queue on this thread\./)).toBeTruthy();
  });

  it('reports the hand-over, including when the incumbent could not be told', async () => {
    const user = userEvent.setup();
    postThreadMessage.mockResolvedValue({
      created_session: true,
      handoff: { claim_slug: 'acme-pr-733', claim_owner: 'Alpha', holder_agent_group_id: 'ag-1', notified: true },
    });
    const { unmount } = renderDetail(thread());
    await user.type(await screen.findByLabelText('Message text'), 'take it');
    await user.click(screen.getByRole('button', { name: 'send' }));
    expect(await screen.findByText(/Alpha was asked to park or release `acme-pr-733`\./)).toBeTruthy();
    unmount();

    postThreadMessage.mockResolvedValue({
      created_session: false,
      handoff: { claim_slug: 'acme-pr-733', claim_owner: 'Alpha', holder_agent_group_id: null, notified: false },
    });
    renderDetail(thread());
    await user.type(await screen.findByLabelText('Message text'), 'take it');
    await user.click(screen.getByRole('button', { name: 'send' }));
    expect(await screen.findByText(/Could not notify Alpha.*tell them yourself/)).toBeTruthy();
  });
});

/**
 * The hint beside the selector used to render on every send, including the
 * common case (an agent already chosen, not assigning) — "only this agent
 * receives it" consumed a full row's width there for a sentence the operator
 * does not need, and pushed the quick-reply row onto a line of its own. It
 * only survives now where it actually says something new: nobody chosen yet,
 * or picking this agent opens a queue.
 */
describe('the steady-state hint is gone, so the row is shared with quick replies', () => {
  it('renders no hint once an agent is already chosen and it is a plain send', async () => {
    const { container } = renderDetail(thread());
    const select = await target();
    expect(select.value).toBe('ag-2');
    expect(screen.queryByText(/only this agent receives it/i)).toBeNull();
    const row = select.closest('.ncc-composer-target') as HTMLElement;
    expect(row.querySelector('.ncc-composer-hint')).toBeNull();
    // With the hint gone, the selector and the quick replies are the row's
    // only real content — siblings in the SAME flex container, not a
    // hint-only row pushing the replies onto a line of their own.
    expect(row.contains(row.querySelector('.ncc-composer-chips'))).toBe(true);
    expect(container.querySelectorAll('.ncc-composer-hint')).toHaveLength(0);
  });
});

describe('prefill chips set the box and nothing else', () => {
  it('offers the three decision chips and never sends on tap', async () => {
    const user = userEvent.setup();
    renderDetail(thread());
    const chips = await screen.findByRole('group', { name: 'One-tap answers' });
    expect(Array.from(chips.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'approve as proposed',
      'hold — need more info',
      'no — …',
    ]);
    await user.click(screen.getByRole('button', { name: 'no — …' }));
    // Mid-sentence on purpose: a refusal with no reason costs another round trip.
    expect((screen.getByLabelText('Message text') as HTMLTextAreaElement).value).toBe('no — ');
    expect(postThreadMessage).not.toHaveBeenCalled();
  });

  it('a ship instruction becomes a chip that presets the addressee', async () => {
    const user = userEvent.setup();
    renderDetail(thread(), { nextAction: 'kit records @charlie ship 869; a human presses the merge' });
    await user.click(await screen.findByRole('button', { name: '@charlie ship 869' }));
    expect((screen.getByLabelText('Message text') as HTMLTextAreaElement).value).toBe('@charlie ship 869');
    // Charlie is not on the thread — the ship chip resolving to it is precisely
    // the case Assign exists for.
    expect((await target()).value).toBe('ag-3');
    expect(postThreadMessage).not.toHaveBeenCalled();
  });

  it('a handle nobody answers to leaves the selector alone', async () => {
    const user = userEvent.setup();
    renderDetail(thread(), { nextAction: 'kit records @nobody ship 912' });
    await user.click(await screen.findByRole('button', { name: '@nobody ship 912' }));
    expect((screen.getByLabelText('Message text') as HTMLTextAreaElement).value).toBe('@nobody ship 912');
    expect((await target()).value).toBe('ag-2');
  });
});

/**
 * Item 3 — mobile density. The three 44px chip buttons cost a whole row on a
 * phone, so a compact dropdown does the same job (CSS decides which of the
 * two is on screen; both are always in the DOM — see console.css). This binds
 * the mechanism: every chip is reachable through it, it never sends, and it
 * can fire the SAME reply twice in a row.
 */
describe('the quick replies are also reachable through a compact dropdown (item 3)', () => {
  it('offers every chip, and picking one sets the box without sending', async () => {
    const user = userEvent.setup();
    renderDetail(thread());
    const menu = (await screen.findByRole('combobox', { name: 'Quick reply' })) as HTMLSelectElement;
    expect(Array.from(menu.options).map((o) => o.textContent)).toEqual([
      'quick reply…',
      'approve as proposed',
      'hold — need more info',
      'no — …',
    ]);
    await user.selectOptions(menu, 'no — …');
    expect((screen.getByLabelText('Message text') as HTMLTextAreaElement).value).toBe('no — ');
    expect(postThreadMessage).not.toHaveBeenCalled();
  });

  it('resets to the placeholder so the SAME reply can be picked again', async () => {
    const user = userEvent.setup();
    renderDetail(thread());
    const menu = (await screen.findByRole('combobox', { name: 'Quick reply' })) as HTMLSelectElement;
    await user.selectOptions(menu, 'approve as proposed');
    expect(menu.value).toBe('');

    await user.type(screen.getByLabelText('Message text'), ' — actually');
    await user.selectOptions(menu, 'approve as proposed');
    expect((screen.getByLabelText('Message text') as HTMLTextAreaElement).value).toBe('approve as proposed');
  });

  it('presets the addressee for a ship chip too, same as the button', async () => {
    const user = userEvent.setup();
    renderDetail(thread(), { nextAction: 'kit records @charlie ship 869; a human presses the merge' });
    const menu = await screen.findByRole('combobox', { name: 'Quick reply' });
    await user.selectOptions(menu, '@charlie ship 869');
    expect((screen.getByLabelText('Message text') as HTMLTextAreaElement).value).toBe('@charlie ship 869');
    expect((await target()).value).toBe('ag-3');
  });
});

/**
 * Item 3 — desktop density. The chips sit in the SAME row as the agent
 * selector now (nested inside `.ncc-composer-target`), rather than a sibling
 * row below it — the merge is what console-mobile.test.ts's CSS assertions
 * assume, and this pins the actual markup they assume it on.
 */
describe('the chip group sits in the composer-target row, not a row of its own (item 3)', () => {
  it('nests the chip group inside the same row as "Send to"', async () => {
    const { container } = renderDetail(thread());
    await target();
    const targetRow = container.querySelector('.ncc-composer-target')!;
    expect(targetRow.querySelector('.ncc-composer-chips')).toBeTruthy();
    expect(targetRow.querySelector('.ncc-composer-quickmenu')).toBeTruthy();
    // Not a sibling of `.ncc-composer-target` — that would be a row of its own.
    expect(container.querySelector('.ncc-composer > .ncc-composer-chips')).toBeNull();
  });
});

describe('message text renders as formatted markdown', () => {
  const withText = (text: string) =>
    getThreadDetail.mockResolvedValue({
      thread: thread(),
      transcript: [
        {
          session_id: 's-alpha',
          agent_group_id: 'ag-1',
          agent_name: 'Alpha',
          kind: 'chat',
          seq: 1,
          timestamp: '2026-08-20T09:00:00.000Z',
          direction: 'out',
          text,
        },
      ],
    });

  it('formats instead of showing the literal asterisks and fences', async () => {
    withText('**ship it** and `npm run build`\n- one\n- two');
    const { container } = renderDetail(thread());
    const body = await waitFor(() => {
      const el = container.querySelector('.ncc-msg-text');
      if (!el) throw new Error('transcript not rendered yet');
      return el;
    });
    expect(body.querySelector('strong')!.textContent).toBe('ship it');
    expect(body.querySelector('code')!.textContent).toBe('npm run build');
    expect(body.querySelectorAll('li')).toHaveLength(2);
    expect(body.textContent).not.toContain('**');
    // The console's own class, not the legacy `nc-md` whose tokens do not
    // resolve inside `.ncc`.
    expect(body.className).toContain('ncc-md');
  });

  it('never lets agent-authored HTML become live markup', async () => {
    withText('<img src=x onerror="alert(1)"> [click](javascript:alert(2))');
    const { container } = renderDetail(thread());
    const body = await waitFor(() => {
      const el = container.querySelector('.ncc-msg-text');
      if (!el) throw new Error('transcript not rendered yet');
      return el;
    });
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('a')).toBeNull();
    expect(body.textContent).toContain('<img');
  });

  it('collapses a long message behind its own preview, slicing the SOURCE', async () => {
    // Slicing rendered HTML would shred the tags; slicing the source and
    // parsing twice is what keeps the preview well-formed.
    withText(`**start**\n\n${'x'.repeat(900)}\n\n**end**`);
    const { container } = renderDetail(thread());
    const details = await waitFor(() => {
      const el = container.querySelector('.ncc-msg-expand');
      if (!el) throw new Error('transcript not rendered yet');
      return el;
    });
    expect(details.querySelector('summary .ncc-msg-text strong')!.textContent).toBe('start');
    expect(details.querySelector('summary')!.textContent).toContain('show full message');
  });
});

/* ─── Stale selection ──────────────────────────────────────────────────────── */

/**
 * The composer holds an `agent_group_id` across live refreshes of the thread
 * row. An agent can leave `participants` (its session archived) and a chip can
 * preset an assignable the next refresh no longer wires to this channel. The
 * legacy Observatory learned this the hard way: the select renders blank while
 * the state still holds the old choice, "and the send would then go to somebody
 * the operator can no longer see. Nobody is the honest reading of that."
 */
describe('a selection that goes stale falls to nobody, never to a silent substitute', () => {
  const rerenderWith = (t: ThreadSummary) =>
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ThreadDetail thread={t} />
      </SWRConfig>,
    );

  it('blanks the selector when the chosen agent is no longer reachable', async () => {
    // The chip path: an assignable is chosen, then it stops being wired.
    const before = thread({ assignable_agents: [{ agent_group_id: 'ag-3', name: 'Charlie' }] });
    const { rerender } = rerenderWith(before);
    const select = await target();
    await userEvent.selectOptions(select, 'ag-3');
    expect(select.value).toBe('ag-3');

    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ThreadDetail thread={thread({ assignable_agents: [] })} />
      </SWRConfig>,
    );
    const after = (await target()) as HTMLSelectElement;
    expect(after.value).toBe('');
    expect(screen.getByText('pick who this goes to')).toBeTruthy();
  });

  it('refuses to send while nobody is selected', async () => {
    const { rerender } = rerenderWith(thread({ assignable_agents: [{ agent_group_id: 'ag-3', name: 'Charlie' }] }));
    await userEvent.selectOptions(await target(), 'ag-3');
    await userEvent.type(screen.getByLabelText('Message text'), 'ship it');

    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ThreadDetail thread={thread({ assignable_agents: [] })} />
      </SWRConfig>,
    );
    const send = screen.getByRole('button', { name: /^send$/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await userEvent.click(send);
    expect(postThreadMessage).not.toHaveBeenCalled();
  });

  it('leaves a still-valid choice alone across a refresh', async () => {
    const { rerender } = rerenderWith(thread());
    await userEvent.selectOptions(await target(), 'ag-1');
    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ThreadDetail thread={thread({ last_activity_at: '2026-08-20T10:00:00.000Z' })} />
      </SWRConfig>,
    );
    expect((await target()).value).toBe('ag-1');
  });
});

/* ─── Shared refusal wording ───────────────────────────────────────────────── */

describe('a refused send is explained in the operator’s words', () => {
  it('translates the wire code rather than printing it', async () => {
    postThreadMessage.mockRejectedValue({ status: 429, error: 'rate_limit_exceeded', retry_after: 9 });
    renderDetail(thread());
    await userEvent.type(await screen.findByLabelText('Message text'), 'go');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText(/too fast — try again in 9s/)).toBeTruthy());
  });

  it('reads an unrouted endpoint as a pending restart, not as a bug in the work', async () => {
    postThreadMessage.mockRejectedValue({ status: 404, error: 'unknown' });
    renderDetail(thread());
    await userEvent.type(await screen.findByLabelText('Message text'), 'go');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText(/not active until the next host restart/)).toBeTruthy());
  });
});

/* ─── The transcript opens at its newest message ───────────────────────────── */

/**
 * jsdom lays nothing out — `scrollHeight` and `clientHeight` are both 0 — so
 * the anchor's arithmetic has no room to be either right or wrong. These give
 * it one: a 1000px transcript in a 300px window, where "at the bottom" is a
 * `scrollTop` of 700 and the newest message is at 1000.
 */
const SCROLL_H = 1000;
const CLIENT_H = 300;
const AT_BOTTOM = SCROLL_H - CLIENT_H;

function entry(seq: number): ThreadTranscriptEntry {
  return {
    session_id: 's-alpha',
    agent_group_id: 'ag-1',
    agent_name: 'Alpha',
    direction: 'out',
    kind: 'chat',
    seq,
    timestamp: '2026-08-20T09:00:00.000Z',
    text: `message ${seq}`,
  };
}

// One stable config object, so a `rerender` keeps the SWR cache it mounted with
// rather than starting a fresh one and refetching everything.
const swr = { provider: () => new Map(), dedupingInterval: 0 };
const mountDetail = (t: ThreadSummary) =>
  render(
    <SWRConfig value={swr}>
      <ThreadDetail thread={t} />
    </SWRConfig>,
  );
const remount = (view: ReturnType<typeof mountDetail>, t: ThreadSummary) =>
  view.rerender(
    <SWRConfig value={swr}>
      <ThreadDetail thread={t} />
    </SWRConfig>,
  );

describe('the transcript opens at its newest message', () => {
  const restore: Array<() => void> = [];
  beforeEach(() => {
    for (const [prop, value] of [
      ['scrollHeight', SCROLL_H],
      ['clientHeight', CLIENT_H],
    ] as const) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value });
      restore.push(() => {
        if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
      });
    }
    getThreadDetail.mockResolvedValue({ thread: thread(), transcript: [entry(1), entry(2)] });
  });
  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  const box = (c: HTMLElement) => c.querySelector('.ncc-transcript') as HTMLElement;

  it('lands on the newest message, not at the top of the history', async () => {
    const view = mountDetail(thread());
    await screen.findByText('message 2');
    await waitFor(() => expect(box(view.container).scrollTop).toBe(SCROLL_H));
  });

  it('re-anchors on a thread switch, wherever the previous thread was left', async () => {
    const view = mountDetail(thread());
    const el = box(view.container);
    await waitFor(() => expect(el.scrollTop).toBe(SCROLL_H));

    // Scrolled up to read history in THIS thread…
    el.scrollTop = 0;
    fireEvent.scroll(el);
    expect(el.scrollTop).toBe(0);

    // …and opening a DIFFERENT thread is an open, not a continuation of that.
    getThreadDetail.mockResolvedValue({ thread: thread(), transcript: [entry(9)] });
    remount(view, thread({ thread_id: 'slack:CTESTCHAN01:1700000999.22' }));
    await waitFor(() => expect(el.scrollTop).toBe(SCROLL_H));
  });

  it('follows a new message when the operator is already at the bottom', async () => {
    const view = mountDetail(thread());
    const el = box(view.container);
    await waitFor(() => expect(el.scrollTop).toBe(SCROLL_H));

    el.scrollTop = AT_BOTTOM;
    fireEvent.scroll(el);

    getThreadDetail.mockResolvedValue({ thread: thread(), transcript: [entry(1), entry(2), entry(3)] });
    remount(view, thread({ last_activity_at: '2026-08-20T09:05:00.000Z' }));
    await screen.findByText('message 3');
    await waitFor(() => expect(el.scrollTop).toBe(SCROLL_H));
  });

  it('does NOT yank the operator down when they have scrolled up to read history', async () => {
    const view = mountDetail(thread());
    const el = box(view.container);
    await waitFor(() => expect(el.scrollTop).toBe(SCROLL_H));

    // 1000 − 120 − 300 = 580px from the bottom. Reading, not following.
    el.scrollTop = 120;
    fireEvent.scroll(el);

    getThreadDetail.mockResolvedValue({ thread: thread(), transcript: [entry(1), entry(2), entry(3)] });
    remount(view, thread({ last_activity_at: '2026-08-20T09:05:00.000Z' }));
    await screen.findByText('message 3');
    // The difference between a chat pane and an annoying one.
    expect(el.scrollTop).toBe(120);
  });
});
