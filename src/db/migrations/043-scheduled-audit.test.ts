import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration043 } from './043-scheduled-audit.js';

/**
 * Tests for migration 043 — scheduled_audit table (design §4.4).
 *
 * The full migration chain is applied via runMigrations (which now includes
 * migration043), then assertions confirm the table + indexes + columns match
 * the spec. Idempotency is verified by re-running migration043.up directly.
 */
function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  // runMigrations applies 001..043 (043 is the last registered entry).
  runMigrations(db);
  return db;
}

function tableNames(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
}

function indexNames(db: Database.Database, table: string): Set<string> {
  // PRAGMA does not accept bound parameters; `table` is a test-literal.
  return new Set((db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
}

describe('migration043', () => {
  it('test_migration043_creates_table', () => {
    const db = makeMigratedDb();

    // Table exists.
    expect(tableNames(db).has('scheduled_audit')).toBe(true);

    // The three named indexes exist.
    const idx = indexNames(db, 'scheduled_audit');
    expect(idx.has('idx_scheduled_audit_series')).toBe(true);
    expect(idx.has('idx_scheduled_audit_correlation')).toBe(true);
    expect(idx.has('idx_scheduled_audit_unresolved')).toBe(true);

    // Columns match the spec.
    const cols = new Set(
      (db.prepare('PRAGMA table_info(scheduled_audit)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const c of [
      'id',
      'ts',
      'actor',
      'action',
      'agent_group_id',
      'session_id',
      'series_id',
      'before_hash',
      'after_hash',
      'before_preview',
      'after_preview',
      'before_len',
      'after_len',
      'detail_json',
      'correlation_id',
      'resolved_at',
    ]) {
      expect(cols.has(c)).toBe(true);
    }

    db.close();
  });

  it('action column accepts the full action enum (no CHECK constraint)', () => {
    const db = makeMigratedDb();
    const actions = ['edit', 'pause', 'resume', 'run_now', 'cancel', 'move', 'move_intent', 'move_restore_failed'];
    for (const action of actions) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO scheduled_audit (actor, action, agent_group_id, session_id, series_id)
             VALUES (?, ?, 'ag', 'sess', 'S')`,
          )
          .run('owner:1', action),
      ).not.toThrow();
    }
    const count = (db.prepare('SELECT COUNT(*) AS c FROM scheduled_audit').get() as { c: number }).c;
    expect(count).toBe(actions.length);
    db.close();
  });

  it('ts defaults to a datetime when omitted', () => {
    const db = makeMigratedDb();
    db.prepare(
      `INSERT INTO scheduled_audit (actor, action, agent_group_id, session_id, series_id)
       VALUES ('owner:1', 'edit', 'ag', 'sess', 'S')`,
    ).run();
    const row = db.prepare('SELECT ts FROM scheduled_audit WHERE id = 1').get() as { ts: string | null };
    expect(row.ts).toBeTruthy();
    db.close();
  });

  it('test_migration043_idempotent', () => {
    const db = makeMigratedDb();
    // Re-running the migration's up() must be a no-op — no throw, table/indexes intact.
    expect(() => migration043.up(db)).not.toThrow();

    expect(tableNames(db).has('scheduled_audit')).toBe(true);
    const idx = indexNames(db, 'scheduled_audit');
    expect(idx.has('idx_scheduled_audit_series')).toBe(true);
    expect(idx.has('idx_scheduled_audit_correlation')).toBe(true);
    expect(idx.has('idx_scheduled_audit_unresolved')).toBe(true);
    db.close();
  });

  it('migration043 is registered in the migrations array after 042', () => {
    // A fresh DB run through runMigrations records scheduled-audit in
    // schema_version, proving it is wired into the barrel array.
    const db = makeMigratedDb();
    const names = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('scheduled-audit');
    expect(names).toContain('support-threads-subject-sender'); // 042 present too
    db.close();
  });
});
