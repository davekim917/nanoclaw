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
}

export interface CommitDigestState {
  repo_path: string;
  agent_group_id: string;
  last_commit_sha: string;
  last_scan: string;
}

// ---- ship_log ----

export function addShipLogEntry(entry: ShipLogEntry): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO ship_log
       (id, agent_group_id, title, description, pr_url, branch, tags, shipped_at)
     VALUES ($id, $agent_group_id, $title, $description, $pr_url, $branch, $tags, $shipped_at)`,
  ).run({
    id: entry.id,
    agent_group_id: entry.agent_group_id,
    title: entry.title,
    description: entry.description,
    pr_url: entry.pr_url,
    branch: entry.branch,
    tags: entry.tags,
    shipped_at: entry.shipped_at,
  });
}

export function getShipLog(agentGroupId: string, limit = 50): ShipLogEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM ship_log
         WHERE agent_group_id = $agent_group_id
         ORDER BY shipped_at DESC LIMIT $limit`,
    )
    .all({ agent_group_id: agentGroupId, limit: limit }) as ShipLogEntry[];
}

export function getShipLogPaginated(
  agentGroupId: string,
  limit = 20,
  offset = 0,
): { data: ShipLogEntry[]; total: number } {
  const db = getDb();
  const total = (
    db
      .prepare('SELECT COUNT(*) AS c FROM ship_log WHERE agent_group_id = $agent_group_id')
      .get({ agent_group_id: agentGroupId }) as { c: number }
  ).c;
  const data = db
    .prepare(
      `SELECT * FROM ship_log
         WHERE agent_group_id = $agent_group_id
         ORDER BY shipped_at DESC LIMIT $limit OFFSET $offset`,
    )
    .all({ agent_group_id: agentGroupId, limit: limit, offset: offset }) as ShipLogEntry[];
  return { data, total };
}

export function getShipLogSince(agentGroupId: string, since: string): ShipLogEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM ship_log
         WHERE agent_group_id = $agent_group_id AND shipped_at >= $since
         ORDER BY shipped_at ASC`,
    )
    .all({ agent_group_id: agentGroupId, since: since }) as ShipLogEntry[];
}

// ---- backlog_items ----

export function getBacklogItemById(id: string): BacklogItem | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM backlog_items WHERE id = $id').get({ id: id }) as BacklogItem) || null;
}

export function addBacklogItem(item: BacklogItem): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO backlog_items
       (id, agent_group_id, title, description, status, priority, tags, notes,
        created_at, updated_at, resolved_at)
     VALUES ($id, $agent_group_id, $title, $description, $status, $priority,
             $tags, $notes, $created_at, $updated_at, $resolved_at)`,
  ).run({
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
  });
}

export function updateBacklogItem(
  id: string,
  updates: Partial<
    Pick<BacklogItem, 'title' | 'description' | 'status' | 'priority' | 'tags' | 'notes' | 'resolved_at'>
  >,
  agentGroupId?: string,
): boolean {
  const db = getDb();
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

  const result = db.prepare(`UPDATE backlog_items SET ${fields.join(', ')} ${whereClause}`).run(values);
  return result.changes > 0;
}

export function deleteBacklogItem(id: string, agentGroupId: string): boolean {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM backlog_items WHERE id = $id AND agent_group_id = $agent_group_id')
    .run({ id: id, agent_group_id: agentGroupId });
  return result.changes > 0;
}

const PRIORITY_ORDER = `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

export function getBacklog(agentGroupId: string, status?: string, limit = 100): BacklogItem[] {
  const db = getDb();
  let rows;
  if (status) {
    rows = db
      .prepare(
        `SELECT * FROM backlog_items
           WHERE agent_group_id = $agent_group_id AND status = $status
           ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT $limit`,
      )
      .all({ agent_group_id: agentGroupId, status: status, limit: limit });
  } else {
    rows = db
      .prepare(
        `SELECT * FROM backlog_items
           WHERE agent_group_id = $agent_group_id
           ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT $limit`,
      )
      .all({ agent_group_id: agentGroupId, limit: limit });
  }
  return rows as BacklogItem[];
}

export function getBacklogPaginated(
  agentGroupId: string,
  status?: string,
  limit = 20,
  offset = 0,
): { data: BacklogItem[]; total: number } {
  const db = getDb();
  let total: number;
  let rows: BacklogItem[];
  if (status) {
    total = (
      db
        .prepare('SELECT COUNT(*) AS c FROM backlog_items WHERE agent_group_id = $agent_group_id AND status = $status')
        .get({ agent_group_id: agentGroupId, status: status }) as { c: number }
    ).c;
    rows = db
      .prepare(
        `SELECT * FROM backlog_items
           WHERE agent_group_id = $agent_group_id AND status = $status
           ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT $limit OFFSET $offset`,
      )
      .all({ agent_group_id: agentGroupId, status: status, limit: limit, offset: offset }) as BacklogItem[];
  } else {
    total = (
      db
        .prepare('SELECT COUNT(*) AS c FROM backlog_items WHERE agent_group_id = $agent_group_id')
        .get({ agent_group_id: agentGroupId }) as { c: number }
    ).c;
    rows = db
      .prepare(
        `SELECT * FROM backlog_items
           WHERE agent_group_id = $agent_group_id
           ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT $limit OFFSET $offset`,
      )
      .all({ agent_group_id: agentGroupId, limit: limit, offset: offset }) as BacklogItem[];
  }
  return { data: rows, total };
}

export function getBacklogResolvedSince(agentGroupId: string, since: string): BacklogItem[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM backlog_items
         WHERE agent_group_id = $agent_group_id
           AND status IN ('resolved','wont_fix')
           AND resolved_at >= $since
         ORDER BY resolved_at ASC`,
    )
    .all({ agent_group_id: agentGroupId, since: since }) as BacklogItem[];
}

// ---- commit_digest_state ----

export function getCommitDigestState(repoPath: string): CommitDigestState | null {
  const db = getDb();
  return (
    (db
      .prepare('SELECT * FROM commit_digest_state WHERE repo_path = $repo_path')
      .get({ repo_path: repoPath }) as CommitDigestState) || null
  );
}

export function upsertCommitDigestState(state: CommitDigestState): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO commit_digest_state
       (repo_path, agent_group_id, last_commit_sha, last_scan)
     VALUES ($repo_path, $agent_group_id, $last_commit_sha, $last_scan)`,
  ).run({
    repo_path: state.repo_path,
    agent_group_id: state.agent_group_id,
    last_commit_sha: state.last_commit_sha,
    last_scan: state.last_scan,
  });
}
