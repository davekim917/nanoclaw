/**
 * Fleet-hardening Phase 1.1: host-side pre-task script gating.
 *
 * Covers the classifier (clean / hard-block / gated) and the sweep-facing
 * runHostGatedTaskScripts, which must:
 *   - actually execute a clean script and act on wakeAgent
 *   - fall back to the (unchanged) container path for anything the
 *     classifier flags, without running it host-side
 *   - never leak the host process's env into the child (only PATH/HOME/TZ)
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTaskRow } from './db.js';
import { classifyForHostExecution, runHostGatedTaskScripts } from './host-script.js';

const TEST_DIR = '/tmp/nanoclaw-host-script-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function insertHostGatedTask(
  db: ReturnType<typeof openInboundDb>,
  id: string,
  script: string,
  overrides: Record<string, unknown> = {},
): void {
  insertTaskRow(db, {
    id,
    seriesId: id,
    processAfter: new Date(Date.now() - 1_000).toISOString(),
    recurrence: null,
    content: JSON.stringify({ prompt: 'monitor', script, scriptHost: true, ...overrides }),
  });
}

function rowStatus(db: ReturnType<typeof openInboundDb>, id: string): string {
  return (db.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;
}

function rowContent(db: ReturnType<typeof openInboundDb>, id: string): Record<string, unknown> {
  return JSON.parse(
    (db.prepare('SELECT content FROM messages_in WHERE id = ?').get(id) as { content: string }).content,
  );
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('classifyForHostExecution', () => {
  it('allows an ordinary curl/jq monitor script', () => {
    expect(
      classifyForHostExecution(
        'c=$(curl -sf https://example.com | jq length) || exit 0\necho "{\\"wakeAgent\\": false}"',
      ),
    ).toEqual({
      safe: true,
    });
  });

  it('hard-blocks rm -rf', () => {
    const result = classifyForHostExecution('rm -rf /workspace/agent/scratch');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('hard-block');
  });

  it('gates a destructive SQL statement (DROP TABLE)', () => {
    const result = classifyForHostExecution('psql -c "DROP TABLE customers"');
    expect(result.safe).toBe(false);
    expect(result.category).toBe('gated');
  });
});

describe('runHostGatedTaskScripts', () => {
  it('runs a clean wakeAgent=false script and marks it completed without a container', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-gated', 'echo \'{"wakeAgent": false}\'');

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(rowStatus(db, 't-gated')).toBe('completed');
    db.close();
  });

  it('runs a clean wakeAgent=true script and injects scriptOutput, leaving the row pending for admission', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-wake', 'echo \'{"wakeAgent": true, "data": {"alerts": 3}}\'');

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(rowStatus(db, 't-wake')).toBe('pending');
    expect(rowContent(db, 't-wake').scriptOutput).toEqual({ alerts: 3 });
    db.close();
  });

  it('marks an erroring script failed (so recurrence backoff can see it)', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-err', 'echo boom >&2; exit 1');

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(rowStatus(db, 't-err')).toBe('failed');
    db.close();
  });

  it('a classifier-flagged rm -rf script never executes host-side and falls back to the container', async () => {
    const db = freshDb();
    // If this ran, it would write a marker file — assert it never does.
    const marker = path.join(TEST_DIR, 'ran.marker');
    insertHostGatedTask(
      db,
      't-danger',
      `touch ${marker}\nrm -rf /workspace/agent/scratch\necho '{"wakeAgent": false}'`,
    );

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(fs.existsSync(marker)).toBe(false);
    // Row untouched: still pending/trigger=0, no scriptOutput — the normal
    // admission + container path picks it up exactly as before this feature.
    expect(rowStatus(db, 't-danger')).toBe('pending');
    expect(rowContent(db, 't-danger').scriptOutput).toBeUndefined();
    db.close();
  });

  it('a classifier-flagged DROP TABLE script never executes host-side and falls back to the container', async () => {
    const db = freshDb();
    const marker = path.join(TEST_DIR, 'ran.marker');
    insertHostGatedTask(db, 't-sql', `touch ${marker}\npsql -c "DROP TABLE customers"\necho '{"wakeAgent": false}'`);

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(fs.existsSync(marker)).toBe(false);
    expect(rowStatus(db, 't-sql')).toBe('pending');
    db.close();
  });

  it('never leaks the host process env into the script — only PATH/HOME/TZ', async () => {
    const db = freshDb();
    const before = process.env.HOST_SCRIPT_TEST_CANARY;
    process.env.HOST_SCRIPT_TEST_CANARY = 'should-not-leak';
    try {
      insertHostGatedTask(
        db,
        't-env',
        'echo "{\\"wakeAgent\\": true, \\"data\\": {\\"canary\\": \\"${HOST_SCRIPT_TEST_CANARY:-absent}\\"}}"',
      );
      await runHostGatedTaskScripts(db, 'sess-test');
      expect(rowContent(db, 't-env').scriptOutput).toEqual({ canary: 'absent' });
    } finally {
      if (before === undefined) delete process.env.HOST_SCRIPT_TEST_CANARY;
      else process.env.HOST_SCRIPT_TEST_CANARY = before;
    }
    db.close();
  });

  it('ignores task rows without scriptHost — the existing container path is untouched', async () => {
    const db = freshDb();
    insertHostGatedTask(db, 't-container-only', 'echo \'{"wakeAgent": false}\'', { scriptHost: false });

    await runHostGatedTaskScripts(db, 'sess-test');

    expect(rowStatus(db, 't-container-only')).toBe('pending');
    expect(rowContent(db, 't-container-only').scriptOutput).toBeUndefined();
    db.close();
  });
});
