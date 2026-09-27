/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTableRaw('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import { AGENT_GROUP_BY_ID_SQL } from '../../db/agent-groups.js';
import { withCentralSync, withRawDb } from '../../db/central-lease.js';
import { MESSAGING_GROUP_BY_ID_SQL } from '../../db/messaging-groups.js';
import type { AgentDestination, AgentGroup, MessagingGroup } from '../../types.js';
import { log } from '../../log.js';
import type { DestinationRow } from '../mailbox/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { AGENT_DESTINATIONS_BY_GROUP_SQL } from './db/agent-destinations.js';

export async function writeDestinations(agentGroupId: string, sessionId: string): Promise<void> {
  // Resolved INSIDE the session, synchronously: this projection is
  // REPLACE-shaped, so a set resolved before a yield could reinstate a
  // destination an admin revoked in the window. Hence every read runs its leaf's
  // SQL constant through `withRawDb`, inside ONE `withCentralSync` block below.
  const resolve = (): DestinationRow[] => {
    const rows = withRawDb((raw) =>
      raw.prepare(AGENT_DESTINATIONS_BY_GROUP_SQL).all(agentGroupId),
    ) as AgentDestination[];
    const resolved: DestinationRow[] = [];

    for (const row of rows) {
      if (row.target_type === 'channel') {
        const mg = withRawDb((raw) => raw.prepare(MESSAGING_GROUP_BY_ID_SQL).get(row.target_id)) as
          | MessagingGroup
          | undefined;
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
        const ag = withRawDb((raw) => raw.prepare(AGENT_GROUP_BY_ID_SQL).get(row.target_id)) as AgentGroup | undefined;
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

  // Existing-only: a session with no mailbox has no container to serve, and
  // provisioning here would recreate a reclaimed directory. The lease is taken
  // AROUND the mailbox write so an admin's revoke cannot land between the
  // resolution and the replace.
  const count = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
    withCentralSync(() => {
      const resolved = resolve();
      mailbox.replaceDestinationRows(resolved);
      return resolved.length;
    }, 'writeDestinations'),
  );
  if (count === undefined) return;
  log.debug('Destination map written', { sessionId, count });
}
