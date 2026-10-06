import type { Migration } from './index.js';

/** NULL is the provider default, so there is deliberately no backfill. */
export const migration085: Migration = {
  version: 85,
  name: 'container-config-speed',
  sqliteOnly: true,
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN speed TEXT;`);
  },
};
