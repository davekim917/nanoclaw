import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'backlog',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ship_log (
        id              TEXT PRIMARY KEY,
        agent_group_id  TEXT NOT NULL,
        title           TEXT NOT NULL,
        description     TEXT,
        pr_url          TEXT,
        branch          TEXT,
        tags            TEXT,
        shipped_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ship_log_agent_group
        ON ship_log(agent_group_id);
      CREATE INDEX IF NOT EXISTS idx_ship_log_shipped_at
        ON ship_log(shipped_at DESC);

      CREATE TABLE IF NOT EXISTS backlog_items (
        id              TEXT PRIMARY KEY,
        agent_group_id  TEXT NOT NULL,
        title           TEXT NOT NULL,
        description     TEXT,
        status          TEXT NOT NULL DEFAULT 'open'
                           CHECK(status IN ('open','in_progress','resolved','wont_fix')),
        priority        TEXT NOT NULL DEFAULT 'medium'
                           CHECK(priority IN ('low','medium','high')),
        tags            TEXT,
        notes           TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        resolved_at     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_backlog_agent_group
        ON backlog_items(agent_group_id);
      CREATE INDEX IF NOT EXISTS idx_backlog_status
        ON backlog_items(status);
      CREATE INDEX IF NOT EXISTS idx_backlog_priority
        ON backlog_items(priority);

      CREATE TABLE IF NOT EXISTS commit_digest_state (
        repo_path       TEXT PRIMARY KEY,
        agent_group_id  TEXT NOT NULL,
        last_commit_sha TEXT NOT NULL,
        last_scan       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_commit_digest_agent_group
        ON commit_digest_state(agent_group_id);
    `);
  },
};
