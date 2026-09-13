import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Adds optional canonical release scope to the durable choice receipt.  The
 * table predates the scope, so existing/generic rows intentionally stay NULL.
 * Receipt rows attest a resolved action and must never be altered afterwards;
 * deletion remains available to the existing agent-group teardown lifecycle.
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
