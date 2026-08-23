import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThreadRow } from './ThreadRow.js';
import { STATE_PRESENTATION, elapsed, initials, showsLiveLine, toolLabel } from './thread-state.js';
import type { ThreadState, ThreadSummary } from '../../lib/api.js';

/**
 * The row is the whole surface's load-bearing element, so these tests bind the
 * three rules that ship broken silently:
 *
 *  - every one of the six states renders, with ITS verb and ITS label (§5);
 *  - the hybrid line appears only on rows wanting attention (§4.1 — a COST
 *    control, so "improving" it into a preview for every row is a regression
 *    this test is here to catch);
 *  - the liveness rule moves only for a running thread and holds still for a
 *    stalled one (§6).
 */

const NOW = Date.parse('2026-08-20T12:00:00.000Z');

function thread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    thread_id: 'slack:CROOM:1700000000.11',
    synthetic: false,
    channel_key: 'slack:CROOM',
    channel_name: '#example-eng',
    title: 'Waiting: which OAuth flow for the retry path?',
    participants: [
      { agent_group_id: 'ag-1', name: 'Alpha', session_id: 's-1', avatarUrl: null, provider: 'claude' },
      { agent_group_id: 'ag-2', name: 'Bravo', session_id: 's-2', avatarUrl: null, provider: 'codex' },
    ],
    assignable_agents: [{ agent_group_id: 'ag-3', name: 'Charlie' }],
    last_activity_at: '2026-08-20T09:00:00.000Z',
    state: 'needs_you',
    session_ids: ['s-1', 's-2'],
    container_status: 'idle',
    provider_status: null,
    current_tool: null,
    tool_started_at: null,
    reply_target_session_id: 's-1',
    snoozed: false,
    scheduled_task: false,
    ...over,
  };
}

const ALL_STATES: ThreadState[] = ['needs_you', 'stalled', 'unassigned', 'running', 'parked', 'idle'];

function renderRow(over: Partial<ThreadSummary> = {}, props: Partial<Parameters<typeof ThreadRow>[0]> = {}) {
  const onSelect = vi.fn();
  const utils = render(
    <ul>
      <ThreadRow thread={thread(over)} now={NOW} onSelect={onSelect} {...props} />
    </ul>,
  );
  const row = utils.container.querySelector('.ncc-row') as HTMLElement;
  return { ...utils, row, onSelect };
}

describe('all six states render, every one with a LIVE verb', () => {
  it.each(ALL_STATES)('%s shows its own label and verb', (state) => {
    const { row } = renderRow({ state });
    const presentation = STATE_PRESENTATION[state];
    expect(row.dataset['state']).toBe(state);
    expect(row.querySelector('.ncc-state')!.textContent).toBe(presentation.label);
    expect(row.querySelector('.ncc-verb')!.textContent).toBe(presentation.verb);
  });

  /**
   * The action model has ONE primitive — send a message to a chosen agent — and
   * the per-state verb is a LABEL over it. `idle` used to be the one row with
   * no button and `stalled`/`unassigned`/`parked` rendered inert with a reason;
   * both of those are gone, and this is the test that keeps them gone.
   */
  it.each(ALL_STATES)('%s fires its verb — no state is inert', async (state) => {
    const onVerb = vi.fn();
    const { row } = renderRow({ state }, { onVerb });
    const verb = row.querySelector('.ncc-verb') as HTMLElement;
    expect(verb.getAttribute('aria-disabled')).toBeNull();
    expect(verb.hasAttribute('disabled')).toBe(false);
    expect(verb.getAttribute('title')).toBeNull();
    await userEvent.click(verb);
    expect(onVerb).toHaveBeenCalledTimes(1);
  });

  it('every state names a verb, and no two states share a label', () => {
    const labels = ALL_STATES.map((s) => STATE_PRESENTATION[s].label);
    expect(new Set(labels).size).toBe(ALL_STATES.length);
    for (const s of ALL_STATES) expect(STATE_PRESENTATION[s].verb.trim()).not.toBe('');
  });

  /**
   * Kill is GONE, not disabled. A stalled thread gets a message, not a kill —
   * there is no verb, no reason string and no code path left that names one.
   */
  it('Kill does not exist anywhere in the presentation table or the row', () => {
    for (const s of ALL_STATES) {
      expect(STATE_PRESENTATION[s].verb.toLowerCase()).not.toContain('kill');
      expect(JSON.stringify(STATE_PRESENTATION[s]).toLowerCase()).not.toContain('kill');
    }
    expect(renderRow({ state: 'stalled' }).row.textContent!.toLowerCase()).not.toContain('kill');
    expect(STATE_PRESENTATION.stalled.verb).toBe('Push');
  });

  it('the verb names its thread, so forty of them down a list are distinguishable', () => {
    const { row } = renderRow({ state: 'idle', title: 'the retry path' });
    expect(row.querySelector('.ncc-verb')!.getAttribute('aria-label')).toBe('Steer — the retry path');
  });

  it('paints the status bar only when the row wants something (§4)', () => {
    // Attention states carry the red bar, running the green one; everything
    // else is transparent because it wants nothing.
    expect(renderRow({ state: 'needs_you' }).row.className).toContain('attention');
    expect(renderRow({ state: 'stalled' }).row.className).toContain('attention');
    expect(renderRow({ state: 'unassigned' }).row.className).toContain('attention');
    expect(renderRow({ state: 'running' }).row.className).toContain('live');
    for (const quiet of ['parked', 'idle'] as ThreadState[]) {
      const cls = renderRow({ state: quiet }).row.className;
      expect(cls).toContain('quiet');
      expect(cls).not.toContain('attention');
      expect(cls).not.toContain('live');
    }
  });

  it('always renders the meta line and the title (§4: always present)', () => {
    for (const state of ALL_STATES) {
      const { row } = renderRow({ state });
      expect(row.querySelector('.ncc-row-title')!.textContent).toContain('OAuth');
      expect(row.querySelector('.ncc-row-meta')!.textContent).toContain('#example-eng');
      expect(row.querySelector('.ncc-row-meta')!.textContent).toContain('2 agents');
    }
  });
});

