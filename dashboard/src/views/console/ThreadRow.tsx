import type { ThreadSummary } from '../../lib/api.js';
import { AgentAvatar } from '../AgentAvatar.js';
import { relAge } from '../../lib/derive.js';
import {
  STATE_PRESENTATION,
  elapsed,
  initials,
  parkAge,
  proposalAuthorName,
  showsLiveLine,
  toolLabel,
} from './thread-state.js';

/**
 * One row = one THREAD (DESIGN.md §3.1), never a session.
 *
 * Zone order is fixed by §4 and this component is the only place it is
 * expressed: status bar, avatar stack, title, hybrid line, live line, meta
 * line, state label, verb.
 */

/** The last message on the thread, as `Speaker: excerpt` (§4). */
export interface ThreadPreview {
  speaker: string;
  excerpt: string;
}

export interface ThreadRowProps {
  thread: ThreadSummary;
  /**
   * Supplied ONLY for rows that want attention. §4.1: message bodies live in
   * per-session DB files with no central rollup, so a preview on every row
   * means opening hundreds of files per refresh. The caller owns that budget —
   * this component just renders what it is handed, and renders nothing when
   * the row is not an attention row even if a preview arrives anyway.
   */
  preview?: ThreadPreview | null;
  selected?: boolean;
  /** Injected so elapsed/age are deterministic under test. */
  now?: number;
  onSelect: (thread: ThreadSummary) => void;
  /**
   * The row's ONE verb (§1: every row ends in a verb). Every state has one and
   * every one of them does the same thing — open the composer on this thread.
   * The word differs, the action does not.
   */
  onVerb?: (thread: ThreadSummary) => void;
}

const MAX_FACES = 3;

/**
 * The "scheduled" pill (operator report, 2026-08-20 — DEFECT 1). A scheduled
 * task's thread has no real channel to sit under (its session never carries a
 * `messaging_group_id` — see `threads.ts`'s `isScheduledTaskThread`), so it
 * lands in the `tasks` pseudo-channel bucket rather than disappearing or
 * inventing one; this is how the row admits that instead of reading as an
 * ordinary channel thread.
 *
 * Matches `.ncc-state`'s own neutral (non-attention, non-live) look byte for
 * byte — mono caps, outlined, `--ncc-secondary` on `--ncc-border` — rather
 * than inventing a new visual language (§7: "do not introduce a third status
 * hue"). Inline because this file does not own console.css; there is nothing
 * here a shared class would save.
 */
const SCHEDULED_PILL_STYLE = {
  fontFamily: 'var(--ncc-font-mono)',
  fontSize: '10.5px',
  fontWeight: 600,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  padding: '1px 5px',
  color: 'var(--ncc-secondary)',
  border: '1px solid var(--ncc-border)',
} as const;

/**
 * The "proposes done" badge (thread-closure contract, item 1). Same shape as
 * `SCHEDULED_PILL_STYLE` above, for the same reason — a small one-off badge
 * this file does not need a shared class for — but GREEN (`--ncc-live`), never
 * `--ncc-secondary`: this is the existing "live"/good-news signal, not a new
 * third status hue (§7).
 *
 * Rendered ALONGSIDE `.ncc-state`, never replacing it (see `ThreadRow` below)
 * — a proposing agent's container is very often still running, and reporting
 * live work as anything but running is exactly the failure that got the old
 * Dismiss action removed.
 */
const PROPOSAL_PILL_STYLE = {
  fontFamily: 'var(--ncc-font-mono)',
  fontSize: '10.5px',
  fontWeight: 600,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  padding: '1px 5px',
  color: 'var(--ncc-live)',
  border: '1px solid var(--ncc-live)',
} as const;

/** The board row's full provenance, for the hover the meta line abbreviates. */
function sourceTitle(thread: ThreadSummary): string {
  const source = thread.attention_source;
  if (!source) return '';
  const when = source.as_of ? `as of ${source.as_of}` : 'source could not be read';
  return `${source.kind} — ${when}. Next: ${source.next_action}`;
}

