import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Historical schema compatibility only.
 *
 * Existing installs may contain rows from the retired v1 semantic-memory
 * experiment, so the deterministic migration chain must continue to create
 * and preserve this table. Runtime code has no reader or writer for it. The
 * sole active memory authority is the canonical workgroup Markdown tree.
 */
export const migration013: Migration = {
  version: 13,
  name: 'memories',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id              TEXT PRIMARY KEY,
        agent_group_id  TEXT NOT NULL,
        type            TEXT NOT NULL CHECK(type IN ('user','project','reference','feedback')),
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        content         TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_agent_group
        ON memories(agent_group_id);
      CREATE INDEX IF NOT EXISTS idx_memories_updated
        ON memories(agent_group_id, updated_at DESC);
    `);
  },
};
