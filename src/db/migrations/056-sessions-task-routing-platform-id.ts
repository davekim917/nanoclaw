import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * A task session's ROUTING STAMP: the `platform_id` where an unaddressed reply lands, NOT where the task posts (the
 * agent picks a destination per fire; `task_thread_anchors` records where posts landed). Hence the console's
 * precedence is anchor → stamp → fallback.
 * Not `messaging_group_id`: `messaging_group_id === null` is the load-bearing task-session discriminator in
 * `src/delivery.ts` (the `task_log` branch and `isTaskSessionPost`), and setting it would silently stop run-log
 * appends.
 * No backfill: the only source is each session's inbound.db, and a migration must not open thousands of session
 * files. Old rows gain the stamp when their series is next scheduled.
 */
export const migration056: Migration = {
  version: 56,
  name: 'sessions-task-routing-platform-id',
  up(db: Database.Database) {
    const columns = new Set((db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name));
    if (!columns.has('task_routing_platform_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN task_routing_platform_id TEXT');
    }
  },
};