describe('the hybrid line is a cost control (§4.1)', () => {
  const preview = { speaker: 'Alpha', excerpt: 'two options and I do not think I should default this one' };

  it('renders on every attention state', () => {
    for (const state of ['needs_you', 'stalled', 'unassigned'] as ThreadState[]) {
      const { row } = renderRow({ state }, { preview });
      expect(row.querySelector('.ncc-row-hybrid')!.textContent).toContain('two options');
      expect(row.querySelector('.ncc-row-hybrid .speaker')!.textContent).toContain('Alpha');
    }
  });

  it('is absent on healthy running, parked and idle rows EVEN IF a preview is handed in', () => {
    for (const state of ['running', 'parked', 'idle'] as ThreadState[]) {
      const { row } = renderRow({ state, tool_started_at: '2026-08-20T11:59:00.000Z' }, { preview });
      expect(row.querySelector('.ncc-row-hybrid')).toBeNull();
    }
  });

  it('degrades to no line at all when the preview has not arrived', () => {
    const { row } = renderRow({ state: 'needs_you' }, { preview: null });
    expect(row.querySelector('.ncc-row-hybrid')).toBeNull();
  });
});

describe('the liveness rule (§6)', () => {
  it('moves for a running thread', () => {
    const { row } = renderRow({ state: 'running', tool_started_at: '2026-08-20T11:57:00.000Z' });
    const seg = row.querySelector('.ncc-track > div')!;
    expect(seg.className).toContain('ncc-seg-live');
    expect(seg.getAttribute('data-motion')).toBe('live');
  });

  it('holds perfectly still for a stalled thread — stillness IS the signal', () => {
    const { row } = renderRow({ state: 'stalled', tool_started_at: '2026-08-20T11:00:00.000Z' });
    const seg = row.querySelector('.ncc-track > div')!;
    expect(seg.className).toContain('ncc-seg-still');
    expect(seg.className).not.toContain('ncc-seg-live');
    expect(seg.getAttribute('data-motion')).toBe('still');
  });

  it('is absent entirely when no tool is in flight', () => {
    for (const state of ALL_STATES) {
      const { row } = renderRow({ state, tool_started_at: null });
      expect(row.querySelector('.ncc-track')).toBeNull();
    }
  });

  it('encodes NOTHING in its length: the markup carries no width, ratio or percent', () => {
    // If someone ever "fixes" the rule into a progress bar, it will land as an
    // inline width / aria-valuenow on this element. There is no percent-complete
    // signal in the system, so any such value would be fabricated.
    const { row } = renderRow({ state: 'running', tool_started_at: '2026-08-20T11:57:00.000Z' });
    const seg = row.querySelector('.ncc-track > div') as HTMLElement;
    expect(seg.style.width).toBe('');
    expect(seg.getAttribute('aria-valuenow')).toBeNull();
    expect(seg.getAttribute('role')).toBeNull();
    expect(row.querySelector('.ncc-track')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('carries the reduced-motion branch in CSS, not JS — the preference can change mid-session', () => {
    const css = readFileSync(join(process.cwd(), 'src/views/console/console.css'), 'utf8');
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('.ncc-seg-live');
    // Degrades to the same static dimmed rule the stalled variant already is.
    expect(block).toContain('animation: none');
    expect(block).toContain('opacity: 0.3');
  });
});

describe('avatar stack (§4)', () => {
  const people = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      agent_group_id: `ag-${i}`,
      name: `Agent ${i}`,
      session_id: `s-${i}`,
      avatarUrl: null,
      provider: 'claude',
    }));

  it('shows at most three faces, then a +N pill', () => {
    const { row } = renderRow({ participants: people(6) });
    expect(row.querySelectorAll('.ncc-face:not(.more)')).toHaveLength(3);
    expect(row.querySelector('.ncc-face.more')!.textContent).toBe('+3');
  });

  it('draws no +N when the thread fits', () => {
    const { row } = renderRow({ participants: people(3) });
    expect(row.querySelector('.ncc-face.more')).toBeNull();
  });

  it('uses the real avatar when one exists, and initials when it does not', () => {
    const { row } = renderRow({
      participants: [
        {
          agent_group_id: 'ag-1',
          name: 'Alpha',
          session_id: 's-1',
          avatarUrl: 'https://example.invalid/a_72.png',
          provider: 'claude',
        },
        { agent_group_id: 'ag-2', name: 'Bravo', session_id: 's-2', avatarUrl: null, provider: 'claude' },
      ],
    });
    const faces = row.querySelectorAll('.ncc-face');
    // Real face, NOT pixelated — §11 removed that treatment.
    const img = faces[0]!.querySelector('img')!;
    expect(img.getAttribute('src')).toContain('example.invalid');
    expect(img.className).not.toContain('pixel');
    // Two letters, not one: at 25px in a stack, agents whose names share a
    // first letter all collapse to one glyph under the default monogram.
    expect(within(faces[1] as HTMLElement).getByText('BR')).toBeTruthy();
  });

  it('falls back to an orphan chip when nobody owns the item', () => {
    const { row } = renderRow({ participants: [], state: 'unassigned' });
    expect(row.querySelector('.ncc-face.orphan')).toBeTruthy();
    expect(row.querySelector('.ncc-row-meta')!.textContent).toContain('no owner');
  });
});

