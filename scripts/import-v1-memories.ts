/**
 * Phase 0 data migration: v1 memories → v2 memories.
 *
 * Source: /home/ubuntu/nanoclaw/store/messages.db (v1 sqlite)
 * Target: /home/ubuntu/nanoclaw-v2/data/v2.db (v2 sqlite)
 *
 * Mapping:
 *   v1.memories.group_folder   → v2.agent_groups.folder (lookup)  → agent_group_id
 *   v1.memories.id             → regenerated as mem-<ts>-<rand>
 *   v1.memories.type           → same (user/project/reference/feedback — schemas match)
 *   v1.memories.name/desc/content → same
 *   v1.memories.created_at/updated_at → same
 *
 * Usage:
 *   # dry-run (default — prints plan, no writes):
 *   npx tsx scripts/import-v1-memories.ts
 *
 *   # with folder remapping (v1 folder → v2 folder):
 *   npx tsx scripts/import-v1-memories.ts --map illysium=illysium-v2 --map main=main
 *
 *   # commit:
 *   npx tsx scripts/import-v1-memories.ts --map illysium=illysium-v2 --commit
 *
 * Idempotency: if a v2 memory already exists for (agent_group_id, type, name),
 * skip it — don't duplicate. Run multiple times safely.
 *
 * Run this during the Phase 4 cutover freeze (after v1 stops, before v2
 * starts taking traffic as the primary). That way there's no window where
 * v1 writes new memories that the import misses.
 */
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAllAgentGroups } from '../src/db/agent-groups.js';

const V1_DB = '/home/ubuntu/nanoclaw/store/messages.db';
const V2_DB = path.join(DATA_DIR, 'v2.db');

interface V1Memory {
  id: string;
  group_folder: string;
  type: string;
  name: string;
  description: string;
  content: string;
  created_at: string;
  updated_at: string;
}

function parseMap(args: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--map' && args[i + 1]) {
      const [from, to] = args[i + 1].split('=');
      if (from && to) m.set(from, to);
      i++;
    }
  }
  return m;
}

function genId(): string {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const folderMap = parseMap(args);

  // Open v2 DB first so we can resolve agent groups
  initDb(V2_DB);
  const v2AgentGroups = getAllAgentGroups();
  const folderToId = new Map(v2AgentGroups.map((ag) => [ag.folder, ag.id]));

  // Open v1 DB read-only
  const v1 = new Database(V1_DB, { readonly: true, fileMustExist: true });
  const v1Mems = v1.prepare('SELECT * FROM memories').all() as V1Memory[];
  v1.close();

  console.log(`V1 source: ${V1_DB}`);
  console.log(`V2 target: ${V2_DB}`);
  console.log(`V1 memories: ${v1Mems.length}`);
  console.log(`V2 agent groups: ${v2AgentGroups.length}`);
  console.log(`Folder remapping: ${folderMap.size ? [...folderMap].map(([k, v]) => `${k}→${v}`).join(', ') : '(none — direct match)'}`);
  console.log();

  // Group v1 memories by source folder, then resolve to v2 agent_group_id.
  const byFolder = new Map<string, V1Memory[]>();
  for (const mem of v1Mems) {
    const arr = byFolder.get(mem.group_folder) ?? [];
    arr.push(mem);
    byFolder.set(mem.group_folder, arr);
  }

  const plan: Array<{ v1Folder: string; v2Folder: string; agentGroupId: string; count: number }> = [];
  const skipped: Array<{ folder: string; count: number; reason: string }> = [];
  for (const [v1Folder, mems] of byFolder) {
    const v2Folder = folderMap.get(v1Folder) ?? v1Folder;
    const agentGroupId = folderToId.get(v2Folder);
    if (!agentGroupId) {
      skipped.push({
        folder: v1Folder,
        count: mems.length,
        reason: `no v2 agent group with folder "${v2Folder}" — add --map ${v1Folder}=<v2-folder> to remap`,
      });
      continue;
    }
    plan.push({ v1Folder, v2Folder, agentGroupId, count: mems.length });
  }

  console.log('Plan:');
  for (const p of plan) {
    console.log(`  ${p.v1Folder.padEnd(20)} → ${p.v2Folder.padEnd(20)} (${p.agentGroupId})  ${p.count} memories`);
  }
  if (skipped.length) {
    console.log();
    console.log('Skipped:');
    for (const s of skipped) console.log(`  ${s.folder.padEnd(20)} ${s.count} memories — ${s.reason}`);
  }
  console.log();

  if (!commit) {
    console.log('Dry-run. Pass --commit to perform the import.');
    return;
  }

  // Idempotency: skip (agent_group_id, type, name) that's already in v2.
  const db = new Database(V2_DB);
  const insert = db.prepare(
    `INSERT INTO memories (id, agent_group_id, type, name, description, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const exists = db.prepare(
    'SELECT 1 FROM memories WHERE agent_group_id = ? AND type = ? AND name = ? LIMIT 1',
  );

  let inserted = 0;
  let duplicate = 0;
  const tx = db.transaction(() => {
    for (const p of plan) {
      const mems = byFolder.get(p.v1Folder)!;
      for (const mem of mems) {
        if (exists.get(p.agentGroupId, mem.type, mem.name)) {
          duplicate++;
          continue;
        }
        insert.run(
          genId(),
          p.agentGroupId,
          mem.type,
          mem.name,
          mem.description,
          mem.content,
          mem.created_at,
          mem.updated_at,
        );
        inserted++;
      }
    }
  });
  tx();
  db.close();

  console.log(`Committed. inserted=${inserted} duplicates-skipped=${duplicate}`);
}

main();
