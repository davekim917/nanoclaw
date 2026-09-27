/**
 * Guard catalog entry for `threads.close`, the one console action that ENDS work (clears the saved continuation,
 * stops the container, archives the sessions; not reversible).
 * Allow/deny only, no `grantActionName`: a hold would route to an asynchronous approver and grow a settle-by-silence
 * path, while a close must be confirmed by the operator in front of the thread.
 * All three rules live in `decide` so no second caller can bring a looser copy: (1) the caller administers at least
 * one agent group backing the thread; (2) no session behind it backs a LIVE (pending or paused) task series, because
 * archiving strands the series forever (fires refuse "session is archived" and nothing unarchives); this is a hard
 * refusal, not a silent cascade-cancel, and the operator must `ncl tasks cancel` it first (pause still counts as
 * live); (3) one confirmation if an agent proposed the close, two if not.
 * The REQUIRED count is decided here, but `confirmations` arrives in the request body, so a crafted POST can claim
 * two. That is accepted: the admin check is the gate, and the second confirmation is procedural friction, not a
 * boundary. A real count would need a persisted first attempt per (thread, user).
 */
import { ALLOW, DENY, defineGuardedAction } from '../guard/index.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';

/**
 * Exported so the HTTP layer can tell the client the number up front; the client never decides it, and `decide`
 * re-derives it from the same input.
 */
export function requiredConfirmations(agentProposed: boolean): 1 | 2 {
  return agentProposed ? 1 : 2;
}

interface ThreadClosePayload extends Record<string, unknown> {
  agentGroupIds: string[];
  agentProposed: boolean;
  /** As counted by the caller from the request body. */
  confirmations: number;
  /** Sampled by the caller: `decide` never opens a per-session mailbox itself. */
  liveTaskSeriesIds: string[];
}

export const threadsClose = defineGuardedAction({
  action: 'threads.close',
  decide: (input) => {
    const actor = input.actor;
    if (actor.kind !== 'human') {
      // An agent closing its own thread is the same blindness switch from the other side.
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
          `(${liveTaskSeriesIds.join(', ')}) — run \`ncl tasks cancel --id <series>\` to end ` +
          `${plural ? 'them' : 'it'} before closing this thread (pausing does not help: a paused series is ` +
          `still live and will deny the close the same way; to keep the work running, recreate it with ` +
          `\`ncl tasks create\` after closing, then cancel this one)`,
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