export function ThreadRow({ thread, preview, selected, now = Date.now(), onSelect, onVerb }: ThreadRowProps) {
  const presentation = STATE_PRESENTATION[thread.state];
  const shown = thread.participants.slice(0, MAX_FACES);
  const overflow = thread.participants.length - shown.length;
  const live = showsLiveLine(thread);
  const agentCount = thread.participants.length;
  const age = thread.last_activity_at ? relAge(thread.last_activity_at, now) : '—';

  return (
    <li
      className={`ncc-row ${presentation.tone}${selected ? ' selected' : ''}`}
      data-thread-id={thread.thread_id}
      data-state={thread.state}
    >
      {/* §4: 3px, full row height, colour = urgency; transparent when the row
          wants nothing. Decorative — the state label carries the meaning. */}
      <span className="ncc-row-bar" aria-hidden="true" />
      <div className="ncc-row-inner">
        <div className="ncc-row-cols">
          <button type="button" className="ncc-row-main" onClick={() => onSelect(thread)}>
            <span className="ncc-faces">
              {shown.length === 0 && (
                <span className="ncc-face orphan">
                  {/* No participants at all — an unowned work item. A face is
                      never invented for one. */}
                  <AgentAvatar name="?" avatarUrl={null} size={25} />
                </span>
              )}
              {shown.map((p) => (
                <span className="ncc-face" key={p.agent_group_id} title={p.name}>
                  <AgentAvatar name={p.name} initials={initials(p.name)} avatarUrl={p.avatarUrl} size={25} />
                </span>
              ))}
              {overflow > 0 && (
                <span className="ncc-face more" aria-hidden="true">
                  +{overflow}
                </span>
              )}
            </span>

            <span className="ncc-row-text">
              {/* §4: always present, single line, ellipsis. */}
              <span className="ncc-row-title">{thread.title ?? 'Untitled thread'}</span>

              {/*
               * WHY this row is `needs_you` (operator report 2026-08-21). Same
               * "spelled out, not just a tooltip" rule as the proposal line
               * below — 390px is the primary viewport and a touch screen never
               * triggers a `title`. Stacks ABOVE the proposal line: a row can
               * carry both (a thread can be needs_you while also carrying a
               * standing done_proposal), and the reason for needing YOU right
               * now outranks a flag about the work being finished.
               */}
              {thread.needs_you_reason && (
                <span className="ncc-row-reason" title={thread.needs_you_reason.text}>
                  {/*
                   * PARK AGE, ahead of the reason it qualifies.
                   *
                   * A parked claim's note is written once and never revised —
                   * releasing a claim is the claim OWNER's job, and the console
                   * deliberately does NOT reconcile one against GitHub, because
                   * a display that second-guesses its source produces two
                   * disagreeing truths. Live evidence: two claims still assert
                   * a human owes a decision on a PR that merged hours earlier.
                   * The age is what makes that legible without the console
                   * inventing a verdict — "parked 40h ago" beside the note says
                   * everything the reconciliation would have, honestly.
                   *
                   * First in the flow so it survives the row's single-line
                   * ellipsis at 390px; a marker clipped off the end is a marker
                   * that does not exist.
                   */}
                  {parkAge(thread) && <span className="ncc-row-parkage">parked {parkAge(thread)} ago</span>}
                  {thread.needs_you_reason.text}
                </span>
              )}

              {/*
               * The proposal's reason, spelled out — not just in the badge's
               * title tooltip, which a touch screen can never trigger and
               * 390px is the primary viewport (§8). Rendered whenever there IS
               * a proposal, regardless of `wantsAttention`: unlike the hybrid
               * line this costs nothing per row (the proposal already rides on
               * the list payload — see `ThreadDoneProposal` — no per-session
               * file open the way a message preview needs).
               */}
              {thread.done_proposal && (
                <span className="ncc-row-proposal" title={thread.done_proposal.reason}>
                  <span className="who">{proposalAuthorName(thread)} proposes done —</span>{' '}
                  {thread.done_proposal.reason}
                </span>
              )}

              {presentation.wantsAttention && preview && (
                <span className="ncc-row-hybrid">
                  {preview.speaker && <span className="speaker">{preview.speaker}: </span>}
                  <span className="excerpt">{preview.excerpt}</span>
                </span>
              )}

              {live && (
                <span className="ncc-row-livelinerow">
                  <span className="ncc-row-livedot" aria-hidden="true" />
                  <span className="ncc-row-step">{toolLabel(thread.current_tool)}</span>
                  <span className="ncc-row-elapsed">{elapsed(thread.tool_started_at, now)}</span>
                </span>
              )}

              {/* §4: channel · N agents · age. The one line every row has. */}
              <span className="ncc-row-meta">
                <span className="channel">{thread.channel_name}</span>
                <span className="sep-agents" aria-hidden="true">
                  ·
                </span>
                <span className="agents">
                  {agentCount === 0 ? 'no owner' : `${agentCount} agent${agentCount === 1 ? '' : 's'}`}
                </span>
                <span aria-hidden="true">·</span>
                <span className="age">{age}</span>
                {/*
                 * Board provenance, and how old the board itself is.
                 *
                 * NOT a suppression signal — there is no staleness threshold
                 * anywhere in this path, on purpose. A stale feed showing real
                 * work with a visible age is strictly better than an empty
                 * feed, because an empty feed is indistinguishable from a
                 * healthy one, and "nothing is blocked on a human" is the one
                 * lie this row exists to prevent.
                 */}
                {thread.attention_source && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="ncc-row-source" title={sourceTitle(thread)}>
                      {thread.attention_source.kind}
                      {thread.attention_source.as_of
                        ? ` ${relAge(thread.attention_source.as_of, now)} old`
                        : ' · not read'}
                    </span>
                  </>
                )}
              </span>
            </span>
          </button>

          <div className="ncc-row-side">
            {thread.scheduled_task && (
              <span className="ncc-scheduled-pill" style={SCHEDULED_PILL_STYLE}>
                scheduled
              </span>
            )}
            {/* Item 1: ALONGSIDE the state pill below, never replacing it. */}
            {thread.done_proposal && (
              <span
                className="ncc-proposal-pill"
                style={PROPOSAL_PILL_STYLE}
                title={`${proposalAuthorName(thread)} proposes done: ${thread.done_proposal.reason}`}
              >
                proposes done
              </span>
            )}
            <span className={`ncc-state ${presentation.tone}`}>{presentation.label}</span>
            {/*
             * Every row, every state, one live verb. There is no inert branch
             * any more and there must not be one again: the word is a label
             * over the single send primitive, so a state that could render a
             * word can always perform the action behind it.
             *
             * The accessible name carries the thread's title because "Steer" on
             * its own, forty times down a list, names nothing.
             */}
            <button
              type="button"
              className="ncc-verb"
              aria-label={`${presentation.verb} — ${thread.title ?? 'Untitled thread'}`}
              onClick={() => (onVerb ?? onSelect)(thread)}
            >
              {presentation.verb}
            </button>
          </div>
        </div>

        {live && <LivenessRule running={thread.state === 'running'} />}
      </div>
    </li>
  );
}

