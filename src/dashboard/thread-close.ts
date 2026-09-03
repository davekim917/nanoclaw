/**
 * Thread close — the console's one action that actually ENDS work.
 *
 *   POST /dashboard/api/threads/:id/close
 *
 * ## Why this exists
 *
 * The Observatory used to have a Dismiss button. It archived the thread, which
 * hid the row from the operator and did nothing whatsoever to the agent: the
 * container kept running, the saved continuation kept resuming, and the work
 * carried on where nobody was looking. It was removed rather than fixed,
 * because a hide-only control over live work is a blindness switch.
 *
 * What replaces it is a real sequence, and every step of it is load-bearing:
 *
 *   (a) ask the agent to wrap up, in its own thread, and confirm
 *   (b) make sure no `work_continuation` survives
 *   (c) stop the container
 *   (d) let the host release the processing claims (it already does)
 *   (e) archive — the TERMINAL marker, and only that
 *
 * **(b) must precede (c) and this is not a style preference.** `work_continuation`
 * is read on ANY wake, and `decideCeilingFollowUp` returns `wake-accountable`
 * on `hasContinuation` as its first unconditional branch. Kill a container
 * without clearing it and the promise simply resurfaces on the next message —
 * the close would look like it worked and would not have.
 *
 * (d) is free: `resetStuckProcessingRows` → `deleteOrphanProcessingClaims` in
 * `host-sweep.ts` already clears claims for a session whose container is gone.
 * There is deliberately nothing here for it.
 *
 * (e) is the one thing the old Dismiss got right, in the one position where it
 * is honest: `archived_at` as the last step of a real close means "this ended",
 * not "someone stopped looking".
 *
 * ## Confirmations
 *
 * One if an agent proposed the close (`propose_done` — it already vouched),
 * two if it did not (the operator is overriding an agent that still believes it
 * has work). The count is decided server-side, by the guard, so no client can
 * collapse the two cases into one click. See `thread-close-guard.ts`.
 *
 * There is no settle-by-silence anywhere in here. Nothing closes because
 * nobody looked; the only thing a timer can do is stop waiting for the AGENT,
 * after the operator has already confirmed.
 *
 * ## What this is not
 *
 * Not snooze. Snooze (`thread-snooze.ts`) is a per-viewer visibility deferral
 * that changes no work state and expires when the thread moves. Untouched.
 *
 * Not a general archive endpoint. The deleted archive routes were exactly that
 * and are not coming back: `archiveSessionById` is reachable from here only as
 * step (e) of a completed close.
 */
import { isContainerRunning, killContainer } from '../container-runner.js';
import { getDb } from '../db/index.js';
import { archiveSessionById } from '../db/sessions.js';
import { guard } from '../guard/index.js';
import { log } from '../log.js';
import { CLOSE_REASON_MAX_CHARS, type DoneProposal } from '../modules/mailbox/index.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { withExistingMailboxSession } from '../session-manager.js';
import { requiredConfirmations, threadsClose, type ThreadClosePayload } from './thread-close-guard.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * How long the close waits for the agent to answer the wrap-up request before
 * finalizing without it.
 *
 * This is NOT a settle-by-silence timer — an operator has already confirmed the
 * close by the time this clock starts, and it can only ever end waiting for the
 * AGENT. Ten minutes: the wrap-up is admitted by the next sweep tick (≤60s) and
 * the agent needs a turn to land its work and answer, so anything much shorter
 * makes the confirmation path unreachable, and anything much longer leaves a
 * thread the operator has closed running for the rest of the hour.
 */
export const CLOSE_CONFIRM_WINDOW_MS = 10 * 60 * 1000;

/** Reason cap, mirroring the container's own `DONE_PROPOSAL_REASON_MAX_CHARS`. */
export { CLOSE_REASON_MAX_CHARS, readDoneProposal, type DoneProposal } from '../modules/mailbox/index.js';

const CLOSE_WAKE_ID_PREFIX = 'thread-close-';

/* ─── The agent's proposal ─────────────────────────────────────────────────── */

