/**
 * Keyed thread anchors: an agent-named incident or topic → the platform message its first post landed on (migration
 * 081). No rotation, unlike `task-thread-anchors.ts`: a key threads until unused for `THREAD_KEY_RETENTION_MS`.
 */
import { getDb } from './connection.js';

const THREAD_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Must match the runner's `parseThreadKey` (container/agent-runner/src/mcp-tools/core.ts); the host re-checks because
 * an outbound row is container-written and never trusted.
 */
export const THREAD_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ThreadKeyAnchor {
  threadPlatformId: string;
  lastUsedAt: string;
}

export interface ThreadKeyAddress {
  agentGroupId: string;
  /** Channel, address AND adapter instance. */
  messagingGroupId: string;
  threadKey: string;
}

function retentionCutoff(nowIso: string): string {
  return new Date(Date.parse(nowIso) - THREAD_KEY_RETENTION_MS).toISOString();
}

/** Null when none exists or it outlived the retention window. */
export async function getThreadKeyAnchor(addr: ThreadKeyAddress, nowIso: string): Promise<ThreadKeyAnchor | null> {
  const row = await getDb().get<{ thread_platform_id: string; last_used_at: string }>(
    `SELECT thread_platform_id, last_used_at FROM thread_key_anchors
      WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_key = ?`,
    addr.agentGroupId,
    addr.messagingGroupId,
    addr.threadKey,
  );
  if (!row) return null;
  // Expiry is decided here, not only by the prune, so whether a key threads never depends on when another key last
  // pruned.
  if (Date.parse(row.last_used_at) < Date.parse(nowIso) - THREAD_KEY_RETENTION_MS) return null;
  return { threadPlatformId: row.thread_platform_id, lastUsedAt: row.last_used_at };
}

/** Records or replaces a key's root post, then prunes stale keys: a new root post is the only thing that adds a row. */
export async function recordThreadKeyAnchor(
  addr: ThreadKeyAddress,
  threadPlatformId: string,
  nowIso: string,
): Promise<void> {
  await getDb().run(
    `INSERT INTO thread_key_anchors
       (agent_group_id, messaging_group_id, thread_key, thread_platform_id, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_group_id, messaging_group_id, thread_key) DO UPDATE SET
       thread_platform_id = excluded.thread_platform_id,
       created_at = excluded.created_at,
       last_used_at = excluded.last_used_at`,
    addr.agentGroupId,
    addr.messagingGroupId,
    addr.threadKey,
    threadPlatformId,
    nowIso,
    nowIso,
  );
  await pruneThreadKeyAnchors(nowIso);
}

export async function touchThreadKeyAnchor(addr: ThreadKeyAddress, nowIso: string): Promise<void> {
  await getDb().run(
    `UPDATE thread_key_anchors SET last_used_at = ?
      WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_key = ?`,
    nowIso,
    addr.agentGroupId,
    addr.messagingGroupId,
    addr.threadKey,
  );
}

async function pruneThreadKeyAnchors(nowIso: string): Promise<void> {
  await getDb().run(
    'DELETE FROM thread_key_anchors WHERE datetime(last_used_at) < datetime(?)',
    retentionCutoff(nowIso),
  );
}

export async function deleteThreadKeyAnchor(addr: ThreadKeyAddress): Promise<void> {
  await getDb().run(
    'DELETE FROM thread_key_anchors WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_key = ?',
    addr.agentGroupId,
    addr.messagingGroupId,
    addr.threadKey,
  );
}
