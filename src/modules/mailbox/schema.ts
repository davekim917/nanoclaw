/**
 * Session-DB schema creation and the fork's additive migrations. Every
 * migration is idempotent and `PRAGMA table_info`-guarded, so it is safe to
 * repeat; it runs lazily on writable opens (read-only opens never migrate), and
 * that IS the upgrade path (no central migration exists for session DBs).
 */
import Database from 'better-sqlite3';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../db/schema.js';
import {
  migrateDeliveredTable as migrateUpstreamDeliveredColumns,
  migrateMessagesInTable as migrateUpstreamMessagesInColumns,
} from '../../mailbox/sqlite/session-db.js';

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
 * Idempotent across three shapes: no extra columns (ADD), legacy
 * `dispatch_task_id` (RENAME, needs SQLite 3.25+), already current (no-op).
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

export function migrateDeliveredTable(db: Database.Database): void {
  migrateUpstreamDeliveredColumns(db);
  const cols = new Set(
    (db.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('error')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN error TEXT').run();
  }
  if (!cols.has('lifecycle_terminal_at')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN lifecycle_terminal_at TEXT').run();
  }
  if (!cols.has('notice')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN notice TEXT').run();
  }
  if (!cols.has('task_list_route')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN task_list_route TEXT').run();
  }
}

/** Here, not ops/fence.ts, because placing it there makes a static import cycle. */
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

export function migrateMessagesInTable(db: Database.Database): void {
  migrateUpstreamMessagesInColumns(db);
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('scheduled_for')) {
    // ALTER and backfill in ONE transaction: split, a crash leaves the column
    // present and the backfill never runs again (the next open sees the column).
    db.transaction(() => {
      db.prepare('ALTER TABLE messages_in ADD COLUMN scheduled_for TEXT').run();
      // Backfill TASK rows from process_after; NULL would make a legacy task's
      // first post-upgrade crash lose its slot. Done here because it must precede
      // every writer of process_after.
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
  // Unconditional: existing DBs skip the series_id branch above but still need
  // this index. Board read-only opens tolerate its absence.
  db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_in_series_seq ON messages_in(series_id, seq DESC)').run();
}

/**
 * Every fork-side inbound migration: `session()` runs it once per inbound path
 * per process, `ensureSchema` on every call.
 * The baseline runs FIRST and unconditionally: a legacy DB can predate whole
 * tables, and an additive migration against an absent table throws or leaves it
 * absent.
 */
export function ensureNanoclawInboundSchema(db: Database.Database): void {
  db.exec(INBOUND_SCHEMA);
  migrateMessagesInTable(db);
  migrateSessionRoutingTable(db);
  migrateDeliveredTable(db);
}
