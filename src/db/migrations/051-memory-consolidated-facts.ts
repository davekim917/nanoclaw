import type Database from 'better-sqlite3';
import type { Migration } from './index.js';
import { enqueueMemoryMaintenanceBacklog } from '../../message-archive.js';
import { readGeneratedMemory } from '../../modules/memory/curator-write.js';
import { parseGeneratedMemoryFacts } from '../../modules/memory/curator-contract.js';

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
 */
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
      const ledger = readGeneratedMemory(id);
      if (parseGeneratedMemoryFacts(ledger.content).length > 0) {
        enqueueMemoryMaintenanceBacklog(id);
      }
    }
  },
};