/** `session_state.done_proposal` as the container writes it. */
/**
 * Copy one session's proposal into `sessions.done_proposal`.
 *
 * Called from the sweep, which reads the proposal off the mailbox session it
 * is already inside, so the thread list can render the flag without opening a
 * file per row (see migration 055 for why the mirror exists at all). Writes
 * only on change so a quiet session costs one central-DB SELECT per tick and
 * nothing else.
 *
 * Takes the proposal rather than a handle: the read is `readDoneProposal`, a
 * mailbox op, and this half is pure central-DB bookkeeping (invariant I-9 —
 * nothing outside the module receives a session handle).
 *
 * Returns the proposal it was given, so the sweep's call site stays one line.
 */
export function syncDoneProposalMirror(sessionId: string, proposal: DoneProposal | null): DoneProposal | null {
  const encoded = proposal ? JSON.stringify(proposal) : null;
  try {
    const current = getDb().prepare('SELECT done_proposal FROM sessions WHERE id = ?').get(sessionId) as
      | { done_proposal: string | null }
      | undefined;
    if (!current || current.done_proposal === encoded) return proposal;
    getDb().prepare('UPDATE sessions SET done_proposal = ? WHERE id = ?').run(encoded, sessionId);
  } catch (err) {
    log.warn('thread-close: done_proposal mirror failed', { sessionId, err });
  }
  return proposal;
}

/** Read a session's proposal from its own outbound.db — exact, never the mirror. */
async function readSessionProposal(agentGroupId: string, sessionId: string): Promise<DoneProposal | null> {
  try {
    // Existing-only. No mailbox yet (a session whose container never started)
    // is not a proposal, and a read must never author the outbound.db the host
    // is not allowed to create.
    return (await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => mailbox.readDoneProposal())) ?? null;
  } catch {
    // Absent is honest.
    return null;
  }
}

/* ─── Thread lookup ────────────────────────────────────────────────────────── */

interface CloseSession {
  id: string;
  agent_group_id: string;
  archived_at: string | null;
}

/**
 * The thread's active sessions, using the same synthetic-key rule the list and
 * snooze paths use (`session:<id>` for a session with a NULL `thread_id`), so
 * the id the console renders addresses the same thread here.
 */
function sessionsOnThread(threadId: string): CloseSession[] {
  return getDb()
    .prepare(
      `SELECT id, agent_group_id, archived_at
         FROM sessions
        WHERE status = 'active' AND COALESCE(thread_id, 'session:' || id) = ?`,
    )
    .all(threadId) as CloseSession[];
}

/* ─── (a) The wrap-up request ──────────────────────────────────────────────── */

/**
 * What the agent is asked to do before its container stops.
 *
 * Server-composed, always — the operator is ending work, not addressing the
 * agent in their own words, and an agent receiving free text it cannot
 * attribute is the shape of every "who told you that?" incident.
 *
 * It names the deadline because the deadline is real: the close finalizes when
 * the window elapses whether or not the agent answers, and an agent that does
 * not know that cannot choose to land its work first.
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

/** Write the wrap-up into one session's inbound queue. */
async function writeCloseWrapUp(
  session: CloseSession,
  threadId: string,
  text: string,
  requestedAt: string,
): Promise<boolean> {
  try {
    // Existing-only: the wrap-up asks a live agent to land its work, and a
    // session with no mailbox has no agent to ask. Provisioning one here would
    // author an outbound.db the host must never create (invariant I-10).
    const inserted = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      // Same primitive and row shape as `writeCeilingRespawn`'s `writeSystemWake`
      // in host-sweep.ts — a deferred trigger row plus its inert recall marker,
      // admitted by the next sweep tick with fresh context. `onWake: 0` because
      // the container that is running RIGHT NOW is exactly who this is for; the
      // ceiling path's `1` exists to keep a DYING container from eating its own
      // accountability notice, which is not the situation here.
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
    return inserted ?? false;
  } catch (err) {
    log.warn('thread-close: could not write the wrap-up request', { sessionId: session.id, err });
    return false;
  }
}

