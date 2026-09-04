/**
 * Record where `messaging_groups.name` came from, so a later refresh can tell
 * whether it is allowed to overwrite it.
 *
 * Two writers produce a channel name and they are not equally informed: the
 * generic per-channel metadata fetch (`reportChannelMetadata`, chat-sdk-bridge)
 * returns whatever raw string the platform puts on the conversation, while the
 * classification seam (`resolveConversation` / `resolveChannelName`) can enrich
 * it — a Slack MPDM has no name a human recognizes, so it is named by its
 * participant roster. Without provenance the raw fetch looks exactly like a
 * platform-side rename and clobbers the enriched answer on every host restart.
 *
 * Value shape is `"<platform>:<source>"` (e.g. `slack:classified`), written and
 * read only through `channelNameProvenance` / `parseChannelNameProvenance` in
 * `src/db/messaging-groups.ts`.
 *
 * Backfill: every already-named row is stamped `<channel_type>:adapter`, which
 * is both the likeliest truth (before this column, the raw fetch overwrote the
 * name on every restart, so it is what is sitting in the column) and the
 * behavior-preserving choice — an adapter-sourced name still accepts an adapter
 * refresh, exactly as these rows did before. Rows with no name stay NULL; an
 * empty name slot accepts any source.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration069: Migration = {
  version: 69,
  name: 'messaging-group-name-source',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (cols.has('name_source')) return;
    db.exec(`ALTER TABLE messaging_groups ADD COLUMN name_source TEXT`);
    db.exec(`UPDATE messaging_groups SET name_source = channel_type || ':adapter' WHERE name IS NOT NULL`);
  },
};
