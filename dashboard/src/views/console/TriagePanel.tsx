import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ThreadSummary } from '../../lib/api.js';
import { closeThread, setSnoozed } from './actions.js';
import { ThreadDetail } from './ThreadDetail.js';
import { STATE_PRESENTATION } from './thread-state.js';

/**
 * Triage — a MODE over the current filtered list, never the home screen and
 * never a separate data source (DESIGN §11).
 *
 * The `ids` prop is the filtered queue frozen at the moment the operator
 * entered: order is fixed for the duration of the pass, and every row is still
 * resolved against the live `threads` array so its content stays current. That
 * freeze is what makes "auto-advance" honest — a thread the operator just
 * snoozed leaves the live list on the next revalidation, and if the queue
 * re-indexed underneath them the advance would silently skip the next thread.
 * The snapshot row is the fallback for exactly that case: it is the same data,
 * one revalidation stale, not a second source of truth.
 *
 * Three verdict keys, per §11:
 *
 *   A — answer and advance (focus the composer; the advance follows the send)
 *   S — snooze until it moves
 *   E — close it out
 *
 * Keyboard rules that are easy to get wrong and are tested:
 *
 * - **The browser's own shortcuts are never swallowed.** Any event carrying
 *   Meta / Control / Alt falls straight through, so ⌘L, ⌘R, ⌘T and friends
 *   still work while the mode has focus.
 * - **Typing is not a verdict.** Keys are ignored whenever focus is in the
 *   composer or any other field, otherwise every "s" typed into a reply would
 *   snooze the thread.
 */

export type TriageVerdict = 'answer' | 'snooze' | 'close';

export interface TriagePanelProps {
  /** The filtered queue, frozen at entry. Order is fixed for the pass. */
  snapshot: ThreadSummary[];
  /** The live list, so a row's content stays fresh while the order does not. */
  threads: ThreadSummary[];
  onExit: () => void;
  /** Revalidate the queue after a verdict lands. */
  onChanged: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** How many position dots the rail draws before it gives up and lets the count speak. */
const MAX_DOTS = 30;

export function TriagePanel({ snapshot, threads, onExit, onChanged }: TriagePanelProps) {
  const [at, setAt] = useState(0);
  const [focusComposer, setFocusComposer] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLElement>(null);

  const total = snapshot.length;
  const frozen = snapshot[at] ?? null;
  const thread = (frozen && threads.find((t) => t.thread_id === frozen.thread_id)) ?? frozen;

  // Focus the mode itself on entry and after every advance: the keys are the
  // whole interface, so they must never depend on the operator clicking first.
  useEffect(() => {
    root.current?.focus();
  }, [at]);

  const advance = useCallback(
    (note: string) => {
      setAt((i) => {
        const next = i + 1;
        const upcoming = snapshot[next];
        setAnnouncement(
          upcoming
            ? `${note} ${next + 1} of ${total}: ${upcoming.title ?? 'Untitled thread'}`
            : `${note} End of the queue — ${total} triaged.`,
        );
        return Math.min(next, total);
      });
    },
    [snapshot, total],
  );

  const verdict = useCallback(
    async (kind: TriageVerdict) => {
      if (!thread || busy) return;
      if (kind === 'answer') {
        // Answer does not advance here — the send does, through onSent below.
        setFocusComposer((n) => n + 1);
        setAnnouncement('Composer focused. Send to answer and advance.');
        return;
      }
      setBusy(true);
      try {
        if (kind === 'snooze') await setSnoozed(thread.thread_id, true);
        else await closeThread(thread);
        onChanged();
        advance(kind === 'snooze' ? 'Snoozed until it moves.' : 'Closed out.');
      } catch (err) {
        setAnnouncement(`Could not ${kind} — ${(err as { error?: string }).error ?? 'request failed'}.`);
      } finally {
        setBusy(false);
      }
    },
    [thread, busy, advance, onChanged],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      // Never swallow the browser's own bindings, and never turn typing into a
      // verdict. Both of these ship broken silently.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onExit();
        return;
      }
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'a' || key === 's' || key === 'e') {
        e.preventDefault();
        void verdict(key === 'a' ? 'answer' : key === 's' ? 'snooze' : 'close');
        return;
      }
      if (key === 'arrowdown' || key === 'arrowright') {
        e.preventDefault();
        setAt((i) => Math.min(i + 1, total));
        return;
      }
      if (key === 'arrowup' || key === 'arrowleft') {
        e.preventDefault();
        setAt((i) => Math.max(i - 1, 0));
      }
    },
    [onExit, verdict, total],
  );

  const presentation = thread ? STATE_PRESENTATION[thread.state] : null;

  return (
    <section
      className="ncc-triage"
      aria-label="Triage"
      tabIndex={-1}
      ref={root}
      onKeyDown={onKeyDown}
      data-triage-index={at}
    >
      <div className="ncc-triage-bar">
        <span className="ncc-triage-count ncc-mono">
          {Math.min(at + 1, total)} / {total}
        </span>
        {/* The rail is POSITION, and position is a real count — unlike §6's
            liveness rule, which encodes nothing by length. Discrete cells, so
            the two can never be misread for each other. */}
        <span className="ncc-triage-rail" aria-hidden="true">
          {snapshot.slice(0, MAX_DOTS).map((t, i) => (
            <span key={t.thread_id} className={`ncc-triage-dot${i === at ? ' now' : i < at ? ' done' : ''}`} />
          ))}
        </span>
        <span className="ncc-spacer" />
        <span className="ncc-triage-keys ncc-mono">A answer · S snooze · E close · Esc exit</span>
        <button type="button" className="ncc-solid-btn" onClick={onExit}>
          exit
        </button>
      </div>

      <div className="ncc-triage-verbs">
        <button type="button" className="ncc-verb" disabled={!thread || busy} onClick={() => void verdict('answer')}>
          A · answer
        </button>
        <button type="button" className="ncc-verb" disabled={!thread || busy} onClick={() => void verdict('snooze')}>
          S · snooze
        </button>
        <button type="button" className="ncc-verb" disabled={!thread || busy} onClick={() => void verdict('close')}>
          E · close
        </button>
        {presentation && <span className={`ncc-state ${presentation.tone}`}>{presentation.label}</span>}
      </div>

      <div className="ncc-triage-live" role="status" aria-live="polite">
        {announcement}
      </div>

      {thread ? (
        <ThreadDetail
          thread={thread}
          focusComposer={focusComposer}
          onSent={() => {
            onChanged();
            advance('Answered.');
          }}
        />
      ) : (
        <div className="ncc-empty">queue clear — nothing left to triage</div>
      )}
    </section>
  );
}
