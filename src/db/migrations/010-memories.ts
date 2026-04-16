import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration010: Migration = {
  version: 10,
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
