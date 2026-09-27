import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * The outbound side of each session, centrally, so the inbox needs no per-session outbound.db opens.
 * `last_outbound_kind` is granular (`chat-sdk:<content.type>` for chat-sdk) so "needs me" derives from one column.
 * NULL means no outbound on record.
 */
export const migration032: Migration = {
  version: 32,
  name: 'sessions-last-outbound',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_outbound_at   TEXT;
      ALTER TABLE sessions ADD COLUMN last_outbound_kind TEXT;
    `);
  },
};
