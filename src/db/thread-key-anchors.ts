/**
 * Keyed thread anchors: an agent-named incident or topic → the platform message
 * its first post landed on. See migration 081 for the "why"; delivery.ts is the
 * only caller. Unlike `task-thread-anchors.ts` there is no rotation — a key
 * threads until it goes unused for `THREAD_KEY_RETENTION_MS`.
 */
import { getDb } from './connection.js';

/** A key unused for this long is treated as absent, and pruned on the next record. */
export const THREAD_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The accepted `threadKey` shape. The runner's `send_message`/`send_file`
 * validate with the same rule (container/agent-runner/src/mcp-tools/core.ts,
 * `parseThreadKey`); the host re-checks because a raw outbound row is
 * container-written and never trusted.
 */
export const THREAD_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ThreadKeyAnchor {
  threadPlatformId: string;
  lastUsedAt: string;
}

export interface ThreadKeyAddress {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadKey: string;
}

function retentionCutoff(nowIso: string): string {
  return new Date(Date.parse(nowIso) - THREAD_KEY_RETENTION_MS).toISOString();
}

/** The live anchor for a key, or null when none exists or it outlived the retention window. */
export async function getThreadKeyAnchor(addr: ThreadKeyAddress, nowIso: string): Promise<ThreadKeyAnchor | null> {
  const row = await getDb().get<{ thread_platform_id: string; last_used_at: string }>(
    `SELECT thread_platform_id, last_used_at FROM thread_key_anchors
      WHERE agent_group_id = ? AND channel_type = ? AND platform_id = ? AND thread_key = ?`,
    addr.agentGroupId,
    addr.channelType,
    addr.platformId,
    addr.threadKey,
  );
  if (!row) return null;
  // Expiry is decided here, not only by the prune, so whether a key still
  // threads never depends on when some other key last triggered a prune.
  if (Date.parse(row.last_used_at) < Date.parse(nowIso) - THREAD_KEY_RETENTION_MS) return null;
  return { threadPlatformId: row.thread_platform_id, lastUsedAt: row.last_used_at };
}

/**
 * Record (or replace) the root post for a key, then prune every key unused for
 * the retention window. Pruning on this write, rather than in the host sweep,
 * keeps it to the moment the table grows: a new root post is the only thing
 * that adds a row.
 */
export async function recordThreadKeyAnchor(
  addr: ThreadKeyAddress,
  threadPlatformId: string,
  nowIso: string,
): Promise<void> {
  await getDb().run(
    `INSERT INTO thread_key_anchors
       (agent_group_id, channel_type, platform_id, thread_key, thread_platform_id, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_group_id, channel_type, platform_id, thread_key) DO UPDATE SET
       thread_platform_id = excluded.thread_platform_id,
       created_at = excluded.created_at,
       last_used_at = excluded.last_used_at`,
    addr.agentGroupId,
    addr.channelType,
    addr.platformId,
    addr.threadKey,
    threadPlatformId,
    nowIso,
    nowIso,
  );
  await pruneThreadKeyAnchors(nowIso);
}

/** Mark a key used by a post that threaded under it. */
export async function touchThreadKeyAnchor(addr: ThreadKeyAddress, nowIso: string): Promise<void> {
  await getDb().run(
    `UPDATE thread_key_anchors SET last_used_at = ?
      WHERE agent_group_id = ? AND channel_type = ? AND platform_id = ? AND thread_key = ?`,
    nowIso,
    addr.agentGroupId,
    addr.channelType,
    addr.platformId,
    addr.threadKey,
  );
}

export async function pruneThreadKeyAnchors(nowIso: string): Promise<void> {
  await getDb().run(
    'DELETE FROM thread_key_anchors WHERE datetime(last_used_at) < datetime(?)',
    retentionCutoff(nowIso),
  );
}

export async function deleteThreadKeyAnchor(addr: ThreadKeyAddress): Promise<void> {
  await getDb().run(
    'DELETE FROM thread_key_anchors WHERE agent_group_id = ? AND channel_type = ? AND platform_id = ? AND thread_key = ?',
    addr.agentGroupId,
    addr.channelType,
    addr.platformId,
    addr.threadKey,
  );
}
