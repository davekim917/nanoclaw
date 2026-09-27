import type { Migration } from './index.js';

/**
 * Upstream's 022 under upstream's `name`: set when our bot leaves the channel, cleared on rejoin. No fork code reads
 * or writes it yet. Registered after 069 because upstream's 016 RECREATES `messaging_groups` with a fixed column list
 * and would drop an earlier-added column on a fresh DB.
 */
export const migration070: Migration = {
  version: 70,
  name: 'messaging-group-detached-at',
  up(db) {
    db.exec(`ALTER TABLE messaging_groups ADD COLUMN detached_at TEXT;`);
  },
};
