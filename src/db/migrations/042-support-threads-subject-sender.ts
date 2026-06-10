import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 042 — support-threads subject + sender
 *
 * Adds `subject` and `sender` to `support_threads` so the host can recompose
 * the channel announcement (🎫 TEAM ISSUE: subject — sender) when the
 * per-issue session reports its Linear ticket via `update_support_ticket`.
 * Without these, the post-ticket edit would have to drop the subject/sender
 * from the announcement — losing the at-a-glance context the parent message
 * exists to provide. 041 shipped before this was caught; the table is empty
 * in prod, so a plain additive ALTER is safe.
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