describe('the scheduled-task pill (operator report 2026-08-20, DEFECT 1)', () => {
  it('renders when the thread is a scheduled task, and names its channel as the tasks pseudo-channel', () => {
    const { row } = renderRow({ scheduled_task: true, channel_name: 'tasks' });
    expect(row.querySelector('.ncc-scheduled-pill')!.textContent).toBe('scheduled');
    expect(row.querySelector('.ncc-row-meta')!.textContent).toContain('tasks');
  });

  it('is absent for an ordinary channel thread', () => {
    const { row } = renderRow({ scheduled_task: false });
    expect(row.querySelector('.ncc-scheduled-pill')).toBeNull();
  });
});

/**
 * The "proposes done" badge (thread-closure contract, item 1). A FLAG, not a
 * state: an agent that proposes closing is very often still `running`,
 * because its container has not exited yet, and reporting live work as
 * anything else is exactly the failure that got the old Dismiss action
 * removed. So the load-bearing rule here is ALONGSIDE, never instead of —
 * `.ncc-state` must keep reading whatever `state` says regardless of whether
 * a proposal is also on the row.
 */
describe('the "proposes done" badge (thread-closure contract, item 1)', () => {
  const proposal = {
    reason: 'fixed the retry loop and confirmed the test suite is green',
    proposed_at: '2026-08-20T11:00:00.000Z',
    agent_group_id: 'ag-1',
    session_id: 's-1',
  };

  it('is absent when the agent has proposed nothing', () => {
    const { row } = renderRow({ done_proposal: null });
    expect(row.querySelector('.ncc-proposal-pill')).toBeNull();
    expect(row.querySelector('.ncc-row-proposal')).toBeNull();
  });

  it('renders ALONGSIDE the state pill, never in place of it', () => {
    const { row } = renderRow({ state: 'idle', done_proposal: proposal });
    expect(row.querySelector('.ncc-proposal-pill')!.textContent).toBe('proposes done');
    // The state pill is UNCHANGED — same element, same label, still there.
    expect(row.querySelector('.ncc-state')!.textContent).toBe(STATE_PRESENTATION.idle.label);
  });

  it('a proposing thread that is still running reads Running, not some seventh "proposed" state', () => {
    const { row } = renderRow({
      state: 'running',
      tool_started_at: '2026-08-20T11:59:00.000Z',
      done_proposal: proposal,
    });
    expect(row.querySelector('.ncc-state')!.textContent).toBe('Running');
    expect(row.querySelector('.ncc-proposal-pill')).toBeTruthy();
    // The liveness rule still moves — a proposal never freezes the row's own
    // live signal, which is a DIFFERENT thing this badge must not shadow.
    expect(row.querySelector('.ncc-track > div')!.className).toContain('ncc-seg-live');
  });

  it("shows the agent's own reason, legibly, not just in a tooltip a touch screen can never trigger", () => {
    const { row } = renderRow({ done_proposal: proposal });
    const line = row.querySelector('.ncc-row-proposal')!;
    expect(line.textContent).toContain('fixed the retry loop and confirmed the test suite is green');
    // Named by the proposing participant, not a generic "agent".
    expect(line.textContent).toContain('Alpha');
  });

  it('falls back to the raw agent_group_id if the proposer somehow left the participant list', () => {
    const { row } = renderRow({ done_proposal: { ...proposal, agent_group_id: 'ag-ghost' } });
    expect(row.querySelector('.ncc-row-proposal')!.textContent).toContain('ag-ghost');
  });
});