/**
 * DESIGN §6. Read this before changing anything here.
 *
 * **THE SEGMENT'S LENGTH ENCODES NOTHING.** There is no percent-complete
 * signal anywhere in the system: a tool call has a start time and no expected
 * duration, so any width derived from it would be fabricated. An earlier draft
 * shipped invented widths and readers correctly took them as meaningful. Do
 * not "fix" this into a percentage, a duration bar, or a width that grows.
 *
 * What it does encode is one bit: MOTION means a tool is running right now,
 * STILLNESS means the thread has stalled. That contrast is the single most
 * valuable glanceable signal on the screen, which is exactly why the length
 * must stay meaningless — two signals in one element and neither reads.
 *
 * Reduced motion is handled in CSS (`@media (prefers-reduced-motion: reduce)`),
 * where the live variant degrades to the same static dimmed rule the stalled
 * one already is. It is a media query rather than a JS check on purpose: the
 * preference can change mid-session and CSS re-evaluates for free.
 */
export function LivenessRule({ running }: { running: boolean }) {
  return (
    <div className="ncc-track" aria-hidden="true">
      <div
        className={running ? 'ncc-seg ncc-seg-live' : 'ncc-seg ncc-seg-still'}
        data-motion={running ? 'live' : 'still'}
      />
    </div>
  );
}
