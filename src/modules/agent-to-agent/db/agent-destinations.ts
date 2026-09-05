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
import { getDb, getRawDb } from '../../../db/connection.js';
import { deletePoliciesTouching, removeMessagePolicy } from './agent-message-policies.js';

/**
 * ⚠️  Caller responsibility: after this returns, call
 * `writeDestinations(row.agent_group_id, <sessionId>)` for each active
 * session of that agent group so the change propagates to the running
 * container's inbound.db. See the top-of-file invariant.
 */
/*
 * Seam 3: `createDestination`, `getDestinationByName` and
 * `getDestinationByTarget` stay SYNCHRONOUS with no async form —
 * `db/messaging-groups.ts`'s `ensureAgentDestinationForWiring` calls all
 * three from inside `cli/resources/wirings.ts`'s pinned raw transaction
 * closure, and `getDestinations` is read inside write-destinations' mailbox
 * action. Plan §4.2/§4.5; they convert in PR 6 with their closure.
 */
export function createDestination(row: AgentDestination): void {
  getRawDb()
    .prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (@agent_group_id, @local_name, @target_type, @target_id, @created_at)`,
    )
    .run(row);
}

export const AGENT_DESTINATIONS_BY_GROUP_SQL = 'SELECT * FROM agent_destinations WHERE agent_group_id = ?';

/**
 * Synchronous by design (seam-3 plan §4.5, I-1): `write-destinations.ts`
 * resolves this map INSIDE the mailbox action, immediately before a
 * REPLACE-shaped `replaceDestinationRows`, so a yield between the read and the
 * write could reinstate a destination an admin revoked. Same rule as §4.2's
 * transaction-reachable leaf exports — one form, not a `*Sync` twin. PR 6 wraps
 * the block in `withCentralSync`/`withRawDb`.
 */
export function getDestinations(agentGroupId: string): AgentDestination[] {
  return getRawDb().prepare(AGENT_DESTINATIONS_BY_GROUP_SQL).all(agentGroupId) as AgentDestination[];
}

export function getDestinationByName(agentGroupId: string, localName: string): AgentDestination | undefined {
  return getRawDb()
    .prepare('SELECT * FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?')
    .get(agentGroupId, localName) as AgentDestination | undefined;
}

/** Reverse lookup: what does this agent call the given target? */
export function getDestinationByTarget(
  agentGroupId: string,
  targetType: 'channel' | 'agent',
  targetId: string,
): AgentDestination | undefined {
  return getRawDb()
    .prepare('SELECT * FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ?')
    .get(agentGroupId, targetType, targetId) as AgentDestination | undefined;
}

export const AGENT_DESTINATION_EXISTS_SQL =
  'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1';

/**
 * Permission check: can this agent send to this target?
 *
 * Synchronous by design (seam-3 plan §4.5, I-1): the `a2a.send` guard in
 * `../guard.ts` calls it from inside its `decide` body, which never awaits.
 */
export function hasDestination(agentGroupId: string, targetType: 'channel' | 'agent', targetId: string): boolean {
  return getRawDb().prepare(AGENT_DESTINATION_EXISTS_SQL).get(agentGroupId, targetType, targetId) !== undefined;
}

/**
 * ⚠️  Caller responsibility: after this returns, call
 * `writeDestinations(agentGroupId, <sessionId>)` for each active session
 * so the deletion propagates to the running container's inbound.db.
 */
export async function deleteDestination(agentGroupId: string, localName: string): Promise<void> {
  // Resolve the target first so we can drop a matching policy for this edge (no ghost gate on re-wire).
  const row = await getDb().get<{ target_type: string; target_id: string }>(
    'SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?',
    agentGroupId,
    localName,
  );
  await getDb().run(
    'DELETE FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?',
    agentGroupId,
    localName,
  );
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
 * `agentGroupId` as a destination target. Use `getDestinationReferencers`
 * below to find them BEFORE calling this (the rows are gone afterwards).
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

/**
 * Return the list of agent_group_ids that currently have a destination
 * row pointing at `targetAgentGroupId`. Call this BEFORE
 * `deleteAllDestinationsTouching` if you need to know whose session
 * projections to refresh after the delete — the rows are gone once the
 * delete runs.
 */
export async function getDestinationReferencers(targetAgentGroupId: string): Promise<string[]> {
  const rows = await getDb().all<{ agent_group_id: string }>(
    "SELECT DISTINCT agent_group_id FROM agent_destinations WHERE target_type = 'agent' AND target_id = ? AND agent_group_id != ?",
    targetAgentGroupId,
    targetAgentGroupId,
  );
  return rows.map((r) => r.agent_group_id);
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
