import { getDb } from '../../../db/connection.js';

export interface CapabilityConfig {
  concurrencyCap: number;
  noProgressTimeoutSec: number;
  spawnDeadlineSec: number;
  drainGraceSec: number;
  targetDenylist?: string[];
}

export async function hasOrchestratorCapability(agentGroupId: string): Promise<boolean> {
  const row = await getDb().get(
    `SELECT 1 FROM agent_group_capabilities WHERE agent_group_id = ? AND role = 'orchestrator' LIMIT 1`,
    agentGroupId,
  );
  return row !== undefined;
}

export async function grantCapability(
  agentGroupId: string,
  role: 'orchestrator',
  config: CapabilityConfig,
  grantedBy: string,
): Promise<void> {
  const configJson = JSON.stringify(config);
  const grantedAt = new Date().toISOString();
  await getDb().run(
    `INSERT INTO agent_group_capabilities (agent_group_id, role, config_json, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_group_id, role) DO UPDATE SET
         config_json = excluded.config_json,
         granted_by  = excluded.granted_by,
         granted_at  = excluded.granted_at`,
    agentGroupId,
    role,
    configJson,
    grantedBy,
    grantedAt,
  );
}

export async function revokeCapability(
  agentGroupId: string,
  role: 'orchestrator',
): Promise<{ success: boolean; reason?: string }> {
  const inFlight = await getDb().get(
    `SELECT 1 FROM tasks
        WHERE parent_agent_group_id = ? AND status IN ('pending', 'running')
        LIMIT 1`,
    agentGroupId,
  );

  if (inFlight !== undefined) {
    return { success: false, reason: 'tasks_in_flight' };
  }

  await getDb().run(`DELETE FROM agent_group_capabilities WHERE agent_group_id = ? AND role = ?`, agentGroupId, role);

  return { success: true };
}

export async function getCapabilityConfig(agentGroupId: string, role: string): Promise<CapabilityConfig | null> {
  const row = await getDb().get<{ config_json: string | null }>(
    `SELECT config_json FROM agent_group_capabilities WHERE agent_group_id = ? AND role = ?`,
    agentGroupId,
    role,
  );

  if (!row) return null;
  if (!row.config_json) return null;

  return JSON.parse(row.config_json) as CapabilityConfig;
}
