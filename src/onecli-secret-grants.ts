import { getAgentGroup, getAllAgentGroups, getAllWorkgroupOnecliSecrets } from './db/agent-groups.js';
import { readContainerConfig, updateContainerConfig } from './container-config.js';

export async function declareGroupSecret(agentGroupId: string, secretName: string): Promise<boolean> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return false;
  // `updateContainerConfig` rewrites the file under a lock even when nothing changes; the OAuth refresh calls this.
  if ((readContainerConfig(group.folder).onecliSecrets ?? []).includes(secretName)) return false;
  let added = false;
  await updateContainerConfig(group.folder, (config) => {
    const current = config.onecliSecrets ?? [];
    if (current.includes(secretName)) return;
    config.onecliSecrets = [...current, secretName];
    added = true;
  });
  return added;
}

export interface SecretDeclarations {
  workgroups: { id: string; declared: string }[];
  groups: { id: string; folder: string; workgroupId: string | null; declared: string }[];
}

/** Reads group files as the spawn does, so it never refuses on a declaration the spawn cannot see. */
export async function findSecretDeclarations(spellings: string[]): Promise<SecretDeclarations> {
  const wanted = new Set(spellings);
  const found: SecretDeclarations = { workgroups: [], groups: [] };
  for (const workgroup of await getAllWorkgroupOnecliSecrets()) {
    for (const declared of workgroup.secrets) {
      if (wanted.has(declared)) found.workgroups.push({ id: workgroup.id, declared });
    }
  }
  for (const group of await getAllAgentGroups()) {
    for (const declared of readContainerConfig(group.folder).onecliSecrets ?? []) {
      if (wanted.has(declared)) {
        found.groups.push({ id: group.id, folder: group.folder, workgroupId: group.workgroup_id ?? null, declared });
      }
    }
  }
  return found;
}
