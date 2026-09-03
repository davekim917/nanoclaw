/**
 * Record the delivering adapter instance on `pending_approvals`.
 *
 * Card delivery resolves an approver's DM through `ensureUserDm`, whose
 * registry lookup falls back across instances of a channel type. Dispatch on
 * the way back out is exact-key, so an edit addressed to the bare channel
 * type finds no adapter at all on an install whose bots are all named
 * instances — the expiry/late-decision edit silently no-ops and the card
 * keeps showing live buttons that resolve nothing.
 *
 * Nullable: rows written before this column existed fall back to the channel
 * type, which is the correct key on single-instance installs.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration066: Migration = {
  version: 66,
  name: 'approvals-instance',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN instance TEXT`);
  },
};
