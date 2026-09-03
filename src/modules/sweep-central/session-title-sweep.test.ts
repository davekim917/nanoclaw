/**
 * F-4.3a (docs/specs/upstream-host-sweep-seam/plan.md §8, S2-PR4) — half of
 * "session-title and thread-title sweeps keep their caps, cooldowns and
 * backoffs". Ported from src/dashboard/session-title-sweep.test.ts (that
 * file's own full suite is untouched — this family PR only moved the
 * tick:housekeeping registration wrapper (T15), not the dashboard module's
 * own code, so its behavior is re-proven here as the acceptance evidence for
 * the moved wrapper's dependency).
 *
 * Kept in its own file, not central.test.ts: this fixture needs the REAL
 * src/llm.js (for its credential-rotation reset helpers), which conflicts
 * with thread-title-retry.test.ts's full `vi.mock('../../llm.js', ...)` —
 * `vi.mock` is hoisted per FILE, not per `describe` block.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  __resetCallHaikuSlotCacheForTest,
  __resetCredentialRotationGateForTest,
  __setCredentialRotationGateMinIntervalForTest,
} from '../../llm.js';
import {
  CONCURRENCY_CAP,
  COOLDOWN_HOURS,
  REFRESH_MIN_NEW_MESSAGES,
  _resetCooldownForTest,
  _resetTitleBackendForTest,
  runSessionTitleSweep,
  setTitleBackendForTest,
} from '../../dashboard/session-title-sweep.js';

let TMP_DIR: string;

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return TMP_DIR;
  },
}));
vi.mock('../../env.js', () => ({ readEnvFileMatching: vi.fn(() => ({})) }));

function now(): string {
  return new Date().toISOString();
}

function seedSession(
  id: string,
  agentGroupId: string,
  opts: { title?: string | null; title_generated_at?: string | null; title_basis_seq?: number | null } = {},
): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at) VALUES (?, ?, NULL, ?, 'active', ?)",
    )
    .run(id, agentGroupId, `system:tasks:${id}`, now());
  if (opts.title !== undefined || opts.title_generated_at !== undefined || opts.title_basis_seq !== undefined) {
    getDb()
      .prepare(`UPDATE sessions SET title = ?, title_generated_at = ?, title_basis_seq = ? WHERE id = ?`)
      .run(opts.title ?? null, opts.title_generated_at ?? null, opts.title_basis_seq ?? null, id);
  }
}

function writeInboundMessages(agentGroupId: string, sessionId: string, seqAndContent: [number, string][]): void {
  const dir = path.join(TMP_DIR, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'inbound.db'));
  db.exec(
    `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT, content TEXT);`,
  );
  for (const [seq, content] of seqAndContent) {
    db.prepare(`INSERT INTO messages_in VALUES (?, ?, 'chat', ?, 'pending', ?)`).run(`m-${seq}`, seq, now(), content);
  }
  db.close();
}

beforeEach(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-central-'));
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'ag-1', folder: 'ag-1', agent_provider: null, created_at: now() });
  __resetCallHaikuSlotCacheForTest();
  __resetCredentialRotationGateForTest();
  __setCredentialRotationGateMinIntervalForTest(0);
});

afterEach(() => {
  closeDb();
  _resetTitleBackendForTest();
  _resetCooldownForTest();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
  __resetCallHaikuSlotCacheForTest();
  __resetCredentialRotationGateForTest();
});

describe('F-4.3a — session-title sweep keeps its cap, cooldown and new-message threshold', () => {
  it('keeps CONCURRENCY_CAP=3, COOLDOWN_HOURS=1 and REFRESH_MIN_NEW_MESSAGES=10', () => {
    expect(CONCURRENCY_CAP).toBe(3);
    expect(COOLDOWN_HOURS).toBe(1);
    expect(REFRESH_MIN_NEW_MESSAGES).toBe(10);
  });

  it('skips a session with a recent title (<1h cooldown)', async () => {
    seedSession('sess-recent', 'ag-1', {
      title: 'existing',
      title_generated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      title_basis_seq: 2,
    });
    writeInboundMessages('ag-1', 'sess-recent', [[10, '{"text":"more chat"}']]);
    const backend = vi.fn(async () => 'WOULD REGENERATE');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it('does NOT refresh when cooldown passed but <10 new messages, and DOES when ≥10', async () => {
    seedSession('sess-quiet', 'ag-1', {
      title: 'old title',
      title_generated_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      title_basis_seq: 50,
    });
    writeInboundMessages('ag-1', 'sess-quiet', [[54, '{"text":"hi"}']]); // 4 past basis_seq
    const quietBackend = vi.fn(async () => 'newer title');
    setTitleBackendForTest(quietBackend);
    const quietResult = await runSessionTitleSweep();
    expect(quietResult.generated).toBe(0);
    expect(quietBackend).not.toHaveBeenCalled();

    seedSession('sess-busy', 'ag-1', {
      title: 'old title',
      title_generated_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      title_basis_seq: 10,
    });
    writeInboundMessages(
      'ag-1',
      'sess-busy',
      Array.from({ length: 12 }, (_, i) => [10 + i + 1, JSON.stringify({ text: `msg ${i}` })]) as [number, string][],
    );
    setTitleBackendForTest(async () => 'refreshed title');
    const busyResult = await runSessionTitleSweep();
    expect(busyResult.generated).toBe(1);
    const row = getDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-busy') as { title: string };
    expect(row.title).toBe('refreshed title');
  });

  it('honors the concurrency cap of 3', async () => {
    for (let i = 1; i <= 5; i++) {
      seedSession(`sess-c-${i}`, 'ag-1');
      writeInboundMessages('ag-1', `sess-c-${i}`, [[2, '{"text":"x"}']]);
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

  it('a failed generation backs off for 15 minutes: stamped, then not retried before it', async () => {
    seedSession('sess-fail', 'ag-1');
    writeInboundMessages('ag-1', 'sess-fail', [[2, '{"text":"x"}']]);
    setTitleBackendForTest(async () => {
      throw new Error('boom');
    });

    const first = await runSessionTitleSweep();
    expect(first.generated).toBe(0);
    expect(first.skipped).toBe(1);

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
});
