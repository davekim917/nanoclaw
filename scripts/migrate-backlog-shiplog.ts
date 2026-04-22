#!/usr/bin/env npx tsx
/**
 * Migrate backlog + ship_log data from v1 to v2.
 *
 * V1 source: ~/nanoclaw/store/messages.db
 * V2 target: ~/nanoclaw-v2/data/v2.db
 *
 * Group mapping (v1 folder → v2 agent_group_id):
 *   illysium    → ag-1776377699463-2axxhg  (illysium-v2)
 *   main        → ag-1776402507183-cf39lq  (main)
 *   axie-dev    → ag-1776402507183-cf39lq  (→ main, closest fit)
 *   axis-labs   → ag-1776377699463-2axxhg  (→ illysium-v2)
 *   personal    → ag-1776402507183-cf39lq  (→ main)
 *   nanoclaw-dev → ag-1776402507183-cf39lq (→ main)
 *   sunday      → ag-1776377699463-2axxhg  (→ illysium-v2)
 *   video-agent → ag-1776402507183-cf39lq  (→ main)
 *
 * Run with: npx tsx scripts/migrate-backlog-shiplog.ts
 * Dry run first: DRY_RUN=1 npx tsx scripts/migrate-backlog-shiplog.ts
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DRY_RUN = process.env.DRY_RUN === '1';

const V1_DB = path.join(process.env.HOME ?? '', 'nanoclaw', 'store', 'messages.db');
const V2_DB = path.join(process.env.HOME ?? '', 'nanoclaw-v2', 'data', 'v2.db');

// group_folder → v2 agent_group_id
const GROUP_MAP: Record<string, string> = {
  illysium:     'ag-1776377699463-2axxhg',
  main:         'ag-1776402507183-cf39lq',
  'axie-dev':   'ag-1776402507183-cf39lq', // → main (closest fit)
  'axis-labs':  'ag-1776377699463-2axxhg', // → illysium-v2
  personal:     'ag-1776402507183-cf39lq',  // → main
  'nanoclaw-dev': 'ag-1776402507183-cf39lq', // → main
  sunday:       'ag-1776377699463-2axxhg',  // → illysium-v2
  'video-agent': 'ag-1776402507183-cf39lq', // → main
};

if (!fs.existsSync(V1_DB)) {
  console.error(`V1 DB not found: ${V1_DB}`);
  process.exit(1);
}
if (!fs.existsSync(V2_DB)) {
  console.error(`V2 DB not found: ${V2_DB}`);
  process.exit(1);
}

const v1 = new Database(V1_DB, { readonly: true });
const v2 = new Database(V2_DB);

if (DRY_RUN) {
  console.log('DRY RUN — no changes will be written');
}

// --- Migrate backlog_items ---
console.log('\n=== backlog_items ===');
const backlog = v1.prepare('SELECT * FROM backlog ORDER BY created_at').all() as Array<Record<string, unknown>>;
console.log(`  Found ${backlog.length} rows in v1`);

let backlogMigrated = 0;
let backlogSkipped = 0;
for (const row of backlog) {
  const groupFolder = row.group_folder as string;
  const agentGroupId = GROUP_MAP[groupFolder];
  if (!agentGroupId) {
    console.log(`  SKIP backlog ${row.id}: unknown group "${groupFolder}"`);
    backlogSkipped++;
    continue;
  }
  if (DRY_RUN) {
    console.log(`  [DRY] backlog ${row.id}: "${row.title}" → ${agentGroupId}`);
  } else {
    v2.prepare(
      `INSERT OR IGNORE INTO backlog_items
         (id, agent_group_id, title, description, status, priority, tags, notes,
          created_at, updated_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      agentGroupId,
      row.title,
      row.description ?? null,
      row.status ?? 'open',
      row.priority ?? 'medium',
      row.tags ?? null,
      row.notes ?? null,
      row.created_at,
      row.updated_at,
      row.resolved_at ?? null,
    );
    backlogMigrated++;
  }
}
console.log(`  Migrated: ${backlogMigrated}, Skipped: ${backlogSkipped}`);

// --- Migrate ship_log ---
console.log('\n=== ship_log ===');
const shipLog = v1.prepare('SELECT * FROM ship_log ORDER BY shipped_at').all() as Array<Record<string, unknown>>;
console.log(`  Found ${shipLog.length} rows in v1`);

let shipMigrated = 0;
let shipSkipped = 0;
for (const row of shipLog) {
  const groupFolder = row.group_folder as string;
  const agentGroupId = GROUP_MAP[groupFolder];
  if (!agentGroupId) {
    console.log(`  SKIP ship_log ${row.id}: unknown group "${groupFolder}"`);
    shipSkipped++;
    continue;
  }
  if (DRY_RUN) {
    console.log(`  [DRY] ship_log ${row.id}: "${row.title}" → ${agentGroupId}`);
  } else {
    v2.prepare(
      `INSERT OR IGNORE INTO ship_log
         (id, agent_group_id, title, description, pr_url, branch, tags, shipped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      agentGroupId,
      row.title,
      row.description ?? null,
      row.pr_url ?? null,
      row.branch ?? null,
      row.tags ?? null,
      row.shipped_at,
    );
    shipMigrated++;
  }
}
console.log(`  Migrated: ${shipMigrated}, Skipped: ${shipSkipped}`);

// --- Migrate commit_digest_state ---
console.log('\n=== commit_digest_state ===');
const digest = v1.prepare('SELECT * FROM commit_digest_state').all() as Array<Record<string, unknown>>;
console.log(`  Found ${digest.length} rows in v1`);

let digestMigrated = 0;
for (const row of digest) {
  const groupFolder = row.group_folder as string;
  const agentGroupId = GROUP_MAP[groupFolder];
  if (!agentGroupId) {
    console.log(`  SKIP digest ${row.repo_path}: unknown group "${groupFolder}"`);
    continue;
  }
  if (DRY_RUN) {
    console.log(`  [DRY] digest ${row.repo_path} → ${agentGroupId}`);
  } else {
    v2.prepare(
      `INSERT OR REPLACE INTO commit_digest_state
         (repo_path, agent_group_id, last_commit_sha, last_scan)
       VALUES (?, ?, ?, ?)`,
    ).run(row.repo_path, agentGroupId, row.last_commit_sha, row.last_scan);
    digestMigrated++;
  }
}
console.log(`  Migrated: ${digestMigrated}`);

v1.close();
v2.close();

console.log('\n=== Summary ===');
if (DRY_RUN) {
  console.log('DRY RUN complete — re-run without DRY_RUN=1 to apply');
} else {
  console.log('Migration complete');
}
