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
