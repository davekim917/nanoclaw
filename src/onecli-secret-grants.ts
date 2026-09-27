import { getAgentGroup } from './db/agent-groups.js';
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
