/** Per-message approval policies for agent-to-agent connections; no row = free flow. */
import type { AgentMessagePolicy } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

/**
 * The `getMessagePolicy` read as a constant: the `a2a.send` guard
 * (`../guard.ts`) is synchronous by design (seam 3 §4.5 I-1) and executes this
 * statement through `withRawDb` inside its caller's lease block.
 */
export const AGENT_MESSAGE_POLICY_BY_PAIR_SQL =
  'SELECT * FROM agent_message_policies WHERE from_agent_group_id = ? AND to_agent_group_id = ?';

export async function getMessagePolicy(
  fromAgentGroupId: string,
  toAgentGroupId: string,
): Promise<AgentMessagePolicy | undefined> {
  return getDb().get<AgentMessagePolicy>(AGENT_MESSAGE_POLICY_BY_PAIR_SQL, fromAgentGroupId, toAgentGroupId);
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
