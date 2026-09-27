/**
 * Per-agent-group provider availability, so a spawn can route around an exhausted account instead of waking a
 * container that can only fail.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration046: Migration = {
  version: 46,
  name: 'provider-health',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_health (
        agent_group_id      TEXT NOT NULL,
        provider            TEXT NOT NULL,
        unavailable_until   TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error_class    TEXT,
        last_error_message  TEXT,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, provider),
        FOREIGN KEY (agent_group_id) REFERENCES agent_groups(id) ON DELETE CASCADE
      )
    `);
  },
};
