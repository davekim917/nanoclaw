/**
 * Per-agent destination map + ACL.
 *
 * Each row means: agent `agent_group_id` is allowed to send messages to
 * target (`target_type`, `target_id`), and refers to it locally as `local_name`.
 *
 * Names are local to each source agent — they exist only inside that agent's
 * namespace. The host uses this table both for routing (resolve name → ID)
 * and for permission checks (row exists ⇒ authorized).
 */
/**
 * ⚠️  DESTINATION PROJECTION INVARIANT — READ BEFORE ADDING NEW CALL SITES.
 *
 * `agent_destinations` in the central DB is the source of truth, but the
 * agent-runner container reads its destinations from a per-session
 * projection in `inbound.db`. That projection is written by
 * `writeDestinations(agentGroupId, sessionId)` in session-manager.ts.
 *
 * `spawnContainer` calls `writeDestinations` on every container wake, so a
 * fresh container always sees the latest destinations. BUT: a container
 * that is ALREADY running when you mutate the central table will keep
 * serving the stale projection until its next wake — the central write
 * does not propagate automatically.
 *
 * **Therefore: every time you call `createDestination` / `deleteDestination` /
 * `deleteAllDestinationsTouching` from code that runs while an agent's
 * container may be alive, you MUST also call `writeDestinations(agentGroupId,
 * sessionId)` for each affected session.** Forgetting this manifests as
 * "dropped: unknown destination" errors at send_message time.
 *
 * Affected call sites today (keep this list honest if you add more):
 *   - src/delivery.ts::handleSystemAction case 'create_agent'
 *   - src/db/messaging-groups.ts::createMessagingGroupAgent
 *   - src/cli/resources/destinations.ts::add / remove (admin-time `ncl destinations`
 *     — iterates over `getSessionsByAgentGroup(agentGroupId)`)
 */
import type { AgentDestination } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { deletePoliciesTouching, removeMessagePolicy } from './agent-message-policies.js';

/**
 * ⚠️  Caller responsibility: after this returns, call
 * `writeDestinations(row.agent_group_id, <sessionId>)` for each active
 * session of that agent group so the change propagates to the running
 * container's inbound.db. See the top-of-file invariant.
 */
export async function createDestination(row: AgentDestination): Promise<void> {
  await getDb().run(
    `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (@agent_group_id, @local_name, @target_type, @target_id, @created_at)`,
    row,
  );
}

/**
 * The `getDestinations` read as a constant, so the one synchronous caller —
 * `write-destinations.ts`'s `resolve()`, which runs inside the central lease
 * immediately before a REPLACE-shaped mailbox write — executes the SAME
 * statement through `withRawDb`. One constant, two executors, not a `*Sync`
 * twin (plan docs/specs/upstream-async-central-db-seam/plan.md §4.5 I-1).
 */
export const AGENT_DESTINATIONS_BY_GROUP_SQL = 'SELECT * FROM agent_destinations WHERE agent_group_id = ?';

export async function getDestinations(agentGroupId: string): Promise<AgentDestination[]> {
  return getDb().all<AgentDestination>(AGENT_DESTINATIONS_BY_GROUP_SQL, agentGroupId);
}

export async function getDestinationByName(
  agentGroupId: string,
  localName: string,
): Promise<AgentDestination | undefined> {
  return getDb().get<AgentDestination>(
    'SELECT * FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?',
    agentGroupId,
    localName,
  );
}

/** Reverse lookup: what does this agent call the given target? */
export async function getDestinationByTarget(
  agentGroupId: string,
  targetType: 'channel' | 'agent',
  targetId: string,
): Promise<AgentDestination | undefined> {
  return getDb().get<AgentDestination>(
    'SELECT * FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ?',
    agentGroupId,
    targetType,
    targetId,
  );
}

/**
 * The destination-exists read as a constant: the `a2a.send` guard
 * (`../guard.ts`) is synchronous by design (§4.5 I-1) and executes this
 * statement through `withRawDb` inside its caller's lease block.
 */
export const AGENT_DESTINATION_EXISTS_SQL =
  'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1';

/**
 * ⚠️  Caller responsibility: after this returns, call
 * `writeDestinations(agentGroupId, <sessionId>)` for each active session
 * so the deletion propagates to the running container's inbound.db.
 */
export async function deleteDestination(agentGroupId: string, localName: string): Promise<void> {
  const db = getDb();
  // Resolve the target first so we can drop a matching policy for this edge (no ghost gate on re-wire).
  const row = await db.get<{ target_type: string; target_id: string }>(
    'SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?',
    agentGroupId,
    localName,
  );
  await db.run('DELETE FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?', agentGroupId, localName);
  if (row?.target_type === 'agent') {
    await removeMessagePolicy(agentGroupId, row.target_id);
  }
}

/**
 * Delete every destination row where this agent group is either the owner
 * or the target. Used when tearing down a dev agent after a swap request
 * completes/rolls-back — drops the bidirectional destinations in one call.
 *
 * ⚠️  Caller responsibility: not only does `agentGroupId`'s own session
 * projection need a refresh, but ALSO every OTHER agent group that had
 * `agentGroupId` as a destination target. Find them BEFORE calling this
 * (the rows are gone afterwards).
 */
export async function deleteAllDestinationsTouching(agentGroupId: string): Promise<void> {
  await getDb().run(
    'DELETE FROM agent_destinations WHERE agent_group_id = ? OR (target_type = ? AND target_id = ?)',
    agentGroupId,
    'agent',
    agentGroupId,
  );
  await deletePoliciesTouching(agentGroupId);
}

/** Normalize a human-readable name into a lowercase, dash-separated identifier. */
export function normalizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}
