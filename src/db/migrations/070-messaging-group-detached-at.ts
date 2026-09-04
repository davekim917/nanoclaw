import type { Migration } from './index.js';

/**
 * Detached marker on `messaging_groups`.
 *
 * Set (ISO timestamp) when our own bot LEFT the channel this row maps to —
 * the wiring survives, but delivery attempts are pointless until the bot is
 * re-invited. Cleared (NULL) when the bot rejoins (written by a channel
 * membership module). Deliberately not a delete: history, wirings, and
 * destinations all keep their rows so a rejoin restores the room with zero
 * re-setup.
 *
 * No backfill: existing rows stay NULL (= attached), reproducing pre-migration
 * behavior exactly.
 *
 * Fork note: this is upstream's 022 under upstream's `name`. The file number is
 * 070 so it sorts after this fork's local migrations; `schema_version` keys on
 * `name`, so the number is cosmetic. It is registered after `migration069` for
 * the reason 069 itself is: upstream's 016 RECREATES `messaging_groups` with a
 * fixed column list, and a column added before it would be silently dropped on
 * a fresh database. No fork code reads or writes the column yet.
 */
export const migration070: Migration = {
  version: 70,
  name: 'messaging-group-detached-at',
  up(db) {
    db.exec(`ALTER TABLE messaging_groups ADD COLUMN detached_at TEXT;`);
  },
};
