import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/** Durable first-stage idempotency for platform message replay. */
export const migration044: Migration = {
  version: 44,
  name: 'channel-ingress-receipts',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_ingress_receipts (
        channel_type TEXT NOT NULL,
        instance TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'deferred', 'completed')),
        claimed_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (channel_type, instance, platform_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_channel_ingress_receipts_completed
        ON channel_ingress_receipts(completed_at)
        WHERE status = 'completed';

      CREATE INDEX IF NOT EXISTS idx_channel_ingress_receipts_deferred
        ON channel_ingress_receipts(claimed_at)
        WHERE status = 'deferred';
    `);
  },
};
