import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getDb } from '../db/index.js';

// The sweep reads inbound/outbound DBs from `${DATA_DIR}/v2-sessions/...`.
// Point DATA_DIR at a temp folder so we can write minimal session DBs the
// sweep will pick up.
let TMP_DIR: string;

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return TMP_DIR;
  },
}));

import Database from 'better-sqlite3';
import {
  runSessionTitleSweep,
  setTitleBackendForTest,
  _resetTitleBackendForTest,
  postProcessTitle,
  CONCURRENCY_CAP,
} from './session-title-sweep.js';

function now(): string {
  return new Date().toISOString();
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function seedSession(
  id: string,
  agentGroupId: string,
  opts: { title?: string | null; title_generated_at?: string | null; title_basis_seq?: number | null } = {},
): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, status, created_at) VALUES (?, ?, NULL, 'active', ?)",
    )
    .run(id, agentGroupId, now());
  if (opts.title !== undefined || opts.title_generated_at !== undefined || opts.title_basis_seq !== undefined) {
    getDb()
      .prepare(`UPDATE sessions SET title = ?, title_generated_at = ?, title_basis_seq = ? WHERE id = ?`)
      .run(opts.title ?? null, opts.title_generated_at ?? null, opts.title_basis_seq ?? null, id);
  }
}

/**
 * Write a minimal inbound.db at the sweep's expected path with a small
 * batch of messages. Returns the highest seq written so callers can pin
 * the basis-seq comparison.
 */
