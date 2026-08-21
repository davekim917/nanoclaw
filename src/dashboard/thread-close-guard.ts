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
 * **Two rules, and both are in `decide` rather than in the handler**, so the
 * seam is the authority and a second caller cannot arrive later with its own
 * looser copy:
 *
 *  1. An admin of at least one agent group backing the thread — the same
 *     privilege the rest of this surface's mutating verbs demand.
 *  2. The confirmation count. An agent-proposed close needs ONE confirmation:
 *     the agent already vouched that it is finished, and the operator is
 *     agreeing. A close with no proposal needs TWO, because it overrides an
 *     agent that still believes it has work — which is precisely the case the
 *     removed Dismiss action got wrong by making it a single silent click.
 *
 * The count is a server-side rule, not a client-side dialog. A UI that
 * forgot the second confirmation does not close the thread; it gets denied.
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
