import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration028 } from './028-dashboard-tables.js';
import { migration031 } from './031-inbox-board-foundations.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL,
      display_name TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO users VALUES ('u1', 'phone', null, '2026-01-01T00:00:00Z');

    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO agent_groups VALUES ('ag1', 'group-a', '2026-01-01T00:00:00Z');

    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE sessions (
      id                 TEXT PRIMARY KEY,
      agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
      messaging_group_id TEXT REFERENCES messaging_groups(id),
      thread_id          TEXT,
      agent_provider     TEXT,
      status             TEXT DEFAULT 'active',
      container_status   TEXT DEFAULT 'stopped',
      last_active        TEXT,
      created_at         TEXT NOT NULL
    );
    INSERT INTO sessions (id, agent_group_id, status, created_at)
    VALUES ('s1', 'ag1', 'active', '2026-01-01T00:00:00Z');
  `);
  migration028.up(db);
  return db;
}

describe('migration031', () => {
  it('adds archived_at, title, title_generated_at, title_basis_seq to sessions', () => {
    const db = makeDb();
    migration031.up(db);
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('archived_at');
    expect(cols).toContain('title');
    expect(cols).toContain('title_generated_at');
    expect(cols).toContain('title_basis_seq');
    db.close();
  });

  it('new session columns are nullable (existing rows survive)', () => {
    const db = makeDb();
    migration031.up(db);
    const row = db
      .prepare('SELECT archived_at, title, title_generated_at, title_basis_seq FROM sessions WHERE id = ?')
      .get('s1') as {
      archived_at: string | null;
      title: string | null;
      title_generated_at: string | null;
      title_basis_seq: number | null;
    };
    expect(row.archived_at).toBeNull();
    expect(row.title).toBeNull();
    expect(row.title_generated_at).toBeNull();
    expect(row.title_basis_seq).toBeNull();
    db.close();
  });

  it('creates partial index on sessions(archived_at)', () => {
    const db = makeDb();
    migration031.up(db);
    const idx = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_archived'")
      .get() as { name: string; sql: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx!.sql).toMatch(/archived_at IS NOT NULL/i);
    db.close();
  });

  it('adds target_type and target_id to steer_idempotency', () => {
    const db = makeDb();
    migration031.up(db);
    const cols = (db.prepare('PRAGMA table_info(steer_idempotency)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('target_type');
    expect(cols).toContain('target_id');
    // legacy column kept for dual-write window — C5 drops it.
    expect(cols).toContain('task_id');
    db.close();
  });

  it('backfills target_type/target_id from existing task_id rows', () => {
    const db = makeDb();
    // Pre-migration row (task-targeted steer).
    db.prepare(
      `INSERT INTO steer_idempotency (user_id, idempotency_key, task_id, message_id, text, reserved_at, request_hash)
       VALUES ('u1', 'k-old', 'task-abc', 'm1', 'hello', '2026-01-01', 'hash1')`,
    ).run();

    migration031.up(db);

    const row = db
      .prepare('SELECT target_type, target_id FROM steer_idempotency WHERE idempotency_key = ?')
      .get('k-old') as {
      target_type: string;
      target_id: string;
    };
    expect(row.target_type).toBe('task');
    expect(row.target_id).toBe('task-abc');
    db.close();
  });

  it('migration is idempotent against pre-existing post-migration state', () => {
    const db = makeDb();
    migration031.up(db);
    // Same migration applied a second time would throw on duplicate ADD COLUMN —
    // verify the runner's "apply once" gate is the right level. (Migrations
    // are not internally idempotent; the schema_version table is the gate.)
    expect(() => migration031.up(db)).toThrow();
    db.close();
  });
});
