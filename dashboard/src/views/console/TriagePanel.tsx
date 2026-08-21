import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ThreadSummary } from '../../lib/api.js';
import { actionError } from './action-error.js';
import { setSnoozed } from './actions.js';
import { ThreadDetail } from './ThreadDetail.js';

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
 * One verdict key, per §11:
 *
 *   S — snooze until it moves
 *
 * There used to be a second, A — answer and advance, which only moved focus
 * into the composer. The operator called it out as pointless: a tap on the
 * row (or the composer itself) already does that, so the button and its
 * keybinding are gone. Sending from the composer still advances the pass —
 * see `onSent` below — there is simply no verdict button for it any more.
 *
 * There used to be a third, E — dismiss it from the queue, which archived
 * every session on the thread. It is gone: archiving hid the thread without
 * stopping the agent, so the work kept running unattended. A thread leaves
 * the queue when it is actually finished, never because an operator triaged
 * it away.
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

  const snooze = useCallback(async () => {
    if (!thread || busy) return;
    setBusy(true);
    try {
      await setSnoozed(thread.thread_id, true);
      onChanged();
      advance('Snoozed until it moves.');
    } catch (err) {
      setAnnouncement(`Could not snooze — ${actionError(err)}.`);
    } finally {
      setBusy(false);
    }
  }, [thread, busy, advance, onChanged]);

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
      // `a` is not bound to anything — same reading as `e` below. It used to
      // focus the composer; a tap on the row already does that.
      if (key === 's') {
        e.preventDefault();
        void snooze();
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
    [onExit, snooze, total],
  );

  return (
    <section
      className="ncc-triage"
      aria-label="Triage"
      tabIndex={-1}
      ref={root}
      onKeyDown={onKeyDown}
      data-triage-index={at}
    >
      {/* One row: position, snooze, exit. Used to be three (a progress-bar
          row, a legend row, a button row with Answer beside Snooze) — too
          tall on a phone. The thread's own state label already renders in
          ThreadDetail's head just below, so it is not repeated here. Exit
          stays a real control in this row rather than a large block: on
          mobile there is no Esc key, so it is the only way out of triage. */}
      <div className="ncc-triage-bar">
        <span className="ncc-triage-count ncc-mono">
          {Math.min(at + 1, total)} / {total}
        </span>
        {/* The rail is POSITION, and position is a real count — unlike §6's
            liveness rule, which encodes nothing by length. Discrete cells, so
            the two can never be misread for each other. Desktop only (§8) —
            the numeric count alone carries the position on a phone. */}
        <span className="ncc-triage-rail" aria-hidden="true">
          {snapshot.slice(0, MAX_DOTS).map((t, i) => (
            <span key={t.thread_id} className={`ncc-triage-dot${i === at ? ' now' : i < at ? ' done' : ''}`} />
          ))}
        </span>
        <span className="ncc-spacer" />
        <span className="ncc-triage-keys ncc-mono">S snooze · Esc exit</span>
        <button type="button" className="ncc-verb" disabled={!thread || busy} onClick={() => void snooze()}>
          S · snooze
        </button>
        <button type="button" className="ncc-solid-btn" onClick={onExit}>
          exit
        </button>
      </div>

      <div className="ncc-triage-live" role="status" aria-live="polite">
        {announcement}
      </div>

      {thread ? (
        <ThreadDetail
          thread={thread}
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
