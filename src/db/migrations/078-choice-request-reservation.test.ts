/**
 * Migration 078's LEGACY-DUPLICATE CLEANUP, exercised on a database that
 * actually holds duplicates before the migration runs.
 *
 * The reservation tests in src/modules/interactive/choice-reservation.test.ts
 * start from an already-migrated, empty database, so they never execute this
 * cleanup at all: deleting it left every one of them green (a review
 * finding). In production the consequence is not cosmetic — two live choice
 * rows sharing a request_id make `CREATE UNIQUE INDEX` throw, which aborts
 * the migration transaction, and `runMigrations` runs at every host start
 * (src/db/migrations/index.ts), so that is a refusal to boot until someone
 * does DB surgery. The cleanup is what makes the migration fail soft instead.
 *
 * So these tests seed the duplicates FIRST and apply 078 afterwards. Delete
 * the UPDATE in 078 and the very first test throws on index creation.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migrations, runMigrations } from './index.js';
import { migration078 } from './078-choice-request-reservation.js';

const NAME = 'choice-request-reservation';
const CHOICE = 'request_choice';

/** Every migration except 078, so duplicates can be seeded before it runs. */
function dbBefore078(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(
    db,
    migrations.filter((m) => m.name !== NAME),
  );
  // pending_approvals references sessions(id) and agent_groups(id); these rows
  // are fixtures for one index, not a session graph, so keep FK enforcement off
  // for the seeding (runMigrations may leave it on after a recreate migration).
  db.pragma('foreign_keys = OFF');
  return db;
}

interface SeedRow {
  id: string;
  requestId: string;
  createdAt: string;
  status?: string;
  action?: string;
}

function seed(db: Database.Database, rows: SeedRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO pending_approvals
       (approval_id, session_id, request_id, action, payload, created_at, status, title, options_json)
     VALUES (?, NULL, ?, ?, '{}', ?, ?, '', '[]')`,
  );
  for (const r of rows) stmt.run(r.id, r.requestId, r.action ?? CHOICE, r.createdAt, r.status ?? 'pending');
}

function statuses(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT approval_id, status FROM pending_approvals').all() as Array<{
    approval_id: string;
    status: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.approval_id, r.status]));
}

function apply078(db: Database.Database): void {
  runMigrations(db, [migration078]);
}

describe('migration078 — legacy duplicate cleanup', () => {
  it('keeps the OLDEST live row and expires the newer ones, so index creation cannot throw', () => {
    const db = dbBefore078();
    // Inserted newest-first on purpose: retention must follow created_at, not
    // insertion order or rowid.
    seed(db, [
      { id: 'appr-c', requestId: 'choice-dup', createdAt: '2026-09-03T00:00:00.000Z' },
      { id: 'appr-a', requestId: 'choice-dup', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'appr-b', requestId: 'choice-dup', createdAt: '2026-09-02T00:00:00.000Z' },
    ]);

    expect(() => apply078(db)).not.toThrow();

    expect(statuses(db)).toEqual({ 'appr-a': 'pending', 'appr-b': 'expired', 'appr-c': 'expired' });
    db.close();
  });

  it('breaks a created_at tie on approval_id, so the survivor is deterministic', () => {
    const db = dbBefore078();
    const sameInstant = '2026-09-01T00:00:00.000Z';
    seed(db, [
      { id: 'appr-zz', requestId: 'choice-tie', createdAt: sameInstant },
      { id: 'appr-aa', requestId: 'choice-tie', createdAt: sameInstant },
    ]);

    apply078(db);

    expect(statuses(db)).toEqual({ 'appr-aa': 'pending', 'appr-zz': 'expired' });
    db.close();
  });

  it('reconciles an `approved` leftover too — both live statuses share one reservation', () => {
    const db = dbBefore078();
    // An `approved` row is a delivery that was in flight when the host died.
    // It still holds a live card, so it competes for the choiceId.
    seed(db, [
      { id: 'appr-old', requestId: 'choice-dup', createdAt: '2026-09-01T00:00:00.000Z', status: 'approved' },
      { id: 'appr-new', requestId: 'choice-dup', createdAt: '2026-09-02T00:00:00.000Z' },
    ]);

    expect(() => apply078(db)).not.toThrow();

    expect(statuses(db)).toEqual({ 'appr-old': 'approved', 'appr-new': 'expired' });
    db.close();
  });

  it('leaves other approval kinds alone, duplicates and all', () => {
    const db = dbBefore078();
    // The gateway re-arms an existing row under the same request.id after a
    // restart, and bash-gate keys on its outbound message id — reuse there is
    // deliberate and must survive this migration untouched.
    seed(db, [
      {
        id: 'appr-cred-1',
        requestId: 'req-shared',
        createdAt: '2026-09-01T00:00:00.000Z',
        action: 'onecli_credential',
      },
      {
        id: 'appr-cred-2',
        requestId: 'req-shared',
        createdAt: '2026-09-02T00:00:00.000Z',
        action: 'onecli_credential',
      },
      { id: 'appr-gate-1', requestId: 'req-shared', createdAt: '2026-09-03T00:00:00.000Z', action: 'bash_gate' },
    ]);

    apply078(db);

    expect(statuses(db)).toEqual({
      'appr-cred-1': 'pending',
      'appr-cred-2': 'pending',
      'appr-gate-1': 'pending',
    });
    db.close();
  });

  it('enforces uniqueness afterwards, across both live statuses, and only for choice cards', () => {
    const db = dbBefore078();
    seed(db, [{ id: 'appr-a', requestId: 'choice-dup', createdAt: '2026-09-01T00:00:00.000Z' }]);
    apply078(db);

    const insert = (id: string, requestId: string, status: string, action = CHOICE): void =>
      seed(db, [{ id, requestId, createdAt: '2026-09-04T00:00:00.000Z', status, action }]);

    // A second live row for the same choiceId is refused in either status.
    expect(() => insert('appr-b', 'choice-dup', 'pending')).toThrow(/UNIQUE/);
    expect(() => insert('appr-c', 'choice-dup', 'approved')).toThrow(/UNIQUE/);
    // A terminal row does not hold the choiceId: the card is gone.
    expect(() => insert('appr-d', 'choice-dup', 'expired')).not.toThrow();
    // Another action is not constrained at all.
    expect(() => insert('appr-e', 'choice-dup', 'pending', 'onecli_credential')).not.toThrow();
    // And a different choiceId is free.
    expect(() => insert('appr-f', 'choice-other', 'pending')).not.toThrow();
    db.close();
  });

  it('is harmless to apply a second time', () => {
    const db = dbBefore078();
    seed(db, [
      { id: 'appr-a', requestId: 'choice-dup', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'appr-b', requestId: 'choice-dup', createdAt: '2026-09-02T00:00:00.000Z' },
    ]);
    apply078(db);
    const afterFirst = statuses(db);

    expect(() => migration078.up(db)).not.toThrow();

    expect(statuses(db)).toEqual(afterFirst);
    db.close();
  });

  it('is registered in the migrations array and applies on a fresh install', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const names = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain(NAME);
    db.close();
  });
});
