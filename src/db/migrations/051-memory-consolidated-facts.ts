import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Migration } from './index.js';
import { DATA_DIR } from '../../config.js';

/**
 * Which episodic-ledger facts are already folded into a topic file, as an order-independent membership set rather
 * than a timestamp cursor (a late or equal-timestamped fact could land behind a cursor and be skipped forever). The
 * backfill enqueues maintenance once per workgroup that already has facts; one claimed job per sweep tick keeps it
 * from storming.
 * DELIBERATELY SELF-CONTAINED: a migration is frozen logic, and migrations/index.ts is loaded by every DB test, so
 * importing application modules dragged module-load side effects into unrelated tests. The ledger read and the
 * `memory_curation_state` upsert are hand-duplicated on purpose; do not "simplify" them back to imports.
 */

const MEMORY_MARKER_PREFIX = '<!-- nanoclaw-memory:id=';

function ledgerIsNonEmpty(workgroupId: string): boolean {
  const ledgerPath = path.join(DATA_DIR, 'workgroups', workgroupId, 'memory', 'generated', 'memory.md');
  let content: string;
  try {
    content = fs.readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return content.includes(MEMORY_MARKER_PREFIX);
}

function enqueueMaintenanceBacklog(workgroupId: string): void {
  const archiveDb = new Database(path.join(DATA_DIR, 'archive.db'));
  try {
    // Mirrors only the one table this backfill touches; IF NOT EXISTS is safe whether or not archive.db's own schema
    // has run.
    archiveDb.exec(`
      CREATE TABLE IF NOT EXISTS memory_curation_state (
        workgroup_id                       TEXT PRIMARY KEY,
        accepted_updates_since_maintenance INTEGER NOT NULL DEFAULT 0,
        maintenance_pending                INTEGER NOT NULL DEFAULT 0,
        not_before                         TEXT NOT NULL,
        lease_owner                        TEXT,
        lease_expires_at                   TEXT,
        updated_at                         TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    archiveDb
      .prepare(
        `INSERT INTO memory_curation_state
           (workgroup_id, accepted_updates_since_maintenance, maintenance_pending,
            not_before, lease_owner, lease_expires_at, updated_at)
         VALUES (?, 0, 1, ?, NULL, NULL, ?)
         ON CONFLICT(workgroup_id) DO UPDATE SET
           maintenance_pending = 1,
           not_before = excluded.not_before,
           updated_at = excluded.updated_at`,
      )
      .run(workgroupId, now, now);
  } finally {
    archiveDb.close();
  }
}

export const migration051: Migration = {
  version: 51,
  name: 'memory-consolidated-facts',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_consolidated_facts (
        workgroup_id TEXT NOT NULL,
        fact_id      TEXT NOT NULL,
        PRIMARY KEY (workgroup_id, fact_id)
      );
    `);

    const workgroups = db.prepare('SELECT id FROM workgroups').all() as Array<{ id: string }>;
    for (const { id } of workgroups) {
      if (ledgerIsNonEmpty(id)) enqueueMaintenanceBacklog(id);
    }
  },
};
