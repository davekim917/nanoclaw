import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration053 } from './053-normalize-naive-timestamps.js';

function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, created_at)
     VALUES ('ag-1', 'ag-1', 'ag-1', '2026-08-01T00:00:00.000Z')`,
  ).run();
  return db;
}

/** Insert a session row carrying the given raw last_outbound_at bytes. */
function seedSession(db: Database.Database, id: string, lastOutboundAt: string): void {
  db.prepare(
    // Distinct thread_id per row: migration 049's unique index forbids two
    // active sessions on the same (agent_group, messaging_group, thread).
    `INSERT INTO sessions (id, agent_group_id, thread_id, status, created_at, last_outbound_at)
     VALUES (?, 'ag-1', ?, 'active', '2026-08-01T00:00:00.000Z', ?)`,
  ).run(id, id, lastOutboundAt);
}

function lastOutbound(db: Database.Database, id: string): string | null {
  return (db.prepare('SELECT last_outbound_at AS v FROM sessions WHERE id = ?').get(id) as { v: string | null }).v;
}

describe('migration053 — normalize naive timestamps', () => {
  it('converts naive UTC to the exact ISO instant, and is idempotent', () => {
    const db = makeMigratedDb();
    seedSession(db, 's-naive', '2026-08-20 07:00:00');

    migration053.up(db);
    expect(lastOutbound(db, 's-naive')).toBe('2026-08-20T07:00:00.000Z');

    // Re-running finds nothing left to convert — no double-suffixing.
    migration053.up(db);
    expect(lastOutbound(db, 's-naive')).toBe('2026-08-20T07:00:00.000Z');
    db.close();
  });

  it('leaves already-ISO and NULL values untouched', () => {
    const db = makeMigratedDb();
    seedSession(db, 's-iso', '2026-08-20T07:00:00.000Z');
    seedSession(db, 's-null', null as unknown as string);

    migration053.up(db);

    expect(lastOutbound(db, 's-iso')).toBe('2026-08-20T07:00:00.000Z');
    expect(lastOutbound(db, 's-null')).toBeNull();
    db.close();
  });

  it('fixes the MAX() inversion a mixed-shape column produces', () => {
    const db = makeMigratedDb();
    // 11pm naive vs 7am ISO on the same day: byte-wise, ' ' (0x20) < 'T' (0x54),
    // so the naive-but-later row loses before normalization.
    seedSession(db, 's-late', '2026-08-20 23:00:00');
    seedSession(db, 's-early', '2026-08-20T07:00:00.000Z');

    const maxId = () =>
      (
        db
          .prepare('SELECT id FROM sessions WHERE last_outbound_at = (SELECT MAX(last_outbound_at) FROM sessions)')
          .get() as { id: string }
      ).id;

    expect(maxId()).toBe('s-early'); // wrong, and this is what mixed shapes do
    migration053.up(db);
    expect(maxId()).toBe('s-late');
    db.close();
  });

  it('normalizes dashboard_tokens.used_at, whose writer now binds ISO', () => {
    const db = makeMigratedDb();
    db.prepare(`INSERT INTO users (id, kind, created_at) VALUES ('u-1', 'human', '2026-08-01T00:00:00.000Z')`).run();
    const seedToken = (hmac: string, usedAt: string | null) =>
      db
        .prepare(
          `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at, used_at)
           VALUES ('u-1', ?, '2026-08-20T00:00:00.000Z', '2026-08-20T01:00:00.000Z', ?)`,
        )
        .run(hmac, usedAt);
    const usedAt = (hmac: string) =>
      (db.prepare('SELECT used_at AS v FROM dashboard_tokens WHERE token_hmac = ?').get(hmac) as { v: string | null })
        .v;

    seedToken('h-naive', '2026-08-20 07:00:00');
    seedToken('h-iso', '2026-08-20T07:00:00.000Z');
    seedToken('h-unused', null);

    migration053.up(db);

    expect(usedAt('h-naive')).toBe('2026-08-20T07:00:00.000Z');
    expect(usedAt('h-iso')).toBe('2026-08-20T07:00:00.000Z');
    // An unused token must stay unused — the single-use gate reads `IS NULL`.
    expect(usedAt('h-unused')).toBeNull();
    db.close();
  });

  it('leaves chat_sdk_subscriptions.subscribed_at naive, since its DDL default still emits that shape', () => {
    const db = makeMigratedDb();
    db.prepare(
      `INSERT INTO chat_sdk_subscriptions (thread_id, subscribed_at) VALUES ('t-1', '2026-08-20 07:00:00')`,
    ).run();

    migration053.up(db);

    expect(
      (
        db.prepare(`SELECT subscribed_at AS v FROM chat_sdk_subscriptions WHERE thread_id = 't-1'`).get() as {
          v: string;
        }
      ).v,
    ).toBe('2026-08-20 07:00:00');
    db.close();
  });

  it('runs as part of runMigrations, so a live DB is normalized at boot', () => {
    const db = makeMigratedDb();
    const applied = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(applied).toContain('normalize-naive-timestamps');
    db.close();
  });
});
