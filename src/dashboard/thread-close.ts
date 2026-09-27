/**
 * Thread close (`POST /dashboard/api/threads/:id/close`): the console's one action that actually ENDS work, as a
 * sequence where every step is load-bearing: (a) ask the agent to wrap up in its own thread, (b) make sure no
 * `work_continuation` survives, (c) stop the container, (d) let the sweep release processing claims
 * (`resetStuckProcessingRows` already does), (e) archive, as the terminal marker only.
 * (b) MUST precede the archive: `work_continuation` is read on any wake and `decideCeilingFollowUp` returns
 * `wake-accountable` on it first, so a killed container's promise would resurface on the next message.
 * Confirmations: one if an agent proposed the close (`propose_done`), two if not; the guard decides the required
 * count (`thread-close-guard.ts`). Nothing closes by silence; a timer only stops waiting for the AGENT after the
 * operator has confirmed. Not snooze, and not a general archive endpoint: `archiveSessionById` is reachable only as
 * step (e).
 */
import { containerOwnsOutbound, killContainer } from '../container-runner.js';
import { getDb } from '../db/connection.js';
import { archiveSessionById, withQuietInvalidationSync } from '../db/sessions.js';
import { withCentralSync, withRawDb } from '../db/central-lease.js';
import { guard } from '../guard/index.js';
import { log } from '../log.js';
import {
  CLOSE_REASON_MAX_CHARS,
  readSessionInbound,
  withExistingNanoclawOutbound,
  withExistingNanoclawOutboundSync,
  type DoneProposal,
} from '../modules/mailbox/index.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { withExistingMailboxSession } from '../session-manager.js';
import { requiredConfirmations, threadsClose } from './thread-close-guard.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * How long the close waits for the agent's wrap-up answer before finalizing without it. Not a settle-by-silence
 * timer: the operator has already confirmed. The wrap-up is admitted by the next sweep tick and the agent needs a
 * turn, so much shorter makes confirmation unreachable.
 */
export const CLOSE_CONFIRM_WINDOW_MS = 10 * 60 * 1000;

export { readDoneProposal, type DoneProposal } from '../modules/mailbox/index.js';

const CLOSE_WAKE_ID_PREFIX = 'thread-close-';

/**
 * Copies one session's proposal into `sessions.done_proposal` so the thread list renders the flag without opening a
 * file per row. Writes only on change. Takes the proposal, not a session handle: nothing outside the mailbox module
 * receives one.
 */
// Best-effort mirror, no transaction: a stale mirror is refreshed next tick, and the close path never trusts this
// copy.
export async function syncDoneProposalMirror(
  sessionId: string,
  proposal: DoneProposal | null,
): Promise<DoneProposal | null> {
  const encoded = proposal ? JSON.stringify(proposal) : null;
  try {
    const current = await getDb().get<{ done_proposal: string | null }>(
      'SELECT done_proposal FROM sessions WHERE id = ?',
      sessionId,
    );
    if (!current || current.done_proposal === encoded) return proposal;
    await getDb().run('UPDATE sessions SET done_proposal = ? WHERE id = ?', encoded, sessionId);
  } catch (err) {
    log.warn('thread-close: done_proposal mirror failed', { sessionId, err });
  }
  return proposal;
}

/**
 * Every session's proposal read SYNCHRONOUSLY, as of one instant. An async fan-out resolves each session at its own
 * moment, so a session could take new work and clear its proposal while another read was outstanding, buying a close
 * over a mid-turn agent. The caller must not await between calling this and deciding. Unreadable is absent.
 */
function sampleProposalsSync(
  sessions: readonly CloseSession[],
  read: (agentGroupId: string, sessionId: string) => DoneProposal | null,
): Map<string, DoneProposal | null> {
  const proposals = new Map<string, DoneProposal | null>();
  for (const session of sessions) proposals.set(session.id, read(session.agent_group_id, session.id));
  return proposals;
}

