import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 072 is already applied on live installs. SQLite cannot alter a
 * foreign-key action, so rebuild its workgroup-owned tables with the same
 * columns, keys, and indexes while adding ON DELETE CASCADE.
 */
export const migration073: Migration = {
  version: 73,
  name: 'observatory-signal-workgroup-cascade',
  disableForeignKeys: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE observatory_projects_073 (
        id TEXT PRIMARY KEY,
        workgroup_id TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        repositories TEXT NOT NULL DEFAULT '[]',
        channel_keys TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO observatory_projects_073
        (rowid, id, workgroup_id, name, description, repositories, channel_keys, version, updated_by, updated_at)
        SELECT rowid, id, workgroup_id, name, description, repositories, channel_keys, version, updated_by, updated_at
        FROM observatory_projects;
      DROP TABLE observatory_projects;
      ALTER TABLE observatory_projects_073 RENAME TO observatory_projects;
      CREATE INDEX observatory_projects_workgroup ON observatory_projects(workgroup_id);

      CREATE TABLE observatory_reviews_073 (
        id TEXT PRIMARY KEY,
        workgroup_id TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        version INTEGER NOT NULL,
        record TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO observatory_reviews_073
        (rowid, id, workgroup_id, source_kind, source_id, evidence_hash, version, record, updated_at)
        SELECT rowid, id, workgroup_id, source_kind, source_id, evidence_hash, version, record, updated_at
        FROM observatory_reviews;
      DROP TABLE observatory_reviews;
      ALTER TABLE observatory_reviews_073 RENAME TO observatory_reviews;
      CREATE INDEX observatory_reviews_workgroup ON observatory_reviews(workgroup_id);
    `);
  },
};
