import type { ThreadSummary } from '../../lib/api.js';
import { AgentAvatar } from '../AgentAvatar.js';
import { relAge } from '../../lib/derive.js';
import { STATE_PRESENTATION, elapsed, initials, showsLiveLine, toolLabel } from './thread-state.js';

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
   * The row's ONE verb (§1: every row ends in a verb). Called only for verbs
   * that have a backing endpoint — `STATE_PRESENTATION[state].inertReason`
   * names the ones that do not, and those render as an explained no-op.
   */
  onVerb?: (thread: ThreadSummary) => void;
}

const MAX_FACES = 3;

export function ThreadRow({ thread, preview, selected, now = Date.now(), onSelect, onVerb }: ThreadRowProps) {
  const presentation = STATE_PRESENTATION[thread.state];
  const shown = thread.participants.slice(0, MAX_FACES);
  const overflow = thread.participants.length - shown.length;
  const live = showsLiveLine(thread);
  const inert = presentation.inertReason !== null;
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
              </span>
            </span>
          </button>

          <div className="ncc-row-side">
            <span className={`ncc-state ${presentation.tone}`}>{presentation.label}</span>
            {/* §5: `idle` is the one state whose verb column reads `—`. It gets
                no button; the row body above is still the way in. */}
            {presentation.verb && (
              /*
               * A verb with no backing endpoint renders INERT, never hidden:
               * §1's "every row ends in a verb" is the contract, and dropping
               * the button would quietly rewrite it. The reason is the button's
               * `title`.
               *
               * `aria-disabled` rather than `disabled` on purpose — a real
               * `disabled` button is not focusable, so a keyboard or
               * screen-reader user could never reach the explanation, which is
               * the entire point of rendering it. The reason therefore also
               * rides in the accessible name, since `title` alone is not
               * reliably announced.
               */
              <button
                type="button"
                className="ncc-verb"
                aria-disabled={inert ? true : undefined}
                {...(inert ? { title: presentation.inertReason ?? '' } : {})}
                {...(inert ? { 'aria-label': `${presentation.verb} — unavailable. ${presentation.inertReason}` } : {})}
                onClick={() => {
                  if (inert) return;
                  (onVerb ?? onSelect)(thread);
                }}
              >
                {presentation.verb}
              </button>
            )}
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