/**
 * WHY a `needs_you` row is `needs_you` (operator report 2026-08-21). An
 * operator opened a `needs_you` thread whose newest message was a completion
 * report and read the flag as a false positive; the actual cause was a parked
 * claim's note two hops away. The row must say why, as text — same "not just
 * a tooltip a touch screen can never trigger" rule the proposal line above
 * already carries.
 */
describe('the needs_you reason line (operator report 2026-08-21)', () => {
  const longNote =
    'waiting on the release owner or backup reviewer: PR #956 mechanically ready at 64c1cca1 but the consequence lane has no recorded human ship';

  it('is absent when there is no reason', () => {
    const { row } = renderRow({ needs_you_reason: null });
    expect(row.querySelector('.ncc-row-reason')).toBeNull();
  });

  it('renders the reason as visible text, not hidden behind a title attribute', () => {
    const { row } = renderRow({ needs_you_reason: { cause: 'parked_note', text: longNote } });
    const line = row.querySelector('.ncc-row-reason')!;
    // The full text is in the DOM's text content — readable without hover,
    // which is what a 390px touch screen requires (§8).
    expect(line.textContent).toBe(longNote);
    // A `title` may ALSO be present (desktop hover is a bonus, same as the
    // proposal line), but it is never the ONLY place the text lives.
    expect(line.textContent!.length).toBeGreaterThan(0);
  });

  it('renders for the ask_question and task_needs_input causes too', () => {
    for (const reason of [
      { cause: 'ask_question' as const, text: 'The agent asked a question and is waiting for a reply.' },
      { cause: 'task_needs_input' as const, text: 'Repo path A or B?' },
    ]) {
      const { row } = renderRow({ needs_you_reason: reason });
      expect(row.querySelector('.ncc-row-reason')!.textContent).toBe(reason.text);
    }
  });

  it('stacks ABOVE the proposal line, never replacing it — a row can carry both', () => {
    const { row } = renderRow({
      needs_you_reason: { cause: 'parked_note', text: 'waiting on ops to confirm the rollback' },
      done_proposal: {
        reason: 'fixed the retry loop and confirmed the test suite is green',
        proposed_at: '2026-08-20T11:00:00.000Z',
        agent_group_id: 'ag-1',
        session_id: 's-1',
      },
    });
    const reasonLine = row.querySelector('.ncc-row-reason')!;
    const proposalLine = row.querySelector('.ncc-row-proposal')!;
    expect(reasonLine.textContent).toContain('waiting on ops to confirm the rollback');
    expect(proposalLine.textContent).toContain('fixed the retry loop');
    // Neither line ate the other — both are still their own elements.
    expect(reasonLine).not.toBe(proposalLine);
  });

  it('truncates gracefully at 390px: single line, ellipsis overflow, never a title-only reveal', () => {
    const css = readFileSync(join(process.cwd(), 'src/views/console/console.css'), 'utf8');
    const block = css.slice(css.indexOf('.ncc-row-reason {'), css.indexOf('.ncc-row-reason {') + 300);
    expect(block).toContain('white-space: nowrap');
    expect(block).toContain('overflow: hidden');
    expect(block).toContain('text-overflow: ellipsis');
  });
});

