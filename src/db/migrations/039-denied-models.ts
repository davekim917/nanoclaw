import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Replaces the 037 allowlist with a `denied_models` blocklist: `opencode models` already enumerates the reachable set
 * live inside the container, and the operator need is "never this slug". `slug` is matched exactly, prefix included.
 * No seed data.
 */
export const migration039: Migration = {
  version: 39,
  name: 'denied-models',
  up(db: Database.Database) {
    db.exec(`DROP TABLE IF EXISTS provider_models;`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS denied_models (
        provider   TEXT NOT NULL,
        slug       TEXT NOT NULL,
        reason     TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (provider, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_denied_models_provider ON denied_models(provider);
    `);
  },
};