/* ─── Phase 1: request ─────────────────────────────────────────────────────── */

export interface ThreadClosureRow {
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

export async function requestThreadClose(
  threadId: string,
  body: ThreadCloseBody,
  ctx: AuthedRequestContext,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!threadId) return NOT_FOUND;
  const reason = (body.reason ?? '').trim().slice(0, CLOSE_REASON_MAX_CHARS) || null;
  const confirmations = typeof body.confirmations === 'number' ? body.confirmations : 0;

  const all = sessionsOnThread(threadId);
  const visible = ctx.scopes.no_filter
    ? all
    : all.filter((s) => ctx.scopes.allowed_group_ids.includes(s.agent_group_id));
  if (visible.length === 0) return NOT_FOUND;
  if (visible.length !== all.length) {
    // A close ends the THREAD, and a thread is every agent on it. Closing only
    // the sessions this caller can see would either lie ("closed" over an agent
    // still working) or escalate (stopping a container in a group they hold no
    // privilege over). Neither is acceptable for an action that ends work, so a
    // partially-visible thread is refused outright — visibly, not as a 404,
    // because the caller can already see this thread and needs to know why the
    // button did nothing.
    return {
      status: 409,
      body: { error: 'thread_extends_beyond_your_scope', thread_id: threadId, visible_sessions: visible.length },
    };
  }

  const existing = getDb().prepare('SELECT * FROM thread_closures WHERE thread_id = ?').get(threadId) as
    | ThreadClosureRow
    | undefined;
  if (existing && existing.state !== 'closed') {
    return {
      status: 409,
      body: { error: 'close_already_in_progress', thread_id: threadId, requested_at: existing.requested_at },
    };
  }

  // EXACT, not the mirror: this decides how many confirmations the operator
  // owes, so a proposal the sweep has not copied across yet must not cost them
  // a second click, and — far more importantly — a mirror row left behind by a
  // proposal the agent has since retracted must not buy them a cheaper one.
  const agentProposed = (await Promise.all(visible.map((s) => readSessionProposal(s.agent_group_id, s.id)))).some(
    (proposal) => proposal !== null,
  );

  const payload: ThreadClosePayload = {
    agentGroupIds: visible.map((s) => s.agent_group_id),
    agentProposed,
    confirmations,
  };
  const decision = guard(threadsClose, {
    actor: { kind: 'human', userId: ctx.user.id },
    resource: { threadId },
    payload,
  });
  if (decision.effect !== 'allow') {
    const required = requiredConfirmations(agentProposed);
    // Two different refusals, and they must not look alike. Too few
    // confirmations is a state the caller can act on — it is told the number
    // and asks again. Anything else (not an admin here, no sessions) collapses
    // to §2a's not-found so the surface never discloses that a thread exists.
    if (confirmations < required && visible.some((s) => hasAdminPrivilege(ctx.user.id, s.agent_group_id))) {
      return {
        status: 409,
        body: {
          error: 'confirmation_required',
          thread_id: threadId,
          required_confirmations: required,
          confirmations,
          agent_proposed: agentProposed,
        },
      };
    }
    log.info('thread-close: refused', { threadId, userId: ctx.user.id, reason: decision.reason });
    return NOT_FOUND;
  }

  const requestedAt = new Date().toISOString();
  const who = ctx.user.display_name ?? ctx.user.id;
  const windowMinutes = Math.round(CLOSE_CONFIRM_WINDOW_MS / 60_000);
  const text = composeCloseWrapUp({ who, reason, windowMinutes });

  // The fan-out is FROZEN here: an agent that joins the thread after this
  // moment was not part of what the operator closed.
  getDb()
    .prepare(
      `INSERT INTO thread_closures
         (thread_id, requested_by, requested_at, reason, agent_proposed, session_ids, state, forced, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'awaiting_confirmation', 0, NULL)
       ON CONFLICT(thread_id) DO UPDATE SET
         requested_by = excluded.requested_by, requested_at = excluded.requested_at,
         reason = excluded.reason, agent_proposed = excluded.agent_proposed,
         session_ids = excluded.session_ids, state = 'awaiting_confirmation',
         forced = 0, closed_at = NULL`,
    )
    .run(threadId, ctx.user.id, requestedAt, reason, agentProposed ? 1 : 0, JSON.stringify(visible.map((s) => s.id)));