/**
 * The console does NOT reconcile a claim against reality — releasing a claim is
 * the claim OWNER's job, and a display that second-guesses its source produces
 * two disagreeing truths. The park age is what makes a stale note legible
 * without the console inventing a verdict.
 */
describe('claim park age', () => {
  const staleNote = 'waiting on the release owner: PR #956 mechanically ready';

  it('renders the age beside the reason', () => {
    const { row } = renderRow({
      needs_you_reason: { cause: 'parked_note', text: staleNote, parked_ms: 20 * 3_600_000 },
    });
    const line = row.querySelector('.ncc-row-reason')!;
    // Formatted by the ONE duration formatter the meta-line age already uses
    // (`relDuration`), so an age never reads in two shapes on the same row —
    // which means it rolls to days past 24h: 40h shows as `1d`, not `40h`.
    expect(line.querySelector('.ncc-row-parkage')!.textContent).toBe('parked 20h ago');
    // The note itself is still fully readable — the marker qualifies it, never
    // replaces it.
    expect(line.textContent).toContain(staleNote);
  });

  it('leads with the age so a 390px ellipsis cannot clip it off the end', () => {
    const { row } = renderRow({
      needs_you_reason: { cause: 'parked_note', text: staleNote.repeat(4), parked_ms: 40 * 3_600_000 },
    });
    expect(row.querySelector('.ncc-row-reason')!.textContent!.startsWith('parked 1d ago')).toBe(true);
  });

  it('renders NO age when nothing measured one — never "parked 0s ago"', () => {
    // §12: an unmeasured value is not a zero. `claims-board.ts` writes 0 when
    // `parked_at` is missing or unparseable, which means unknown, not "now".
    for (const parked_ms of [null, 0, undefined]) {
      const { row } = renderRow({ needs_you_reason: { cause: 'parked_note', text: staleNote, parked_ms } });
      expect(row.querySelector('.ncc-row-parkage')).toBeNull();
      expect(row.querySelector('.ncc-row-reason')!.textContent).toBe(staleNote);
    }
  });

  it('never appears on the other two needs_you causes — neither has a claim behind it', () => {
    const { row } = renderRow({ needs_you_reason: { cause: 'ask_question', text: 'A question is pending.' } });
    expect(row.querySelector('.ncc-row-parkage')).toBeNull();
  });
});

/**
 * §2/§5: an ownerless work item from a workgroup attention source. Its age
 * marker is a PROVENANCE signal, never a suppression one — an empty feed is
 * indistinguishable from a healthy one.
 */
