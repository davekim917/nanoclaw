/**
 * Assign guard adapter — the catalog entry for `observatory.assign`, composed
 * at this feature's module edge (imported by `assign.ts`).
 *
 * Assigning is privileged for the plainest possible reason: it CAUSES AN AGENT
 * TO DO WORK. A browser press turns into a one-shot task with a server-composed
 * prompt, a real container boot, and an agent talking in a room full of people.
 * That is the same class of act as steering a thread or admitting a sender, so
 * it passes the same seam they do rather than resting on a handler-local `if`.
 *
 * **Allow/deny only, no `grantActionName`.** Assignment is not a request that
 * waits for a second person: the operator standing in front of the queue is the
 * one deciding where the work goes, and a HOLD would turn a queue-triage action
 * into an approval card someone has to chase. Nothing pairs with an approval
 * handler here because nothing is ever waiting for one — the same call
 * `thread-close-guard.ts` makes, for the same reason.
 *
 * **Both rules live in `decide`, not in the handler.** The seam is the
 * authority, so a second caller arriving later cannot bring its own looser
 * copy:
 *
 *  1. **Admin privilege over the target agent group.** Identical to
 *     `canAssign`'s allow condition (owner / global admin / admin of that
 *     group) — `hasAdminPrivilege` IS that predicate, so the two cannot drift.
 *  2. **The target agent is wired to the item's own channel.** This is the
 *     invariant that keeps a browser from making an agent speak somewhere it
 *     does not belong, and it is exactly the rule an assign path is most likely
 *     to lose: the caller is the one that knows the channel, so leaving the
 *     check in the caller means every future caller re-decides it. The handler
 *     RE-DERIVES the wiring from `messaging_group_agents` and reports what it
 *     found; the guard is what refuses when the answer is no.
 *
 * Scope (§2a) is deliberately NOT here. An out-of-scope agent group must be
 * indistinguishable from one that does not exist — the handler resolves it to
 * absent before a decision is ever asked for, because a guard that decided it
 * would have to answer "denied", which is the authorization oracle §2a exists
 * to prevent.
 */
import { ALLOW, DENY, defineGuardedAction } from '../guard/index.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';

export interface ObservatoryAssignPayload extends Record<string, unknown> {
  /** The agent group the work is being handed to. */
  agentGroupId: string;
  /**
   * The item's channel key, as the ATTENTION SOURCE declared it — never a value
   * off the request body. On the payload so a denial can name the room.
   */
  channelKey: string;
  /**
   * The caller re-derived the wiring and found the target agent on this
   * channel. A fact the handler looked up, not a claim the client made.
   */
  wiredToItemChannel: boolean;
}

export const observatoryAssign = defineGuardedAction({
  action: 'observatory.assign',
  decide: (input) => {
    const actor = input.actor;
    if (actor.kind !== 'human') {
      // An agent handing work to another agent is not this surface's job — that
      // is what a2a is for, with its own guard. Nothing in the host should be
      // able to mint an assignment nobody asked for.
      return DENY('assigning a work item is an operator action');
    }
    const payload = input.payload as Partial<ObservatoryAssignPayload>;
    const agentGroupId = typeof payload.agentGroupId === 'string' ? payload.agentGroupId : '';
    if (!agentGroupId) return DENY('no target agent group');
    if (!hasAdminPrivilege(actor.userId, agentGroupId)) {
      return DENY('not an admin of the agent group this work is being handed to');
    }
    if (payload.wiredToItemChannel !== true) {
      return DENY(`that agent is not wired to ${payload.channelKey || 'the item’s channel'}`);
    }
    return ALLOW('an admin of an agent wired to the item’s own channel');
  },
});