/** Synchronous twin of `readSessionProposal`, with the same existence and fault rules. */
function readSessionProposalSync(agentGroupId: string, sessionId: string): DoneProposal | null {
  try {
    return withExistingNanoclawOutboundSync(agentGroupId, sessionId, (outbound) => outbound.readDoneProposal()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Series ids of every live (pending|paused) task row in this session's inbound.db, read synchronously through the
 * read-only funnel so it fits the no-await decision span. Fails open: an unreadable inbound.db reports none rather
 * than blocking every future close of the thread.
 */
function liveTaskSeriesIdsSync(agentGroupId: string, sessionId: string): string[] {
  try {
    const rows = readSessionInbound({ agentGroupId, sessionId }, (inbound) => inbound.listLiveTaskRows());
    if (!rows) return [];
    return [...new Set(rows.map((row) => row.series_id).filter((id): id is string => id !== null))];
  } catch {
    return [];
  }
}

interface CloseSession {
  id: string;
  agent_group_id: string;
  archived_at: string | null;
}

/**
 * The thread's active sessions, with the same `session:<id>` synthetic-key rule as the list and snooze paths.
 * PERMANENTLY synchronous: it runs inside `requestThreadClose`'s no-await decision span, reading through `withRawDb`,
 * so callers must hold `withCentralSync`.
 */
function sessionsOnThread(threadId: string): CloseSession[] {
  return withRawDb(
    (db) =>
      db
        .prepare(
          `SELECT id, agent_group_id, archived_at
         FROM sessions
        WHERE status = 'active' AND COALESCE(thread_id, 'session:' || id) = ?`,
        )
        .all(threadId) as CloseSession[],
  );
}

/**
 * Same predicate as `sessionsOnThread` for one id. PERMANENTLY synchronous: it runs inside `writeCloseWrapUp`'s
 * mailbox callback, where no yield may precede the insert.
 */
function stillOnThread(sessionId: string, threadId: string): boolean {
  return withRawDb(
    (db) =>
      db
        .prepare(
          `SELECT 1
           FROM sessions
          WHERE id = ? AND status = 'active' AND COALESCE(thread_id, 'session:' || id) = ?`,
        )
        .get(sessionId, threadId) !== undefined,
  );
}

/**
 * Server-composed, always: an agent receiving free text it cannot attribute is the shape of every "who told you
 * that?" incident. It names the deadline because the close finalizes when the window elapses whether or not the agent
 * answers.
 */
export function composeCloseWrapUp(opts: { who: string; reason: string | null; windowMinutes: number }): string {
  return (
    `[system] ${opts.who} asked to close this thread from the Observatory` +
    (opts.reason ? `: "${opts.reason}"` : '') +
    `. Wrap up now. Finish or checkpoint anything in flight to a durable path, ` +
    `post ONE message accounting for state — done / lost / next — and release or park any work claim you hold. ` +
    `If you have saved work, call cancel_continuation. ` +
    `Then confirm with propose_done({ reason: "<what you finished, how you know>" }). ` +
    `Your container is stopped once you confirm, or in about ${opts.windowMinutes} minutes either way — ` +
    `confirming is how you get to land the work first. ` +
    `If you believe this close is wrong, say so in that message and say why; it is the operator's call, ` +
    `but it should be an informed one.`
  );
}

async function writeCloseWrapUp(
  session: CloseSession,
  threadId: string,
  text: string,
  requestedAt: string,
): Promise<boolean> {
  try {
    // Existing-only: a session with no mailbox has no agent to ask, and the host must never create an outbound.db.
    const inserted = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      withCentralSync(() => {
        // Membership and liveness re-asked in-session: the snapshot can name a session that has since closed or left
        // the thread. Synchronous, so nothing yields before the insert.
        if (!stillOnThread(session.id, threadId)) return false;
        // Same row shape as host-sweep's `writeSystemWake`: a deferred trigger row plus its inert recall marker.
        // `onWake: 0` because the running container is exactly who this is for.
        // `withQuietInvalidationSync` kills the quiet mark in the same synchronous turn as the row; without it the
        // row sits unseen behind the sweep's quiet cache. FAIL-CLOSED: a refusal throws into the catch below, so this
        // pass simply has no wrap-up rather than an unseen one.
        const wrote = withQuietInvalidationSync(session.id, () =>
          mailbox.insertDeferredMessageWithContextIfNew({
            id: `${CLOSE_WAKE_ID_PREFIX}${session.id}-${requestedAt}`,
            kind: 'chat',
            timestamp: requestedAt,
            platformId: session.agent_group_id,
            channelType: 'agent',
            threadId: null,
            content: JSON.stringify({
              text,
              sender: 'system',
              senderId: 'system',
              _system: { kind: 'thread_close_wrap_up', thread_id: threadId },
            }),
            processAfter: null,
            recurrence: null,
            onWake: 0,
          }),
        );
        return wrote;
      }, 'thread-close wrap-up'),
    );
    return inserted ?? false;
  } catch (err) {
    log.warn('thread-close: could not write the wrap-up request', { sessionId: session.id, err });
    return false;
  }
}

interface ThreadClosureRow {
  thread_id: string;
  requested_by: string;
  requested_at: string;
  reason: string | null;
  agent_proposed: number;
  session_ids: string;
  state: 'awaiting_confirmation' | 'finalizing' | 'closed';
  forced: number;
  closed_at: string | null;
}

export interface ThreadCloseBody {
  confirmations?: number;
  reason?: string;
}

const NOT_FOUND = { status: 404 as const, body: { error: 'thread_not_found' } };

interface ClosureDecision {
  /**
   * `live-task-series` is its own outcome because, unlike every other refusal, it is safe to disclose to an admin of
   * a group on the thread (they can already see it). Every other refusal stays `refused`, which the response
   * collapses to not-found.
   */
  outcome: 'reserve' | 'confirmation-required' | 'live-task-series' | 'refused';
  /** As of `freshVisible`: what the row stores AND what the response reports. */
  agentProposed: boolean;
  required: 1 | 2;
  sessionIds: string[];
  agentGroupIds: string[];
  liveTaskSeriesIds: string[];
  reason?: string;
}

/**
 * The whole close decision, in one place, with no await in it. Everything returned (reservation inputs and reported
 * fields) comes from one evaluation against one session set; a decision made before an await must never still be
 * load-bearing after it.
 * It does read current privilege, which is why it runs late. `freshVisible` is the scope-filtered set NOW. A session
 * absent from `proposalsBySession` counts as not proposing, which can only raise the confirmation bar, never lower
 * it.
 */
function decideClosure(
  freshVisible: CloseSession[],
  proposalsBySession: ReadonlyMap<string, boolean>,
  confirmations: number,
  caller: { userId: string; threadId: string },
): ClosureDecision {
  const agentProposed = freshVisible.some((s) => proposalsBySession.get(s.id) === true);
  const required = requiredConfirmations(agentProposed);
  // Read directly rather than pre-sampled: inbound.db is host-owned, so there is no concurrent container writer to
  // race. Fails open; see `liveTaskSeriesIdsSync`.
  const liveTaskSeriesIds = [...new Set(freshVisible.flatMap((s) => liveTaskSeriesIdsSync(s.agent_group_id, s.id)))];
  const reported = {
    agentProposed,
    required,
    sessionIds: freshVisible.map((s) => s.id),
    agentGroupIds: freshVisible.map((s) => s.agent_group_id),
    liveTaskSeriesIds,
  };

  const decision = guard(threadsClose, {
    actor: { kind: 'human', userId: caller.userId },
    resource: { threadId: caller.threadId },
    payload: { agentGroupIds: reported.agentGroupIds, agentProposed, confirmations, liveTaskSeriesIds },
  });
  if (decision.effect === 'allow') return { ...reported, outcome: 'reserve' };

  // Neither branch below may disclose anything to a caller for whom this is false.
  const callerIsAdmin = freshVisible.some((s) => hasAdminPrivilege(caller.userId, s.agent_group_id));

  // A live series is a hard block no confirmation count satisfies, and naming it to an admin who can already see the
  // thread leaks nothing.
  if (liveTaskSeriesIds.length > 0 && callerIsAdmin) {
    return { ...reported, outcome: 'live-task-series', reason: decision.reason };
  }

  // Too few confirmations is actionable and reported; anything else collapses to not-found so the surface never
  // discloses that a thread exists.
  if (confirmations < required && callerIsAdmin) {
    return { ...reported, outcome: 'confirmation-required', reason: decision.reason };
  }
  return { ...reported, outcome: 'refused', reason: decision.reason };
}

export async function requestThreadClose(
  threadId: string,
  body: ThreadCloseBody,
  ctx: AuthedRequestContext,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!threadId) return NOT_FOUND;
  const reason = (body.reason ?? '').trim().slice(0, CLOSE_REASON_MAX_CHARS) || null;
  const confirmations = typeof body.confirmations === 'number' ? body.confirmations : 0;

  // Under the lease: the membership read and the in-flight closure check are one snapshot.
  const { all, existing } = await withCentralSync(
    () => ({
      all: sessionsOnThread(threadId),
      existing: withRawDb(
        (db) =>
          db.prepare('SELECT * FROM thread_closures WHERE thread_id = ?').get(threadId) as ThreadClosureRow | undefined,
      ),
    }),
    'thread close entry read',
  );
  const visible = ctx.scopes.no_filter
    ? all
    : all.filter((s) => ctx.scopes.allowed_group_ids.includes(s.agent_group_id));
  if (visible.length === 0) return NOT_FOUND;
  if (visible.length !== all.length) {
    // A close ends the whole THREAD. Closing only the visible sessions would either lie or stop a container in a
    // group the caller has no privilege over, so a partially visible thread is refused visibly (409, not 404).
    return {
      status: 409,
      body: { error: 'thread_extends_beyond_your_scope', thread_id: threadId, visible_sessions: visible.length },
    };
  }

  if (existing && existing.state !== 'closed') {
    return {
      status: 409,
      body: { error: 'close_already_in_progress', thread_id: threadId, requested_at: existing.requested_at },
    };
  }

  // EXACT proposals, not the mirror: a proposal the sweep has not copied must not cost a second click, and a mirror
  // row for a retracted proposal must not buy a cheaper close.
  // THIS IS THE LAST AWAIT. Everything after it is one synchronous block. Proposals are sampled synchronously over
  // the entry set; membership is re-read after, and a session absent from the sample counts as not proposing.
  const sampled = sampleProposalsSync(visible, readSessionProposalSync);

  // One synchronous decision, under ONE `withCentralSync` block, from the membership re-read through the reservation,
  // with no yield. Membership is re-read here because a sibling joining during the earlier yield would otherwise be
  // frozen out; the scope rule is re-applied to the fresh set.
  type SpanOutcome =
    | { kind: 'scope'; visible: number }
    | { kind: 'decision'; decision: ClosureDecision }
    | {
        kind: 'reserved';
        decision: ClosureDecision;
        freshVisible: CloseSession[];
        requestedAt: string;
      }
    | { kind: 'lost'; requestedAt: string | null };
  const span = await withCentralSync((): SpanOutcome => {
    const freshAll = sessionsOnThread(threadId);
    const freshVisible = ctx.scopes.no_filter
      ? freshAll
      : freshAll.filter((s) => ctx.scopes.allowed_group_ids.includes(s.agent_group_id));
    if (freshVisible.length !== freshAll.length) return { kind: 'scope', visible: freshVisible.length };

    const proposalsBySession = new Map(freshVisible.map((s) => [s.id, sampled.get(s.id) != null] as const));
    const decision = decideClosure(freshVisible, proposalsBySession, confirmations, {
      userId: ctx.user.id,
      threadId,
    });
    if (decision.outcome !== 'reserve') return { kind: 'decision', decision };

    const requestedAt = new Date().toISOString();
    const reserved = withRawDb((db) =>
      db
        .prepare(
          `INSERT INTO thread_closures
         (thread_id, requested_by, requested_at, reason, agent_proposed, session_ids, state, forced, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'awaiting_confirmation', 0, NULL)
       ON CONFLICT(thread_id) DO UPDATE SET
         requested_by = excluded.requested_by, requested_at = excluded.requested_at,
         reason = excluded.reason, agent_proposed = excluded.agent_proposed,
         session_ids = excluded.session_ids, state = 'awaiting_confirmation',
         forced = 0, closed_at = NULL
       WHERE thread_closures.state = 'closed'`,
        )
        .run(
          threadId,
          ctx.user.id,
          requestedAt,
          reason,
          decision.agentProposed ? 1 : 0,
          JSON.stringify(decision.sessionIds),
        ),
    );
    if (reserved.changes === 0) {
      const winner = withRawDb(
        (db) =>
          db.prepare('SELECT requested_at FROM thread_closures WHERE thread_id = ?').get(threadId) as
            | { requested_at: string }
            | undefined,
      );
      return { kind: 'lost', requestedAt: winner?.requested_at ?? null };
    }
    return { kind: 'reserved', decision, freshVisible, requestedAt };
  }, 'thread close decision and reservation');

  if (span.kind === 'scope') {
    return {
      status: 409,
      body: { error: 'thread_extends_beyond_your_scope', thread_id: threadId, visible_sessions: span.visible },
    };
  }
  if (span.kind === 'lost') {
    // Lost the race: refused from the row the winner wrote, and never reaching the fan-out, so one close produces one
    // wrap-up.
    log.info('thread-close: lost the reservation race', { threadId, userId: ctx.user.id });
    return {
      status: 409,
      body: { error: 'close_already_in_progress', thread_id: threadId, requested_at: span.requestedAt },
    };
  }
  if (span.kind === 'decision') {
    const { decision } = span;
    if (decision.outcome === 'confirmation-required') {
      return {
        status: 409,
        body: {
          error: 'confirmation_required',
          thread_id: threadId,
          required_confirmations: decision.required,
          confirmations,
          agent_proposed: decision.agentProposed,
        },
      };
    }
    if (decision.outcome === 'live-task-series') {
      // Disclosed: `decideClosure` already established this caller can see the thread.
      log.info('thread-close: refused — live task series', {
        threadId,
        userId: ctx.user.id,
        seriesIds: decision.liveTaskSeriesIds,
      });
      return {
        status: 409,
        body: {
          error: 'live_task_series',
          thread_id: threadId,
          series_ids: decision.liveTaskSeriesIds,
          reason: decision.reason,
        },
      };
    }
    log.info('thread-close: refused', { threadId, userId: ctx.user.id, reason: decision.reason });
    return NOT_FOUND;
  }

  const { decision, freshVisible, requestedAt } = span;
  const who = ctx.user.display_name ?? ctx.user.id;
  const windowMinutes = Math.round(CLOSE_CONFIRM_WINDOW_MS / 60_000);
  const text = composeCloseWrapUp({ who, reason, windowMinutes });

  // The fan-out is FROZEN at the reservation. The reservation is atomic, not a bare upsert: two confirmed requests (a
  // double-click, two admins) can both pass the entry check, and an unconditional DO UPDATE would let the second
  // replace the first and fan out a second wrap-up. `WHERE thread_closures.state = 'closed'` makes the row the lock:
  // a live closure is never overwritten, a finished one can re-open, and zero rows changed means someone else won.

  // A late joiner in the frozen set gets its wrap-up, but its proposal is NOT re-read for `agentProposed`: that could
  // only lower the bar.
  let delivered = 0;
  for (const s of freshVisible) if (await writeCloseWrapUp(s, threadId, text, requestedAt)) delivered++;

  // Reported straight off the decision the row was written from.
  log.info('thread-close: requested', {
    threadId,
    userId: ctx.user.id,
    sessions: decision.sessionIds.length,
    delivered,
    agentProposed: decision.agentProposed,
    confirmations,
  });
  return {
    status: 202,
    body: {
      thread_id: threadId,
      state: 'awaiting_confirmation',
      requested_at: requestedAt,
      session_ids: decision.sessionIds,
      wrap_up_delivered: delivered,
      agent_proposed: decision.agentProposed,
      confirm_window_ms: CLOSE_CONFIRM_WINDOW_MS,
    },
  };
}

/**
 * Deletes an active `work_continuation` from the host side. The key is container-owned, but a close that stops a
 * container without clearing it closes nothing (see the file header).
 * Module-private with exactly one caller, {@link finalizeSession}, which runs only against a `thread_closures` row
 * after an operator confirmed a close and the agent answered or the window elapsed. Do not give it another caller: a
 * host-side "cancel this agent's saved work" utility is a much larger decision. Logged at info so ended work is
 * findable.
 */
async function forceClearWorkContinuation(session: CloseSession, threadId: string): Promise<boolean> {
  // OUTBOUND-keyed: `work_continuation` lives in outbound.db, and `withExistingMailboxSession` keys existence on
  // inbound.db, so a session with outbound but no inbound would read as "cleared" and be archived with a live
  // continuation. `undefined` here means outbound.db is genuinely absent (no continuation); a present file that will
  // not open raises instead, and `ensureContinuationCleared` counts that as not cleared.
  const cleared = await withExistingNanoclawOutbound(session.agent_group_id, session.id, (outbound) => {
    // Re-checked inside the session immediately before the write: outbound.db has one writer, and a wake can start a
    // container during the open. Not cleared, so the caller does not archive and the closure retries next tick.
    if (containerOwnsOutbound(session.id)) {
      log.info('thread-close: skipped the force-clear — a container owns outbound.db', {
        threadId,
        sessionId: session.id,
      });
      return false;
    }
    const held = outbound.clearWorkContinuation();
    if (held) {
      log.info('thread-close: force-cleared a work_continuation the container still held', {
        threadId,
        sessionId: session.id,
        key: held.key,
        continuationId: held.id,
        droppedTask: held.task,
      });
    }
    // Presence, not validity: an unparseable record is still a record.
    return outbound.readContinuationPresence() === null;
  });
  return cleared ?? true;
}

/** False means the close must NOT proceed to the kill for this session. */
async function ensureContinuationCleared(session: CloseSession, threadId: string): Promise<boolean> {
  try {
    return await forceClearWorkContinuation(session, threadId);
  } catch (err) {
    // A real open failure counts as not cleared and stops the kill.
    log.error('thread-close: could not clear work_continuation — not killing this container', {
      threadId,
      sessionId: session.id,
      err,
    });
    return false;
  }
}

export interface ThreadCloseDeps {
  now?: number;
  isContainerRunning?: (sessionId: string) => boolean;
  killContainer?: (sessionId: string, reason: string, onExit?: () => void) => void;
  archiveSession?: (sessionId: string) => boolean;
  clearContinuation?: (session: CloseSession, threadId: string) => boolean | Promise<boolean>;
  /**
   * SYNCHRONOUS by contract: finalization samples every session with nothing awaited between the reads and the
   * decision.
   */
  readProposal?: (agentGroupId: string, sessionId: string) => DoneProposal | null;
}

/**
 * Steps (b), (c), (e) for ONE session; the order is the invariant. The clear must be done before the archive, and
 * re-done in the kill's `onExit`, the one place the process is provably gone. `archived_at` is terminal and must
 * never mark a thread ended while its container runs. (d) is the sweep's job.
 */
async function finalizeSession(session: CloseSession, threadId: string, deps: ThreadCloseDeps): Promise<void> {
  const kill = deps.killContainer ?? killContainer;
  const archive = deps.archiveSession ?? archiveSessionById;
  const clear = deps.clearContinuation ?? ensureContinuationCleared;
  // `containerOwnsOutbound`, not `isContainerRunning`: a wake issued a moment ago is still SPAWNING and not yet in
  // the running registry.
  const owns = (id: string): boolean =>
    deps.isContainerRunning ? deps.isContainerRunning(id) : containerOwnsOutbound(id);

  /**
   * THE settle path: clear, re-sample ownership synchronously, and archive only if nobody took the session. Both
   * branches call it so neither hand-rolls the sequence. `still-owned` means a wake landed inside the clear: do NOT
   * archive (archiving is display-only and would leave that container working in a "closed" thread); staying
   * `finalizing` sends the next tick down the kill path.
   */
  type SettleOutcome = 'settled' | 'not-cleared' | 'still-owned';
  const clearThenSettle = async (): Promise<SettleOutcome> => {
    if (!(await clear(session, threadId))) return 'not-cleared';
    if (owns(session.id)) return 'still-owned';
    await archive(session.id);
    return 'settled';
  };

  // Ownership decides the ORDER, not whether to clear. The clear awaits, and a session with no outbound.db never
  // reaches the force-clear's own guard, so ownership is re-asked after the clear and immediately before the archive.
  if (!owns(session.id)) {
    // `still-owned` falls through to the kill path; the clear re-runs idempotently in `onExit`.
    if ((await clearThenSettle()) !== 'still-owned') return;
  }

  // (c) KILL FIRST, then clear once the container is provably gone: outbound.db has ONE writer, and clearing under a
  // live container is a host write under that writer; a continuation persisted during SIGTERM grace is then cleared,
  // not raced. A failed clear leaves the session unarchived and the closure `finalizing` for the next tick.
  // `onExit` is synchronous and the clear async, so exit work is handed back through a promise created here; a later
  // exit's settle error must be caught by this function, not escape to the process `unhandledRejection` handler.
  // Exit does not mean nobody else took the session: a concurrent restart can register its own respawn, so the same
  // settle path re-checks ownership.
  let settleExit: () => void = () => {};
  let exitFailed: ((err: unknown) => void) | undefined;
  const exitWork = new Promise<void>((resolve, reject) => {
    settleExit = resolve;
    exitFailed = reject;
  });
  let fired = false;
  kill(session.id, `thread close ${threadId}`, () => {
    fired = true;
    void clearThenSettle().then(
      () => settleExit(),
      (err) => exitFailed?.(err),
    );
  });
  // Await only an exit that fired in this turn: the real `killContainer` fires `onExit` on a later tick, and awaiting
  // it would hang the sweep step.
  if (fired) {
    await exitWork;
    return;
  }
  void exitWork.catch((err) =>
    log.warn('thread-close: the post-exit settle failed; the closure stays finalizing for the next tick', {
      threadId,
      sessionId: session.id,
      err,
    }),
  );
}

/**
 * Pure decision half of the sweep step. `confirmed` requires a proposal STRICTLY NEWER than the request: a proposal
 * already standing at click time is what made this a one-confirmation close and is not an answer to the wrap-up.
 */
export function decideCloseFinalization(args: {
  requestedAtMs: number;
  now: number;
  /** `proposed_at` per session in the frozen fan-out; null where there is none. */
  proposalAtMs: (number | null)[];
}): { finalize: false } | { finalize: true; forced: boolean } {
  const confirmed =
    args.proposalAtMs.length > 0 && args.proposalAtMs.every((at) => at !== null && at > args.requestedAtMs);
  if (confirmed) return { finalize: true, forced: false };
  if (args.now - args.requestedAtMs >= CLOSE_CONFIRM_WINDOW_MS) return { finalize: true, forced: true };
  return { finalize: false };
}

/**
 * Advances every unfinished close. Idempotent: re-derived from `archived_at` each tick, so a host restart mid-close
 * resumes it.
 */
export async function advanceThreadClosures(deps: ThreadCloseDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now();
  let rows: ThreadClosureRow[];
  try {
    rows = await getDb().all<ThreadClosureRow>(
      `SELECT * FROM thread_closures WHERE state IN ('awaiting_confirmation', 'finalizing')`,
    );
  } catch (err) {
    log.warn('thread-close: could not read pending closures', { err });
    return;
  }
  for (const row of rows) {
    try {
      await advanceOneClosure(row, now, deps);
    } catch (err) {
      log.warn('thread-close: advancing a closure failed', { threadId: row.thread_id, err });
    }
  }
}

async function advanceOneClosure(row: ThreadClosureRow, now: number, deps: ThreadCloseDeps): Promise<void> {
  let sessionIds: string[];
  try {
    sessionIds = JSON.parse(row.session_ids) as string[];
  } catch {
    log.warn('thread-close: unreadable session_ids — closing the row out', { threadId: row.thread_id });
    await markClosed(row.thread_id, now, row.forced === 1);
    return;
  }
  if (sessionIds.length === 0) {
    await markClosed(row.thread_id, now, row.forced === 1);
    return;
  }

  const live = await getDb().all<CloseSession>(
    `SELECT id, agent_group_id, archived_at FROM sessions WHERE id IN (${sessionIds.map(() => '?').join(', ')})`,
    ...sessionIds,
  );
  // A session that no longer exists cannot be left running.
  if (live.length === 0) {
    await markClosed(row.thread_id, now, row.forced === 1);
    return;
  }

  let forced = row.forced === 1;
  if (row.state === 'awaiting_confirmation') {
    const requestedAtMs = Date.parse(row.requested_at);
    if (Number.isNaN(requestedAtMs)) {
      log.warn('thread-close: unparseable requested_at — finalizing', { threadId: row.thread_id });
    }
    // Read synchronously, with nothing awaited before `decideCloseFinalization`.
    const proposalAtMs = [...sampleProposalsSync(live, deps.readProposal ?? readSessionProposalSync).values()].map(
      (proposal) => {
        const at = proposal ? Date.parse(proposal.proposed_at) : NaN;
        return Number.isNaN(at) ? null : at;
      },
    );
    const decision = decideCloseFinalization({
      requestedAtMs: Number.isNaN(requestedAtMs) ? 0 : requestedAtMs,
      now,
      proposalAtMs,
    });
    if (!decision.finalize) return;
    forced = decision.forced;
    // `AND state = 'awaiting_confirmation'`: `row` was read before awaits, so the authorizing state may be stale;
    // without the predicate a 'closed' row could be moved back and its kills re-run. Non-overlapping ticks are a
    // scheduler property, not this statement's.
    await getDb().run(
      `UPDATE thread_closures SET state = 'finalizing', forced = ?
        WHERE thread_id = ? AND state = 'awaiting_confirmation'`,
      forced ? 1 : 0,
      row.thread_id,
    );
    log.info('thread-close: finalizing', {
      threadId: row.thread_id,
      requestedBy: row.requested_by,
      sessions: live.length,
      // `forced`: the agent never answered and the host ended its work anyway.
      forced,
    });
  }

  for (const session of live) {
    if (session.archived_at) continue;
    await finalizeSession(session, row.thread_id, deps);
  }

  // Re-read: `finalizeSession` archives inside the kill's exit callback, so a session still stopping stays open until
  // a later tick.
  const remaining = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sessions
      WHERE archived_at IS NULL AND id IN (${sessionIds.map(() => '?').join(', ')})`,
    ...sessionIds,
  );
  if (remaining?.n === 0) await markClosed(row.thread_id, now, forced);
}

async function markClosed(threadId: string, now: number, forced: boolean): Promise<void> {
  await getDb().run(
    `UPDATE thread_closures SET state = 'closed', forced = ?, closed_at = ? WHERE thread_id = ?`,
    forced ? 1 : 0,
    new Date(now).toISOString(),
    threadId,
  );
  log.info('thread-close: closed', { threadId, forced });
}

export interface ThreadCloseState {
  state: ThreadClosureRow['state'];
  requested_by: string;
  requested_at: string;
  forced: boolean;
}

/** One query for the page's threads, never per row. */
export async function readThreadClosures(threadIds: string[]): Promise<Map<string, ThreadCloseState>> {
  const out = new Map<string, ThreadCloseState>();
  if (threadIds.length === 0) return out;
  try {
    const rows = await getDb().all<{
      thread_id: string;
      state: ThreadClosureRow['state'];
      requested_by: string;
      requested_at: string;
      forced: number;
    }>(
      `SELECT thread_id, state, requested_by, requested_at, forced FROM thread_closures
        WHERE thread_id IN (${threadIds.map(() => '?').join(', ')})`,
      ...threadIds,
    );
    for (const r of rows) {
      out.set(r.thread_id, {
        state: r.state,
        requested_by: r.requested_by,
        requested_at: r.requested_at,
        forced: r.forced === 1,
      });
    }
  } catch (err) {
    log.warn('thread-close: closure read failed — treating the page as un-closed', { err });
  }
  return out;
}

export const threadCloseHandler: AuthHandler = async (req, params, ctx) => {
  const raw = params['id'] ?? '';
  let threadId = raw;
  try {
    threadId = decodeURIComponent(raw);
  } catch {
    /* not percent-encoded — use it verbatim */
  }

  let body: ThreadCloseBody;
  try {
    body = (await req.json()) as ThreadCloseBody;
  } catch {
    return json(400, { error: 'invalid_request' });
  }

  try {
    const result = await requestThreadClose(threadId, body, ctx);
    return json(result.status, result.body);
  } catch (err) {
    log.warn('threadCloseHandler: failed', { threadId, err });
    return json(500, { error: 'internal_error' });
  }
};
