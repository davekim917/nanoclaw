/**
 * Per-agent-group memory storage.
 *
 * Ported from v1 fork's memory system. In v2, memories are scoped by
 * `agent_group_id` (in v1 they were scoped by `group_folder`). The table
 * lives in the central v2.db — memories survive session restarts and are
 * queryable across all sessions of the same agent group.
 *
 * Embeddings (sqlite-vec) are NOT included in Phase A — keyword/recent
 * retrieval only. Phase C can add them later via a separate vec table.
 */
import type { Memory } from '../types.js';
import { getDb } from './connection.js';

export function insertMemory(memory: Memory): void {
  getDb()
    .prepare(
      `INSERT INTO memories (id, agent_group_id, type, name, description, content, created_at, updated_at)
       VALUES (@id, @agent_group_id, @type, @name, @description, @content, @created_at, @updated_at)`,
    )
    .run(memory);
}

export function getMemoryById(agentGroupId: string, id: string): Memory | undefined {
  return getDb().prepare('SELECT * FROM memories WHERE agent_group_id = ? AND id = ?').get(agentGroupId, id) as
    | Memory
    | undefined;
}

export function listMemories(agentGroupId: string, limit = 50): Memory[] {
  return getDb()
    .prepare('SELECT * FROM memories WHERE agent_group_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(agentGroupId, limit) as Memory[];
}

export function countMemories(agentGroupId: string): number {
  const row = getDb().prepare('SELECT COUNT(*) as c FROM memories WHERE agent_group_id = ?').get(agentGroupId) as {
    c: number;
  };
  return row.c;
}

export function deleteMemoryById(agentGroupId: string, id: string): boolean {
  const info = getDb().prepare('DELETE FROM memories WHERE agent_group_id = ? AND id = ?').run(agentGroupId, id);
  return info.changes > 0;
}

export function updateMemoryFields(
  agentGroupId: string,
  id: string,
  fields: Partial<Pick<Memory, 'type' | 'name' | 'description' | 'content'>>,
): boolean {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (keys.length === 0) return false;

  const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
  const params: Record<string, unknown> = {
    ...fields,
    agent_group_id: agentGroupId,
    id,
    updated_at: new Date().toISOString(),
  };

  const info = getDb()
    .prepare(
      `UPDATE memories SET ${setClause}, updated_at = @updated_at WHERE agent_group_id = @agent_group_id AND id = @id`,
    )
    .run(params);
  return info.changes > 0;
}

/** Keyword search — simple LIKE over name/description/content. Case-insensitive. */
export function searchMemoriesKeyword(agentGroupId: string, query: string, limit = 10): Memory[] {
  const pattern = `%${query}%`;
  return getDb()
    .prepare(
      `SELECT * FROM memories
       WHERE agent_group_id = ?
         AND (name LIKE ? OR description LIKE ? OR content LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(agentGroupId, pattern, pattern, pattern, limit) as Memory[];
}

export function recentMemories(agentGroupId: string, limit = 6): Memory[] {
  return getDb()
    .prepare('SELECT * FROM memories WHERE agent_group_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(agentGroupId, limit) as Memory[];
}