  let delivered = 0;
  for (const s of visible) if (await writeCloseWrapUp(s, threadId, text, requestedAt)) delivered++;

  log.info('thread-close: requested', {
    threadId,
    userId: ctx.user.id,
    sessions: visible.length,
    delivered,
    agentProposed,
    confirmations,
  });
  return {
    status: 202,
    body: {
      thread_id: threadId,
      state: 'awaiting_confirmation',
      requested_at: requestedAt,
      session_ids: visible.map((s) => s.id),
      wrap_up_delivered: delivered,
      agent_proposed: agentProposed,
      confirm_window_ms: CLOSE_CONFIRM_WINDOW_MS,
    },
  };
}

/* ─── (b) The force-clear ──────────────────────────────────────────────────── */

/**
 * Delete an active `work_continuation` from the host side.
 *
 * **WHY THIS EXISTS.** `work_continuation` is container-owned: `cancel_continuation`
 * is the only thing that clears it and it runs inside the container. The host
 * has never had a general way to, and deliberately so — the host's other writes
 * to this key are bookkeeping (attempt counters) and one legacy `pending_next`
 * migration, none of which end work.
 *
 * But a close that stops a container without clearing it does not close
 * anything. `decideCeilingFollowUp` returns `wake-accountable` on
 * `hasContinuation` as its FIRST unconditional branch, and the poll loop reads
 * the record on any wake, so the promise resurfaces on the next message through
 * every kill path there is. Clearing it is what makes the close real.
 *
 * **HOW IT IS GATED.** It is module-private and has exactly one caller,
 * {@link finalizeSession}, which runs only from {@link advanceThreadClosures}
 * against a `thread_closures` row — i.e. only after an operator explicitly
 * confirmed a close (once with an agent proposal behind it, twice without) AND
 * either the agent confirmed the wrap-up or {@link CLOSE_CONFIRM_WINDOW_MS}
 * elapsed with no answer. It is not registered anywhere and has no route; the
 * only other reference to it is the `_forceClearWorkContinuationForTesting`
 * wrapper below, named that way so nobody reaches for it by accident. Do not
 * give it a caller: a host-side "cancel this agent's saved work" utility is a
 * different and much larger decision than this feature made.
 *
 * Logged at info with the thread, the session and the task it dropped, because
 * "we ended work an agent still believed it had" must be findable afterwards.
 *
 * The statements themselves are `clearWorkContinuation` / `readContinuationPresence`
 * in `src/modules/mailbox/ops/session-state.ts`; this function is the policy
 * around them (invariant I-2).
 */
async function forceClearWorkContinuation(session: CloseSession, threadId: string): Promise<boolean> {
  // Existing-only, and the ONE fork op that opens outbound.db read-write from
  // inside a session. The file must already exist: `prepare()` here would
  // author a container-owned outbound.db for a session the host is closing.
  const cleared = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    const held = mailbox.clearWorkContinuation();
    if (held) {
      log.info('thread-close: force-cleared a work_continuation the container still held', {
        threadId,
        sessionId: session.id,
        key: held.key,
        continuationId: held.id,
        droppedTask: held.task,
      });
    }
    // Presence, not validity: a record that will not parse is still a record,
    // and "we could not read it" is not a state this path may call cleared.
    return mailbox.readContinuationPresence() === null;
  });
  // `undefined` means the mailbox is gone — nothing left to resurrect, so the
  // close may proceed. That is the same answer the old `existsSync` on
  // outbound.db gave for a session whose container never started.
  return cleared ?? true;
}

/**
 * True when the session provably holds no continuation any more. False means
 * the close must NOT proceed to the kill for this session — see the ordering
 * note in the file header.
 */
