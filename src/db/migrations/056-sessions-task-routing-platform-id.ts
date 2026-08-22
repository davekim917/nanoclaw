import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `sessions.task_routing_platform_id` — a task session's ROUTING STAMP.
 *
 * ## What it is, and what it is NOT
 *
 * `ncl tasks` describes itself as "tasks run from the agent group system
 * session and the agent chooses delivery destination at fire time", and the
 * creation-time routing flags are documented as "Routing (where an unaddressed
 * reply lands)". So the value stamped here is the task's DEFAULT landing place
 * — `messaging_groups.platform_id`, already in channel-key shape — not a claim
 * about where the task has posted or will post. The agent can address a
 * different destination on any fire, and `task_thread_anchors` is the table
 * that records where a post ACTUALLY landed.
 *
 * That distinction is why the console's precedence is anchor → stamp →
 * fallback and not the other way round (`buildThreadList` in
 * `src/dashboard/api/threads.ts`). Do not read this column as "the channel
 * this task belongs to", and do not rename it into something that says so.
 *
 * ## Why a new column instead of `messaging_group_id`
 *
 * The obvious-looking move — give task sessions the `messaging_group_id` they
 * were routed to — is a trap. `sessions.messaging_group_id === null` is a
 * LOAD-BEARING discriminator for task sessions in two places in
 * `src/delivery.ts`: the `task_log` branch (which appends a run's final text to
 * the series log) and `isTaskSessionPost` (which drives the rolling
 * `task_thread_anchors` day-thread). Backfilling a messaging group would send
 * `task_log` rows down the else branch — "task_log row outside a task session
 * — ignoring" — and silently stop run-log appends. So the routing stamp gets
 * its own column and the NULL stays NULL.
 *
 * ## No backfill
 *
 * Deliberate. The stamp's only source is the task's `messages_in` row, which
 * lives in a per-session `inbound.db`, and a migration must not open thousands
 * of session files to reconstruct it (the same rule migration 052's header
 * states for `engaged_at`). Central data holds nothing equivalent. Pre-existing
 * rows stay NULL and keep the current anchor-or-fallback behavior exactly,
 * which is not a regression — they gain the stamp the next time their series is
 * (re)scheduled through `resolveTaskSession`.
 *
 * Nothing here writes a timestamp, so migration 053's naive-timestamp
 * normalizer has nothing to do with this column and ordering does not matter.
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
