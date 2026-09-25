/** Shared by the single-process agent bootstrap scripts (init-cli-agent, init-first-agent). */
import { createAgentGroup, getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import type { AgentGroup } from '../../src/types.js';

export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The agent group living in `folder`, created with `name` if none does yet. */
export async function findOrCreateAgentGroup(folder: string, name: string, now: string): Promise<AgentGroup> {
  let ag: AgentGroup | undefined = await getAgentGroupByFolder(folder);
  if (!ag) {
    const agId = generateId('ag');
    await createAgentGroup({
      id: agId,
      name,
      folder,
      agent_provider: null,
      created_at: now,
    });
    ag = (await getAgentGroupByFolder(folder))!;
    console.log(`Created agent group: ${ag.id} (${folder})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${folder})`);
  }
  return ag;
}
