import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Effort is a REQUEST parameter no provider bills back, so without these columns a silent config no-op on effort was
 * invisible in the ledger. `effort` is EFFECTIVE (post-clamp, what the provider received); `effort_requested` is
 * pre-clamp. They diverge exactly where the clamp acts (Haiku has no effort control; an out-of-vocabulary `-e` falls
 * back), which is the failure these columns exist to catch.
 * No backfill: NULL means "not recorded", NEVER "ran at no effort". NULLs also persist for no-effort models (`effort`
 * only) and for subagent-model rows on a multi-model turn, which are deliberately not guessed.
 */
export const migration076: Migration = {
  version: 76,
  name: 'turn-usage-effort',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('turn_usage')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const [name, type] of [
      ['effort', 'TEXT'],
      ['effort_requested', 'TEXT'],
    ] as const) {
      if (!cols.has(name)) db.exec(`ALTER TABLE turn_usage ADD COLUMN ${name} ${type}`);
    }
  },
};
