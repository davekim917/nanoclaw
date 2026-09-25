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
import type { AgentMessagePolicy } from '../../types.js';
import { AGENT_GROUP_BY_ID_SQL } from '../../db/agent-groups.js';
import { withRawDb } from '../../db/central-lease.js';
import { CONTAINER_CONFIG_BY_GROUP_SQL } from '../../db/container-configs.js';
import { ALLOW, DENY, HOLD, defineGuardedAction } from '../../guard/index.js';
import { AGENT_DESTINATION_EXISTS_SQL } from './db/agent-destinations.js';
import { AGENT_MESSAGE_POLICY_BY_PAIR_SQL } from './db/agent-message-policies.js';

/**
 * pending_approvals action string for held a2a messages. Lives here (not in
 * agent-route.ts) so agent-route can import this adapter — loading the
 * consult site guarantees its catalog entry is registered — without a cycle.
 */
export const A2A_MESSAGE_GATE_ACTION = 'a2a_message_gate';

// A catalog entry only: nothing consults it, but defining it registers `agents.create`.
defineGuardedAction({
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
    // Synchronous by design (seam-3 plan §4.5, I-1): this decide runs inside
    // the agent-route WriteGuard — itself inside `writeSessionMessage`'s
    // `withCentralSync` block, with nothing awaited between it and the insert
    // — so it never awaits. Its central reads execute the leaves' exported
    // SQL constants through `withRawDb`, not the leaves' async exports.
    if (!isSelf && withRawDb((raw) => raw.prepare(AGENT_DESTINATION_EXISTS_SQL).get(from, 'agent', to)) === undefined) {
      return DENY(`unauthorized agent-to-agent: ${from} has no destination for ${to}`);
    }
    if (withRawDb((raw) => raw.prepare(AGENT_GROUP_BY_ID_SQL).get(to)) === undefined) {
      return DENY(`target agent group ${to} not found for message ${String(input.payload.id)}`);
    }
    if (isSelf) return ALLOW('self-send');
    const policy = withRawDb((raw) => raw.prepare(AGENT_MESSAGE_POLICY_BY_PAIR_SQL).get(from, to)) as
      | AgentMessagePolicy
      | undefined;
    if (policy) {
      return HOLD(`a2a message policy ${from}→${to} holds for ${policy.approver}`, policy.approver);
    }
    return ALLOW('destination grant exists');
  },
});

// Synchronous by design (seam-3 plan §4.5, I-1): runs inside the consult
// site's `withCentralSync` block and never awaits. The central read executes
// the leaf's exported SQL through `withRawDb`.
function cliScopeOf(agentGroupId: string): string {
  const row = withRawDb((raw) => raw.prepare(CONTAINER_CONFIG_BY_GROUP_SQL).get(agentGroupId)) as
    | { cli_scope: string | null }
    | undefined;
  return row?.cli_scope ?? 'group';
}
