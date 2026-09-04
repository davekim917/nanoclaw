/**
 * Tests for the Scheduled Tasks Board simple mutations (Tasks C1-C5):
 *   PUT  /scheduled/:key            edit (prompt/script/cron)
 *   POST /scheduled/:key/pause      pause
 *   POST /scheduled/:key/resume     resume (slot recompute)
 *   POST /scheduled/:key/run-now    early fire
 *   POST /scheduled/:key/cancel     end series
 *   moduleOwner(seriesId)           module-owned registry
 *
 * TDD: written before the implementation. On-disk session fixtures + in-memory
 * central DB, driving the AuthHandlers directly.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import Database from 'better-sqlite3';

import type { NanoclawMailboxSession } from '../../modules/mailbox/index.js';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { openInboundDb } from '../../modules/mailbox/openers.js';
import { ensureSchema } from '../../modules/mailbox/schema.js';
import { migration043 } from '../../db/migrations/043-scheduled-audit.js';
import {
  encodeKey,
  invalidateScheduledCache,
  moduleOwner,
  rateLimit,
  _resetScheduledRateLimitForTesting,
} from './scheduled-shared.js';
import type { AuthedRequestContext } from '../router.js';

// Unique per-file temp dir (mkdtemp) — no fixed /tmp path a sibling file or a
// parallel agent process could collide on (hermeticity, matches the read/
// assembly test fix). Hoisted because DATA_DIR is mocked to it below: the
// mutation writes go through the mailbox seam, which resolves session paths
// from DATA_DIR, so the injected `dataDir` and DATA_DIR have to be the same
// root or the gate would read the fixture and the write would miss it.
const TEST_DIR = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'nc-sched-mut-')) as string;
});
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_DIR,
}));

// wakeContainer is mocked so run-now doesn't try to spawn a real container.
const mockWakeContainer = vi.fn().mockResolvedValue(true);
const mockAdmitDueTaskContexts = vi.fn().mockReturnValue(1);
vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return { ...real, wakeContainer: (...args: unknown[]) => mockWakeContainer(...args) };
});
// A hook that fires INSIDE the mutation's mailbox acquisition — the window the
// async funnel opened between the preflight verdict and the write. Real
// implementation otherwise, so every other case in this file is unaffected.
const duringMailboxAcquire = vi.hoisted(() => ({ run: null as (() => void) | null }));
vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    admitDueTaskContexts: (...args: unknown[]) => mockAdmitDueTaskContexts(...args),
    withExistingMailboxSession: async (agentGroupId: string, sessionId: string, action: never) => {
      const hook = duringMailboxAcquire.run;
      duringMailboxAcquire.run = null;
      hook?.();
      return real.withExistingMailboxSession(agentGroupId, sessionId, action);
    },
  };
});

import {
  editHandler,
  pauseHandler,
  resumeHandler,
  runNowHandler,
  cancelHandler,
  _setMutationsTestOptions,
} from './scheduled-mutations.js';

const NOW = Date.parse('2026-06-13T12:00:00Z');
const AG = 'ag-1';
const SESS = 'sess-1';
const MG = 'mg-1';

function isoIn(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

function setupCentralDb(): void {
  const db = initTestDb();
  db.exec(`
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, agent_provider TEXT, created_at TEXT NOT NULL);
    CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL, name TEXT, created_at TEXT NOT NULL, UNIQUE(channel_type, platform_id));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT, thread_id TEXT, agent_provider TEXT, status TEXT DEFAULT 'active', container_status TEXT DEFAULT 'stopped', last_active TEXT, sweep_quiet_until TEXT, created_at TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
    CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL, agent_group_id TEXT, granted_by TEXT, granted_at TEXT NOT NULL, PRIMARY KEY (user_id, role, agent_group_id));
    -- Cron edits resolve the owning group's timezone override (resolveGroupTimezone).
    CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, timezone TEXT, updated_at TEXT);
  `);
  migration043.up(db);
  db.prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, datetime('now'))").run(
    AG,
    'G1',
    AG,
  );
  db.prepare(
    "INSERT INTO messaging_groups (id, channel_type, platform_id, name, created_at) VALUES (?, 'discord', 'd:1', 'chan', datetime('now'))",
  ).run(MG);
  db.prepare(
    "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at) VALUES (?, ?, ?, NULL, 'active', 'stopped', datetime('now'))",
  ).run(SESS, AG, MG);
}

function addUser(id: string): void {
  getDb().prepare("INSERT INTO users (id, kind, created_at) VALUES (?, 'phone', datetime('now'))").run(id);
}
function grant(uid: string, role: string, ag: string | null): void {
  getDb()
    .prepare("INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES (?, ?, ?, datetime('now'))")
    .run(uid, role, ag);
}

function seedSession(): { inbound: string; outbound: string } {
  const dir = path.join(TEST_DIR, 'v2-sessions', AG, SESS);
  fs.mkdirSync(dir, { recursive: true });
  const inbound = path.join(dir, 'inbound.db');
  const outbound = path.join(dir, 'outbound.db');
  ensureSchema(inbound, 'inbound');
  ensureSchema(outbound, 'outbound');
  return { inbound, outbound };
}

function insertRow(
  inboundPath: string,
  row: {
    id: string;
    series_id?: string;
    status?: string;
    recurrence?: string | null;
    process_after?: string | null;
    scheduled_for?: string | null;
    content?: string;
  },
): void {
  const db = openInboundDb(inboundPath);
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages_in').get() as { m: number }).m + 2;
  const processAfter = row.process_after === undefined ? isoIn(3600_000) : row.process_after;
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, scheduled_for, recurrence, series_id, content, platform_id, channel_type)
     VALUES (@id, @seq, 'task', @ts, @status, @processAfter, @scheduledFor, @recurrence, @seriesId, @content, 'd:1', 'discord')`,
  ).run({
    id: row.id,
    seq,
    ts: isoIn(-3600_000),
    status: row.status ?? 'pending',
    processAfter,
    // Mirrors what every real insert path stamps.
    scheduledFor: row.scheduled_for === undefined ? processAfter : row.scheduled_for,
    recurrence: row.recurrence === undefined ? '0 9 * * *' : row.recurrence,
    seriesId: row.series_id ?? row.id,
    content: row.content ?? JSON.stringify({ prompt: 'old prompt', script: 'echo old' }),
  });
  db.close();
}

function setClaim(outboundPath: string, messageId: string): void {
  const db = new Database(outboundPath);
  db.pragma('journal_mode = DELETE');
  db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
  ).run(messageId);
  db.close();
}

function liveRow(seriesId: string):
  | {
      id: string;
      seq: number;
      status: string;
      trigger: number;
      process_after: string | null;
      scheduled_for: string | null;
      recurrence: string | null;
      content: string;
    }
  | undefined {
  const db = openInboundDb(path.join(TEST_DIR, 'v2-sessions', AG, SESS, 'inbound.db'));
  const row = db
    .prepare(
      'SELECT id, seq, status, trigger, process_after, scheduled_for, recurrence, content FROM messages_in WHERE series_id = ? ORDER BY seq DESC LIMIT 1',
    )
    .get(seriesId) as
    | {
        id: string;
        seq: number;
        status: string;
        trigger: number;
        process_after: string | null;
        scheduled_for: string | null;
        recurrence: string | null;
        content: string;
      }
    | undefined;
  db.close();
  return row;
}

function ctxFor(userId: string, scopes: AuthedRequestContext['scopes']): AuthedRequestContext {
  return {
    rawNodeReq: {} as never,
    user: { id: userId, kind: 'phone', display_name: null, created_at: '' } as never,
    scopes,
  };
}
const OWNER_SCOPES = { role: 'owner' as const, allowed_group_ids: [], no_filter: true };

function putReq(body: unknown): Request {
  return new Request('http://x/m', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}
function postReq(body?: unknown): Request {
  return new Request('http://x/m', {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}
async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function keyFor(seriesId: string): string {
  return encodeKey(AG, SESS, seriesId);
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setupCentralDb();
  invalidateScheduledCache();
  _resetScheduledRateLimitForTesting();
  mockWakeContainer.mockClear();
  mockAdmitDueTaskContexts.mockReset();
  // The stub stands in for the recall POLICY only — which row deserves a pair
  // and what the pair says. The COMMIT is the module's real `admitDueRow`, so
  // run-now's admission probe is checked against the production transaction
  // rather than a second hand-written copy of it.
  mockAdmitDueTaskContexts.mockImplementation((mailbox: NanoclawMailboxSession) => {
    const [task] = mailbox.listDueAdmissionRows();
    if (!task) return 0;
    return mailbox.admitDueRow(
      {
        id: `recall-${task.id}`,
        kind: 'system',
        timestamp: task.timestamp,
        platformId: null,
        channelType: null,
        threadId: null,
        content: JSON.stringify({ subtype: 'recall_context', source: 'fresh-test-admission' }),
        processAfter: task.process_after,
        recurrence: null,
        trigger: 0,
        sourceSessionId: null,
        onWake: 0,
      },
      task.id,
    )
      ? 1
      : 0;
  });
  _setMutationsTestOptions({ dataDir: TEST_DIR, nowMs: NOW });
  addUser('owner');
  grant('owner', 'owner', null);
});

afterEach(() => {
  _setMutationsTestOptions(null);
  closeDb();
  vi.restoreAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ── C1: edit ────────────────────────────────────────────────────────────────
// Codex F2. `updateSession` is the sole writer of `last_active`, but these
// handlers move `process_after` STRAIGHT into the session DB — a cron edit
// recomputes the next slot, a resume skips forward to the next future one — and
// due-ness lives nowhere the host sweep's quiet cache can see it. Without a
// central-DB touch the session stays quiet past its new due time, and since
// S2-PR15 persists that mark, across a restart too.
//
// Asserted on the central `sessions` row, deliberately not on the funnel: mailbox
// PR 7 rewrites this module onto the outbound funnel and this property must
// survive that rewrite unchanged.
describe('scheduled mutations invalidate the quiet mark (S2-PR15 / F2)', () => {
  function markSessionQuiet(): void {
    getDb()
      .prepare("UPDATE sessions SET last_active = ?, sweep_quiet_until = '2099-01-01T00:00:00.000Z' WHERE id = ?")
      .run('2026-06-01T00:00:00.000Z', SESS);
  }
  function sessionRow(): { last_active: string | null; sweep_quiet_until: string | null } {
    return getDb().prepare('SELECT last_active, sweep_quiet_until FROM sessions WHERE id = ?').get(SESS) as {
      last_active: string | null;
      sweep_quiet_until: string | null;
    };
  }

  it('a cron edit clears the quiet mark and moves last_active', async () => {
    insertRow(seedSession().inbound, {
      id: 'r1',
      series_id: 'ser-1',
      recurrence: '0 9 * * *',
      process_after: isoIn(3600_000),
    });
    markSessionQuiet();

    const res = (await editHandler(
      putReq({ cron: '0 6 * * *' }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(200);

    const row = sessionRow();
    expect(row.sweep_quiet_until, 'the quiet mark outlived a due-time change').toBeNull();
    expect(row.last_active).not.toBe('2026-06-01T00:00:00.000Z');
  });

  it('a resume clears the quiet mark and moves last_active', async () => {
    insertRow(seedSession().inbound, {
      id: 'r1',
      series_id: 'ser-1',
      recurrence: '0 9 * * *',
      process_after: isoIn(3600_000),
      status: 'paused',
    });
    markSessionQuiet();

    const res = (await resumeHandler(putReq({}), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);

    const row = sessionRow();
    expect(row.sweep_quiet_until).toBeNull();
    expect(row.last_active).not.toBe('2026-06-01T00:00:00.000Z');
  });

  // Codex round 2 H1 (a), in its final form. The invalidation now runs inside
  // the mailbox callback, in the same synchronous turn as the statement, so the
  // only interleave left is a flush whose basis was computed BEFORE it — which
  // the real `persistQuietSessionMarks` guard must reject.
  it('a quiet mark computed before the mutation is rejected by the flush guard', async () => {
    insertRow(seedSession().inbound, {
      id: 'r1',
      series_id: 'ser-1',
      recurrence: '0 9 * * *',
      process_after: isoIn(3600_000),
    });
    markSessionQuiet();
    const basis = sessionRow().last_active;

    const res = (await editHandler(
      putReq({ cron: '0 6 * * *' }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(200);
    expect(liveRow('ser-1')?.recurrence, 'the edit itself never landed').toBe('0 6 * * *');

    // The sweep's flush lands after the edit, carrying the basis it read before.
    const sessionsModule = await import('../../db/sessions.js');
    sessionsModule.persistQuietSessionMarks([
      { sessionId: SESS, quietUntil: '2099-01-01T00:00:00.000Z', lastActive: basis },
    ]);
    expect(sessionRow().sweep_quiet_until, 'a mark computed before the edit hid it').toBeNull();
  });

  // Codex round 2, H1 (b). Fail-closed: a refused invalidation must abort the
  // mutation with a 503 rather than write a due-time change that stays hidden
  // behind a mark nothing will clear.
  it('a failed invalidation refuses the mutation with a 503 and writes nothing', async () => {
    insertRow(seedSession().inbound, {
      id: 'r1',
      series_id: 'ser-1',
      recurrence: '0 9 * * *',
      process_after: isoIn(3600_000),
    });
    markSessionQuiet();

    const sessionsModule = await import('../../db/sessions.js');
    vi.spyOn(sessionsModule, 'withQuietInvalidationSync').mockImplementation((id: string) => {
      throw new sessionsModule.QuietInvalidationError(id, new Error('central DB is read-only'));
    });

    const res = (await editHandler(
      putReq({ cron: '0 6 * * *' }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(503);
    expect((await readJson(res)).reason).toBe('invalidation_failed');
    // The session-DB row is untouched: no due-time change landed behind the
    // still-live mark.
    expect(liveRow('ser-1')?.recurrence).toBe('0 9 * * *');
    expect(sessionRow().sweep_quiet_until).toBe('2099-01-01T00:00:00.000Z');
  });

  // Codex round 3, H2. A session row closed under the mutation must refuse, not
  // write into a session the sweep will never enumerate.
  it('refuses when the session row is no longer active', async () => {
    insertRow(seedSession().inbound, {
      id: 'r1',
      series_id: 'ser-1',
      recurrence: '0 9 * * *',
      process_after: isoIn(3600_000),
    });
    getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(SESS);

    const res = (await editHandler(
      putReq({ cron: '0 6 * * *' }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(503);
    expect((await readJson(res)).reason).toBe('invalidation_failed');
    expect(liveRow('ser-1')?.recurrence, 'a due-time change landed in a closed session').toBe('0 9 * * *');
  });
});

describe('editHandler', () => {
  it('test_edit_cron_recomputes_process_after', async () => {
    insertRow(seedSession().inbound, {
      id: 'r1',
      series_id: 'ser-1',
      recurrence: '0 9 * * *',
      process_after: isoIn(3600_000),
    });
    const res = (await editHandler(
      putReq({ cron: '0 6 * * *' }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(200);
    const row = liveRow('ser-1')!;
    expect(row.recurrence).toBe('0 6 * * *');
    // process_after recomputed to the next 06:00 occurrence — strictly future, not the old 09:00 slot.
    expect(Date.parse(row.process_after!)).toBeGreaterThan(NOW);
    expect(row.process_after).not.toBe(isoIn(3600_000));
    expect(row.trigger).toBe(0);
  });

  it('test_edit_invalid_cron_400', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1' });
    const res = (await editHandler(
      putReq({ cron: 'not a cron' }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('bad_cron');
  });

  it('test_edit_cron_empty_or_null_rejected_no_runaway', async () => {
    // cron-parser 5.5.0 ACCEPTS '' / null / undefined as the wildcard "* * * * *"
    // (parse does not throw), so a non-string/empty cron would slip past cronIsValid
    // and write recurrence='' / null verbatim → a runaway per-minute fire loop (the
    // recurring-task-runaway class). Each of these must be 400 with the live row's
    // recurrence UNCHANGED. (Empty string → 400 bad_cron via cronIsValid; null/number
    // → 400 invalid_request via the typeof guard.)
    insertRow(seedSession().inbound, {
      id: 'r1',
      series_id: 'ser-1',
      recurrence: '0 9 * * *',
      process_after: isoIn(3600_000),
    });
    for (const bad of ['', null, 99, {}, []] as unknown[]) {
      const res = (await editHandler(putReq({ cron: bad }), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
      expect(res.status).toBe(400);
      // The live recurring row is untouched — no recurrence='' / null written.
      expect(liveRow('ser-1')!.recurrence).toBe('0 9 * * *');
    }
  });

  it('test_edit_script_too_long_400', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1' });
    const res = (await editHandler(
      putReq({ script: 'x'.repeat(4001) }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('too_long');
  });

  it('prompt too long → 400', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1' });
    const res = (await editHandler(
      putReq({ prompt: 'x'.repeat(8001) }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(400);
  });

  it('test_edit_claimed_409', async () => {
    const { inbound, outbound } = seedSession();
    insertRow(inbound, { id: 'r1', series_id: 'ser-1', process_after: isoIn(-1000) });
    setClaim(outbound, 'r1'); // processing claim → processing health
    const res = (await editHandler(
      putReq({ prompt: 'new' }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('source_busy');
  });

  it('edits prompt + script into content (updateTask merge)', async () => {
    insertRow(seedSession().inbound, {
      id: 'r1',
      series_id: 'ser-1',
      content: JSON.stringify({ prompt: 'old', script: 'echo old', extra: 'keep' }),
    });
    await editHandler(putReq({ prompt: 'new prompt' }), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES));
    const parsed = JSON.parse(liveRow('ser-1')!.content) as Record<string, unknown>;
    expect(parsed.prompt).toBe('new prompt');
    expect(parsed.script).toBe('echo old');
    expect(parsed.extra).toBe('keep');
    expect(liveRow('ser-1')!.trigger).toBe(0);
  });

  it('gate: non-manage caller → 404; malformed key → 400', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1' });
    addUser('member');
    grant('member', 'member', AG);
    const memberScopes = { role: 'member' as const, allowed_group_ids: [AG], no_filter: false };
    expect(
      (await editHandler(putReq({ prompt: 'x' }), { key: keyFor('ser-1') }, ctxFor('member', memberScopes)))!.status,
    ).toBe(404);
    expect(
      (await editHandler(putReq({ prompt: 'x' }), { key: '@@bad@@' }, ctxFor('owner', OWNER_SCOPES)))!.status,
    ).toBe(400);
  });

  // ── M3: reject non-string prompt/script (live-content corruption) ─────────────
  it('test_edit_non_string_prompt_400_no_mutation', async () => {
    const original = JSON.stringify({ prompt: 'old prompt', script: 'echo old' });
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', content: original });
    const res = (await editHandler(
      putReq({ prompt: 99999 }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('invalid_request');
    // The live row's content is UNCHANGED.
    expect(liveRow('ser-1')!.content).toBe(original);
    // No audit row was written.
    const audit = getDb().prepare("SELECT COUNT(*) AS c FROM scheduled_audit WHERE series_id = 'ser-1'").get() as {
      c: number;
    };
    expect(audit.c).toBe(0);
  });

  it('test_edit_non_string_script_400', async () => {
    const original = JSON.stringify({ prompt: 'old', script: 'echo old' });
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', content: original });
    const res = (await editHandler(
      putReq({ script: { x: 1 } }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('invalid_request');
    expect(liveRow('ser-1')!.content).toBe(original);
  });

  // ── M4: a traversal :key never opens a file outside data/v2-sessions ──────────
  it('test_edit_traversal_key_rejected', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1' });
    // A base64url key whose decoded agentGroupId is '..' → decodeKey rejects it
    // (M4) → 400 bad_key, never an open outside the session tree.
    const traversalKey = Buffer.from('../../etc/passwd', 'utf8').toString('base64url');
    const res = (await editHandler(putReq({ prompt: 'x' }), { key: traversalKey }, ctxFor('owner', OWNER_SCOPES)))!;
    expect([400, 404]).toContain(res.status);
  });

  it('test_cancel_traversal_key_rejected', async () => {
    seedSession();
    const traversalKey = Buffer.from('..\\x/sess/series', 'utf8').toString('base64url');
    const res = (await cancelHandler(postReq(), { key: traversalKey }, ctxFor('owner', OWNER_SCOPES)))!;
    expect([400, 404]).toContain(res.status);
  });

  // ── cron corruption (M3 sibling): a falsy/non-string cron must never reach the
  // recurrence column. cron-parser accepts null/undefined/'' as "* * * * *" (a
  // per-minute fire), so an unguarded `{cron:""}` or `{cron:null}` turns a live
  // series into a runaway minute loop. Each of these MUST 400 with NO mutation.
  it('test_edit_empty_string_cron_400_no_mutation', async () => {
    const original = '0 9 * * *';
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', recurrence: original });
    const res = (await editHandler(putReq({ cron: '' }), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(400);
    // recurrence is UNCHANGED (never '' — '' is IS NOT NULL → firing-path runaway).
    expect(liveRow('ser-1')!.recurrence).toBe(original);
    const audit = getDb().prepare("SELECT COUNT(*) AS c FROM scheduled_audit WHERE series_id = 'ser-1'").get() as {
      c: number;
    };
    expect(audit.c).toBe(0);
  });

  it('test_edit_whitespace_cron_400', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', recurrence: '0 9 * * *' });
    const res = (await editHandler(putReq({ cron: '   ' }), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(400);
    expect(liveRow('ser-1')!.recurrence).toBe('0 9 * * *');
  });

  it('test_edit_null_cron_400_no_recurrence_clear', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', recurrence: '0 9 * * *' });
    // JSON `{"cron":null}` — must NOT silently clear recurrence (recurring→one-off)
    // or reschedule. typeof guard → 400 invalid_request, row untouched.
    const res = (await editHandler(putReq({ cron: null }), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('invalid_request');
    expect(liveRow('ser-1')!.recurrence).toBe('0 9 * * *');
  });

  it('test_edit_non_string_cron_400', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', recurrence: '0 9 * * *' });
    for (const bad of [12345, { x: 1 }, ['0 9 * * *']]) {
      const res = (await editHandler(putReq({ cron: bad }), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toBe('invalid_request');
      expect(liveRow('ser-1')!.recurrence).toBe('0 9 * * *');
    }
  });
});

// ── C2: pause / resume ────────────────────────────────────────────────────────
describe('pause / resume', () => {
  it('test_pause_then_resume_roundtrip', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', process_after: isoIn(3600_000) });
    expect((await pauseHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!.status).toBe(200);
    expect(liveRow('ser-1')!.status).toBe('paused');
    expect((await resumeHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!.status).toBe(200);
    const row = liveRow('ser-1')!;
    expect(row.status).toBe('pending');
    expect(Date.parse(row.process_after!)).toBeGreaterThan(NOW);
    expect(row.trigger).toBe(0);
  });

  it('test_resume_recomputes_slot_no_immediate_fire', async () => {
    // Paused, process_after 2 slots in the past.
    insertRow(seedSession().inbound, {
      id: 'r1',
      series_id: 'ser-1',
      status: 'paused',
      recurrence: '0 9 * * *',
      process_after: isoIn(-48 * 3600_000),
    });
    await resumeHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES));
    const row = liveRow('ser-1')!;
    expect(row.status).toBe('pending');
    // Recomputed to a FUTURE slot — does NOT fire immediately.
    expect(Date.parse(row.process_after!)).toBeGreaterThan(NOW);
  });

  // The preflight approves a PAUSED row, then the mailbox acquisition yields.
  // If another request resumes that row in the window, the old code still ran
  // `updateTask` (rewriting process_after on a now-pending row) and only then
  // discovered `resumeTask` touched nothing — reporting 409 while having
  // silently rescheduled a live series.
  it('a resume whose row was resumed during acquisition changes nothing and refuses', async () => {
    const armed = isoIn(-48 * 3600_000);
    insertRow(seedSession().inbound, {
      id: 'r1',
      series_id: 'ser-1',
      status: 'paused',
      recurrence: '0 9 * * *',
      process_after: armed,
    });

    duringMailboxAcquire.run = () => {
      const db = openInboundDb(path.join(TEST_DIR, 'v2-sessions', AG, SESS, 'inbound.db'));
      db.prepare("UPDATE messages_in SET status = 'pending' WHERE id = 'r1'").run();
      db.close();
    };

    const res = (await resumeHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).not.toBe(200);

    // The decisive assertion: the armed instant is untouched. The bug was not
    // the status code, it was the write that happened before it.
    const row = liveRow('ser-1')!;
    expect(row.status).toBe('pending');
    expect(row.process_after).toBe(armed);
  });

  it('test_pause_claimed_409', async () => {
    const { inbound, outbound } = seedSession();
    insertRow(inbound, { id: 'r1', series_id: 'ser-1', process_after: isoIn(-1000) });
    setClaim(outbound, 'r1');
    const res = (await pauseHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('source_busy');
  });
});

// ── C3: run-now ────────────────────────────────────────────────────────────────
describe('runNowHandler', () => {
  it('test_runnow_stalled_unclaimed_fires', async () => {
    // Overdue + unclaimed (no outbound claim) → fires.
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', process_after: isoIn(-60_000) });
    const res = (await runNowHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);
    expect((await readJson(res)).fired).toBe(true);
    // Fresh due admission completes before the direct wake.
    expect(mockAdmitDueTaskContexts).toHaveBeenCalledWith(expect.anything(), AG, SESS);
    expect(mockWakeContainer).toHaveBeenCalledTimes(1);
    expect(mockAdmitDueTaskContexts.mock.invocationCallOrder[0]).toBeLessThan(
      mockWakeContainer.mock.invocationCallOrder[0]!,
    );
    const row = liveRow('ser-1')!;
    expect(Date.parse(row.process_after!)).toBeLessThanOrEqual(NOW + 1000);
    expect(row.trigger).toBe(1);
  });

  it("an early fire moves process_after but leaves the occurrence's slot alone", async () => {
    // §4.6: run-now does not shift the schedule. The row is still FOR its
    // original slot, so that is what the agent must be told it is running.
    const originalSlot = isoIn(-60_000);
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', process_after: originalSlot });

    const res = (await runNowHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);

    const row = liveRow('ser-1')!;
    expect(Date.parse(row.process_after!)).toBeLessThanOrEqual(NOW + 1000);
    expect(row.scheduled_for).toBe(originalSlot);
  });

  it('does not report fired or wake when fresh context admission fails', async () => {
    const originalSlot = isoIn(30_000);
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', process_after: originalSlot });
    mockAdmitDueTaskContexts.mockReturnValueOnce(0);

    const res = (await runNowHandler(
      postReq({ force: true }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;

    expect(res.status).toBe(503);
    expect((await readJson(res)).error).toBe('context_admission_failed');
    expect(mockWakeContainer).not.toHaveBeenCalled();
    expect(liveRow('ser-1')).toMatchObject({ trigger: 0, process_after: originalSlot });
  });

  it('test_runnow_unknown_503', async () => {
    // Overdue but outbound.db absent → unknown → 503 fail-closed, no wake.
    const dir = path.join(TEST_DIR, 'v2-sessions', AG, SESS);
    fs.mkdirSync(dir, { recursive: true });
    ensureSchema(path.join(dir, 'inbound.db'), 'inbound');
    // NO outbound.db created → unknown.
    insertRow(path.join(dir, 'inbound.db'), { id: 'r1', series_id: 'ser-1', process_after: isoIn(-60_000) });
    const res = (await runNowHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(503);
    expect((await readJson(res)).reason).toBe('claim_state_unreadable');
    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('test_runnow_near_slot_needs_force', async () => {
    // process_after within GUARD_GRACE of now (healthy, near slot), not forced.
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', process_after: isoIn(30_000) });
    const res = (await runNowHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('near_slot');
    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('test_runnow_force_fires', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', process_after: isoIn(30_000) });
    const res = (await runNowHandler(
      postReq({ force: true }),
      { key: keyFor('ser-1') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(200);
    expect(mockWakeContainer).toHaveBeenCalledTimes(1);
  });

  it('test_runnow_rate_limited', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1', process_after: isoIn(-60_000) });
    for (let i = 0; i < 30; i++) expect(rateLimit('owner', 'run_now').ok).toBe(true);

    const res = (await runNowHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;

    expect(res.status).toBe(429);
  });
});

// ── C4: cancel ──────────────────────────────────────────────────────────────
describe('cancelHandler', () => {
  it('test_cancel_writes_audit', async () => {
    insertRow(seedSession().inbound, { id: 'r1', series_id: 'ser-1' });
    const res = (await cancelHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);
    expect((await readJson(res)).cancelled).toBe(true);
    const audit = getDb()
      .prepare("SELECT 1 AS ok FROM scheduled_audit WHERE series_id = 'ser-1' AND action = 'cancel'")
      .get() as { ok: number } | undefined;
    expect(audit).toBeDefined();
    expect(liveRow('ser-1')!.status).toBe('cancelled');
  });

  it('test_cancel_strand_succeeds', async () => {
    // Pure strand: one terminal (completed) row, recurrence still set, no live row.
    const { inbound } = seedSession();
    insertRow(inbound, { id: 'r1', series_id: 'ser-1' });
    {
      const db = openInboundDb(inbound);
      db.prepare("UPDATE messages_in SET status='completed' WHERE series_id='ser-1'").run(); // recurrence stays set
      db.close();
    }
    const res = (await cancelHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200); // NOT 409 — the strand clear counts as touched
  });

  it('test_cancel_no_resurrection', async () => {
    const { inbound } = seedSession();
    insertRow(inbound, { id: 'r1', series_id: 'ser-1' });
    {
      const db = openInboundDb(inbound);
      db.prepare("UPDATE messages_in SET status='completed' WHERE series_id='ser-1'").run();
      db.close();
    }
    await cancelHandler(postReq(), { key: keyFor('ser-1') }, ctxFor('owner', OWNER_SCOPES));
    // getCompletedRecurring would mint a successor if recurrence were still set.
    const { getCompletedRecurring } = await import('../../modules/scheduling/db.js');
    const db = openInboundDb(inbound);
    const recurring = getCompletedRecurring(db).filter((r) => r.series_id === 'ser-1');
    db.close();
    expect(recurring).toHaveLength(0);
  });

  it('stale key (no rows) → 409 stale_key', async () => {
    seedSession(); // empty inbound
    const res = (await cancelHandler(postReq(), { key: keyFor('nonexistent') }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('stale_key');
  });
});

// ── C5: moduleOwner ─────────────────────────────────────────────────────────
describe('moduleOwner', () => {
  it('test_module_synth_detected', () => {
    expect(moduleOwner('memory-synth-ag-xyz')).toEqual({ moduleOwned: true, owner: 'memory' });
  });
  it('test_operator_task_not_module', () => {
    expect(moduleOwner('task-morning-briefing')).toEqual({ moduleOwned: false });
  });
  it('test_mnemon_static_map', () => {
    // memory-lint-* is the other prefixed module series.
    expect(moduleOwner('memory-lint-ag-xyz')).toEqual({ moduleOwned: true, owner: 'memory' });
  });
});
