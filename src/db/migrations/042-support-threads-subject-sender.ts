import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `subject` and `sender`, so the host can recompose the announcement when the session reports its Linear ticket
 * instead of dropping them from the edit.
 */
export const migration042: Migration = {
  version: 42,
  name: 'support-threads-subject-sender',
  up(db: Database.Database) {
    const cols = (db.prepare(`PRAGMA table_info(support_threads)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('subject')) {
      db.exec(`ALTER TABLE support_threads ADD COLUMN subject TEXT;`);
    }
    if (!cols.includes('sender')) {
      db.exec(`ALTER TABLE support_threads ADD COLUMN sender TEXT;`);
    }
  },
};
