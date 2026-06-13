/**
 * Tests for the Scheduled Tasks Board read endpoints (Tasks B3 + B4):
 * GET /dashboard/api/scheduled (list) and GET /dashboard/api/scheduled/:key
 * (detail).
 *
 * TDD: written before the implementation. On-disk session fixtures + in-memory
 * central DB, driving the AuthHandlers directly with a synthetic ctx.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import Database from 'better-sqlite3';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { migration043 } from '../../db/migrations/043-scheduled-audit.js';
import { invalidateScheduledCache, encodeKey, writeAudit } from './scheduled-shared.js';
import { _resetAssemblyInFlightForTesting } from './scheduled-assembly.js';
import { scheduledListHandler, scheduledDetailHandler } from './scheduled-read.js';
import type { AuthedRequestContext } from '../router.js';

const TEST_DIR = '/tmp/nanoclaw-scheduled-read-test';
const NOW = Date.parse('2026-06-13T12:00:00Z');

// The read handlers default to DATA_DIR; point that at our fixture dir for the
// duration of the test by overriding the env the config captured. The handlers
// accept an options bag in tests via a module-level injection seam.
import * as readMod from './scheduled-read.js';

function isoIn(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

function setupCentralDb(): void {
  const db = initTestDb();
  db.exec(`
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
      name TEXT, created_at TEXT NOT NULL, UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
      thread_id TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
    CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL, agent_group_id TEXT, granted_by TEXT, granted_at TEXT NOT NULL, PRIMARY KEY (user_id, role, agent_group_id));
  `);
  migration043.up(db);
}

function addGroup(id: string, name: string): void {
  getDb()
    .prepare(
      "INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, 'claude', datetime('now'))",
    )
    .run(id, name, id);
}
function addMg(id: string, channelType: string, platformId: string, name: string): void {
  getDb()
    .prepare(
      "INSERT INTO messaging_groups (id, channel_type, platform_id, name, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run(id, channelType, platformId, name);
}
function addSession(id: string, agentGroupId: string, mgId: string): void {
  getDb()
    .prepare(
      "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at) VALUES (?, ?, ?, NULL, 'active', datetime('now'))",
    )
    .run(id, agentGroupId, mgId);
}
function addUser(id: string): void {
  getDb().prepare("INSERT INTO users (id, kind, created_at) VALUES (?, 'phone', datetime('now'))").run(id);
}
function grant(uid: string, role: string, ag: string | null): void {
  getDb()
    .prepare("INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES (?, ?, ?, datetime('now'))")
    .run(uid, role, ag);
}

function seedSession(agentGroupId: string, sessionId: string): { inbound: string; outbound: string } {
  const dir = path.join(TEST_DIR, 'v2-sessions', agentGroupId, sessionId);
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
    content?: string;
    timestamp?: string;
  },
): void {
  const db = openInboundDb(inboundPath);
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages_in').get() as { m: number }).m + 2;
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, content, platform_id, channel_type)
     VALUES (@id, @seq, 'task', @timestamp, @status, @processAfter, @recurrence, @seriesId, @content, 'd:1', 'discord')`,
  ).run({
    id: row.id,
    seq,
    timestamp: row.timestamp ?? isoIn(-3600_000),
    status: row.status ?? 'pending',
    processAfter: row.process_after ?? isoIn(3600_000),
    recurrence: row.recurrence === undefined ? '0 9 * * *' : row.recurrence,
    seriesId: row.series_id ?? row.id,
    content: row.content ?? JSON.stringify({ prompt: 'do thing', script: 'echo hi' }),
  });
  db.close();
}

function addReply(outboundPath: string, inReplyTo: string, ts: string): void {
  const db = new Database(outboundPath);
  db.pragma('journal_mode = DELETE');
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages_out').get() as { m: number }).m + 1;
  db.prepare(
    "INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, content) VALUES (?, ?, ?, ?, 'chat', '{}')",
  ).run(`out-${inReplyTo}`, seq, inReplyTo, ts);
  db.close();
}

function ctxFor(userId: string, scopes: AuthedRequestContext['scopes']): AuthedRequestContext {
  return {
    rawNodeReq: {} as never,
    user: { id: userId, kind: 'phone', display_name: null, created_at: '' } as never,
    scopes,
  };
}

const OWNER_SCOPES = { role: 'owner' as const, allowed_group_ids: [], no_filter: true };

function listReq(): Request {
  return new Request('http://x/dashboard/api/scheduled');
}
async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setupCentralDb();
  invalidateScheduledCache();
  _resetAssemblyInFlightForTesting();
  // Point the read handlers' assembly at the fixture dir + fixed now.
  readMod._setReadTestOptions({ dataDir: TEST_DIR, nowMs: NOW });
});

afterEach(() => {
  readMod._setReadTestOptions(null);
  closeDb();
  vi.restoreAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ── B3: list ────────────────────────────────────────────────────────────────
describe('scheduledListHandler', () => {
  it('test_list_owner_sees_all', async () => {
    addGroup('ag-1', 'G1');
    addGroup('ag-2', 'G2');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('s1', 'ag-1', 'mg-1');
    addSession('s2', 'ag-2', 'mg-1');
    insertRow(seedSession('ag-1', 's1').inbound, { id: 'r1' });
    insertRow(seedSession('ag-2', 's2').inbound, { id: 'r2' });
    addUser('owner');
    grant('owner', 'owner', null);

    const res = (await scheduledListHandler(listReq(), {}, ctxFor('owner', OWNER_SCOPES)))!;
    const body = await readJson(res);
    const rows = body.rows as Array<{ agent_group_id: string }>;
    const groups = new Set(rows.map((r) => r.agent_group_id));
    expect(groups.has('ag-1')).toBe(true);
    expect(groups.has('ag-2')).toBe(true);
  });

  it('test_list_scope_filters_rows', async () => {
    addGroup('ag-1', 'G1');
    addGroup('ag-2', 'G2');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('s1', 'ag-1', 'mg-1');
    addSession('s2', 'ag-2', 'mg-1');
    insertRow(seedSession('ag-1', 's1').inbound, { id: 'r1' });
    insertRow(seedSession('ag-2', 's2').inbound, { id: 'r2' });
    addUser('sadmin');
    grant('sadmin', 'admin', 'ag-1');

    const scopes = { role: 'admin_of_group' as const, allowed_group_ids: ['ag-1'], no_filter: false };
    const res = (await scheduledListHandler(listReq(), {}, ctxFor('sadmin', scopes)))!;
    const body = await readJson(res);
    const rows = body.rows as Array<{ agent_group_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.agent_group_id === 'ag-1')).toBe(true);
  });

  it('test_list_includes_available_verbs', async () => {
    addGroup('ag-1', 'G1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('s1', 'ag-1', 'mg-1');
    insertRow(seedSession('ag-1', 's1').inbound, { id: 'r1' });
    addUser('owner');
    grant('owner', 'owner', null);

    const res = (await scheduledListHandler(listReq(), {}, ctxFor('owner', OWNER_SCOPES)))!;
    const body = await readJson(res);
    const rows = body.rows as Array<{ available_verbs: unknown }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => Array.isArray(r.available_verbs))).toBe(true);
    expect(body.counts).toBeDefined();
    expect(body.degraded).toBe(false);
    expect(body.assembled_at).toBeTruthy();
  });

  it('test_list_surfaces_unresolved_repair_row', async () => {
    addGroup('ag-1', 'G1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('s1', 'ag-1', 'mg-1');
    seedSession('ag-1', 's1'); // empty inbound — the series has NO live row
    addUser('owner');
    grant('owner', 'owner', null);

    // An unresolved move_restore_failed audit row for a series with no live row.
    writeAudit(getDb(), {
      actor: 'owner',
      action: 'move_restore_failed',
      agentGroupId: 'ag-1',
      sessionId: 's1',
      seriesId: 'lost-series',
      correlationId: 'corr-x',
    });

    const res = (await scheduledListHandler(listReq(), {}, ctxFor('owner', OWNER_SCOPES)))!;
    const body = await readJson(res);
    const rows = body.rows as Array<{ series_id: string; health: string }>;
    const repair = rows.find((r) => r.series_id === 'lost-series');
    expect(repair).toBeDefined();
    expect(repair!.health).toBe('stalled');
  });
});

// ── B4: detail ────────────────────────────────────────────────────────────────
describe('scheduledDetailHandler', () => {
  function detailReq(): Request {
    return new Request('http://x/dashboard/api/scheduled/key');
  }

  it('returns full prompt + script + history for an in-scope key', async () => {
    addGroup('ag-1', 'G1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('s1', 'ag-1', 'mg-1');
    const { inbound, outbound } = seedSession('ag-1', 's1');
    insertRow(inbound, { id: 'r1', series_id: 'ser-1', content: JSON.stringify({ prompt: 'P', script: 'echo S' }) });
    // A completed prior fire WITH a reply → outcome 'ran'.
    insertRow(inbound, {
      id: 'fire-1',
      series_id: 'ser-1',
      status: 'completed',
      recurrence: null,
      process_after: isoIn(-7200_000),
      timestamp: isoIn(-7200_000),
    });
    addReply(outbound, 'fire-1', isoIn(-7100_000));
    addUser('owner');
    grant('owner', 'owner', null);

    const key = encodeKey('ag-1', 's1', 'ser-1');
    const res = (await scheduledDetailHandler(detailReq(), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.prompt).toBe('P');
    expect(body.script).toBe('echo S');
    const history = body.history as Array<{ outcome: string }>;
    expect(history.find((h) => h.outcome === 'ran')).toBeDefined();
  });

  it('test_detail_out_of_scope_404', async () => {
    addGroup('ag-1', 'G1');
    addGroup('ag-2', 'G2');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('s2', 'ag-2', 'mg-1');
    insertRow(seedSession('ag-2', 's2').inbound, { id: 'r2', series_id: 'ser-2' });
    addUser('sadmin');
    grant('sadmin', 'admin', 'ag-1');

    // Scoped admin of ag-1 requests a key for ag-2 → 404 disclose-as-not-found.
    const key = encodeKey('ag-2', 's2', 'ser-2');
    const scopes = { role: 'admin_of_group' as const, allowed_group_ids: ['ag-1'], no_filter: false };
    const res = (await scheduledDetailHandler(detailReq(), { key }, ctxFor('sadmin', scopes)))!;
    expect(res.status).toBe(404);
  });

  it('test_detail_audit_tail_mutation_tier_only', async () => {
    addGroup('ag-1', 'G1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('s1', 'ag-1', 'mg-1');
    insertRow(seedSession('ag-1', 's1').inbound, { id: 'r1', series_id: 'ser-1' });
    // An audit row exists for the series.
    writeAudit(getDb(), {
      actor: 'owner',
      action: 'edit',
      agentGroupId: 'ag-1',
      sessionId: 's1',
      seriesId: 'ser-1',
      before: 'old',
      after: 'new',
    });
    addUser('owner');
    grant('owner', 'owner', null);
    addUser('member');
    grant('member', 'member', 'ag-1');

    const key = encodeKey('ag-1', 's1', 'ser-1');

    // Owner (mutation tier) → audit_tail present.
    const ownerRes = (await scheduledDetailHandler(detailReq(), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    const ownerBody = await readJson(ownerRes);
    expect(Array.isArray(ownerBody.audit_tail)).toBe(true);
    expect((ownerBody.audit_tail as unknown[]).length).toBeGreaterThan(0);

    // Member (read tier, but in-scope so not 404) → audit_tail ABSENT.
    const memberScopes = { role: 'member' as const, allowed_group_ids: ['ag-1'], no_filter: false };
    const memberRes = (await scheduledDetailHandler(detailReq(), { key }, ctxFor('member', memberScopes)))!;
    const memberBody = await readJson(memberRes);
    expect(memberBody.audit_tail).toBeUndefined();
  });

  it('test_detail_history_labels', async () => {
    addGroup('ag-1', 'G1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('s1', 'ag-1', 'mg-1');
    const { inbound } = seedSession('ag-1', 's1');
    insertRow(inbound, { id: 'live', series_id: 'ser-1' });
    // completed WITHOUT a reply → 'completed (no chat output)'.
    insertRow(inbound, {
      id: 'fire-noout',
      series_id: 'ser-1',
      status: 'completed',
      recurrence: null,
      process_after: isoIn(-7200_000),
      timestamp: isoIn(-7200_000),
    });
    addUser('owner');
    grant('owner', 'owner', null);

    const key = encodeKey('ag-1', 's1', 'ser-1');
    const res = (await scheduledDetailHandler(detailReq(), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    const body = await readJson(res);
    const history = body.history as Array<{ outcome: string }>;
    expect(history.find((h) => h.outcome === 'completed (no chat output)')).toBeDefined();
  });

  it('rejects a malformed key with 400 (codec contract — bad request, not hidden resource)', async () => {
    addUser('owner');
    grant('owner', 'owner', null);
    const res = (await scheduledDetailHandler(detailReq(), { key: '@@bad@@' }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(400);
  });

  it('returns a COMPLETE ScheduledRow the drawer can consume (available_verbs/health/joins)', async () => {
    addGroup('ag-1', 'G1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('s1', 'ag-1', 'mg-1');
    const { inbound } = seedSession('ag-1', 's1');
    // platform_id/channel_type 'd:1'/'discord' are set by insertRow → joins to chan-1.
    insertRow(inbound, { id: 'r1', series_id: 'ser-1' });
    addUser('owner');
    grant('owner', 'owner', null);

    const key = encodeKey('ag-1', 's1', 'ser-1');
    const res = (await scheduledDetailHandler(detailReq(), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    const body = await readJson(res);
    const row = body.row as Record<string, unknown>;
    // The drawer reads ALL of these — a thin projection would make it throw on
    // row.available_verbs.includes(...) and render undefined fields.
    expect(Array.isArray(row.available_verbs)).toBe(true);
    expect(typeof row.health).toBe('string');
    expect(row.agent_group_name).toBe('G1');
    expect(row.channel_name).toBe('chan-1');
    expect(row.kind).toBe('recurring');
    expect(row.series_id).toBe('ser-1');
    expect(row.key).toBe(key);
    expect('module_owner' in row).toBe(true);
    expect('next_fire_local' in row).toBe(true);
    expect('quiet_status' in row).toBe(true);
    expect('flag_intent' in row).toBe(true);
  });
});
