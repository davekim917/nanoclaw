import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';
import { updateColumnsById } from './update-columns.js';

/**
 * For `modules/agent-to-agent/write-destinations.ts`'s synchronous `resolve()`, which must not yield between this
 * read and the REPLACE-shaped projection it feeds. One constant, two executors, never a `*Sync` twin.
 */
export const AGENT_GROUP_BY_ID_SQL = 'SELECT * FROM agent_groups WHERE id = ?';

/**
 * `workgroup_id` defaults to NULL. The params are built field by field because an `AgentGroup` read with `SELECT *`
 * carries keys this statement does not name.
 */
export async function createAgentGroup(group: AgentGroup): Promise<void> {
  await getDb().run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, workgroup_id)
       VALUES (@id, @name, @folder, @agent_provider, @created_at, @workgroup_id)`,
    {
      id: group.id,
      name: group.name,
      folder: group.folder,
      agent_provider: group.agent_provider,
      created_at: group.created_at,
      workgroup_id: group.workgroup_id ?? null,
    },
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
  await updateColumnsById('agent_groups', id, updates);
}

export async function deleteAgentGroup(id: string): Promise<void> {
  await getDb().run('DELETE FROM agent_groups WHERE id = ?', id);
}

/**
 * The workgroup's shared baseline, unioned at spawn with the group's own `container.json.onecliSecrets`
 * (`mergeWorkgroupAndGroupSecrets`). [] when there is no workgroup or it declares none.
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
 * Takes the already-resolved workgroup id: joining through `agent_groups.workgroup_id` is racy under concurrent
 * reconcile.
 */
export async function getWorkgroupOnecliSecretsById(workgroupId: string): Promise<string[]> {
  const row = await getDb().get<{ secrets: string }>(
    `SELECT onecli_secrets AS secrets FROM workgroups WHERE id = ?`,
    workgroupId,
  );
  return parseSecrets(row);
}

/**
 * For `ncl integrations remove --delete-secret`, which must refuse while ANY workgroup still names the secret: the
 * merge is union-only, so no group can take back a workgroup declaration, and deleting a still-named secret aborts
 * every spawn in that workgroup.
 */
export async function getAllWorkgroupOnecliSecrets(): Promise<{ id: string; secrets: string[] }[]> {
  const rows = await getDb().all<{ id: string; secrets: string }>(
    'SELECT id, onecli_secrets AS secrets FROM workgroups',
  );
  return rows.map((row) => ({ id: row.id, secrets: parseSecrets(row) }));
}

export async function workgroupExists(workgroupId: string): Promise<boolean> {
  return (await getDb().get('SELECT 1 FROM workgroups WHERE id = ?', workgroupId)) !== undefined;
}

/** One statement, so two concurrent grants cannot drop each other's append. True when added. */
export async function addWorkgroupOnecliSecret(workgroupId: string, secretName: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE workgroups
        SET onecli_secrets = json_insert(COALESCE(onecli_secrets, '[]'), '$[#]', ?)
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(workgroups.onecli_secrets, '[]')) WHERE value = ?)`,
    secretName,
    workgroupId,
    secretName,
  );
  return result.changes > 0;
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
