import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration064: Migration = {
  version: 64,
  name: 'container-security-config',
  up(db: Database.Database) {
    // Nullable: existing rows get NULL → hardcoded safe defaults apply at read time.
    db.prepare('ALTER TABLE container_configs ADD COLUMN security_json TEXT').run();
  },
};
