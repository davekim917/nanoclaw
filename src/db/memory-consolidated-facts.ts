/**
 * `memory_consolidated_facts` — the order-independent membership set that
 * replaces a `captured=`-stamp cursor for pillar-2 consolidation (see
 * docs/specs/workgroup-cerebro/plan.md §P2.4 item 1). A fact id present here,
 * for its workgroup, has already been folded into a topic file; the "tail"
 * consolidation reads each pass is every ledger fact whose id is absent.
 *
 * Central DB (v2.db) — not the per-workgroup archive.db that
 * message-archive.ts owns, and not the workgroup's own generated/memory.md
 * ledger file on disk. This table only ever stores ids.
 */
import { getDb } from './connection.js';

export function markFactsConsolidated(workgroupId: string, factIds: readonly string[]): void {
  if (factIds.length === 0) return;
  const db = getDb();
  const insert = db.prepare('INSERT OR IGNORE INTO memory_consolidated_facts (workgroup_id, fact_id) VALUES (?, ?)');
  db.transaction((ids: readonly string[]) => {
    for (const id of ids) insert.run(workgroupId, id);
  })(factIds);
}

export function consolidatedFactIds(workgroupId: string): Set<string> {
  const rows = getDb()
    .prepare('SELECT fact_id FROM memory_consolidated_facts WHERE workgroup_id = ?')
    .all(workgroupId) as Array<{ fact_id: string }>;
  return new Set(rows.map((row) => row.fact_id));
}

/**
 * Drops every consolidated-fact row for `workgroupId` whose id is no longer
 * in the live ledger (supersession removed the line, so its old marker id
 * will never appear again). Without this, an A→B→A revert — B superseding A,
 * then a later fact reintroducing A's exact text — gets a NEW marker id (the
 * id is a content hash) that lands in the tail correctly, but a stale row
 * for the OLD id just sits here forever; harmless for correctness, but it
 * means this table only ever grows even though the ledger doesn't. Call at
 * the start of every consolidation pass, before tail computation, so a
 * pruned id is immediately tail-eligible again on the same pass. Side
 * benefit: this keeps the table bounded by ledger size instead of by
 * cumulative history.
 *
 * Uses a temp table rather than a parameterized `NOT IN (?,?,...)` list —
 * `liveIds` can run to thousands of entries for a large store, well past a
 * safe SQLite bound-parameter count.
 */
export function pruneConsolidatedFacts(workgroupId: string, liveIds: ReadonlySet<string>): void {
  const db = getDb();
  db.transaction(() => {
    db.exec('CREATE TEMP TABLE _prune_live_ids (fact_id TEXT PRIMARY KEY)');
    try {
      const insert = db.prepare('INSERT INTO _prune_live_ids (fact_id) VALUES (?)');
      for (const id of liveIds) insert.run(id);
      db.prepare(
        `DELETE FROM memory_consolidated_facts
          WHERE workgroup_id = ?
            AND fact_id NOT IN (SELECT fact_id FROM _prune_live_ids)`,
      ).run(workgroupId);
    } finally {
      db.exec('DROP TABLE _prune_live_ids');
    }
  })();
}
