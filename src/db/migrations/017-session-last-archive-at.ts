import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * High-water mark for thread-context injection.
 *
 * Per-thread sessions replay missed thread messages from archive.db on wake
 * (see src/thread-context.ts). Without a watermark, each wake would re-inject
 * the same prior context and Claude would see duplicates across turns.
 *
 * `last_archive_at` stores the ISO timestamp of the most recent archive row
 * injected into this session's inbound.db. Next wake queries archive with
 * `sent_at > last_archive_at`, advances the watermark to the new max.
 *
 * Nullable: NULL means "no context has been injected yet", which on first
 * wake becomes a bounded look-back window (last ~30 min / 20 rows).
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
