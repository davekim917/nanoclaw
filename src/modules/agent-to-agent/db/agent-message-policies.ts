/** Per-message approval policies for agent-to-agent connections; no row = free flow. */
import type { AgentMessagePolicy } from '../../../types.js';
import { getDb, getRawDb } from '../../../db/connection.js';

export const AGENT_MESSAGE_POLICY_BY_PAIR_SQL =
  'SELECT * FROM agent_message_policies WHERE from_agent_group_id = ? AND to_agent_group_id = ?';

/**
 * Synchronous by design (seam-3 plan §4.5, I-1): the `a2a.send` guard in
 * `../guard.ts` consults the policy inside its `decide` body, which never
 * awaits. One form, not a `*Sync` twin; PR 6 moves it inside `withRawDb`.
 */
export function getMessagePolicy(fromAgentGroupId: string, toAgentGroupId: string): AgentMessagePolicy | undefined {
  return getRawDb().prepare(AGENT_MESSAGE_POLICY_BY_PAIR_SQL).get(fromAgentGroupId, toAgentGroupId) as
    | AgentMessagePolicy
    | undefined;
}

export async function setMessagePolicy(
  fromAgentGroupId: string,
  toAgentGroupId: string,
  approver: string,
  createdAt: string,
): Promise<void> {
  await getDb().run(
    `INSERT INTO agent_message_policies (from_agent_group_id, to_agent_group_id, approver, created_at)
       VALUES (@from_agent_group_id, @to_agent_group_id, @approver, @created_at)
       ON CONFLICT (from_agent_group_id, to_agent_group_id) DO UPDATE SET approver = excluded.approver`,
    { from_agent_group_id: fromAgentGroupId, to_agent_group_id: toAgentGroupId, approver, created_at: createdAt },
  );
}

export async function removeMessagePolicy(fromAgentGroupId: string, toAgentGroupId: string): Promise<boolean> {
  const info = await getDb().run(
    'DELETE FROM agent_message_policies WHERE from_agent_group_id = ? AND to_agent_group_id = ?',
    fromAgentGroupId,
    toAgentGroupId,
  );
  return info.changes > 0;
}

/** Delete every policy touching this agent group, so none outlives its connection. */
export async function deletePoliciesTouching(agentGroupId: string): Promise<void> {
  await getDb().run(
    'DELETE FROM agent_message_policies WHERE from_agent_group_id = ? OR to_agent_group_id = ?',
    agentGroupId,
    agentGroupId,
  );
}
