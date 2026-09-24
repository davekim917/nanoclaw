/**
 * Outbound-file initialization. Moved from db/connection.test.ts when the fork's
 * raw connection layer was replaced by upstream's seam + this module.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureNanoclawOutboundSchema, prepareOutboundFile } from './schema.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-outbound-init-'));
  tempDirs.push(dir);
  return path.join(dir, 'outbound.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('outbound DB initialization', () => {
  it('installs busy_timeout before journal mode so a concurrent writer is waited out', async () => {
    const dbPath = tempDbPath();
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE lock_probe (id INTEGER)');
    seed.close();

    const holder = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { Database } = require('bun:sqlite');
         const db = new Database(process.argv[1]);
         db.exec('BEGIN EXCLUSIVE');
         console.log('locked');
         await Bun.sleep(300);
         db.exec('COMMIT');
         db.close();`,
        dbPath,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const reader = holder.stdout.getReader();
    const firstChunk = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(firstChunk.value)).toContain('locked');

    const started = Date.now();
    prepareOutboundFile(() => new Database(dbPath));
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    const db = new Database(dbPath);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    db.close();
    expect(await holder.exited).toBe(0);
  });

  it('closes a partially initialized connection so the next open starts clean', () => {
    const calls: string[] = [];
    let closed = false;
    const candidate = {
      exec(sql: string) {
        calls.push(sql.trim());
        if (sql.includes('journal_mode')) throw new Error('database is locked');
      },
      close() {
        closed = true;
      },
    } as unknown as Database;

    expect(() => prepareOutboundFile(() => candidate)).toThrow('database is locked');
    expect(calls[0]).toBe('PRAGMA busy_timeout = 5000');
    expect(closed).toBe(true);
  });

  it('keeps the connection configuration order explicit', () => {
    const calls: string[] = [];
    const candidate = {
      exec(sql: string) {
        calls.push(sql.trim());
      },
      close() {},
    } as unknown as Database;

    prepareOutboundFile(() => candidate);

    expect(calls).toEqual(['PRAGMA busy_timeout = 5000', 'PRAGMA journal_mode = DELETE']);
  });

  it('test_container_state_forward_compat_adds_resource_telemetry_columns', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE container_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_tool TEXT,
        tool_declared_timeout_ms INTEGER,
        tool_started_at TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    ensureNanoclawOutboundSchema(db);

    const columns = new Set(
      (db.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((row) => row.name),
    );
    expect(columns.has('memory_current_bytes')).toBe(true);
    expect(columns.has('memory_peak_bytes')).toBe(true);
    expect(columns.has('memory_max_bytes')).toBe(true);
    expect(columns.has('memory_oom_events')).toBe(true);
    expect(columns.has('memory_oom_kill_events')).toBe(true);
    expect(columns.has('memory_max_events')).toBe(true);
    expect(columns.has('memory_telemetry_at')).toBe(true);
    db.close();
  });

  // A container restarted onto an outbound.db an older runner created, with a
  // row already in it: the backfill adds provider_query_event_at once, keeps the
  // row, and a second boot is a no-op rather than a duplicate-column throw.
  it('backfills provider_query_event_at onto an old-runner DB, idempotently', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE container_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_tool TEXT,
        tool_declared_timeout_ms INTEGER,
        tool_started_at TEXT,
        provider_executing INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);
    db.prepare("INSERT INTO container_state (id, provider_executing, updated_at) VALUES (1, 1, 'old')").run();
    const columnsOf = () =>
      (db.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columnsOf()).not.toContain('provider_query_event_at');

    ensureNanoclawOutboundSchema(db);
    expect(columnsOf()).toContain('provider_query_event_at');
    expect(() => ensureNanoclawOutboundSchema(db)).not.toThrow();
    expect(columnsOf().filter((name) => name === 'provider_query_event_at')).toHaveLength(1);

    const row = db.prepare('SELECT provider_executing, provider_query_event_at FROM container_state').get() as {
      provider_executing: number;
      provider_query_event_at: string | null;
    };
    expect(row).toEqual({ provider_executing: 1, provider_query_event_at: null });
    db.close();
  });
});
