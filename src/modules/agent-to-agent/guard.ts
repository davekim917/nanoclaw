/**
 * Agent-to-agent guard adapter — the module's catalog entries, composed at
 * the module edge (imported by ./index.ts).
 *
 * agents.create — the cli_scope branch moved verbatim out of
 * create-agent.ts: `global` scope creates directly (create_agent is the
 * intended primitive for trusted owner agent groups); anything else — the
 * default `group` scope, and unknown/missing config, fail-closed — holds for
 * the requesting group's admin chain.
 *
 * a2a.send — the decision moved verbatim out of routeAgentMessage, in its
 * original check order: a missing destination row denies; a missing target
 * group denies; self-sends allow without a destination row; an
 * agent_message_policies row for the (from, to) pair holds for the row's
 * named approver. The ghost-policy edge (policy row with no destination row)
 * denies — the destination check precedes the policy check, exactly today's
 * outcome. Policy rows can only tighten (hold), never allow: absence of a
 * row falls through to the structural checks.
 */
import { AGENT_GROUP_BY_ID_SQL } from '../../db/agent-groups.js';
import { getRawDb } from '../../db/connection.js';
import { CONTAINER_CONFIG_BY_GROUP_SQL } from '../../db/container-configs.js';
import { ALLOW, DENY, HOLD, defineGuardedAction } from '../../guard/index.js';
import { hasDestination } from './db/agent-destinations.js';
import { getMessagePolicy } from './db/agent-message-policies.js';

/**
 * pending_approvals action string for held a2a messages. Lives here (not in
 * agent-route.ts) so agent-route can import this adapter — loading the
 * consult site guarantees its catalog entry is registered — without a cycle.
 */
export const A2A_MESSAGE_GATE_ACTION = 'a2a_message_gate';

export const agentsCreate = defineGuardedAction({
  action: 'agents.create',
  grantActionName: 'create_agent',
  // Bind a create_agent grant to the name that was approved.
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { name?: string }).name === input.payload.name;
    } catch {
      return false;
    }
  },
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('create_agent is a container-originated action.');
    const cliScope = cliScopeOf(input.actor.agentGroupId);
    if (cliScope === 'global') {
      // Trusted owner agent group — an approval tap on every sub-agent spawn
      // would be needless friction.
      return ALLOW('trusted global-scope agent group');
    }
    // The realistic prompt-injection victim (default `group` scope) — and any
    // unknown config value, fail-closed — requires an admin before any
    // central-DB write.
    return HOLD('agent-initiated create_agent requires admin approval');
  },
});

export const a2aSend = defineGuardedAction({
  action: 'a2a.send',
  grantActionName: A2A_MESSAGE_GATE_ACTION,
  // Bind an a2a grant to the exact held message target.
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { platform_id?: string }).platform_id === input.resource?.to;
    } catch {
      return false;
    }
  },
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('agent-to-agent send requires an agent actor');
    const from = input.actor.agentGroupId;
    const to = input.resource?.to ?? '';
    const isSelf = to === from;
    if (!isSelf && !hasDestination(from, 'agent', to)) {
      return DENY(`unauthorized agent-to-agent: ${from} has no destination for ${to}`);
    }
    if (getRawDb().prepare(AGENT_GROUP_BY_ID_SQL).get(to) === undefined) {
      return DENY(`target agent group ${to} not found for message ${String(input.payload.id)}`);
    }
    if (isSelf) return ALLOW('self-send');
    const policy = getMessagePolicy(from, to);
    if (policy) {
      return HOLD(`a2a message policy ${from}→${to} holds for ${policy.approver}`, policy.approver);
    }
    return ALLOW('destination grant exists');
  },
});

// Synchronous by design (seam-3 plan §4.5, I-1): this decision runs inside
// callers' guard-adjacent blocks — `guard(a2aSend)` inside the agent-route
// WriteGuard, `guard(threadsClose)` inside thread-close's one synchronous
// decision — so it never awaits. Its central reads use the leaf's exported SQL
// on the raw handle; PR 6 wraps them in `withRawDb` inside `withCentralSync`.
function cliScopeOf(agentGroupId: string): string {
  const row = getRawDb().prepare(CONTAINER_CONFIG_BY_GROUP_SQL).get(agentGroupId) as
    | { cli_scope: string | null }
    | undefined;
  return row?.cli_scope ?? 'group';
}
