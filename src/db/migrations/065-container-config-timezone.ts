import type { Migration } from './index.js';

/**
 * Per-agent-group timezone override on `container_configs`.
 *
 * NULL = follow the install-global timezone (TZ in .env / system), matching
 * pre-migration behavior for every existing row — deliberately no backfill.
 * A non-NULL value is a validated IANA id (rejected at the ncl write path);
 * it grounds host-side scheduling (cron parsing, --process-after, run-log
 * stamps) immediately and the container's TZ env on next respawn.
 *
 * File number is 065 to slot after this fork's local migrations; the `name`
 * is upstream's, which is what `schema_version` keys on.
 */
export const migration065: Migration = {
  version: 65,
  name: 'container-config-timezone',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN timezone TEXT;`);
  },
};
