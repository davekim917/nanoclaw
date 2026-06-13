/**
 * Tests for the shared scoped live-row count helper (QA-fix H1).
 *
 * countLiveRowsInSessions opens each named session's inbound.db read-only and
 * counts the series' live (pending|paused) task rows. A per-session read FAILURE
 * makes the whole count `unreadable=true` (fail-safe → callers never restore on
 * unknown). A missing inbound.db contributes 0 and is NOT unreadable.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { countLiveRowsInSessions } from './live-count.js';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-livecount-'));

function seedInbound(agentGroupId: string, sessionId: string): string {
  const dir = path.join(TEST_DIR, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'inbound.db');
  ensureSchema(p, 'inbound');
  return p;
}

function insertRow(inboundPath: string, opts: { id: string; seriesId: string; status?: string }): void {
  const db = openInboundDb(inboundPath);
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages_in').get() as { m: number }).m + 2;
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, recurrence, series_id, content)
     VALUES (?, ?, 'task', datetime('now'), ?, '0 9 * * *', ?, '{}')`,
  ).run(opts.id, seq, opts.status ?? 'pending', opts.seriesId);
  db.close();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});
afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('countLiveRowsInSessions', () => {
  it('test_livecount_sums_across_locators', () => {
    const src = seedInbound('ag-src', 'sess-src');
    const tgt = seedInbound('ag-tgt', 'sess-tgt');
    insertRow(src, { id: 'a', seriesId: 'ser-1', status: 'pending' });
    insertRow(tgt, { id: 'b', seriesId: 'ser-1', status: 'paused' });
    const r = countLiveRowsInSessions(
      TEST_DIR,
      [
        { agentGroupId: 'ag-src', sessionId: 'sess-src' },
        { agentGroupId: 'ag-tgt', sessionId: 'sess-tgt' },
      ],
      'ser-1',
    );
    expect(r).toEqual({ count: 2, unreadable: false });
  });

  it('only counts pending|paused task rows for the series', () => {
    const src = seedInbound('ag-src', 'sess-src');
    insertRow(src, { id: 'live', seriesId: 'ser-1', status: 'pending' });
    insertRow(src, { id: 'done', seriesId: 'ser-1', status: 'completed' });
    insertRow(src, { id: 'other', seriesId: 'ser-2', status: 'pending' });
    const r = countLiveRowsInSessions(TEST_DIR, [{ agentGroupId: 'ag-src', sessionId: 'sess-src' }], 'ser-1');
    expect(r).toEqual({ count: 1, unreadable: false });
  });

  it('test_livecount_missing_session_contributes_zero_not_unreadable', () => {
    // No inbound.db on disk for this locator → contributes 0, NOT unreadable.
    const r = countLiveRowsInSessions(TEST_DIR, [{ agentGroupId: 'ag-x', sessionId: 'sess-missing' }], 'ser-1');
    expect(r).toEqual({ count: 0, unreadable: false });
  });

  it('test_livecount_read_failure_marks_unreadable', () => {
    // A corrupt-but-existent inbound.db → read throws → unreadable=true
    // (fail-safe: callers must NOT restore on unreadable).
    const dir = path.join(TEST_DIR, 'v2-sessions', 'ag-bad', 'sess-bad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'inbound.db'), 'this is not sqlite');
    const r = countLiveRowsInSessions(TEST_DIR, [{ agentGroupId: 'ag-bad', sessionId: 'sess-bad' }], 'ser-1');
    expect(r.unreadable).toBe(true);
  });

  it('one unreadable locator taints the whole count even if another has a live row', () => {
    const good = seedInbound('ag-good', 'sess-good');
    insertRow(good, { id: 'g', seriesId: 'ser-1', status: 'pending' });
    const badDir = path.join(TEST_DIR, 'v2-sessions', 'ag-bad', 'sess-bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'inbound.db'), 'not sqlite');
    const r = countLiveRowsInSessions(
      TEST_DIR,
      [
        { agentGroupId: 'ag-good', sessionId: 'sess-good' },
        { agentGroupId: 'ag-bad', sessionId: 'sess-bad' },
      ],
      'ser-1',
    );
    expect(r.unreadable).toBe(true);
  });

  it('skips null locators (a not-yet-resolved target session)', () => {
    const src = seedInbound('ag-src', 'sess-src');
    insertRow(src, { id: 'a', seriesId: 'ser-1', status: 'pending' });
    const r = countLiveRowsInSessions(TEST_DIR, [{ agentGroupId: 'ag-src', sessionId: 'sess-src' }, null], 'ser-1');
    expect(r).toEqual({ count: 1, unreadable: false });
  });
});