async function ensureContinuationCleared(session: CloseSession, threadId: string): Promise<boolean> {
  try {
    return await forceClearWorkContinuation(session, threadId);
  } catch (err) {
    // A REAL open failure — permissions, corruption, a full disk — counts as
    // not-cleared and stops the kill.
    log.error('thread-close: could not clear work_continuation — not killing this container', {
      threadId,
      sessionId: session.id,
      err,
    });
    return false;
  }
}

/* ─── Phase 2: finalize ────────────────────────────────────────────────────── */

export interface ThreadCloseDeps {
  now?: number;
  /** Injected for tests; defaults to the real container registry / kill path. */
  isContainerRunning?: (sessionId: string) => boolean;
  killContainer?: (sessionId: string, reason: string, onExit?: () => void) => void;
  archiveSession?: (sessionId: string) => boolean;
  clearContinuation?: (session: CloseSession, threadId: string) => boolean | Promise<boolean>;
  /** The agent's confirmation source; defaults to the session's own outbound.db. */
  readProposal?: (agentGroupId: string, sessionId: string) => DoneProposal | null | Promise<DoneProposal | null>;
}

/**
 * Steps (b) → (c) → (d) → (e) for ONE session, in that order.
 *
 * The order is the whole invariant. (b) before (c) because a killed container's
 * `work_continuation` resurrects on the next wake. (c) again in the exit
 * callback — `killContainer`'s `onExit` is the one place the host knows the
 * process is provably gone — so a continuation queued in the window between the
 * clear and the kill cannot outlive us. (e) last, because `archived_at` is a
 * terminal marker and marking a thread ended while its container is still
 * running is the exact failure Dismiss shipped.
 *
 * (d) is absent on purpose: `resetStuckProcessingRows` in the sweep already
 * releases the claims of a session whose container is gone.
 */
async function finalizeSession(session: CloseSession, threadId: string, deps: ThreadCloseDeps): Promise<void> {
  const running = (deps.isContainerRunning ?? isContainerRunning)(session.id);
  const kill = deps.killContainer ?? killContainer;
  const archive = deps.archiveSession ?? archiveSessionById;
  const clear = deps.clearContinuation ?? ensureContinuationCleared;

  // (b)
  if (!(await clear(session, threadId))) return;
  if (!running) {
    archive(session.id); // (e)
    return;
  }
  // (c)
  //
  // `killContainer`'s onExit is a synchronous callback and the clear is async
  // now, so the exit work is captured rather than awaited inline. Awaiting the
  // captured promise afterwards costs nothing in production — the real
  // `killContainer` fires onExit long after this returns, so `exitWork` is
  // still undefined here and the closure simply advances on the next tick, as
  // the comment below has always said. When onExit DOES fire synchronously
  // (a stopped container, or an injected kill), awaiting it keeps the original
  // ordering: clear, then archive, both before this function returns.
  let exitWork: Promise<void> | undefined;
  kill(session.id, `thread close ${threadId}`, () => {
    exitWork = (async () => {
      try {
        await clear(session, threadId);
      } finally {
        archive(session.id); // (e)
      }
    })();
  });
  await exitWork;
}

/**
 * Pure decision half of the sweep step, so the "when may a close stop waiting
 * for the agent" rule is directly testable.
 *
 * `confirmed` requires a proposal STRICTLY NEWER than the request: a proposal
 * that was already standing when the operator clicked is what made this a
 * one-confirmation close, and reading it a second time as the agent's answer
 * to the wrap-up would mean the agent never actually answered anything.
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
 * Sweep step: advance every close that is not finished.
 *
 * Idempotent by construction — it re-derives from `archived_at` each tick, so a
 * host restart mid-close resumes rather than losing or double-applying it.
 */
