import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `workgroups.attention_sources` — where an install declares its own
 * "work blocked on a human" feeds.
 *
 * ## What it is
 *
 * A JSON array of source declarations, each naming a source KIND that trunk
 * knows how to read plus the binding it needs to read one:
 *
 * ```json
 * [{ "kind": "release-board", "root": "releases", "channel_key": "slack:C0EXAMPLE1" }]
 * ```
 *
 * Trunk ships the generic reader; the install ships the identifiers. That
 * split is not cosmetic — this fork's trunk is public and
 * `scripts/check-public-boundary.ts` rejects install-specific channel ids and
 * workgroup names in source, so a producer that hardcodes them cannot land at
 * all. Declaring them here is the same move `onecli_secrets` already made on
 * this table: install config lives on the row, not in `.env`, not in source,
 * and not in a new config file nobody remembers to look at.
 *
 * ## Why `workgroups` and not somewhere else
 *
 * The workgroup is already the data-pool boundary (CLAUDE.md: chat archive,
 * Graphify retrieval, shared files, OneCLI declarations) AND the console's
 * primary filter axis (DESIGN.md §3.5). A feed of ownerless work items is
 * scoped to exactly one workgroup's pool of files, and the console filters it
 * on exactly that axis. Any other home would need a join to answer both
 * questions this column answers for free.
 *
 * ## NULL vs `'[]'` — the distinction is load-bearing
 *
 * Nullable with NO default, unlike `onecli_secrets`. NULL means "this
 * workgroup declares nothing", `'[]'` means "declared, and empty". They are
 * both read as "emit no items", but they are not the same fact and a default
 * would erase the difference. The whole feature exists because an empty feed
 * reads as "nothing is blocked on a human" — the one lie it must not tell —
 * so every state that produces an empty feed stays separately nameable.
 *
 * ## No backfill
 *
 * There is nothing to backfill from. A declaration names an install-specific
 * channel and a directory layout; no central data implies either. Existing
 * rows stay NULL and every existing install therefore behaves exactly as it
 * did before this migration, which is the point: a trunk update alone changes
 * nothing until an operator writes a declaration.
 *
 * Nothing here writes a timestamp, so migration 053's naive-timestamp
 * normalizer has nothing to do with this column and ordering does not matter.
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
