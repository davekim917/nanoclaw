import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * High-water mark for thread-context injection (src/thread-context.ts): each wake injects only archive rows with
 * `sent_at > last_archive_at`, so context is not duplicated across turns. NULL means nothing injected yet, which
 * becomes a bounded look-back on first wake.
 */
export const migration017: Migration = {
  version: 17,
  name: 'session-last-archive-at',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('last_archive_at')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN last_archive_at TEXT`);
    }
  },
};
