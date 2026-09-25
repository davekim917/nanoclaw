import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 081 — `thread_key_anchors`
 *
 * WHY. `task_thread_anchors` (migration 048) groups a task session's root
 * posts by UTC day. A watcher that reports incidents wants them grouped by
 * INCIDENT instead: one top-level post per incident, every repeat about that
 * incident in its thread, across midnight, and a fresh top-level post once the
 * incident ends and a new one starts. Only the agent knows what "the same
 * incident" means, so it names it: `send_message({ thread_key })`, carried on
 * the outbound row's content as `threadKey`. This table remembers where each
 * key's first post landed.
 *
 * SHAPE. Keyed by agent group, not session, so a recreated task session keeps
 * threading its open incidents: S19 closes a spent task session,
 * `findSystemSession` matches
 * active rows only, so the series' next scheduling
 * mints a new session id.
 * And per messaging group, not (channel type, platform id): delivery sends
 * through the resolved messaging group's adapter instance
 * (`deliverInstance = mg.instance`), and two instances
 * wired to one conversation are two messaging_groups rows (migration 016) with
 * separate bot identities, so each keeps its own parent.
 *
 * No day rotation: `created_at` is informational only.
 * `last_used_at` moves on every post under the key, and keys unused for the
 * retention window are treated as absent and pruned on write
 * (`src/db/thread-key-anchors.ts`), so the table stays bounded by the number of
 * incidents live in that window.
 *
 * No foreign key, same as 048: a row's only reader is delivery, and a stale
 * row (including one whose messaging group was deleted) ages out through the
 * prune.
 */
export const migration081: Migration = {
  version: 81,
  name: 'thread-key-anchors',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_key_anchors (
        agent_group_id      TEXT NOT NULL,
        messaging_group_id  TEXT NOT NULL,
        thread_key          TEXT NOT NULL,
        thread_platform_id  TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        last_used_at        TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, messaging_group_id, thread_key)
      );
    `);
  },
};
