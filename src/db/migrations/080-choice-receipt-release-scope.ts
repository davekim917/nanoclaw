import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Existing and generic rows stay NULL. Receipt rows attest a resolved action and are never altered afterwards; only
 * agent-group teardown deletes them.
 */
export const migration080: Migration = {
  version: 80,
  name: 'choice-receipt-release-scope',
  up(db: Database.Database) {
    const columns = db.prepare("PRAGMA table_info('choice_receipts')").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'release_scope_json')) {
      db.exec('ALTER TABLE choice_receipts ADD COLUMN release_scope_json TEXT');
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS choice_receipts_reject_update
      BEFORE UPDATE ON choice_receipts
      BEGIN
        SELECT RAISE(ABORT, 'choice receipts are immutable');
      END;
    `);
  },
};