export async function advanceThreadClosures(deps: ThreadCloseDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now();
  let rows: ThreadClosureRow[];
  try {
    rows = getDb()
      .prepare(`SELECT * FROM thread_closures WHERE state IN ('awaiting_confirmation', 'finalizing')`)
      .all() as ThreadClosureRow[];
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
    markClosed(row.thread_id, now, row.forced === 1);
    return;
  }
  if (sessionIds.length === 0) {
    markClosed(row.thread_id, now, row.forced === 1);
    return;
  }

  const live = getDb()
    .prepare(
      `SELECT id, agent_group_id, archived_at FROM sessions WHERE id IN (${sessionIds.map(() => '?').join(', ')})`,
    )
    .all(...sessionIds) as CloseSession[];
  // A session that no longer exists cannot be left running, so it does not hold
  // the close open.
  if (live.length === 0) {
    markClosed(row.thread_id, now, row.forced === 1);
    return;
  }

  let forced = row.forced === 1;
  if (row.state === 'awaiting_confirmation') {
    const requestedAtMs = Date.parse(row.requested_at);
    if (Number.isNaN(requestedAtMs)) {
      log.warn('thread-close: unparseable requested_at — finalizing', { threadId: row.thread_id });
    }
    const decision = decideCloseFinalization({
      requestedAtMs: Number.isNaN(requestedAtMs) ? 0 : requestedAtMs,
      now,
      // Resolved BEFORE the decision so the fan-out is frozen the way it
      // always was: one read per session, all of them taken now.
      proposalAtMs: await Promise.all(
        live.map(async (s) => {
          const p = await (deps.readProposal ?? readSessionProposal)(s.agent_group_id, s.id);
          const at = p ? Date.parse(p.proposed_at) : NaN;
          return Number.isNaN(at) ? null : at;
        }),
      ),
    });
    if (!decision.finalize) return;
    forced = decision.forced;
    getDb()
      .prepare(`UPDATE thread_closures SET state = 'finalizing', forced = ? WHERE thread_id = ?`)
      .run(forced ? 1 : 0, row.thread_id);
    log.info('thread-close: finalizing', {
      threadId: row.thread_id,
      requestedBy: row.requested_by,
      sessions: live.length,
      // The distinction that matters in a log search afterwards: `forced` means
      // the agent never answered the wrap-up and the host ended its work anyway.
      forced,
    });
  }

  for (const session of live) {
    if (session.archived_at) continue;
    await finalizeSession(session, row.thread_id, deps);
  }

  // Re-read rather than trusting the loop above: `finalizeSession` archives
  // inside `killContainer`'s exit callback, so a session stopping right now is
  // still open and this closure simply advances on the next tick.
  const remaining = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions
        WHERE archived_at IS NULL AND id IN (${sessionIds.map(() => '?').join(', ')})`,
    )
    .get(...sessionIds) as { n: number };
  if (remaining.n === 0) markClosed(row.thread_id, now, forced);
}

function markClosed(threadId: string, now: number, forced: boolean): void {
  getDb()
    .prepare(`UPDATE thread_closures SET state = 'closed', forced = ?, closed_at = ? WHERE thread_id = ?`)
    .run(forced ? 1 : 0, new Date(now).toISOString(), threadId);
  log.info('thread-close: closed', { threadId, forced });
}

/* ─── Read side for the thread list ────────────────────────────────────────── */

export interface ThreadCloseState {
  state: ThreadClosureRow['state'];
  requested_by: string;
  requested_at: string;
  forced: boolean;
}

/** Pending closes for exactly the threads on the page — one query, never per row. */
export function readThreadClosures(threadIds: string[]): Map<string, ThreadCloseState> {
  const out = new Map<string, ThreadCloseState>();
  if (threadIds.length === 0) return out;
  try {
    const rows = getDb()
      .prepare(
        `SELECT thread_id, state, requested_by, requested_at, forced FROM thread_closures
          WHERE thread_id IN (${threadIds.map(() => '?').join(', ')})`,
      )
      .all(...threadIds) as {
      thread_id: string;
      state: ThreadClosureRow['state'];
      requested_by: string;
      requested_at: string;
      forced: number;
    }[];
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

/* ─── HTTP ─────────────────────────────────────────────────────────────────── */

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
