/**
 * Seed chat-stream watermarks for shared-FS workgroup siblings.
 *
 * Companion to the expandChatStreamGroups fix (memory-daemon): siblings that
 * were never swept have NO watermark row, and a null watermark makes
 * processGroup scan the group's ENTIRE archive history — thousands of LLM
 * classification calls on the first post-fix sweep. This script pre-creates
 * watermark rows at a chosen cutoff so ingestion starts from there instead.
 *
 * Targets exactly the ids the expansion will add: members of migrated
 * workgroups whose groups/<folder>/container.json has memory.enabled=true and
 * that have no watermarks row yet. Idempotent; never touches existing rows.
 *
 * Usage (run with the memory daemon STOPPED — it is the ingest-db writer):
 *   pnpm exec tsx scripts/seed-sibling-watermarks.ts --cutoff now        # dry run
 *   pnpm exec tsx scripts/seed-sibling-watermarks.ts --cutoff 30d --apply
 *   pnpm exec tsx scripts/seed-sibling-watermarks.ts --cutoff 2026-06-01T00:00:00Z --apply
 *
 * --cutoff accepts: "now", "<N>d" (N days back), or an ISO timestamp.
 * Omitting --cutoff entirely (no row seeded) = full-history backfill on the
 * first sweep; that's a deliberate choice, not this script's default.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { readContainerConfig } from '../src/container-config.js';

const apply = process.argv.includes('--apply');
const cutoffArgIdx = process.argv.indexOf('--cutoff');
const cutoffRaw = cutoffArgIdx >= 0 ? process.argv[cutoffArgIdx + 1] : undefined;
if (!cutoffRaw) {
  console.error('Usage: seed-sibling-watermarks.ts --cutoff <now|Nd|ISO> [--apply]');
  process.exit(2);
}
let cutoff: string;
if (cutoffRaw === 'now') cutoff = new Date().toISOString();
else if (/^\d+d$/.test(cutoffRaw)) cutoff = new Date(Date.now() - parseInt(cutoffRaw, 10) * 86_400_000).toISOString();
else {
  const d = new Date(cutoffRaw);
  if (isNaN(d.getTime())) {
    console.error(`invalid --cutoff: ${cutoffRaw}`);
    process.exit(2);
  }
  cutoff = d.toISOString();
}

const central = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true });
const ingest = new Database(path.join(DATA_DIR, 'mnemon-ingest.db'));
ingest.pragma('busy_timeout = 5000');

try {
  // Members of migrated workgroups only — mirrors the expansion's gate.
  const wgRoot = path.join(DATA_DIR, 'workgroups');
  const migrated = fs.existsSync(wgRoot)
    ? fs.readdirSync(wgRoot).filter((d) => fs.existsSync(path.join(wgRoot, d, '.migrated')))
    : [];
  const members = central
    .prepare(
      `SELECT id, folder, workgroup_id FROM agent_groups WHERE workgroup_id IN (${migrated.map(() => '?').join(',') || "''"})`,
    )
    .all(...migrated) as Array<{ id: string; folder: string; workgroup_id: string }>;

  let seeded = 0;
  for (const m of members) {
    if (!fs.existsSync(path.join(GROUPS_DIR, m.folder))) continue;
    const cfg = readContainerConfig(m.folder);
    if (cfg.agentGroupId !== m.id || cfg.memory?.enabled !== true) continue;
    const existing = ingest.prepare('SELECT 1 FROM watermarks WHERE agent_group_id = ?').get(m.id);
    if (existing) continue; // already swept at least once — never touch
    console.log(`${apply ? 'SEED     ' : 'WOULD SEED'} ${m.workgroup_id.padEnd(14)} ${m.id}  scan_cursor=${cutoff}`);
    if (apply) {
      ingest
        .prepare(
          `INSERT INTO watermarks (agent_group_id, scan_cursor, last_classified_sent_at, updated_at)
           VALUES (?, ?, NULL, ?)`,
        )
        .run(m.id, cutoff, new Date().toISOString());
    }
    seeded++;
  }
  console.log(`\n${apply ? 'Seeded' : 'Would seed'} ${seeded} watermark(s) at cutoff ${cutoff}.`);
} finally {
  central.close();
  ingest.close();
}
