/**
 * Accessors for ship_log, backlog_items, and commit_digest_state tables.
 *
 * ship_log: one row per shipped feature/change. Written by add_ship_log
 * (MCP tool) and scan_commits (commit digest).
 *
 * backlog_items: one row per open/resolved issue. Written by the backlog
 * MCP tools.
 *
 * commit_digest_state: tracks the last-scanned SHA per repo so scan_commits
 * only picks up new commits on each run.
 *
 * Seam 3 PR 5d: every export runs on the async driver. Each is a single
 * statement, so no caller needs `centralTransaction` — the lease exists to
 * keep a SYNCHRONOUS block out of an open driver transaction, and there is no
 * synchronous block left here (plan §4.1, §4.4).
 */
import { getDb } from './connection.js';

// ---- Types ----

export interface ShipLogEntry {
  id: string;
  agent_group_id: string;
  title: string;
  description: string | null;
  pr_url: string | null;
  branch: string | null;
  tags: string | null;
  shipped_at: string;
}

export interface BacklogItem {
  id: string;
  agent_group_id: string;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'resolved' | 'wont_fix';
  priority: 'low' | 'medium' | 'high';
  tags: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  /** External tracker URL, present for ephemeral GitHub Issues digest rows. */
  url?: string;
}

export interface CommitDigestState {
  repo_path: string;
  agent_group_id: string;
  last_commit_sha: string;
  last_scan: string;
}

// ---- ship_log ----

export async function addShipLogEntry(entry: ShipLogEntry): Promise<void> {
  await getDb().run(
    `INSERT OR REPLACE INTO ship_log
       (id, agent_group_id, title, description, pr_url, branch, tags, shipped_at)
     VALUES ($id, $agent_group_id, $title, $description, $pr_url, $branch, $tags, $shipped_at)`,
    {
      id: entry.id,
      agent_group_id: entry.agent_group_id,
      title: entry.title,
      description: entry.description,
      pr_url: entry.pr_url,
      branch: entry.branch,
      tags: entry.tags,
      shipped_at: entry.shipped_at,
    },
  );
}

export function getShipLog(agentGroupId: string, limit = 50): Promise<ShipLogEntry[]> {
  return getDb().all<ShipLogEntry>(
    `SELECT * FROM ship_log
         WHERE agent_group_id = $agent_group_id
         ORDER BY shipped_at DESC LIMIT $limit`,
    { agent_group_id: agentGroupId, limit: limit },
  );
}

/**
 * COUNT and page as two sequential awaits, deliberately NOT a
 * `centralTransaction`. The pair once sat in one synchronous lease
 * block, so a concurrent insert could not land between them; now it can, and
 * `total` may exceed what `data` shows by one row for one render. That skew is
 * cosmetic, no writer reads either value back, and neither paginated helper has
 * a runtime caller (they are re-export surface — `src/db/index.ts`). Wrapping
 * them in a transaction would put a lease-acquiring call inside a leaf export,
 * which throws `CentralLeaseReentrancyError` the day a caller invokes it from
 * inside another central transaction. See plan §4.4.
 */
export async function getShipLogPaginated(
  agentGroupId: string,
  limit = 20,
  offset = 0,
): Promise<{ data: ShipLogEntry[]; total: number }> {
  const totalRow = await getDb().get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM ship_log WHERE agent_group_id = $agent_group_id',
    { agent_group_id: agentGroupId },
  );
  const data = await getDb().all<ShipLogEntry>(
    `SELECT * FROM ship_log
         WHERE agent_group_id = $agent_group_id
         ORDER BY shipped_at DESC LIMIT $limit OFFSET $offset`,
    { agent_group_id: agentGroupId, limit: limit, offset: offset },
  );
  return { data, total: totalRow?.c ?? 0 };
}

export function getShipLogSince(agentGroupId: string, since: string): Promise<ShipLogEntry[]> {
  return getDb().all<ShipLogEntry>(
    `SELECT * FROM ship_log
         WHERE agent_group_id = $agent_group_id AND shipped_at >= $since
         ORDER BY shipped_at ASC`,
    { agent_group_id: agentGroupId, since: since },
  );
}

// ---- backlog_items ----

export async function getBacklogItemById(id: string): Promise<BacklogItem | null> {
  return (await getDb().get<BacklogItem>('SELECT * FROM backlog_items WHERE id = $id', { id: id })) ?? null;
}

export async function addBacklogItem(item: BacklogItem): Promise<void> {
  await getDb().run(
    `INSERT OR REPLACE INTO backlog_items
       (id, agent_group_id, title, description, status, priority, tags, notes,
        created_at, updated_at, resolved_at)
     VALUES ($id, $agent_group_id, $title, $description, $status, $priority,
             $tags, $notes, $created_at, $updated_at, $resolved_at)`,
    {
      id: item.id,
      agent_group_id: item.agent_group_id,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      tags: item.tags,
      notes: item.notes,
      created_at: item.created_at,
      updated_at: item.updated_at,
      resolved_at: item.resolved_at,
    },
  );
}

