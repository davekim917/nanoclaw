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
  // Resolved INSIDE the session, not before it. `getDestinations` and the
  // `getMessagingGroup`/`getAgentGroup` lookups it feeds read the central DB;
  // the funnel below yields between that read and `replaceDestinationRows`,
  // and this projection is REPLACE-shaped — it overwrites the whole map. A set
  // resolved before the yield can therefore reinstate a destination an admin
  // revoked in the window, which is the one direction that matters here: the
  // container resolves names against this table to decide where it may send.
  // All three lookups are synchronous, so there is no yield left between the
  // resolution and the write.
  //
  // Seam 3 §4.5 I-1: that is why every read below executes its leaf's
  // exported SQL constant (`AGENT_DESTINATIONS_BY_GROUP_SQL`,
  // `MESSAGING_GROUP_BY_ID_SQL`, `AGENT_GROUP_BY_ID_SQL`) through `withRawDb`
  // rather than calling the leaves' async exports — one constant, two
  // executors, not a `*Sync` twin (plan
  // docs/specs/upstream-async-central-db-seam/plan.md §4.5). The whole
  // resolve-then-replace pair runs inside ONE `withCentralSync` block below,
  // so no driver transaction can be open while these raw reads execute.
  const resolve = (): DestinationRow[] => {
    const rows = withRawDb((raw) => raw.prepare(AGENT_DESTINATIONS_BY_GROUP_SQL).all(agentGroupId)) as AgentDestination[];
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

  // Existing-only: the projection is refreshed on every wake and after admin
  // edits, and a session with no mailbox has no container to resolve names
  // for. Provisioning here would recreate a reclaimed directory (I-10); the
  // old code expressed the same rule as an existsSync on inbound.db.
  // The lease is taken AROUND the mailbox write, not inside it: the
  // resolution and the replace are one synchronous block under
  // `withCentralSync`, so an admin's revoke cannot land between them
  // (plan §4.1, "sites that evaluate ... inside a synchronous mailbox action
  // take the lease around the mailbox action").
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
