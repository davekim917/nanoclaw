/**
 * Project the memories table into a human-readable file inside each
 * agent group's folder so Claude Code picks it up via the CLAUDE.md
 * hierarchy.
 *
 * Per-agent-group:
 *   groups/<folder>/memories.md        — regenerated on every save/update/delete
 *   groups/<folder>/CLAUDE.md          — gets an `@./memories.md` import appended
 *                                         once (idempotent)
 *
 * Claude Code follows @-imports inside CLAUDE.md at turn start, so the
 * memories.md contents end up in the model's system context every turn
 * without the agent-runner or formatter needing to know about memories.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { listMemories } from './db/memories.js';
import { log } from './log.js';
import type { Memory } from './types.js';

const MEMORIES_FILE = 'memories.md';
const IMPORT_LINE = '@./memories.md';

function groupFolder(agentGroupId: string): string | null {
  const ag = getAgentGroup(agentGroupId);
  if (!ag) return null;
  return path.resolve(GROUPS_DIR, ag.folder);
}

function renderMarkdown(memories: Memory[]): string {
  if (memories.length === 0) {
    return `# Memories\n\n_(none yet)_\n`;
  }
  // Group by type for a little structure. Sort within each group by updated_at DESC.
  const byType: Record<string, Memory[]> = { user: [], project: [], feedback: [], reference: [] };
  for (const m of memories) {
    (byType[m.type] ?? (byType[m.type] = [])).push(m);
  }
  for (const t of Object.keys(byType)) {
    byType[t].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  const parts: string[] = ['# Memories', ''];
  for (const t of ['user', 'project', 'feedback', 'reference']) {
    const items = byType[t];
    if (!items || items.length === 0) continue;
    parts.push(`## ${t}`);
    parts.push('');
    for (const m of items) {
      parts.push(`- **${m.name}** _(updated ${m.updated_at.slice(0, 10)})_  `);
      parts.push(`  ${m.content.replace(/\n+/g, ' ').trim()}`);
    }
    parts.push('');
  }
  return parts.join('\n') + '\n';
}

function ensureImportInClaudeMd(groupDir: string): boolean {
  const claudeMd = path.join(groupDir, 'CLAUDE.md');
  let content: string;
  try {
    content = fs.readFileSync(claudeMd, 'utf-8');
  } catch {
    return false;
  }
  if (content.includes(IMPORT_LINE)) return false;
  const updated =
    content.trimEnd() +
    '\n\n<!-- Auto-generated memories (host-managed via memory-projection.ts) -->\n' +
    IMPORT_LINE +
    '\n';
  fs.writeFileSync(claudeMd, updated);
  return true;
}

/**
 * Regenerate memories.md for an agent group from the current DB state.
 * Idempotent — safe to call from every save/update/delete hook.
 * Swallows errors (never breaks the caller) and logs warnings.
 */
export function projectMemoriesToFile(agentGroupId: string): void {
  try {
    const dir = groupFolder(agentGroupId);
    if (!dir) return;
    if (!fs.existsSync(dir)) return;

    const memories = listMemories(agentGroupId, 500);
    const md = renderMarkdown(memories);
    const target = path.join(dir, MEMORIES_FILE);
    fs.writeFileSync(target, md);

    if (ensureImportInClaudeMd(dir)) {
      log.info('Added memories.md import to CLAUDE.md', { agentGroupId });
    }
  } catch (err) {
    log.warn('Failed to project memories to file', { agentGroupId, err });
  }
}
