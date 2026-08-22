import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `observatory_item_assignments` — which agent an ownerless work item was
 * handed to, and when.
 *
 * ## Why the assign path needs a row at all
 *
 * An attention item (DESIGN.md §5 `unassigned`) is derived, not stored: it is
 * recomputed on every poll from a release board plus the claims directory
 * (`src/attention-sources.ts`). Assigning one dispatches a one-shot task; the
 * agent then boots, claims the work, and only THEN does `claimCoversPr`
 * suppress the item. That is minutes away, and until it happens the row is
 * still ownerless — so the operator presses Assign again, and again, each
 * press queueing another task at another agent for the same work.
 *
 * This table is the item's missing memory, and it does two jobs that are the
 * same job:
 *
 *  - **Idempotency.** The PRIMARY KEY is the dedupe, the same shape migration
 *    050 uses for `observatory_item_threads`. The reservation is written
 *    BEFORE the dispatch, so a double-click loses on the insert rather than on
 *    a check-then-act window it can slip through. It also survives a host
 *    restart, which the in-memory map it replaces did not.
 *  - **Visibility.** The list endpoint decorates the row with it, so the item
 *    stops reading as ownerless the moment the assignment lands rather than
 *    when the agent gets around to claiming it.
 *
 * ## Why `assigned_at` is a re-assignment window, not a permanent lock
 *
 * An agent that never picks the work up must not strand it. So the row is
 * upsertable once it is older than the assign path's own dedupe window
 * (`ASSIGN_DEDUPE_MS`) — the refusal is a recency test on this column, not the
 * row's existence. That keeps "assigned two minutes ago, wait for it" and
 * "assigned an hour ago and nothing happened, try someone else" distinguishable
 * without a sweep, an expiry column, or a second state anywhere.
 *
 * Keyed by `(workgroup_id, item_id)` for migration 050's reason, verbatim:
 * board item ids are repo-scoped strings, and two workgroups working the same
 * repo would otherwise share one row.
 *
 * `item_id` is the item's NATURAL id, with no `board:` prefix. The prefix is a
 * rendering concern minted by `readAttentionItems`; storing it would tie this
 * table to a display decision and break the moment a second producer stamps a
 * different one.
 *
 * `assigned_by` is a `users.id`; the display name resolves at read time so a
 * rename is never frozen in. `assigned_at` is written from JS as ISO-8601 UTC,
 * so migration 053's normalizer has nothing to do here and position in the
 * migration list does not matter.
 */
export const migration058: Migration = {
  version: 58,
  name: 'observatory-item-assignments',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS observatory_item_assignments (
        workgroup_id   TEXT NOT NULL,
        item_id        TEXT NOT NULL,
        agent_group_id TEXT NOT NULL,
        assigned_at    TEXT NOT NULL,
        assigned_by    TEXT NOT NULL,
        PRIMARY KEY (workgroup_id, item_id)
      );
    `);
  },
};
