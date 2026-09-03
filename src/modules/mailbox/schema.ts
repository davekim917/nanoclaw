/**
 * Session-DB schema creation and the fork's additive migrations.
 *
 * Internal to `src/modules/mailbox/`. The fork's on-disk shape is upstream's
 * baseline plus: `repo_ingress_fence`, `messages_in.repo_fence_epoch` /
 * `.repo_fence_original_trigger` and their four guard triggers,
 * `idx_messages_in_series_seq`, `session_routing.spawn_task_id` / `.session_id`,
 * `delivered.error`, and the `container_state` provider/memory columns. Every
 * migration here is idempotent and guarded by `PRAGMA table_info`, so it is
 * safe to run on every open — that lazy, on-open shape IS the upgrade path for
 * session DBs (there is no central migration for them).
 */
import Database from 'better-sqlite3';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../db/schema.js';

/** Apply the inbound or outbound schema to a DB file. Idempotent. */
export function ensureSchema(dbPath: string, schema: 'inbound' | 'outbound'): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  if (schema === 'inbound') {
    const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_in'").get();
    if (existing) migrateMessagesInTable(db);
    ensureNanoclawInboundSchema(db);
  } else {
    db.exec(OUTBOUND_SCHEMA);
    const containerColumns = new Set(
      (db.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!containerColumns.has('provider_executing')) {
      db.exec('ALTER TABLE container_state ADD COLUMN provider_executing INTEGER NOT NULL DEFAULT 0');
    }
  }
  db.close();
}

/**
 * Ensure session_routing has the spawn_task_id and session_id columns the
 * upsert needs. Handles three cases idempotently:
 *   1. Pre-Phase-1 sessions (no extra columns)            → ADD spawn_task_id + session_id
 *   2. Phase-1 sessions (have legacy dispatch_task_id)    → RENAME to spawn_task_id
 *   3. Post-rework sessions (already have spawn_task_id)  → no-op
 *
 * SQLite ALTER TABLE RENAME COLUMN requires 3.25+ (better-sqlite3 ships 3.45+).
 */
export function migrateSessionRoutingTable(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(session_routing)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (existing.has('dispatch_task_id') && !existing.has('spawn_task_id')) {
    db.exec('ALTER TABLE session_routing RENAME COLUMN dispatch_task_id TO spawn_task_id');
    existing.delete('dispatch_task_id');
    existing.add('spawn_task_id');
  }
  for (const col of ['spawn_task_id TEXT', 'session_id TEXT']) {
    const colName = col.split(' ')[0]!;
    if (!existing.has(colName)) {
      db.exec(`ALTER TABLE session_routing ADD COLUMN ${col}`);
    }
  }
}

/** Ensure the delivered table has columns added after initial schema. */
export function migrateDeliveredTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('platform_message_id')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN platform_message_id TEXT').run();
  }
  if (!cols.has('status')) {
    db.prepare("ALTER TABLE delivered ADD COLUMN status TEXT NOT NULL DEFAULT 'delivered'").run();
  }
  if (!cols.has('error')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN error TEXT').run();
  }
}

/**
 * The four repository-ingress guard triggers.
 *
 * Lives here rather than in `ops/fence.ts` (where the rest of the fence
 * subsystem sits) because `migrateMessagesInTable` installs them and the fence
 * ops call `migrateMessagesInTable` — the other placement makes schema.ts and
 * ops/fence.ts a static import cycle for no gain. Trigger creation is schema.
 */
