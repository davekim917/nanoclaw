import type { Migration } from './index.js';

export const SIGNAL_SCHEMA = `
  CREATE TABLE observatory_projects (
    id TEXT PRIMARY KEY,
    workgroup_id TEXT NOT NULL REFERENCES workgroups(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    repositories TEXT NOT NULL DEFAULT '[]',
    channel_keys TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX observatory_projects_workgroup ON observatory_projects(workgroup_id);
  CREATE TABLE observatory_reviews (
    id TEXT PRIMARY KEY,
    workgroup_id TEXT NOT NULL REFERENCES workgroups(id),
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,
    version INTEGER NOT NULL,
    record TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX observatory_reviews_workgroup ON observatory_reviews(workgroup_id);
`;
export const migration072: Migration = {
  version: 72,
  name: 'observatory-signal',
  up(db) {
    db.exec(SIGNAL_SCHEMA);
  },
};
