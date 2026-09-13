import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migrations, runMigrations } from './index.js';
import { migration080 } from './080-choice-receipt-release-scope.js';

const NAME = 'choice-receipt-release-scope';

function dbBefore080(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(
    db,
    migrations.filter((migration) => migration.name !== NAME),
  );
  return db;
}

function seedReceipt(db: Database.Database, approvalId = 'appr-legacy'): void {
  db.prepare(
    `INSERT INTO choice_receipts
       (approval_id, request_id, action, session_id, value, label, clicker_user_id, resolved_at)
     VALUES (?, 'choice-1', 'request_choice', 'session-1', 'ship', 'Ship', 'slack:user', '2026-09-13T10:00:00.000Z')`,
  ).run(approvalId);
}

describe('migration080 — choice receipt release scope', () => {
  it('upgrades legacy rows without backfill, writes a new nullable scope, and rejects updates', () => {
    const db = dbBefore080();
    seedReceipt(db);

    runMigrations(db, [migration080]);

    expect(
      db.prepare("SELECT release_scope_json FROM choice_receipts WHERE approval_id = 'appr-legacy'").get(),
    ).toEqual({
      release_scope_json: null,
    });
    db.prepare(
      `INSERT INTO choice_receipts
         (approval_id, request_id, action, session_id, value, label, clicker_user_id, release_scope_json, resolved_at)
       VALUES ('appr-scoped', 'choice-2', 'request_choice', 'session-2', 'ship', 'Ship', 'slack:user', ?, '2026-09-13T10:01:00.000Z')`,
    ).run('{"purpose":"release_ship"}');
    expect(() =>
      db.prepare("UPDATE choice_receipts SET value = 'hold' WHERE approval_id = 'appr-scoped'").run(),
    ).toThrow(/immutable/);
    // Existing group teardown deletes receipt rows; only mutation-in-place is forbidden.
    expect(() => db.prepare("DELETE FROM choice_receipts WHERE approval_id = 'appr-scoped'").run()).not.toThrow();
    db.close();
  });

  it('is registered and harmless when its up function is called twice', () => {
    const db = dbBefore080();
    runMigrations(db, [migration080]);
    expect(() => migration080.up(db)).not.toThrow();
    expect(db.prepare('SELECT 1 FROM schema_version WHERE name = ?').get(NAME)).toBeDefined();
    db.close();
  });
});
