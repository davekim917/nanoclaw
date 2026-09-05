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
import { containerOwnsOutbound, killContainer } from '../container-runner.js';
import { getDb } from '../db/connection.js';
import { getRawDb } from '../db/index.js';
import { archiveSessionById, withQuietInvalidationSync } from '../db/sessions.js';
import { withCentralSync } from '../db/central-lease.js';
import { guard } from '../guard/index.js';
import { log } from '../log.js';
import {
  CLOSE_REASON_MAX_CHARS,
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
// On the async driver since seam 3 PR 6 (the "5c" family, converted with its
// one sweep-continuation caller): a best-effort mirror, so the read→write pair
// needs no transaction — a stale mirror is refreshed by the next tick, and the
// close path never trusts this copy.
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
 * Every session's proposal, read SYNCHRONOUSLY, as of one instant.
 *
 * The async fan-out this replaces at the decision point resolved each session
 * at its own moment: A's read could land, A could then take new work and clear
 * its `done_proposal`, and B's read could still be outstanding — and A's cached
 * `true` would then buy a close over an agent that is mid-turn. Sampling twice
 * did not fix it, because both samples had the same shape; a second stale set
 * is still stale.
 *
 * Nothing awaits inside this loop, so every value is read after the last change
 * that could precede the decision and before any change that could follow it.
 * The caller must not await between calling this and deciding.
 *
 * Unreadable is absent, exactly as the async read treats it.
 */
function sampleProposalsSync(
  sessions: readonly CloseSession[],
  read: (agentGroupId: string, sessionId: string) => DoneProposal | null,
): Map<string, DoneProposal | null> {
  const proposals = new Map<string, DoneProposal | null>();
  for (const session of sessions) proposals.set(session.id, read(session.agent_group_id, session.id));
  return proposals;
}

/** The synchronous twin of `readSessionProposal`, same existence and fault rules. */
function readSessionProposalSync(agentGroupId: string, sessionId: string): DoneProposal | null {
  try {
    return withExistingNanoclawOutboundSync(agentGroupId, sessionId, (outbound) => outbound.readDoneProposal()) ?? null;
  } catch {
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
 *
 * PERMANENT raw/sync exception (§4.5-class, not a 5c deferral): this function
 * is called both before AND inside `requestThreadClose`'s documented "ONE
 * synchronous decision, no await from here to the reservation" span (see
 * `ClosureDecision`'s doc comment and "THIS IS THE LAST AWAIT" below) — the
 * whole point of `sampleProposalsSync`/`readSessionProposalSync` existing as
 * synchronous twins is to keep that span awaitless. Converting this function
 * would break the invariant at its in-span call site regardless of which PR
 * does it, so it stays on the raw handle even after 5c.
 */
function sessionsOnThread(threadId: string): CloseSession[] {
  return getRawDb()
    .prepare(
      `SELECT id, agent_group_id, archived_at
         FROM sessions
        WHERE status = 'active' AND COALESCE(thread_id, 'session:' || id) = ?`,
    )
    .all(threadId) as CloseSession[];
}

/**
 * Is this ONE session still active and still on this thread? Same predicate as
 * `sessionsOnThread`, keyed to a single id, so a caller holding a snapshot can
 * re-ask the question it snapshotted without re-running the fan-out.
 *
 * PERMANENT raw/sync exception (§4.5-class, not a 5c deferral): called from
 * inside `writeCloseWrapUp`'s mailbox-action callback, which must stay
 * "synchronous, so nothing yields before the insert below" (the
 * `withQuietInvalidationSync` precondition a few lines down that call site).
 * Converting this to the async driver would introduce exactly the yield that
 * comment forbids.
 */
function stillOnThread(sessionId: string, threadId: string): boolean {
  return (
    getRawDb()
      .prepare(
        `SELECT 1
           FROM sessions
          WHERE id = ? AND status = 'active' AND COALESCE(thread_id, 'session:' || id) = ?`,
      )
      .get(sessionId, threadId) !== undefined
  );
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
      withCentralSync(() => {
        // Membership and liveness, re-asked in-session. `freshVisible` was
        // sampled once and the fan-out awaits per session, so by this iteration
        // the snapshot can name a session that has since closed or moved off the
        // thread. Asking an agent that is not on this thread to wrap up for it is
        // the "who told you that?" shape this file exists to avoid, and a closed
        // session has no one to ask. Synchronous, so nothing yields before the
        // insert below.
        if (!stillOnThread(session.id, threadId)) return false;
        // Same primitive and row shape as `writeCeilingRespawn`'s `writeSystemWake`
        // in host-sweep.ts — a deferred trigger row plus its inert recall marker,
        // admitted by the next sweep tick with fresh context. `onWake: 0` because
        // the container that is running RIGHT NOW is exactly who this is for; the
        // ceiling path's `1` exists to keep a DYING container from eating its own
        // accountability notice, which is not the situation here.
        //
        // Due-ness. The wrap-up is a deferred trigger row, and both the sweep's
        // quiet cache and the delivery sweep's activity horizon key on
        // `last_active` — a row written into a quiet session without an
        // invalidation sits unseen until the cache expires, or indefinitely past
        // the 7-day horizon. The wake this row triggers would bump it, but not
        // until the wake happens; the insert-to-wake window is exactly the gap.
        //
        // `withQuietInvalidationSync` is the single form every due-ness write in
        // the fork takes (`modules/scheduling/create.ts`, `recurrence.ts`,
        // `cli/resources/tasks.ts`, `db/scheduled-tasks.ts`): the mark dies in
        // the same synchronous turn as the row, inside the mailbox callback so
        // no await can sit between them, and FAIL-CLOSED — the advisory bump
        // this replaced swallowed a central-DB refusal and left the row behind a
        // mark nothing would clear. A refusal now throws into the catch below,
        // which logs and answers `false`, so the close simply has no wrap-up
        // request this pass rather than a silently unseen one. A session with no
        // ACTIVE central row is also refused, and that is right: it has no sweep
        // to reach it.
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

/** The single decision every reservation input and reported field comes from. */
export interface ClosureDecision {
  outcome: 'reserve' | 'confirmation-required' | 'refused';
  /** As of `freshVisible` — this is what the row stores AND what the response reports. */
  agentProposed: boolean;
  required: 1 | 2;
  sessionIds: string[];
  agentGroupIds: string[];
  reason?: string;
}

/**
 * The whole close decision, in one place, with no await in it.
 *
 * Everything this returns — the reservation inputs AND the fields the response
 * and the log report — comes out of one evaluation against one set of
 * sessions. That is the point. The close used to decide twice: once on the
 * pre-await `visible` set and again, conditionally, on the fresh one, and the
 * two could disagree in both directions. If the admin-backed session left
 * during the proposal reads and a member-visible one joined, the fresh set
 * could contain no group the caller administers while the first decision's
 * `allow` still stood. And the response reported the pre-await proposal value
 * while the row persisted the recomputed one, so the operator was told
 * something the record contradicts.
 *
 * Neither is a line to patch; both are the same structural fact, that a
 * decision made before an await was still load-bearing after it. So there is
 * exactly one decision now, it happens after the last await, and nothing
 * computed before that await reaches the caller except through
 * `freshVisible`.
 *
 * Pure in the sense that matters here: no awaits and no writes. It does read —
 * `guard` and `hasAdminPrivilege` consult current privilege, which is the
 * whole reason to run them late — but it decides nothing from state it has not
 * just looked at, and a test can drive it directly with any interleave.
 *
 * @param freshVisible sessions on the thread NOW, already scope-filtered.
 * @param proposalsBySession which sessions were found to hold a standing
 *   `propose_done`. A session ABSENT from this map counts as not proposing: it
 *   joined after the reads, and reading it here would need the one thing this
 *   function may not have. Under-counting proposals can only raise the
 *   confirmation bar, never lower it.
 */
export function decideClosure(
  freshVisible: CloseSession[],
  proposalsBySession: ReadonlyMap<string, boolean>,
  confirmations: number,
  caller: { userId: string; threadId: string },
): ClosureDecision {
  const agentProposed = freshVisible.some((s) => proposalsBySession.get(s.id) === true);
  const required = requiredConfirmations(agentProposed);
  const reported = {
    agentProposed,
    required,
    sessionIds: freshVisible.map((s) => s.id),
    agentGroupIds: freshVisible.map((s) => s.agent_group_id),
  };

  const decision = guard(threadsClose, {
    actor: { kind: 'human', userId: caller.userId },
    resource: { threadId: caller.threadId },
    payload: { agentGroupIds: reported.agentGroupIds, agentProposed, confirmations },
  });
  if (decision.effect === 'allow') return { ...reported, outcome: 'reserve' };

  // Two refusals that must not look alike. Too few confirmations is a state
  // the caller can act on — it is told the number and asks again. Anything
  // else (not an admin on this thread any more, no sessions) collapses to the
  // not-found so the surface never discloses that a thread exists.
  if (confirmations < required && freshVisible.some((s) => hasAdminPrivilege(caller.userId, s.agent_group_id))) {
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

  // PERMANENT raw/sync exception (§4.5-class, not a 5c deferral): this read,
  // the reservation INSERT below, and the loser's read on a lost race all
  // sit inside (or feed) the "ONE synchronous decision, no await from here
  // to the reservation" span documented above `ClosureDecision` — see
  // `sessionsOnThread`'s doc comment for the full reasoning.
  const existing = getRawDb().prepare('SELECT * FROM thread_closures WHERE thread_id = ?').get(threadId) as
    | ThreadClosureRow
    | undefined;
  if (existing && existing.state !== 'closed') {
    return {
      status: 409,
      body: { error: 'close_already_in_progress', thread_id: threadId, requested_at: existing.requested_at },
    };
  }

  // EXACT, not the mirror: the decision below reads how many confirmations the
  // operator owes off these values, so a proposal the sweep has not copied
  // across yet must not cost them a second click, and — far more importantly —
  // a mirror row left behind by a proposal the agent has since retracted must
  // not buy them a cheaper one.
  //
  // WHICH sessions proposed, not merely whether any did: the set below is
  // intersected with the fresh membership, so a proposer that goes inactive
  // during these reads takes its proposal with it.
  //
  // THIS IS THE LAST AWAIT. Everything after it is one synchronous block.
  //
  // TWO SAMPLES, and a proposal counts only if both saw it. Refreshing
  // membership below catches a proposer that LEFT; it cannot catch one that
  // stayed and RETRACTED, which buys the cheaper bar by a different route — a
  // container clears `done_proposal` the moment it takes new work. The read is
  // async and cannot be made synchronous, so it cannot be moved adjacent to the
  // decision; what it can be is repeated, with any disagreement resolved
  // against the close. Both samples finish BEFORE the synchronous block, so
  // this adds no await between the membership read and the decision.
  //
  // Sampled over the set as it stood at entry, and sampled SYNCHRONOUSLY, so
  // the reads and the decision below are one uninterrupted block. Membership is
  // re-read after this and the decision is made on THAT set: a session present
  // now but absent from the sample counts as not proposing, which can only
  // raise the confirmation bar, never lower it.
  const sampled = sampleProposalsSync(visible, readSessionProposalSync);

  // ── One synchronous decision. No await from here to the reservation. ──────
  //
  // Membership is re-read HERE. `visible` above was computed before the
  // proposal reads; a sibling joining during that yield was frozen out of the
  // reservation, so it never received a wrap-up and was never finalized. The
  // scope rule is re-applied to the fresh set for the same reason it applied to
  // the first one: closing a thread that now reaches an agent this caller
  // cannot see would either lie or escalate, and refusing here is safe because
  // nothing has been reserved yet.
  const freshAll = sessionsOnThread(threadId);
  const freshVisible = ctx.scopes.no_filter
    ? freshAll
    : freshAll.filter((s) => ctx.scopes.allowed_group_ids.includes(s.agent_group_id));
  if (freshVisible.length !== freshAll.length) {
    return {
      status: 409,
      body: { error: 'thread_extends_beyond_your_scope', thread_id: threadId, visible_sessions: freshVisible.length },
    };
  }

  const proposalsBySession = new Map(freshVisible.map((s) => [s.id, sampled.get(s.id) != null] as const));

  // Under the central lease: `guard()`'s reads are raw by design (seam 3
  // §4.5 I-1). The reservation below is its own CAS (`WHERE state = 'closed'`),
  // so the lease hop between the decision and the write changes nothing about
  // who wins a race — the row does.
  const decision = await withCentralSync(
    () =>
      decideClosure(freshVisible, proposalsBySession, confirmations, {
        userId: ctx.user.id,
        threadId,
      }),
    'thread close decision',
  );
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
  if (decision.outcome === 'refused') {
    log.info('thread-close: refused', { threadId, userId: ctx.user.id, reason: decision.reason });
    return NOT_FOUND;
  }

  const requestedAt = new Date().toISOString();
  const who = ctx.user.display_name ?? ctx.user.id;
  const windowMinutes = Math.round(CLOSE_CONFIRM_WINDOW_MS / 60_000);
  const text = composeCloseWrapUp({ who, reason, windowMinutes });

  // The fan-out is FROZEN here: an agent that joins the thread after this
  // moment was not part of what the operator closed.
  //
  // This is an atomic RESERVATION, not a bare upsert, because the
  // `thread_closures` check earlier is no longer in the same synchronous step
  // as this write. `readSessionProposal` became awaiting when it moved behind
  // the mailbox seam (PR 4; pre-seam it was a synchronous open), so two
  // sufficiently-confirmed requests for one thread — a double-click, or two
  // admins — can both pass that check and both yield before either writes. An
  // unconditional DO UPDATE then let the second silently replace the first's
  // actor, reason, timestamp and confirmation window, answer 202, and fan out
  // a second wrap-up.
  //
  // `WHERE thread_closures.state = 'closed'` on the DO UPDATE makes the row
  // itself the lock: a LIVE closure is never overwritten, a finished one still
  // re-opens (the case the upsert exists for), and zero rows changed means
  // somebody else reserved it first.
  const reserved = getRawDb()
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
    );

  if (reserved.changes === 0) {
    // Lost the race. The same refusal the early check gives, reported from the
    // row the winner just wrote — and, the point of returning here, the loser
    // never reaches the fan-out below, so one close request produces one
    // wrap-up.
    const winner = getRawDb().prepare('SELECT requested_at FROM thread_closures WHERE thread_id = ?').get(threadId) as
      | { requested_at: string }
      | undefined;
    log.info('thread-close: lost the reservation race', { threadId, userId: ctx.user.id });
    return {
      status: 409,
      body: { error: 'close_already_in_progress', thread_id: threadId, requested_at: winner?.requested_at ?? null },
    };
  }

  // The fan-out follows the frozen set, so a late joiner gets its wrap-up too.
  // Its `propose_done` is deliberately NOT re-read for `agentProposed` above:
  // counting it could only LOWER the confirmations the operator owes, and this
  // path never gets cheaper on a second look (see the EXACT-not-mirror note).
  let delivered = 0;
  for (const s of freshVisible) if (await writeCloseWrapUp(s, threadId, text, requestedAt)) delivered++;

  // Reported straight off the decision — the same object the row was written
  // from. Reading `agentProposed` from anywhere else is how the response came
  // to contradict the record it had just persisted.
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
  // OUTBOUND-keyed, not a mailbox session. `work_continuation` lives in
  // outbound.db and nothing here reads inbound at all, so the existence
  // question this path must ask is about outbound.db alone.
  //
  // Going through `withExistingMailboxSession` asked the wrong one: that
  // funnel keys existence on inbound.db, so a session whose inbound.db is gone
  // while outbound.db remains — a real cohort, the same one `host-sweep.ts`'s
  // usage rollup names — resolved `undefined`, which this function read as
  // "cleared". The finalizer would then archive a session with a live
  // `work_continuation` (or `pending_next`) still sitting in outbound.
  //
  // `undefined` from this funnel means outbound.db is genuinely ABSENT: the
  // container owns that file, one that never ran has not written it, and a
  // session with no outbound.db holds no continuation to clear. That is the
  // only shape this function may call cleared without looking. A file that is
  // present but will not open raises from the opener instead, and
  // `ensureContinuationCleared` counts that as not-cleared.
  const cleared = await withExistingNanoclawOutbound(session.agent_group_id, session.id, (outbound) => {
    // Re-checked INSIDE the session, immediately before the write, with no
    // await in between — the guard shape PR 5 established for every host write
    // to the container-owned outbound.db. Opening the session is a yield, and a
    // wake can start a container in it; `outbound.db` has exactly one writer,
    // so the host may only write while none is claimed. Not cleared, so the
    // caller does not archive: the closure retries on the next tick, by which
    // time the kill has landed.
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
    // Presence, not validity: a record that will not parse is still a record,
    // and "we could not read it" is not a state this path may call cleared.
    return outbound.readContinuationPresence() === null;
  });
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
  /**
   * SYNCHRONOUS by contract. The finalization decision samples every live
   * session with nothing awaited between the reads and the decision, so a dep
   * that returned a promise could not participate in that instant at all.
   */
  readProposal?: (agentGroupId: string, sessionId: string) => DoneProposal | null;
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
  const kill = deps.killContainer ?? killContainer;
  const archive = deps.archiveSession ?? archiveSessionById;
  const clear = deps.clearContinuation ?? ensureContinuationCleared;
  // `containerOwnsOutbound` rather than `isContainerRunning`: a wake issued a
  // moment ago is SPAWNING and has not reached the running registry yet, but it
  // is about to hold the session. An injected `isContainerRunning` still wins,
  // so tests keep one knob.
  const owns = (id: string): boolean =>
    deps.isContainerRunning ? deps.isContainerRunning(id) : containerOwnsOutbound(id);

  /**
   * Clear, re-sample ownership, and archive only if nobody took the session.
   *
   * THE settle path — both branches below call it and neither hand-rolls the
   * sequence. Three separate review findings were the same defect on three
   * different branches of this function: a clear that awaits, and an archive
   * decided from a read taken before it. Writing the sequence once is what
   * stops a fourth branch from getting it wrong.
   *
   * The re-sample is synchronous and sits immediately after the clear resolves,
   * with no await before the archive. `still-owned` means a wake landed inside
   * the clear: the caller must NOT archive, because archiving is display-only
   * and would leave that container working in a thread the operator sees as
   * closed. Leaving the closure `finalizing` sends the next tick down the kill
   * path against the new container, which is the correct answer for both
   * callers.
   */
  type SettleOutcome = 'settled' | 'not-cleared' | 'still-owned';
  const clearThenSettle = async (): Promise<SettleOutcome> => {
    if (!(await clear(session, threadId))) return 'not-cleared';
    if (owns(session.id)) return 'still-owned';
    await archive(session.id); // (e)
    return 'settled';
  };

  // Ownership is read HERE, and it decides the ORDER, not whether to clear.
  //
  // No container: nothing to stop, so clear and then archive — but the clear
  // AWAITS, and a wake issued during it leaves a live container that this
  // branch would archive around. Archiving is display-only, so nothing stops
  // that container: the operator sees a closed thread with an agent still
  // working in it.
  //
  // `forceClearWorkContinuation`'s own guard does not cover this on its own.
  // It refuses to WRITE under a live container, but a session with no
  // outbound.db never runs that guard at all — the funnel resolves `undefined`
  // before the action, and "nothing to clear" is a legitimate success. So the
  // ownership question is re-asked here, after the clear resolves and
  // immediately before the archive, with no await in between.
  if (!owns(session.id)) {
    // `still-owned` falls through to the kill path below rather than archiving
    // around the container that just took the session; the clear runs again in
    // `onExit`, idempotent, with the process provably gone.
    if ((await clearThenSettle()) !== 'still-owned') return;
  }

  // (c) KILL FIRST, then clear once the container is provably gone.
  //
  // This used to clear BEFORE the kill, on the reasoning that killing first
  // would leave the dying container's continuation intact. That has it exactly
  // backwards: `outbound.db` has ONE writer, and clearing while the container
  // still owns it is a host write under a live writer. The concern it was
  // guarding is precisely why the clear belongs AFTER exit — a continuation
  // persisted during the SIGTERM grace period is then cleared rather than
  // raced. `killContainer`'s `onExit` is what guarantees the process is gone.
  //
  // A failed clear means the promise may still be live, so the session is NOT
  // archived: the closure stays `finalizing` and the next tick retries, which
  // is the same answer a failed clear has always given. By then the container
  // is stopped, so the retry is the one that succeeds.
  //
  // `onExit` is a synchronous callback and the clear is async, so the exit work
  // is handed back through a promise created HERE rather than a variable
  // assigned inside the callback. That assignment was read immediately after
  // `kill` returned — while it was still `undefined` for the real
  // `killContainer`, which fires `onExit` long after — so `await exitWork` was
  // awaiting nothing, and a settle error on a later real exit rejected a
  // promise with no local catch. It escaped this function's caller entirely and
  // surfaced at the process `unhandledRejection` handler, outside
  // `advanceThreadClosures`' per-row containment, so the close could neither
  // report nor retry it.
  //
  // Resolving from the callback keeps both shapes correct: a synchronous
  // `onExit` (an already-stopped container, or an injected kill) still orders
  // kill, clear and archive before this returns, and an asynchronous one is
  // still caught — by this function, where the closure can act on it.
  //
  // Through the same settle path: exit does not mean nobody else took the
  // session. A concurrent group or provider restart can register its own
  // `onExit` respawn for this process and `wakeContainer` while we sit in the
  // clear, and archiving then would strand that replacement in a closed thread
  // — later closure ticks skip an archived session entirely.
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
  // Only await an exit that actually happened in this turn. The real
  // `killContainer` fires `onExit` on a later tick and this promise would
  // otherwise never settle, hanging the sweep step — the failure the old
  // `undefined` read was accidentally avoiding. A later exit's rejection is
  // still caught below rather than escaping to the process handler.
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
  // A session that no longer exists cannot be left running, so it does not hold
  // the close open.
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
    // THE DECISION SET, read synchronously, all of it, with nothing awaited
    // between these reads and `decideCloseFinalization` below.
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
    // `AND state = 'awaiting_confirmation'`: `row` was read before the
    // proposal reads above, which await, so the state that authorized this
    // transition is not the state at the moment of it. Without the predicate
    // the statement will move a row from 'closed' back to 'finalizing' and
    // re-run the kills. Nothing can do that today — the sweep is a
    // self-rescheduling chain, so ticks never overlap — but that is a
    // property of the scheduler, not of this statement, and the statement is
    // where it belongs.
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

/* ─── Read side for the thread list ────────────────────────────────────────── */

export interface ThreadCloseState {
  state: ThreadClosureRow['state'];
  requested_by: string;
  requested_at: string;
  forced: boolean;
}

/** Pending closes for exactly the threads on the page — one query, never per row. */
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
