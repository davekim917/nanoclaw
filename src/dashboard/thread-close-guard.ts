/**
 * Thread-close guard adapter — the catalog entry for `threads.close`, composed
 * at this feature's module edge (imported by `thread-close.ts`).
 *
 * Closing is privileged because it is the one console action that ENDS work:
 * it clears the agent's saved continuation, stops its container and archives
 * the sessions. None of that is trivially reversible — `unarchiveSessionById`
 * puts the row back on the list, but the continuation and the container are
 * gone — so it passes the same seam every other privileged action does.
 *
 * **Allow/deny only, no `grantActionName`.** A hold routes to the approvals
 * primitive, which resolves through an approver's chat card — a second person,
 * asynchronously, possibly never. Closure has the opposite requirement: the
 * operator confirms it themselves, in front of the thread, or it does not
 * happen. There is no settle-by-silence for closure, and a HOLD is exactly the
 * shape that would grow one. Nothing pairs with an approval handler here
 * because nothing is ever waiting for one.
 *
 * **Three rules, and all are in `decide` rather than in the handler**, so the
 * seam is the authority and a second caller cannot arrive later with its own
 * looser copy:
 *
 *  1. An admin of at least one agent group backing the thread — the same
 *     privilege the rest of this surface's mutating verbs demand.
 *  2. No session behind the thread may back a LIVE (pending or paused) task
 *     series. A per-series task thread (`system:tasks:<seriesId>`) is 1:1
 *     with its session — archiving that session strands the series: it stays
 *     `pending`/`paused` forever, `unwakeableReason` refuses every fire with
 *     "session is archived" (`src/container-runner.ts`), and nothing
 *     reopens it, because `unarchiveSessionById` has no callers. A silent
 *     cascade-cancel was considered and rejected — closing a thread must not
 *     quietly end scheduled work — so this is a hard refusal, not a third
 *     confirmation: the operator must explicitly end the series first
 *     (`ncl tasks cancel --id <series>` or `ncl tasks pause --id <series>`)
 *     before the thread can close.
 *  3. The confirmation count. An agent-proposed close needs ONE confirmation:
 *     the agent already vouched that it is finished, and the operator is
 *     agreeing. A close with no proposal needs TWO, because it overrides an
 *     agent that still believes it has work — which is precisely the case the
 *     removed Dismiss action got wrong by making it a single silent click.
 *
 * **What the count is, and what it is NOT.** The REQUIRED number is decided
 * here and only here: a UI that forgot the second confirmation, or shipped its
 * own looser guess, sends too low a number and is denied. What is NOT decided
 * here is how many acts actually happened — `confirmations` arrives in the
 * request body (`thread-close.ts` reads it straight off the JSON), so nothing
 * on this path distinguishes two deliberate clicks from one crafted POST
 * carrying `{"confirmations": 2}`. Do not read the paragraphs above as a claim
 * that a client cannot collapse the two acts into one call. It can.
 *
 * That is accepted, not overlooked. The gate that matters is the admin check
 * immediately above, and the same admin can click twice; the second
 * confirmation is procedural friction that makes an irreversible action
 * deliberate, not a boundary that keeps anyone out. Making it a real count
 * would mean persisting the first refused attempt per (thread, user) with a
 * TTL — new server state for a step that stops nobody who is already allowed
 * to close. If that trade is ever revisited, the honest fix is that row, not a
 * stricter-looking comment here.
 */
import { ALLOW, DENY, defineGuardedAction } from '../guard/index.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';

/**
 * How many explicit operator confirmations this close requires.
 *
 * Exported so the HTTP layer can TELL the client the number before it asks —
 * the client must never be the one deciding it. `decide` re-derives it from
 * the same input, so the two cannot drift apart in a way that lets a close
 * through.
 */
export function requiredConfirmations(agentProposed: boolean): 1 | 2 {
  return agentProposed ? 1 : 2;
}

export interface ThreadClosePayload extends Record<string, unknown> {
  /** Every agent group with a session in the close's frozen fan-out. */
  agentGroupIds: string[];
  /** An agent on this thread has a standing `propose_done` record. */
  agentProposed: boolean;
  /** Confirmations the operator actually gave, as counted by the caller. */
  confirmations: number;
  /**
   * Series ids of any LIVE (pending|paused) task series a session behind this
   * thread backs, sampled by the caller before the decision — `decide` never
   * touches a per-session mailbox itself, the same reason `agentProposed`
   * arrives pre-sampled rather than re-derived in here. See
   * `src/dashboard/thread-close.ts`'s `liveTaskSeriesIdsSync`.
   */
  liveTaskSeriesIds: string[];
}

export const threadsClose = defineGuardedAction({
  action: 'threads.close',
  decide: (input) => {
    const actor = input.actor;
    if (actor.kind !== 'human') {
      // Not a policy choice about who is trustworthy — an agent closing its
      // own thread is the blindness switch again, from the other side, and the
      // host has no business ending work nobody asked it to end.
      return DENY('closing a thread is an operator action');
    }
    const payload = input.payload as Partial<ThreadClosePayload>;
    const agentGroupIds = Array.isArray(payload.agentGroupIds)
      ? payload.agentGroupIds.filter((id): id is string => typeof id === 'string' && id !== '')
      : [];
    if (agentGroupIds.length === 0) return DENY('no sessions back this thread');
    if (!agentGroupIds.some((id) => hasAdminPrivilege(actor.userId, id))) {
      return DENY('not an admin of any agent group on this thread');
    }

    const liveTaskSeriesIds = Array.isArray(payload.liveTaskSeriesIds)
      ? payload.liveTaskSeriesIds.filter((id): id is string => typeof id === 'string' && id !== '')
      : [];
    if (liveTaskSeriesIds.length > 0) {
      const plural = liveTaskSeriesIds.length > 1;
      return DENY(
        `a session behind this thread backs ${plural ? 'live task series' : 'a live task series'} ` +
          `(${liveTaskSeriesIds.join(', ')}) — run \`ncl tasks cancel --id <series>\` or ` +
          `\`ncl tasks pause --id <series>\` to end ${plural ? 'them' : 'it'} before closing this thread`,
      );
    }

    const required = requiredConfirmations(payload.agentProposed === true);
    const given = typeof payload.confirmations === 'number' ? payload.confirmations : 0;
    if (!Number.isInteger(given) || given < required) {
      return DENY(
        `close requires ${required} explicit operator confirmation(s), got ${given}` +
          (required === 2 ? ' — no agent has proposed closing this thread' : ''),
      );
    }
    return ALLOW(
      `${required} confirmation(s) given by an admin of the thread` +
        (payload.agentProposed === true ? ', backed by an agent proposal' : ''),
    );
  },
});
