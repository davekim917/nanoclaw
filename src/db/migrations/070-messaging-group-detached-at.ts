import type { Migration } from './index.js';

/**
 * Set when our bot LEFT the channel, cleared when it rejoins. Not a delete, so a rejoin restores history, wirings and
 * destinations with no re-setup. NULL means attached.
 * Upstream's 022 under upstream's `name` (`schema_version` keys on name, so the number is cosmetic). Registered after
 * 069 because upstream's 016 RECREATES `messaging_groups` with a fixed column list and would drop an earlier-added
 * column on a fresh DB.
 */
export const migration070: Migration = {
  version: 70,
  name: 'messaging-group-detached-at',
  up(db) {
    db.exec(`ALTER TABLE messaging_groups ADD COLUMN detached_at TEXT;`);
  },
};
