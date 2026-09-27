import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `workgroups.attention_sources`: a JSON array of an install's "work blocked on a human" feeds, each a source KIND
 * trunk can read plus its binding (e.g. `{ "kind": "release-board", "root": "releases", "channel_key":
 * "slack:C0EXAMPLE1" }`). Install identifiers live on the row because the public trunk's boundary check rejects them
 * in source.
 * NULL ("declares nothing") and `'[]'` ("declared, empty") must stay distinct, so there is no default: an empty feed
 * reads as "nothing is blocked on a human", and every state that produces one must stay nameable. No backfill: a
 * trunk update alone changes nothing.
 */
export const migration057: Migration = {
  version: 57,
  name: 'workgroups-attention-sources',
  up(db: Database.Database) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(workgroups)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has('attention_sources')) {
      db.exec('ALTER TABLE workgroups ADD COLUMN attention_sources TEXT');
    }
  },
};
