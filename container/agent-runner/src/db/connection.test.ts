import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureOutboundDb, openOutboundDb } from './connection.js';

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
    const db = openOutboundDb(() => new Database(dbPath));
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
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

    expect(() => openOutboundDb(() => candidate)).toThrow('database is locked');
    expect(calls[0]).toBe('PRAGMA busy_timeout = 5000');
    expect(closed).toBe(true);
  });

  it('keeps the connection configuration order explicit', () => {
    const calls: string[] = [];
    const candidate = {
      exec(sql: string) {
        calls.push(sql.trim());
      },
      prepare() {
        return { all: () => [] };
      },
    } as unknown as Database;

    configureOutboundDb(candidate);

    expect(calls.slice(0, 3)).toEqual([
      'PRAGMA busy_timeout = 5000',
      'PRAGMA journal_mode = DELETE',
      'PRAGMA foreign_keys = ON',
    ]);
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

    configureOutboundDb(db);

    const columns = new Set(
      (db.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((row) => row.name),
    );
    expect(columns.has('memory_current_bytes')).toBe(true);
    expect(columns.has('memory_peak_bytes')).toBe(true);
    expect(columns.has('memory_max_bytes')).toBe(true);
    expect(columns.has('memory_oom_events')).toBe(true);
    expect(columns.has('memory_oom_kill_events')).toBe(true);
    expect(columns.has('memory_telemetry_at')).toBe(true);
    db.close();
  });
});
