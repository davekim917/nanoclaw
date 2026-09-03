/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { DestinationRow } from '../mailbox/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

export async function writeDestinations(agentGroupId: string, sessionId: string): Promise<void> {
  // Resolved INSIDE the session, not before it. `getDestinations` and the
  // `getMessagingGroup`/`getAgentGroup` lookups it feeds read the central DB;
  // the funnel below yields between that read and `replaceDestinationRows`,
  // and this projection is REPLACE-shaped — it overwrites the whole map. A set
  // resolved before the yield can therefore reinstate a destination an admin
  // revoked in the window, which is the one direction that matters here: the
  // container resolves names against this table to decide where it may send.
  // All three lookups are synchronous, so there is no yield left between the
  // resolution and the write.
  const resolve = (): DestinationRow[] => {
    const rows = getDestinations(agentGroupId);
    const resolved: DestinationRow[] = [];

    for (const row of rows) {
      if (row.target_type === 'channel') {
        const mg = getMessagingGroup(row.target_id);
        if (!mg) continue;
        resolved.push({
          name: row.local_name,
          display_name: mg.name ?? row.local_name,
          type: 'channel',
          channel_type: mg.channel_type,
          platform_id: mg.platform_id,
          agent_group_id: null,
        });
      } else if (row.target_type === 'agent') {
        const ag = getAgentGroup(row.target_id);
        if (!ag) continue;
        resolved.push({
          name: row.local_name,
          display_name: ag.name,
          type: 'agent',
          channel_type: null,
          platform_id: null,
          agent_group_id: ag.id,
        });
      }
    }
    return resolved;
  };

  // Existing-only: the projection is refreshed on every wake and after admin
  // edits, and a session with no mailbox has no container to resolve names
  // for. Provisioning here would recreate a reclaimed directory (I-10); the
  // old code expressed the same rule as an existsSync on inbound.db.
  const count = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => {
    const resolved = resolve();
    mailbox.replaceDestinationRows(resolved);
    return resolved.length;
  });
  if (count === undefined) return;
  log.debug('Destination map written', { sessionId, count });
}