describe('attention-source provenance', () => {
  const source = {
    kind: 'release-board',
    as_of: '2026-08-20T09:00:00.000Z',
    url: 'https://github.com/example-org/example-app/pull/817',
    next_action: '@releasebot ship 817',
  };

  it('is absent on an ordinary thread row', () => {
    const { row } = renderRow();
    expect(row.querySelector('.ncc-row-source')).toBeNull();
  });

  it('names the source and how old it is', () => {
    const { row } = renderRow({ attention_source: source });
    expect(row.querySelector('.ncc-row-source')!.textContent).toBe('release-board 3h old');
  });

  it('says the source could not be read rather than implying it is fresh', () => {
    const { row } = renderRow({ attention_source: { ...source, as_of: null } });
    // "No board" and "board says nothing is blocked" must stay distinguishable
    // all the way to the pixel.
    expect(row.querySelector('.ncc-row-source')!.textContent).toContain('not read');
  });

  it('still renders the row when the board is ancient — staleness is marked, never hidden', () => {
    const { row } = renderRow({
      attention_source: { ...source, as_of: '2026-01-01T00:00:00.000Z' },
      participants: [],
      state: 'unassigned',
    });
    expect(row).not.toBeNull();
    expect(row.querySelector('.ncc-row-source')!.textContent).toContain('231d old');
    // …and it still ends in a verb (§1), which is the whole point of showing it.
    expect(row.querySelector('.ncc-verb')).not.toBeNull();
  });

  it('marks a row whose OWN source is past its declared cadence', () => {
    const { row } = renderRow({ attention_source: { ...source, stale: true } });
    const mark = row.querySelector('.ncc-row-source')!;
    // The word LEADS: a marker clipped off the end of a 390px ellipsis is a
    // marker that does not exist (the same rule `.ncc-row-parkage` follows).
    expect(mark.textContent!.startsWith('stale · ')).toBe(true);
    expect(mark.classList.contains('stale')).toBe(true);
    expect(mark.getAttribute('title')).toContain('PAST ITS EXPECTED REFRESH');
  });

  it('leaves a row from a fresh source unmarked', () => {
    const { row } = renderRow({ attention_source: { ...source, stale: false } });
    const mark = row.querySelector('.ncc-row-source')!;
    expect(mark.textContent).toBe('release-board 3h old');
    expect(mark.classList.contains('stale')).toBe(false);
  });

  it('leaves a row unmarked when no cadence was declared — nobody said, so nothing is claimed', () => {
    // `null` must render exactly like `false` does, and must NOT be turned into
    // a "fresh" word: an unmarked row means nobody checked, and §12 forbids
    // undeclared reading as verified.
    const { row } = renderRow({ attention_source: { ...source, stale: null } });
    const mark = row.querySelector('.ncc-row-source')!;
    expect(mark.textContent).toBe('release-board 3h old');
    expect(mark.classList.contains('stale')).toBe(false);
    expect(mark.getAttribute('title')).not.toContain('PAST ITS EXPECTED REFRESH');
  });

  it('marks a stale row without hiding it — the work is real either way', () => {
    const { row } = renderRow({
      attention_source: { ...source, stale: true, as_of: '2026-01-01T00:00:00.000Z' },
      participants: [],
      state: 'unassigned',
    });
    expect(row.querySelector('.ncc-row-source')!.textContent).toContain('231d old');
    // …and it still ends in a verb (§1), which is the whole point of showing it.
    expect(row.querySelector('.ncc-verb')).not.toBeNull();
  });

  it('carries the next action in the hover, so the row says what a PERSON has to do', () => {
    const { row } = renderRow({ attention_source: source });
    expect(row.querySelector('.ncc-row-source')!.getAttribute('title')).toContain('@releasebot ship 817');
  });
});

describe('interaction', () => {
  it('opens the thread from the row body and from the verb', async () => {
    const user = userEvent.setup();
    const { row, onSelect } = renderRow();
    await user.click(row.querySelector('.ncc-row-main')!);
    await user.click(row.querySelector('.ncc-verb')!);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('routes the verb to onVerb when Phase 3 supplies one', async () => {
    const user = userEvent.setup();
    const onVerb = vi.fn();
    const { row, onSelect } = renderRow({}, { onVerb });
    await user.click(row.querySelector('.ncc-verb')!);
    expect(onVerb).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the row body and the verb as SIBLING buttons — nested buttons are unreachable', () => {
    const { row } = renderRow();
    const main = row.querySelector('.ncc-row-main')!;
    expect(main.querySelector('button')).toBeNull();
  });
});

describe('thread-state helpers', () => {
  it('shows the live line for running and stalled only, and only with a tool in flight', () => {
    expect(showsLiveLine({ state: 'running', tool_started_at: '2026-08-20T11:00:00Z' })).toBe(true);
    expect(showsLiveLine({ state: 'stalled', tool_started_at: '2026-08-20T11:00:00Z' })).toBe(true);
    expect(showsLiveLine({ state: 'running', tool_started_at: null })).toBe(false);
    expect(showsLiveLine({ state: 'parked', tool_started_at: '2026-08-20T11:00:00Z' })).toBe(false);
  });

  it('never prints a provider wire constant at the operator (§5.1)', () => {
    // Roughly half the fleet is non-Claude and reports the generic `CodexItem`.
    expect(toolLabel('CodexItem')).toBe('working');
    expect(toolLabel(null)).toBe('working');
    expect(toolLabel('Bash · git fetch --all')).toBe('Bash · git fetch --all');
  });

  it('formats elapsed in the artboard shape', () => {
    const t = (mins: number) => elapsed(new Date(NOW - mins * 60_000).toISOString(), NOW);
    expect(elapsed(new Date(NOW - 18_000).toISOString(), NOW)).toBe('18s');
    expect(t(3)).toBe('3m 00s');
    expect(t(41)).toBe('41m 00s');
    expect(t(125)).toBe('2h 05m');
    expect(elapsed(null, NOW)).toBe('');
  });

  it('derives initials from friendly names, never from ids', () => {
    expect(initials('Alpha')).toBe('AL');
    expect(initials('example codex')).toBe('EC');
    expect(initials('')).toBe('·');
  });
});