export async function updateBacklogItem(
  id: string,
  updates: Partial<
    Pick<BacklogItem, 'title' | 'description' | 'status' | 'priority' | 'tags' | 'notes' | 'resolved_at'>
  >,
  agentGroupId?: string,
): Promise<boolean> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id: id };

  if (updates.title !== undefined) {
    fields.push('title = $title');
    values.title = updates.title;
  }
  if (updates.description !== undefined) {
    fields.push('description = $description');
    values.description = updates.description;
  }
  if (updates.status !== undefined) {
    fields.push('status = $status');
    values.status = updates.status;
  }
  if (updates.priority !== undefined) {
    fields.push('priority = $priority');
    values.priority = updates.priority;
  }
  if (updates.tags !== undefined) {
    fields.push('tags = $tags');
    values.tags = updates.tags;
  }
  if (updates.notes !== undefined) {
    fields.push('notes = $notes');
    values.notes = updates.notes;
  }
  if (updates.resolved_at !== undefined) {
    fields.push('resolved_at = $resolved_at');
    values.resolved_at = updates.resolved_at;
  }

  if (fields.length === 0) return false;

  fields.push('updated_at = $updated_at');
  values.updated_at = new Date().toISOString();

  const whereClause =
    agentGroupId !== undefined ? 'WHERE id = $id AND agent_group_id = $agent_group_id' : 'WHERE id = $id';
  if (agentGroupId !== undefined) values.agent_group_id = agentGroupId;

  const result = await getDb().run(`UPDATE backlog_items SET ${fields.join(', ')} ${whereClause}`, values);
  return result.changes > 0;
}

export async function deleteBacklogItem(id: string, agentGroupId: string): Promise<boolean> {
  const result = await getDb().run('DELETE FROM backlog_items WHERE id = $id AND agent_group_id = $agent_group_id', {
    id: id,
    agent_group_id: agentGroupId,
  });
  return result.changes > 0;
}

const PRIORITY_ORDER = `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

export function getBacklog(agentGroupId: string, status?: string, limit = 100): Promise<BacklogItem[]> {
  if (status) {
    return getDb().all<BacklogItem>(
      `SELECT * FROM backlog_items
           WHERE agent_group_id = $agent_group_id AND status = $status
           ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT $limit`,
      { agent_group_id: agentGroupId, status: status, limit: limit },
    );
  }
  return getDb().all<BacklogItem>(
    `SELECT * FROM backlog_items
         WHERE agent_group_id = $agent_group_id
         ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT $limit`,
    { agent_group_id: agentGroupId, limit: limit },
  );
}

/** Same two-await COUNT/page shape and rationale as `getShipLogPaginated`. */
export async function getBacklogPaginated(
  agentGroupId: string,
  status?: string,
  limit = 20,
  offset = 0,
): Promise<{ data: BacklogItem[]; total: number }> {
  if (status) {
    const totalRow = await getDb().get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM backlog_items WHERE agent_group_id = $agent_group_id AND status = $status',
      { agent_group_id: agentGroupId, status: status },
    );
    const rows = await getDb().all<BacklogItem>(
      `SELECT * FROM backlog_items
           WHERE agent_group_id = $agent_group_id AND status = $status
           ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT $limit OFFSET $offset`,
      { agent_group_id: agentGroupId, status: status, limit: limit, offset: offset },
    );
    return { data: rows, total: totalRow?.c ?? 0 };
  }
  const totalRow = await getDb().get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM backlog_items WHERE agent_group_id = $agent_group_id',
    { agent_group_id: agentGroupId },
  );
  const rows = await getDb().all<BacklogItem>(
    `SELECT * FROM backlog_items
         WHERE agent_group_id = $agent_group_id
         ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT $limit OFFSET $offset`,
    { agent_group_id: agentGroupId, limit: limit, offset: offset },
  );
  return { data: rows, total: totalRow?.c ?? 0 };
}

export function getBacklogResolvedSince(agentGroupId: string, since: string): Promise<BacklogItem[]> {
  return getDb().all<BacklogItem>(
    `SELECT * FROM backlog_items
         WHERE agent_group_id = $agent_group_id
           AND status IN ('resolved','wont_fix')
           AND resolved_at >= $since
         ORDER BY resolved_at ASC`,
    { agent_group_id: agentGroupId, since: since },
  );
}

// ---- commit_digest_state ----

export async function getCommitDigestState(repoPath: string): Promise<CommitDigestState | null> {
  return (
    (await getDb().get<CommitDigestState>('SELECT * FROM commit_digest_state WHERE repo_path = $repo_path', {
      repo_path: repoPath,
    })) ?? null
  );
}

export async function upsertCommitDigestState(state: CommitDigestState): Promise<void> {
  await getDb().run(
    `INSERT OR REPLACE INTO commit_digest_state
       (repo_path, agent_group_id, last_commit_sha, last_scan)
     VALUES ($repo_path, $agent_group_id, $last_commit_sha, $last_scan)`,
    {
      repo_path: state.repo_path,
      agent_group_id: state.agent_group_id,
      last_commit_sha: state.last_commit_sha,
      last_scan: state.last_scan,
    },
  );
}
