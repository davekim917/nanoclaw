/** Persist the decision context needed to keep approval cards informative after resolution. */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration045: Migration = {
  version: 45,
  name: 'approval-question-render-metadata',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE pending_questions ADD COLUMN question TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN question TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE pending_channel_approvals ADD COLUMN question TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE pending_sender_approvals ADD COLUMN question TEXT NOT NULL DEFAULT ''`);
  },
};
