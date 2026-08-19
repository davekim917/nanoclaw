import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Migration } from './index.js';
import { DATA_DIR } from '../../config.js';

/**
 * Migration 051 — memory_consolidated_facts
 *
 * Pillar-2 semantic consolidation (docs/specs/workgroup-cerebro/plan.md
 * §P2.4) tracks which episodic-ledger facts have already been folded into a
 * curator-maintained topic file with an order-independent membership set
 * rather than a `captured=`-stamp cursor — a late-arriving or
 * equal-timestamped episode can otherwise land at or behind a cursor and be
 * skipped forever. The "tail" a pass consolidates is every ledger fact whose
 * marker id is absent from this table for its workgroup.
 *
 * Backfill: every workgroup whose ledger already holds at least one fact is
 * enqueued for maintenance one time, so existing stores are not stuck
 * waiting for 50 NEW updates before their first consolidation pass. The
 * fleet-wide claim/lease serialization (one maintenance job claimed per host
 * sweep tick) plus the 150-fact-per-pass cap mean this enqueue does not
 * storm — it bounds to one pass per sweep round per workgroup.
 *
 * DELIBERATELY SELF-CONTAINED. A migration is frozen logic: once it has
 * shipped, its behavior must never move underneath it just because an
 * application module it happened to import changed shape later. This one
 * used to call into message-archive.ts and modules/memory/curator-*.ts for
 * the ledger read and the maintenance-pending upsert; migrations/index.ts is
 * loaded by every DB-touching test, so that pulled curator-contract.ts's
 * `../../secret-scrubber.js` import — and its `setLogScrubber(scrubSecrets)`
 * module-load side effect — into the import graph of tests that partial-mock
 * `log.js` and never expected it, breaking them at collection. The ledger
 * read below (path join + a marker substring check) and the
 * `memory_curation_state` upsert below are therefore hand-duplicated from
 * `workgroupMemoryDir`/`readGeneratedMemory` and
 * `enqueueMemoryMaintenanceBacklog` respectively — on purpose. Do not
 * "simplify" this back to an application import.
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
    // Mirrors only the one table this backfill touches — archive.db's full
    // self-bootstrapping schema lives in message-archive.ts and is not
    // duplicated here; CREATE TABLE IF NOT EXISTS makes this safe whether
    // that schema has already run on this file or not.
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
