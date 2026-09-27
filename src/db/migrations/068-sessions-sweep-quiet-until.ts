import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * The host sweep's quiet mark, made durable so a restart does not force a sweep of every active session on the first
 * tick; `startHostSweep` warms its map from it. ISO-8601 UTC like `last_active`, compared through `datetime()`. NULL
 * means no mark (sweep it); no backfill, since the value is a prediction from each session's inbound.db.
 * Invalidation contract: a mark must never outlive a change to when the session next has work due. Only
 * `updateSession` (same statement as `last_active`) and `withQuietInvalidationSync` (required immediately before any
 * due-ness write, in the same synchronous turn) clear it; a raw-SQL `last_active` writer elsewhere would silently
 * reintroduce the defect.
 */
export const migration068: Migration = {
  version: 68,
  name: 'sessions-sweep-quiet-until',
  up: (db: Database.Database) => {
    db.exec('ALTER TABLE sessions ADD COLUMN sweep_quiet_until TEXT');
  },
};
