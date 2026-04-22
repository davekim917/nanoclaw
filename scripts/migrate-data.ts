/**
 * Data migration: CLAUDE.md, memories, orphaned sessions.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { initDb, getDb } from '../src/db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const V2_GROUPS = path.join(PROJECT_ROOT, 'groups');
const V1_GROUPS = '/home/ubuntu/nanoclaw/groups';

const AG_MAP: Record<string, string> = {
  'main':         'ag-1776402507183-cf39lq',
  'illysium':     'ag-1776377699463-2axxhg',
  'number-drinks':'ag-1776735605479-6p0461m',
  'axis-labs':    'ag-1776735605480-gg0aix7',
  'axie-dev':     'ag-1776735605480-ymhokes',
  'madison-reed': 'ag-1776735605480-vosgej2',
  'dirt-market':  'ag-1776735605480-6q2c9zu',
  'xerus':        'ag-1776735605480-y23k2jv',
  'video-agent':  'ag-1776735605480-5htprgz',
};

async function main() {
  initDb(path.join(PROJECT_ROOT, 'data', 'v2.db'));
  const db = getDb();

  // ── 1. Copy CLAUDE.md from V1 → V2 ────────────────────────────────────
  console.log('=== Copy CLAUDE.md ===');
  for (const [folder, agId] of Object.entries(AG_MAP)) {
    const src = path.join(V1_GROUPS, folder, 'CLAUDE.md');
    const dst = path.join(V2_GROUPS, folder, 'CLAUDE.md');
    if (fs.existsSync(src) && fs.statSync(src).size > 0) {
      const size = fs.statSync(src).size;
      if (fs.existsSync(dst) && fs.statSync(dst).size > 0) {
        console.log(`  SKIP ${folder}/CLAUDE.md (V2 already has ${fs.statSync(dst).size} bytes)`);
      } else {
        fs.copyFileSync(src, dst);
        console.log(`  Copied ${folder}/CLAUDE.md (${size} bytes)`);
      }
    } else {
      console.log(`  SKIP ${folder}/CLAUDE.md (V1 empty or missing)`);
    }
  }

  // ── 2. Import memories from V1 export ───────────────────────────────────
  console.log('\n=== Import memories ===');
  const exportPath = path.join(PROJECT_ROOT, 'data', 'v1-memories-export.json');
  if (!fs.existsSync(exportPath)) {
    console.log('  Export file not found — skipping');
  } else {
    const memories = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    console.log(`  Found ${memories.length} memories in export`);

    let imported = 0;
    let skipped = 0;
    const now = new Date().toISOString();

    for (const mem of memories) {
      const agId = AG_MAP[mem.group_folder];
      if (!agId) {
        // Some memories reference folders that don't map cleanly (e.g., 'personal', 'nanoclaw-dev')
        skipped++;
        continue;
      }

      // Check for duplicate
      const existing = db.prepare(
        'SELECT id FROM memories WHERE id = ?'
      ).get(mem.id);
      if (existing) {
        skipped++;
        continue;
      }

      db.prepare(
        `INSERT INTO memories (id, agent_group_id, type, name, description, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        mem.id,
        agId,
        mem.type,
        mem.name,
        mem.description,
        mem.content,
        mem.created_at,
        mem.updated_at,
      );
      imported++;
    }
    console.log(`  Imported: ${imported}, Skipped (no mapping or duplicate): ${skipped}`);
  }

  // ── 3. Clean orphaned sessions ──────────────────────────────────────────
  console.log('\n=== Clean orphaned sessions ===');
  const sessions = db.prepare('SELECT id, agent_group_id, messaging_group_id FROM sessions').all() as any[];
  for (const sess of sessions) {
    const ag = db.prepare('SELECT id FROM agent_groups WHERE id = ?').get(sess.agent_group_id);
    const mg = db.prepare('SELECT id FROM messaging_groups WHERE id = ?').get(sess.messaging_group_id);
    if (!ag || !mg) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sess.id);
      console.log(`  Deleted orphaned: ${sess.id} (ag=${!!ag}, mg=${!!mg})`);
    } else {
      // Also check: does this session's AG own this messaging group?
      const wiring = db.prepare(
        'SELECT 1 FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?'
      ).get(sess.messaging_group_id, sess.agent_group_id);
      if (!wiring) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sess.id);
        console.log(`  Deleted (AG doesn't own MG): ${sess.id}`);
      }
    }
  }

  // ── 4. Verify ─────────────────────────────────────────────────────────
  console.log('\n=== V2 Memories ===');
  const byGroup = db.prepare(
    `SELECT ag.folder, COUNT(*) as cnt FROM memories m JOIN agent_groups ag ON ag.id = m.agent_group_id GROUP BY ag.folder ORDER BY cnt DESC`
  ).all() as any[];
  for (const row of byGroup) {
    console.log(`  ${row.folder}: ${row.cnt}`);
  }

  console.log('\n=== V2 Sessions ===');
  for (const row of db.prepare('SELECT id, agent_group_id, messaging_group_id FROM sessions').all() as any[]) {
    console.log(`  ${row.id} | ${row.agent_group_id} | ${row.messaging_group_id}`);
  }
}

main().catch(console.error);