function installRepoIngressFenceGuards(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_in_repo_fence_insert_guard
    BEFORE INSERT ON messages_in
    WHEN
      (NEW.repo_fence_epoch IS NULL AND NEW.repo_fence_original_trigger IS NOT NULL)
      OR (NEW.repo_fence_epoch IS NOT NULL AND NEW.repo_fence_original_trigger IS NULL)
      OR (NEW.repo_fence_epoch IS NOT NULL AND NEW.trigger <> 0)
      OR (NEW.repo_fence_original_trigger IS NOT NULL AND NEW.repo_fence_original_trigger NOT IN (0, 1))
    BEGIN
      SELECT RAISE(ABORT, 'repository-fenced inbound rows must be tagged, inert, and retain their original trigger');
    END;

    CREATE TRIGGER IF NOT EXISTS messages_in_repo_fence_update_guard
    BEFORE UPDATE OF trigger, repo_fence_epoch, repo_fence_original_trigger ON messages_in
    WHEN
      (NEW.repo_fence_epoch IS NULL AND NEW.repo_fence_original_trigger IS NOT NULL)
      OR (NEW.repo_fence_epoch IS NOT NULL AND NEW.repo_fence_original_trigger IS NULL)
      OR (NEW.repo_fence_epoch IS NOT NULL AND NEW.trigger <> 0)
      OR (NEW.repo_fence_original_trigger IS NOT NULL AND NEW.repo_fence_original_trigger NOT IN (0, 1))
    BEGIN
      SELECT RAISE(ABORT, 'repository-fenced inbound rows must be tagged, inert, and retain their original trigger');
    END;

    CREATE TRIGGER IF NOT EXISTS messages_in_repo_fence_auto_tag_insert
    AFTER INSERT ON messages_in
    WHEN NEW.repo_fence_epoch IS NULL
      AND EXISTS (SELECT 1 FROM repo_ingress_fence WHERE id = 1 AND state = 'active')
    BEGIN
      UPDATE messages_in
      SET repo_fence_epoch = (SELECT epoch FROM repo_ingress_fence WHERE id = 1),
          repo_fence_original_trigger = NEW.trigger,
          trigger = 0
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS messages_in_repo_fence_auto_tag_trigger_update
    AFTER UPDATE OF trigger ON messages_in
    WHEN NEW.repo_fence_epoch IS NULL
      AND NEW.trigger = 1
      AND EXISTS (SELECT 1 FROM repo_ingress_fence WHERE id = 1 AND state = 'active')
    BEGIN
      UPDATE messages_in
      SET repo_fence_epoch = (SELECT epoch FROM repo_ingress_fence WHERE id = 1),
          repo_fence_original_trigger = NEW.trigger,
          trigger = 0
      WHERE id = NEW.id;
    END;
  `);
}

// LEGACY-COMPAT(v1-tasks): adds columns added to messages_in after the initial
// v2 schema to pre-existing session DBs — this lazy, on-open migration IS the
// upgrade path for old installs (there is no central migration for session
// DBs). No-op on fresh installs where the columns are in the baseline schema.
// Backfills existing rows so invariants hold (series_id = id).
export function migrateMessagesInTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('series_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN series_id TEXT').run();
    db.prepare('UPDATE messages_in SET series_id = id WHERE series_id IS NULL').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id)').run();
  }
  if (!cols.has('trigger')) {
    // All pre-existing rows got written with the old "every inbound wakes
    // the agent" semantics, so backfill 1 and default 1 for new inserts.
    db.prepare('ALTER TABLE messages_in ADD COLUMN trigger INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.has('source_session_id')) {
    // For agent-to-agent return-path routing. NULL on existing rows is fine —
    // their replies fall back to the legacy "newest active session" lookup.
    db.prepare('ALTER TABLE messages_in ADD COLUMN source_session_id TEXT').run();
  }
  if (!cols.has('on_wake')) {
    // 1 = only deliver on the container's first poll (fresh start).
    // All existing rows are normal messages, so default 0.
    db.prepare('ALTER TABLE messages_in ADD COLUMN on_wake INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!cols.has('scheduled_for')) {
    // ALTER and backfill in ONE transaction. SQLite makes DDL transactional,
    // and better-sqlite3 nests via SAVEPOINT, so this is safe wherever the
    // migration is called from. Split, a crash between the two statements
    // leaves the column present and every legacy task's slot NULL — and
    // because the next open sees the column in PRAGMA table_info, the backfill
    // never runs again. The first retry after that would rewrite
    // `process_after`, the formatter would fall back to the backoff deadline,
    // and the regression this column exists to prevent would be permanent.
    db.transaction(() => {
      db.prepare('ALTER TABLE messages_in ADD COLUMN scheduled_for TEXT').run();
      // Backfilled from process_after for existing TASK rows, once, here.
      //
      // Leaving them NULL looks conservative and is not: a legacy occurrence
      // would carry no slot until something rewrote it, so its FIRST crash after
      // the upgrade would defer process_after, the formatter would fall back to
      // the backoff deadline, and the exact defect this column exists to prevent
      // would reproduce on every pre-migration task.
      //
      // The backfill is never worse than NULL. For a row not currently deferred,
      // process_after IS its slot and this is simply correct. For one already
      // sitting in backoff the value is the deadline — but that is precisely what
      // the NULL fallback would have rendered anyway, so nothing is lost, and the
      // next genuine reschedule corrects it.
      //
      // At the migration seam rather than in each deferral path: `scheduled_for`
      // has to be present before ANY writer of process_after runs, and there is
      // more than one (fresh-context retry, stale-message backoff). One statement
      // here covers every such path, including ones added later.
      //
      // Through strftime, not a bare copy. `process_after` on a pre-upgrade
      // install can hold SQLite's naive `YYYY-MM-DD HH:MM:SS`, and copying
      // that shape verbatim would seed the new column with values that
      // `new Date()` reads as LOCAL time and that string comparisons rank
      // against ISO ones. strftime treats a naive value as UTC — which is what
      // it is — and re-renders an already-ISO one unchanged, so one expression
      // normalizes both. This is the root fix: no naive `scheduled_for` is
      // ever created, so no reader downstream has to cope with one.
      db.prepare(
        `UPDATE messages_in
            SET scheduled_for = strftime('%Y-%m-%dT%H:%M:%fZ', process_after)
          WHERE kind = 'task' AND process_after IS NOT NULL`,
      ).run();
    })();
  }
  if (!cols.has('repo_fence_epoch')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN repo_fence_epoch TEXT').run();
  }
  if (!cols.has('repo_fence_original_trigger')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN repo_fence_original_trigger INTEGER').run();
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_ingress_fence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch TEXT NOT NULL,
      generation TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'released'))
    )
  `);
  const fenceCols = new Set(
    (db.prepare("PRAGMA table_info('repo_ingress_fence')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!fenceCols.has('generation')) {
    db.prepare('ALTER TABLE repo_ingress_fence ADD COLUMN generation TEXT').run();
    db.prepare('UPDATE repo_ingress_fence SET generation = lower(hex(randomblob(16))) WHERE generation IS NULL').run();
  }
  installRepoIngressFenceGuards(db);
  // Read-path enabler for the Scheduled Tasks Board (design §4.8). Added
  // unconditionally — existing DBs already carry `series_id` (so the branch
  // above is skipped) yet still need this compound index. Created on the next
  // write-path open; board read-only opens tolerate its absence and fall back
  // to the scan. Idempotent via IF NOT EXISTS. Read-path only; C1 untouched.
  db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_in_series_seq ON messages_in(series_id, seq DESC)').run();
}

/**
 * Run every fork-side inbound migration against an already-open handle.
 *
 * The single entry point `NanoclawAgentMailbox.session()` uses, once per
 * inbound path per process. Additive and `PRAGMA table_info`-guarded
 * throughout, so it is safe on a DB that already has the current shape and on
 * a legacy one that has none of it.
 *
 * The baseline runs FIRST, and unconditionally. A legacy DB can predate
 * `session_routing` or `delivered` entirely, and an additive migration against
 * an absent table either throws or (if guarded) silently leaves it absent —
 * after which the next spawn's `writeSessionRouting` fails on
 * `ALTER TABLE session_routing` for that session, every time. `CREATE TABLE IF
 * NOT EXISTS` throughout, so it is a no-op on a current DB. This is what
 * `initSessionFolder`'s unconditional `ensureSchema` has always done.
 */
export function ensureNanoclawInboundSchema(db: Database.Database): void {
  db.exec(INBOUND_SCHEMA);
  migrateMessagesInTable(db);
  migrateSessionRoutingTable(db);
  migrateDeliveredTable(db);
}
