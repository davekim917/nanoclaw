import { useState } from 'react';
import type { ApiError, ThreadSummary } from '../../lib/api.js';
import { actionError } from './action-error.js';
import { closeThread } from './actions.js';

/**
 * The thread-closure contract's item 2 — the CLOSE control, rendered next to
 * Snooze in the detail pane's action row (`ThreadConsole.tsx`).
 *
 * **This is not Dismiss.** The removed Dismiss archived every session on a
 * thread and stopped nothing — a hide-without-stop action, which is why it
 * was deleted rather than fixed. This control drives the real sequence in
 * `src/dashboard/thread-close.ts`: ask the agent to wrap up, clear its saved
 * continuation, stop its container, archive the thread — and it never claims
 * to be instant or reversible (see the copy below).
 *
 * **Not Triage's business.** Triage is a fast snooze/exit pass over a frozen
 * list and does not get this control back; see `TriagePanel.tsx`.
 *
 * **The confirmation count is server-authoritative, and the UI trusts that,
 * not its own guess.** `thread.close_confirmations_required` only seeds the
 * IDLE button's tooltip — it is explicitly "not the authority" on the wire
 * (`src/dashboard/api/threads.ts`). The FIRST deliberate click always sends
 * `confirmations: 1`, a real request. When one is enough (the agent proposed),
 * the server allows it immediately — "one deliberate click". When it is not,
 * the server answers `409 confirmation_required` naming the actual count
 * needed (`thread-close-guard.ts`'s `requiredConfirmations`), and ONLY THEN
 * does a second, genuinely separate control appear — a different button pair
 * (Confirm / Cancel), not a toast, not something that vanishes on blur, and
 * nothing here auto-dismisses it or auto-retries. A SECOND deliberate click
 * sends that exact count. This control never pre-arms the higher number, so a
 * first click here always sends `1` and a two-confirmation thread always comes
 * back as a visible 409 (this thread stays open, with an explanation on screen)
 * rather than the work silently ending. That is a property of THIS component,
 * not a guarantee the server enforces: the count travels in the request body,
 * so a caller that sends `2` up front closes in one call. See the note on
 * `requiredConfirmations` in `src/dashboard/thread-close-guard.ts` for why that
 * is accepted rather than plugged.
 *
 * `thread.closing` is server truth (a `thread_closures` row already exists)
 * and overrides all of the above with a plain disabled "closing…" — reachable
 * the moment the caller's `onClosed` triggers a revalidation, and on later
 * renders whenever the thread is already mid-close for any other reason
 * (another operator, a page reload).
 */

type Phase = 'idle' | 'busy' | 'confirming';

const IDLE_TITLE_ONE_CONFIRMATION =
  'The agent has proposed this thread is done. Asks it to wrap up, then stops its container and archives the ' +
  'thread. Not reversible.';
const IDLE_TITLE_TWO_CONFIRMATIONS =
  'No agent has proposed this thread is done — closing it overrides live work and needs two separate ' +
  'confirmations. Asks the agent to wrap up, then stops its container and archives the thread. Not reversible.';
const CONFIRM_TITLE =
  "Ends the agent's work: asks it to wrap up, then stops its container and archives the thread. Not reversible.";
const CLOSING_TITLE = 'This thread is closing — the agent was asked to wrap up, or the window will end it without them.';

export function CloseThreadControl({
  thread,
  onClosed,
}: {
  thread: ThreadSummary;
  /** Fired once a close request LANDS — success or a 409 the operator must act on — so the caller revalidates. */
  onClosed: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  /** What the NEXT click sends, once the server has told us — never guessed locally. */
  const [nextConfirmations, setNextConfirmations] = useState(1);
  const [message, setMessage] = useState('');

  // Server truth beats all local state: another tab, another operator, or a
  // page reload can all leave this thread already mid-close.
  if (thread.closing) {
    return (
      <button type="button" className="ncc-verb" disabled title={CLOSING_TITLE}>
        closing…
      </button>
    );
  }

  const busy = phase === 'busy';

  const fire = async (confirmations: number): Promise<void> => {
    setPhase('busy');
    try {
      const res = await closeThread(thread.thread_id, confirmations);
      const n = res.session_ids.length;
      const mins = Math.round(res.confirm_window_ms / 60_000);
      const undelivered = n - res.wrap_up_delivered;
      setMessage(
        `Closing — asked ${n} agent${n === 1 ? '' : 's'} to wrap up. Up to ${mins} min to land the work before ` +
          'the container stops.' +
          (undelivered > 0 ? ` Could not reach ${undelivered} of them — they may not get the notice.` : ''),
      );
      setPhase('idle');
      setNextConfirmations(1);
      onClosed();
    } catch (err) {
      const e = err as Partial<ApiError>;
      if (e.status === 409 && e.error === 'confirmation_required') {
        // The server's count, not `confirmations + 1` — it is the authority.
        // Nothing changed server-side (the guard denies BEFORE the row is
        // written — see `requestThreadClose`), so there is nothing to
        // revalidate: no `onClosed()` here.
        setNextConfirmations(e.required_confirmations ?? confirmations + 1);
        setPhase('confirming');
        setMessage(
          'No agent has proposed this thread is done — closing it overrides live work still in flight. ' +
            'Confirm again to end it, or cancel.',
        );
        return;
      }
      setPhase('idle');
      setNextConfirmations(1);
      if (e.status === 409 && e.error === 'close_already_in_progress') {
        // Unlike the branch above, this DOES mean our cached `thread.closing`
        // was stale — the server says a close is already under way — so this
        // is the one error worth revalidating for.
        setMessage('A close is already in progress for this thread — wait for it to finish.');
        onClosed();
      } else if (e.status === 409 && e.error === 'thread_extends_beyond_your_scope') {
        setMessage(
          "This thread reaches agents in groups you can't manage — an admin who can see all of them has to close it.",
        );
      } else {
        setMessage(`Could not close — ${actionError(err)}.`);
      }
    }
  };

  const cancel = (): void => {
    setPhase('idle');
    setNextConfirmations(1);
    setMessage('');
  };

  return (
    <div className="ncc-close">
      {phase === 'confirming' ? (
        <>
          <button type="button" className="ncc-chip" disabled={busy} onClick={cancel}>
            cancel
          </button>
          <button
            type="button"
            className="ncc-verb"
            disabled={busy}
            title={CONFIRM_TITLE}
            onClick={() => void fire(nextConfirmations)}
          >
            {busy ? 'closing…' : 'confirm close'}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="ncc-verb"
          disabled={busy}
          title={thread.close_confirmations_required === 1 ? IDLE_TITLE_ONE_CONFIRMATION : IDLE_TITLE_TWO_CONFIRMATIONS}
          onClick={() => void fire(1)}
        >
          {busy ? 'closing…' : 'close thread'}
        </button>
      )}
      {message && (
        <span className="ncc-close-status" role="status" aria-live="polite">
          {message}
        </span>
      )}
    </div>
  );
}
