import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration083: Migration = {
  version: 83,
  name: 'work-outcome-receipts',
  up(db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_outcome_receipts (
      workgroup_id TEXT NOT NULL,
      work_item TEXT NOT NULL,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('sending','delivered','uncertain','retry')),
      platform_message_id TEXT,
      channel_type TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      thread_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolution TEXT,
      PRIMARY KEY(workgroup_id, work_item)
    )`);
  },
};
