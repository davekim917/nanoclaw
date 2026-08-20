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
 *  - every one of the seven states renders, with ITS verb and ITS label (§5);
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
    last_activity_at: '2026-08-20T09:00:00.000Z',
    state: 'needs_you',
    session_ids: ['s-1', 's-2'],
    container_status: 'idle',
    provider_status: null,
    current_tool: null,
    tool_started_at: null,
    reply_target_session_id: 's-1',
    snoozed: false,
    ...over,
  };
}

const ALL_STATES: ThreadState[] = ['needs_you', 'stalled', 'unassigned', 'running', 'parked', 'done', 'idle'];

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

describe('all seven states render', () => {
  it.each(ALL_STATES)('%s shows its own label and verb', (state) => {
    const { row } = renderRow({ state });
    const presentation = STATE_PRESENTATION[state];
    expect(row.dataset['state']).toBe(state);
    expect(row.querySelector('.ncc-state')!.textContent).toBe(presentation.label);
    // §5: `idle`'s verb column reads `—`, so that row carries no button.
    expect(row.querySelector('.ncc-verb')?.textContent ?? null).toBe(presentation.verb);
  });

  it('gives every state at most one verb, and no two states share a label', () => {
    const labels = ALL_STATES.map((s) => STATE_PRESENTATION[s].label);
    expect(new Set(labels).size).toBe(ALL_STATES.length);
    for (const s of ALL_STATES) {
      const verb = STATE_PRESENTATION[s].verb;
      if (s === 'idle') expect(verb).toBeNull();
      else expect(verb!.split(/\s/)).toHaveLength(1);
    }
  });

  /**
   * §1 says every row ends in a verb, and three of the seven verbs have no
   * backing endpoint today. Hiding those buttons would quietly rewrite the
   * contract; rendering them inert WITH THE REASON is the honest shape, and
   * these tests exist because "just hide it" is the tempting simplification.
   */
  describe('verbs with no backing endpoint render inert, not hidden', () => {
    it.each(['stalled', 'unassigned', 'parked'] as ThreadState[])('%s carries a reason on the button', (state) => {
      const onVerb = vi.fn();
      const { row } = renderRow({ state }, { onVerb });
      const verb = row.querySelector('.ncc-verb')!;
      expect(verb.textContent).toBe(STATE_PRESENTATION[state].verb);
      expect(verb.getAttribute('aria-disabled')).toBe('true');
      expect(verb.getAttribute('title')).toBe(STATE_PRESENTATION[state].inertReason);
      // Focusable on purpose: a real `disabled` button cannot be reached by
      // keyboard, and the explanation would be unreachable with it.
      expect(verb.hasAttribute('disabled')).toBe(false);
      expect(verb.getAttribute('aria-label')).toContain('unavailable');
    });

    it.each(['stalled', 'unassigned', 'parked'] as ThreadState[])('%s does nothing when pressed', async (state) => {
      const onVerb = vi.fn();
      const { row } = renderRow({ state }, { onVerb });
      await userEvent.click(row.querySelector('.ncc-verb') as HTMLElement);
      expect(onVerb).not.toHaveBeenCalled();
    });

    it.each(['needs_you', 'running', 'done'] as ThreadState[])('%s is live and fires its verb', async (state) => {
      const onVerb = vi.fn();
      const { row } = renderRow({ state }, { onVerb });
      const verb = row.querySelector('.ncc-verb')!;
      expect(verb.getAttribute('aria-disabled')).toBeNull();
      expect(verb.getAttribute('title')).toBeNull();
      await userEvent.click(verb as HTMLElement);
      expect(onVerb).toHaveBeenCalledTimes(1);
    });

    it('every inert reason names what is missing rather than just saying no', () => {
      for (const state of ALL_STATES) {
        const { inertReason, action } = STATE_PRESENTATION[state];
        // A verb is either wired or explained — never silently dead.
        if (STATE_PRESENTATION[state].verb === null) continue;
        expect(action === null).toBe(inertReason !== null);
        if (inertReason) expect(inertReason.length).toBeGreaterThan(40);
      }
    });
  });

  it('paints the status bar only when the row wants something (§4)', () => {
    // Attention states carry the red bar, running the green one; everything
    // else is transparent because it wants nothing.
    expect(renderRow({ state: 'needs_you' }).row.className).toContain('attention');
    expect(renderRow({ state: 'stalled' }).row.className).toContain('attention');
    expect(renderRow({ state: 'unassigned' }).row.className).toContain('attention');
    expect(renderRow({ state: 'running' }).row.className).toContain('live');
    for (const quiet of ['parked', 'done', 'idle'] as ThreadState[]) {
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

  it('is absent on healthy running, parked, done and idle rows EVEN IF a preview is handed in', () => {
    for (const state of ['running', 'parked', 'done', 'idle'] as ThreadState[]) {
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