function writeInboundMessages(
  agentGroupId: string,
  sessionId: string,
  messages: Array<{ kind: string; content: string }>,
): number {
  const dir = path.join(TMP_DIR, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'inbound.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT,
      content TEXT,
      process_after TEXT,
      recurrence TEXT,
      series_id TEXT,
      trigger INTEGER NOT NULL DEFAULT 1,
      source_session_id TEXT,
      tries INTEGER NOT NULL DEFAULT 0
    );
  `);
  let seq = 0;
  for (const m of messages) {
    seq += 2;
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(`msg-${sessionId}-${seq}`, seq, m.kind, now(), m.content);
  }
  db.close();
  return seq;
}

beforeEach(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-'));
  setupDb();
  seedAgentGroup('ag-1');
});

afterEach(() => {
  closeDb();
  _resetTitleBackendForTest();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('postProcessTitle', () => {
  it('strips quotes, preamble, trailing periods, and caps length', () => {
    expect(postProcessTitle('"EXAMPLE-71 rollout fix"')).toBe('EXAMPLE-71 rollout fix');
    expect(postProcessTitle('Title: Slack auto-wire debug')).toBe('Slack auto-wire debug');
    expect(postProcessTitle('Done.')).toBe('Done');
    expect(postProcessTitle('a'.repeat(120)).length).toBe(60);
    expect(postProcessTitle('  whitespace\nand newlines  ')).toBe('whitespace and newlines');
  });
});

describe('runSessionTitleSweep', () => {
  it('generates a title for a session that has none', async () => {
    seedSession('sess-fresh', 'ag-1');
    writeInboundMessages('ag-1', 'sess-fresh', [
      { kind: 'chat', content: JSON.stringify({ text: 'fix the rollout for EXAMPLE-71' }) },
    ]);
    setTitleBackendForTest(async () => 'EXAMPLE-71 rollout fix');

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(1);

    const row = getDb()
      .prepare('SELECT title, title_basis_seq, title_generated_at FROM sessions WHERE id = ?')
      .get('sess-fresh') as { title: string; title_basis_seq: number; title_generated_at: string };
    expect(row.title).toBe('EXAMPLE-71 rollout fix');
    expect(row.title_basis_seq).toBeGreaterThan(0);
    expect(row.title_generated_at).toBeTruthy();
  });

  it('skips a session with a recent title (<1h cooldown)', async () => {
    seedSession('sess-recent', 'ag-1', {
      title: 'existing',
      title_generated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      title_basis_seq: 2,
    });
    writeInboundMessages('ag-1', 'sess-recent', [{ kind: 'chat', content: '{"text":"more chat"}' }]);

    const backend = vi.fn(async () => 'WOULD REGENERATE');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it('does NOT refresh when cooldown passed but <10 new messages', async () => {
    seedSession('sess-stale-but-quiet', 'ag-1', {
      title: 'old title',
      title_generated_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      title_basis_seq: 50,
    });
    // Write enough messages so the max seq is only 5 beyond basis_seq.
    // Each writeInboundMessages call resets seq at 0, so we seed the table
    // directly with high seqs.
    const dir = path.join(TMP_DIR, 'v2-sessions', 'ag-1', 'sess-stale-but-quiet');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'inbound.db'));
    db.exec(
      `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT, content TEXT);`,
    );
    db.prepare(`INSERT INTO messages_in VALUES ('m1', 54, 'chat', ?, 'pending', '{"text":"hi"}')`).run(now());
    db.close();

    const backend = vi.fn(async () => 'newer title');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it('refreshes when cooldown passed AND ≥10 new messages', async () => {
    seedSession('sess-busy', 'ag-1', {
      title: 'old title',
      title_generated_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      title_basis_seq: 10,
    });
    const dir = path.join(TMP_DIR, 'v2-sessions', 'ag-1', 'sess-busy');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'inbound.db'));
    db.exec(
      `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT, content TEXT);`,
    );
    // Seed messages at seqs that include rows ≥10 past basis_seq=10
    for (let i = 1; i <= 12; i++) {
      db.prepare(`INSERT INTO messages_in VALUES (?, ?, 'chat', ?, 'pending', ?)`).run(
        `m-${i}`,
        10 + i,
        now(),
        JSON.stringify({ text: `msg ${i}` }),
      );
    }
    db.close();

    setTitleBackendForTest(async () => 'refreshed title');
    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(1);

    const row = getDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-busy') as { title: string };
    expect(row.title).toBe('refreshed title');
  });

  it('honors concurrency cap of 3', async () => {
    // Seed 5 candidates that all need a title.
    for (let i = 1; i <= 5; i++) {
      seedSession(`sess-c-${i}`, 'ag-1');
      writeInboundMessages('ag-1', `sess-c-${i}`, [{ kind: 'chat', content: '{"text":"x"}' }]);
    }
    let inFlight = 0;
    let peak = 0;
    setTitleBackendForTest(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return 'parallel title';
    });

    const result = await runSessionTitleSweep();
    expect(peak).toBeLessThanOrEqual(CONCURRENCY_CAP);
    expect(result.generated).toBe(CONCURRENCY_CAP);
  });

  it('swallows backend failures and continues other candidates', async () => {
    seedSession('sess-ok', 'ag-1');
    seedSession('sess-fail', 'ag-1');
    writeInboundMessages('ag-1', 'sess-ok', [{ kind: 'chat', content: '{"text":"ok"}' }]);
    writeInboundMessages('ag-1', 'sess-fail', [{ kind: 'chat', content: '{"text":"will fail"}' }]);

    const backend = vi.fn(async (_s, user: string) => {
      if (user.includes('will fail')) throw new Error('boom');
      return 'all good';
    });
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(1);
    expect(result.skipped).toBe(1);

    const ok = getDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-ok') as { title: string | null };
    const fail = getDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-fail') as {
      title: string | null;
    };
    expect(ok.title).toBe('all good');
    expect(fail.title).toBeNull();
  });

  it('returns {0, 0} when no candidates exist', async () => {
    const result = await runSessionTitleSweep();
    expect(result).toEqual({ generated: 0, skipped: 0 });
  });

  it('skips a session whose inbound.db is missing', async () => {
    seedSession('sess-no-db', 'ag-1');
    const backend = vi.fn(async () => 'should not be called');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it('no-op when no backend is configured (key missing AND no test override)', async () => {
    // Production mode: ANTHROPIC_API_KEY is unset (OneCLI vault path) and
    // the test override has been reset. Sweep must short-circuit without
    // doing DB writes or candidate picks.
    seedSession('sess-no-backend', 'ag-1');
    writeInboundMessages('ag-1', 'sess-no-backend', [{ kind: 'chat', content: '{"text":"x"}' }]);
    _resetTitleBackendForTest();
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const result = await runSessionTitleSweep();
      expect(result).toEqual({ generated: 0, skipped: 0 });
      // No row should be stamped — gate runs BEFORE pickCandidates.
      const row = getDb()
        .prepare('SELECT title, title_generated_at FROM sessions WHERE id = ?')
        .get('sess-no-backend') as { title: string | null; title_generated_at: string | null };
      expect(row.title).toBeNull();
      expect(row.title_generated_at).toBeNull();
    } finally {
      if (originalKey !== undefined) process.env['ANTHROPIC_API_KEY'] = originalKey;
    }
  });

  it('re-entrancy guard: a second concurrent sweep call is a no-op (Q3)', async () => {
    seedSession('sess-1', 'ag-1');
    seedSession('sess-2', 'ag-1');
    writeInboundMessages('ag-1', 'sess-1', [{ kind: 'chat', content: '{"text":"a"}' }]);
    writeInboundMessages('ag-1', 'sess-2', [{ kind: 'chat', content: '{"text":"b"}' }]);
    const backend = vi.fn(async () => {
      // Hold the backend mid-flight so the second sweep starts before the
      // first finishes — without the re-entrancy guard this would double-
      // batch the same candidates.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return 'title';
    });
    setTitleBackendForTest(backend);

    const [a, b] = await Promise.all([runSessionTitleSweep(), runSessionTitleSweep()]);
    // Exactly one of the calls did the work; the other returned 0/0.
    const totals = [a.generated + a.skipped, b.generated + b.skipped];
    expect(totals).toContain(0);
    expect(totals.some((n) => n > 0)).toBe(true);
  });

  it('failure backoff stamps title_generated_at so the row is skipped next tick (Q3)', async () => {
    seedSession('sess-fail', 'ag-1');
    writeInboundMessages('ag-1', 'sess-fail', [{ kind: 'chat', content: '{"text":"x"}' }]);
    setTitleBackendForTest(async () => {
      throw new Error('boom');
    });

    const first = await runSessionTitleSweep();
    expect(first.generated).toBe(0);
    expect(first.skipped).toBe(1);

    // The failure stamps a recent `title_generated_at`; the candidate
    // query filters out rows with title_generated_at within the cooldown
    // window. Next sweep tick should not pick this session.
    const row = getDb().prepare('SELECT title_generated_at FROM sessions WHERE id = ?').get('sess-fail') as {
      title_generated_at: string | null;
    };
    expect(row.title_generated_at).toBeTruthy();

    const backendSecond = vi.fn(async () => 'should not run');
    setTitleBackendForTest(backendSecond);
    const second = await runSessionTitleSweep();
    expect(second.generated).toBe(0);
    expect(backendSecond).not.toHaveBeenCalled();
  });

  it('stamps an empty/contentless session so it exits the candidate pool (clog fix)', async () => {
    // An active NULL-title session with an inbound.db that has NO messages.
    // Pre-fix this was skipped WITHOUT stamping, so it re-entered the candidate
    // set forever and (in bulk) starved real sessions. It must now be stamped.
    seedSession('sess-empty', 'ag-1');
    writeInboundMessages('ag-1', 'sess-empty', []); // empty db, slice.maxSeq < 0
    const backend = vi.fn(async () => 'unused');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
    const row = getDb().prepare('SELECT title, title_generated_at FROM sessions WHERE id = ?').get('sess-empty') as {
      title: string | null;
      title_generated_at: string | null;
    };
    expect(row.title).toBeNull();
    expect(row.title_generated_at).toBeTruthy(); // stamped → won't clog next tick
  });

  it('a backlog of empty shells does NOT starve a real recently-active session (clog fix)', async () => {
    // 15 empty shells, seeded FIRST (lowest rowids) and marked long-inactive.
    // Pre-fix the candidate query (oldest-rowid-first, LIMIT cap*4=12) returned
    // only these 12 empties → 0 generated, and the real session below — seeded
    // last, highest rowid — was never reached. The new ordering (untitled +
    // most-recently-active first) surfaces the real session instead.
    for (let i = 1; i <= 15; i++) {
      seedSession(`sess-empty-${i}`, 'ag-1');
      writeInboundMessages('ag-1', `sess-empty-${i}`, []);
      getDb().prepare("UPDATE sessions SET last_active = '2026-01-01T00:00:00Z' WHERE id = ?").run(`sess-empty-${i}`);
    }
    seedSession('sess-real', 'ag-1');
    writeInboundMessages('ag-1', 'sess-real', [
      { kind: 'chat', content: JSON.stringify({ text: 'deploy the EXAMPLE-99 hotfix' }) },
    ]);
    getDb().prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(now(), 'sess-real');

    setTitleBackendForTest(async () => 'EXAMPLE-99 hotfix deploy');
    const result = await runSessionTitleSweep();

    const real = getDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-real') as {
      title: string | null;
    };
    expect(real.title).toBe('EXAMPLE-99 hotfix deploy'); // not starved
    expect(result.generated).toBeGreaterThanOrEqual(1);
  });
});
