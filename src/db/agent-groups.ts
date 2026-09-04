import type { AgentGroup } from '../types.js';
import { getRawDb } from './connection.js';

export function createAgentGroup(group: AgentGroup): void {
  getRawDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (@id, @name, @folder, @agent_provider, @created_at)`,
    )
    .run(group);
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return getRawDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return getRawDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  return getRawDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
}

export function updateAgentGroup(id: string, updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>>): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getRawDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteAgentGroup(id: string): void {
  getRawDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}

/**
 * The OneCLI secret declarations on the workgroup this agent group belongs
 * to. These are the shared baseline every sibling inherits at spawn — the
 * host merges them (union) with the per-group `container.json.onecliSecrets`
 * before calling `applyOnecliSecrets`. Returns [] if the group has no
 * workgroup or the workgroup declares none. See `mergeWorkgroupAndGroupSecrets`.
 */
export function getWorkgroupOnecliSecrets(agentGroupId: string): string[] {
  const row = getRawDb()
    .prepare(
      `SELECT w.onecli_secrets AS secrets FROM workgroups w
       JOIN agent_groups a ON a.workgroup_id = w.id
       WHERE a.id = ?`,
    )
    .get(agentGroupId) as { secrets: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.secrets) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Workgroup-keyed variant for spawnContainer's hot path. Joins on
 * `agent_groups.workgroup_id` are racey under concurrent reconcile, so this
 * variant takes the already-resolved workgroup id and queries the workgroups
 * row directly. Returns [] if no such workgroup exists.
 */
export function getWorkgroupOnecliSecretsById(workgroupId: string): string[] {
  const row = getRawDb().prepare(`SELECT onecli_secrets AS secrets FROM workgroups WHERE id = ?`).get(workgroupId) as
    | { secrets: string }
    | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.secrets) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
