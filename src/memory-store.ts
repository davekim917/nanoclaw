/**
 * Higher-level memory API: save/update/delete with logging, ID generation,
 * and dedup at the business-logic layer.
 *
 * Low-level DB ops live in `src/db/memories.ts`. The extraction pipeline
 * (Haiku-driven) lives in `src/memory-extractor.ts`. This module is the
 * boundary both call through — keep business logic here, DB statements
 * in db/memories.ts, and extraction logic in memory-extractor.ts.
 */
import {
  deleteMemoryById,
  getMemoryById,
  insertMemory,
  recentMemories,
  searchMemoriesKeyword,
  updateMemoryFields,
} from './db/memories.js';
import { log } from './log.js';
import type { Memory, MemoryType } from './types.js';

export function saveMemory(
  agentGroupId: string,
  type: MemoryType,
  name: string,
  description: string,
  content: string,
): string {
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  insertMemory({
    id,
    agent_group_id: agentGroupId,
    type,
    name,
    description,
    content,
    created_at: now,
    updated_at: now,
  });

  log.info('Memory saved', { id, agentGroupId, type, name });
  return id;
}

export function updateMemory(
  agentGroupId: string,
  id: string,
  fields: Partial<Pick<Memory, 'type' | 'name' | 'description' | 'content'>>,
): boolean {
  const updated = updateMemoryFields(agentGroupId, id, fields);
  if (updated) {
    log.info('Memory updated', { id, agentGroupId, fields: Object.keys(fields) });
  }
  return updated;
}

export function deleteMemory(agentGroupId: string, id: string): boolean {
  const deleted = deleteMemoryById(agentGroupId, id);
  if (deleted) {
    log.info('Memory deleted', { id, agentGroupId });
  }
  return deleted;
}

export function getMemory(agentGroupId: string, id: string): Memory | undefined {
  return getMemoryById(agentGroupId, id);
}

/**
 * Retrieve memories to inject into agent context at turn start. Starts with
 * keyword search; if no query or no hits, falls back to most-recently-updated.
 *
 * Phase A: keyword search only. Phase C may add semantic vector search.
 */
export function getRelevantMemories(
  agentGroupId: string,
  queryText: string | null,
  limit = 6,
): Memory[] {
  if (queryText && queryText.trim().length > 0) {
    const hits = searchMemoriesKeyword(agentGroupId, queryText, limit);
    if (hits.length > 0) return hits;
  }
  return recentMemories(agentGroupId, limit);
}

/** Format memories as an XML block suitable for prompt injection. */
export function formatMemoryBlock(memories: Memory[]): string {
  if (memories.length === 0) return '';
  const items = memories
    .map(
      (m) =>
        `  <memory id="${escapeXml(m.id)}" type="${escapeXml(m.type)}" name="${escapeXml(m.name)}" updated="${m.updated_at.slice(0, 10)}">\n    ${escapeXml(m.content)}\n  </memory>`,
    )
    .join('\n');
  return `<memories>\n${items}\n</memories>\n`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Re-export low-level reads for callers that need them directly.
export { listMemories, searchMemoriesKeyword } from './db/memories.js';
