import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

/**
 * The `getAgentGroup` read, as a constant, so a synchronous guard-path caller
 * can execute the SAME statement through the raw handle.
 *
 * One constant, two executors — NOT a `*Sync` twin of the export
 * (docs/specs/upstream-async-central-db-seam/plan.md §4.5 I-1). The only such
 * caller is `modules/agent-to-agent/write-destinations.ts`, whose `resolve()`
 * must not yield between the read and the REPLACE-shaped projection it feeds.
 */
export const AGENT_GROUP_BY_ID_SQL = 'SELECT * FROM agent_groups WHERE id = ?';

export async function createAgentGroup(group: AgentGroup): Promise<void> {
  await getDb().run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (@id, @name, @folder, @agent_provider, @created_at)`,
    group,
  );
}

export async function getAgentGroup(id: string): Promise<AgentGroup | undefined> {
  return getDb().get<AgentGroup>(AGENT_GROUP_BY_ID_SQL, id);
}

export async function getAgentGroupByFolder(folder: string): Promise<AgentGroup | undefined> {
  return getDb().get<AgentGroup>('SELECT * FROM agent_groups WHERE folder = ?', folder);
}

export async function getAllAgentGroups(): Promise<AgentGroup[]> {
  return getDb().all<AgentGroup>('SELECT * FROM agent_groups ORDER BY name');
}

export async function updateAgentGroup(
  id: string,
  updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  await getDb().run(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`, values);
}

export async function deleteAgentGroup(id: string): Promise<void> {
  await getDb().run('DELETE FROM agent_groups WHERE id = ?', id);
}

/**
 * The OneCLI secret declarations on the workgroup this agent group belongs
 * to. These are the shared baseline every sibling inherits at spawn — the
 * host merges them (union) with the per-group `container.json.onecliSecrets`
 * before calling `applyOnecliSecrets`. Returns [] if the group has no
 * workgroup or the workgroup declares none. See `mergeWorkgroupAndGroupSecrets`.
 */
export async function getWorkgroupOnecliSecrets(agentGroupId: string): Promise<string[]> {
  const row = await getDb().get<{ secrets: string }>(
    `SELECT w.onecli_secrets AS secrets FROM workgroups w
       JOIN agent_groups a ON a.workgroup_id = w.id
       WHERE a.id = ?`,
    agentGroupId,
  );
  return parseSecrets(row);
}

/**
 * Workgroup-keyed variant for spawnContainer's hot path. Joins on
 * `agent_groups.workgroup_id` are racey under concurrent reconcile, so this
 * variant takes the already-resolved workgroup id and queries the workgroups
 * row directly. Returns [] if no such workgroup exists.
 */
export async function getWorkgroupOnecliSecretsById(workgroupId: string): Promise<string[]> {
  const row = await getDb().get<{ secrets: string }>(
    `SELECT onecli_secrets AS secrets FROM workgroups WHERE id = ?`,
    workgroupId,
  );
  return parseSecrets(row);
}

function parseSecrets(row: { secrets: string } | undefined): string[] {
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.secrets) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
