/**
 * Guard catalog entry for `observatory.assign`: a press becomes a one-shot task, a container boot, and an agent
 * talking in a room, so it passes the same seam as other privileged acts.
 * Allow/deny only, no `grantActionName`: a HOLD would turn queue triage into an approval card to chase.
 * Both rules live in `decide` so no later caller brings a looser copy: (1) admin privilege over the target group
 * (`hasAdminPrivilege`, identical to `canAssign`'s allow condition); (2) the target agent is wired to the item's own
 * channel, which the handler re-derives and the guard enforces.
 * Scope is deliberately NOT here: an out-of-scope group must be indistinguishable from a missing one, and a guard can
 * only answer "denied".
 */
import { ALLOW, DENY, defineGuardedAction } from '../guard/index.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';

export interface ObservatoryAssignPayload extends Record<string, unknown> {
  agentGroupId: string;
  /** As the attention source declared it, never from the request body. */
  channelKey: string;
  /** Looked up by the handler, never claimed by the client. */
  wiredToItemChannel: boolean;
}

export const observatoryAssign = defineGuardedAction({
  action: 'observatory.assign',
  decide: (input) => {
    const actor = input.actor;
    if (actor.kind !== 'human') {
      // Agent-to-agent handoff is a2a's job, with its own guard.
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
