/**
 * Tests for the Scheduled Tasks Board move flow (Tasks D1 + D2):
 *   POST /dashboard/api/scheduled/:key/move/preview  (dry-run delta)
 *   POST /dashboard/api/scheduled/:key/move           (cancel-first execute)
 *
 * TDD: written before the implementation. On-disk session fixtures + in-memory
 * central DB, driving the AuthHandlers directly with a synthetic ctx.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { migration043 } from '../../db/migrations/043-scheduled-audit.js';
import { encodeKey, invalidateScheduledCache, _resetScheduledRateLimitForTesting } from './scheduled-shared.js';
import { movePreviewHandler, moveExecuteHandler, _setMoveTestOptions } from './scheduled-move.js';
import { computeSecretDelta } from './scheduled-move.js';
import type { AuthedRequestContext } from '../router.js';

const TEST_DIR = '/tmp/nanoclaw-scheduled-move-test';
const NOW = Date.parse('2026-06-13T12:00:00Z');

function isoIn(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

function setupCentralDb(): void {
  const db = initTestDb();
  db.exec(`
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, created_at TEXT NOT NULL, workgroup_id TEXT
    );
    CREATE TABLE workgroups (id TEXT PRIMARY KEY, display_name TEXT, onecli_secrets TEXT);
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
      name TEXT, is_group INTEGER DEFAULT 0, unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
      created_at TEXT NOT NULL, UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE messaging_group_agents (
      id TEXT PRIMARY KEY, messaging_group_id TEXT NOT NULL, agent_group_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(messaging_group_id, agent_group_id)
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
      thread_id TEXT, agent_provider TEXT, status TEXT DEFAULT 'active',
      container_status TEXT DEFAULT 'stopped', last_active TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
    CREATE UNIQUE INDEX sessions_channel_root_unique ON sessions(agent_group_id, messaging_group_id)
      WHERE thread_id IS NULL AND status = 'active';
    CREATE TABLE users (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
    CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL, agent_group_id TEXT, granted_by TEXT, granted_at TEXT NOT NULL, PRIMARY KEY (user_id, role, agent_group_id));
    CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, provider TEXT, updated_at TEXT);
  `);
  migration043.up(db);
}

function addGroup(id: string, folder: string, workgroupId: string | null = null): void {
  getDb()
    .prepare(
      "INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, workgroup_id) VALUES (?, ?, ?, 'claude', datetime('now'), ?)",
    )
    .run(id, id, folder, workgroupId);
}
function addWorkgroup(id: string, secrets: string[]): void {
  getDb()
    .prepare('INSERT INTO workgroups (id, display_name, onecli_secrets) VALUES (?, ?, ?)')
    .run(id, id, JSON.stringify(secrets));
}
function addMg(id: string, channelType: string, platformId: string, name: string): void {
  getDb()
    .prepare(
      "INSERT INTO messaging_groups (id, channel_type, platform_id, name, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run(id, channelType, platformId, name);
}
function wire(mgId: string, agId: string): void {
  getDb()
    .prepare(
      "INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at) VALUES (?, ?, ?, datetime('now'))",
    )
    .run(`mga-${mgId}-${agId}`, mgId, agId);
}
function addSession(id: string, agentGroupId: string, mgId: string): void {
  getDb()
    .prepare(
      "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at) VALUES (?, ?, ?, NULL, 'active', 'stopped', datetime('now'))",
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

/** Write a group's container.json with onecliSecrets (the per-group secret source). */
function setGroupSecrets(folder: string, secrets: string[]): void {
  const dir = path.join(TEST_DIR, 'groups', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify({ onecliSecrets: secrets }));
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
    platform_id?: string;
    channel_type?: string;
  },
): void {
  const db = openInboundDb(inboundPath);
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages_in').get() as { m: number }).m + 2;
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, content, platform_id, channel_type)
     VALUES (@id, @seq, 'task', @ts, @status, @processAfter, @recurrence, @seriesId, @content, @platformId, @channelType)`,
  ).run({
    id: row.id,
    seq,
    ts: isoIn(-3600_000),
    status: row.status ?? 'pending',
    processAfter: row.process_after ?? isoIn(3600_000),
    recurrence: row.recurrence === undefined ? '0 9 * * *' : row.recurrence,
    seriesId: row.series_id ?? row.id,
    content: row.content ?? JSON.stringify({ prompt: 'do thing', script: 'echo hi' }),
    platformId: row.platform_id ?? 'src:1',
    channelType: row.channel_type ?? 'discord',
  });
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

function req(body: unknown): Request {
  return new Request('http://x/m', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}
async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setupCentralDb();
  invalidateScheduledCache();
  _resetScheduledRateLimitForTesting();
  _setMoveTestOptions({ dataDir: TEST_DIR, nowMs: NOW });
});

afterEach(() => {
  _setMoveTestOptions(null);
  closeDb();
  vi.restoreAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ── Common fixture: source group/session/series + a target group/channel ──────
function seedMoveFixture(opts?: { sourceStatus?: string; sourceProcessAfter?: string | null }): { key: string } {
  addWorkgroup('wg-1', ['Anthropic', 'Linear']);
  addGroup('src-ag', 'src-folder', 'wg-1');
  addGroup('tgt-ag', 'tgt-folder', 'wg-1');
  addMg('src-mg', 'discord', 'src:1', 'src-chan');
  addMg('tgt-mg', 'discord', 'tgt:1', 'tgt-chan');
  wire('src-mg', 'src-ag');
  wire('tgt-mg', 'tgt-ag'); // target wired by default
  addSession('src-sess', 'src-ag', 'src-mg');
  setGroupSecrets('src-folder', ['Anthropic']); // effective source = wg ∪ group = {Anthropic, Linear}
  setGroupSecrets('tgt-folder', ['Datafold-Prod']); // effective target = {Anthropic, Linear, Datafold-Prod}
  const { inbound } = seedSession('src-ag', 'src-sess');
  insertRow(inbound, {
    id: 'r1',
    series_id: 'ser-1',
    status: opts?.sourceStatus ?? 'pending',
    process_after: opts?.sourceProcessAfter ?? isoIn(3600_000),
  });
  addUser('owner');
  grant('owner', 'owner', null);
  addUser('sadmin');
  grant('sadmin', 'admin', 'src-ag');
  return { key: encodeKey('src-ag', 'src-sess', 'ser-1') };
}

// ── D1: preview ────────────────────────────────────────────────────────────────
describe('movePreviewHandler', () => {
  it('test_preview_requires_mutation_tier', async () => {
    const { key } = seedMoveFixture();
    const scopes = { role: 'admin_of_group' as const, allowed_group_ids: ['src-ag'], no_filter: false };
    const res = (await movePreviewHandler(
      req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
      { key },
      ctxFor('sadmin', scopes),
    ))!;
    // Scoped admin cannot enumerate target secret names → 404 disclose-as-not-found.
    expect(res.status).toBe(404);
  });

  it('test_preview_returns_names_not_values', async () => {
    const { key } = seedMoveFixture();
    const res = (await movePreviewHandler(
      req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(200);
    const body = await readJson(res);
    // gains = effective(target) − effective(source) = {Datafold-Prod}.
    expect(body.gains).toEqual(['Datafold-Prod']);
    // losses = effective(source) − effective(target) = {} (target is a superset here).
    expect(body.losses).toEqual([]);
    expect(body.wiringOk).toBe(true);
    expect(body.environmentDeltaChecked).toBe(false);
    expect(body.scriptPresent).toBe(true);
    expect(typeof body.deltaHash).toBe('string');
  });

  it('test_preview_unwired_target', async () => {
    const { key } = seedMoveFixture();
    // Remove the target wiring.
    getDb().prepare("DELETE FROM messaging_group_agents WHERE agent_group_id = 'tgt-ag'").run();
    const res = (await movePreviewHandler(
      req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.wiringOk).toBe(false);
  });

  it('test_preview_emits_delta_hash', async () => {
    const { key } = seedMoveFixture();
    const a = await readJson(
      (await movePreviewHandler(
        req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
        { key },
        ctxFor('owner', OWNER_SCOPES),
      ))!,
    );
    const b = await readJson(
      (await movePreviewHandler(
        req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
        { key },
        ctxFor('owner', OWNER_SCOPES),
      ))!,
    );
    // Stable hash for identical inputs.
    expect(a.deltaHash).toBe(b.deltaHash);
  });

  it('out-of-scope target key → 404 (never 403)', async () => {
    const { key } = seedMoveFixture();
    const res = (await movePreviewHandler(
      req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
      { key: encodeKey('nonexistent', 'x', 'y') },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(404);
  });

  it('crossWorkgroup is false when both groups share a workgroup', async () => {
    const { key } = seedMoveFixture();
    const body = await readJson(
      (await movePreviewHandler(
        req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
        { key },
        ctxFor('owner', OWNER_SCOPES),
      ))!,
    );
    expect(body.crossWorkgroup).toBe(false);
  });
});

// ── D2: execute ────────────────────────────────────────────────────────────────
function deltaHashFor(targetMessagingGroupId = 'tgt-mg'): string {
  // effective(src) = {Anthropic, Linear}; effective(tgt) = {Anthropic, Linear, Datafold-Prod}.
  // The hash now binds the move target identity (E-4) — pass the MG id used at execute.
  return computeSecretDelta(
    'src-ag',
    'src-folder',
    'tgt-ag',
    'tgt-folder',
    targetMessagingGroupId,
    path.join(TEST_DIR, 'groups'),
  ).deltaHash;
}

function liveRowsForSeries(
  agentGroupId: string,
  sessionId: string,
  seriesId: string,
): Array<{ id: string; status: string; process_after: string | null; recurrence: string | null }> {
  const p = path.join(TEST_DIR, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
  if (!fs.existsSync(p)) return [];
  const db = openInboundDb(p);
  const rows = db
    .prepare(
      "SELECT id, status, process_after, recurrence FROM messages_in WHERE series_id = ? AND kind = 'task' AND status IN ('pending','paused')",
    )
    .all(seriesId) as Array<{ id: string; status: string; process_after: string | null; recurrence: string | null }>;
  db.close();
  return rows;
}

/** Target session id for (tgt-ag, tgt-mg) — scheduleTask creates a channel-root session. */
function targetSessionId(): string | null {
  const row = getDb()
    .prepare(
      "SELECT id FROM sessions WHERE agent_group_id = 'tgt-ag' AND messaging_group_id = 'tgt-mg' AND status='active' LIMIT 1",
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

function moveBody(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    targetAgentGroupId: 'tgt-ag',
    targetMessagingGroupId: 'tgt-mg',
    confirmedDeltaHash: deltaHashFor(),
    ...over,
  };
}

describe('moveExecuteHandler', () => {
  it('test_move_one_live_row_invariant', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) }); // far future, unclaimed → move allowed
    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);
    expect((await readJson(res)).moved).toBe(true);

    // Source row terminal (no live row); exactly one live recurrence-set row in target.
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(0);
    const tgtSess = targetSessionId();
    expect(tgtSess).toBeTruthy();
    const tgtLive = liveRowsForSeries('tgt-ag', tgtSess!, 'ser-1');
    expect(tgtLive).toHaveLength(1);
    expect(tgtLive[0].recurrence).toBe('0 9 * * *');
  });

  it('test_move_paused_stages_insert_never_due_pending', async () => {
    // Paused source with a PAST-due process_after (paused >1 cycle).
    const { key } = seedMoveFixture({ sourceStatus: 'paused', sourceProcessAfter: isoIn(-48 * 3600_000) });
    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);

    const tgtSess = targetSessionId()!;
    const tgtLive = liveRowsForSeries('tgt-ag', tgtSess, 'ser-1');
    expect(tgtLive).toHaveLength(1);
    // Final state: paused, with the original (past-due) process_after restored.
    expect(tgtLive[0].status).toBe('paused');
    expect(tgtLive[0].process_after).toBe(isoIn(-48 * 3600_000));
    // Invariant the staged insert guarantees: the row is never (pending AND due)
    // — since it ended paused, it was never a claimable pending+due target.
  });

  it('test_move_writes_intent_before_cancel', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES));
    // A move_intent audit row was written, then resolved (resolved_at set, body purged).
    const intent = getDb()
      .prepare("SELECT detail_json, resolved_at FROM scheduled_audit WHERE action = 'move_intent'")
      .get() as { detail_json: string | null; resolved_at: string | null } | undefined;
    expect(intent).toBeDefined();
    expect(intent!.resolved_at).toBeTruthy(); // resolved on success
    expect(intent!.detail_json).toBeNull(); // body purged (F5)
  });

  it('writes TWO-sided move audit sharing a correlation_id', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES));
    const moveRows = getDb()
      .prepare("SELECT agent_group_id, correlation_id FROM scheduled_audit WHERE action = 'move'")
      .all() as Array<{ agent_group_id: string; correlation_id: string }>;
    expect(moveRows).toHaveLength(2);
    const groups = new Set(moveRows.map((r) => r.agent_group_id));
    expect(groups.has('src-ag')).toBe(true);
    expect(groups.has('tgt-ag')).toBe(true);
    // Same correlation id on both sides.
    expect(moveRows[0].correlation_id).toBe(moveRows[1].correlation_id);
    expect(moveRows[0].correlation_id).toBeTruthy();
  });

  it('test_move_delta_changed_409', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const res = (await moveExecuteHandler(
      req(moveBody({ confirmedDeltaHash: 'stale-hash' })),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('delta_changed');
    // No cancel performed — source still live.
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(1);
  });

  it('test_move_due_source_409_source_busy', async () => {
    // Pending source, process_after in the past → due → move blocked.
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(-1000) });
    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('source_busy');
    // No cancel performed.
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(1);
  });

  it('test_move_compensation_restores_source', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    // Real post-cancel failure trigger: remove the TARGET wiring so
    // scheduleTask's own destination validation (resolveAndValidateDestination —
    // the credential-boundary gate) THROWS during step 4, after the intent +
    // cancel have committed. This exercises the genuine compensation path
    // (restoreTaskRow) rather than mocking — ESM namespace bindings are frozen,
    // so vi.spyOn can't replace scheduleTask anyway.
    getDb().prepare("DELETE FROM messaging_group_agents WHERE agent_group_id = 'tgt-ag'").run();

    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;

    // Move failed; source restored live (compensation via restoreTaskRow).
    expect(res.status).toBeGreaterThanOrEqual(500);
    const srcLive = liveRowsForSeries('src-ag', 'src-sess', 'ser-1');
    expect(srcLive).toHaveLength(1); // source is live again
    // No orphaned target row.
    const tgtSess = targetSessionId();
    if (tgtSess) expect(liveRowsForSeries('tgt-ag', tgtSess, 'ser-1')).toHaveLength(0);
  });

  it('stale :key (no live source row) → 409 stale_key', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    // Mark the source row terminal so there's no live row to move.
    {
      const p = path.join(TEST_DIR, 'v2-sessions', 'src-ag', 'src-sess', 'inbound.db');
      const db = openInboundDb(p);
      db.prepare("UPDATE messages_in SET status = 'completed' WHERE series_id = 'ser-1'").run();
      db.close();
    }
    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('stale_key');
  });

  it('non-manage caller → 404 (gate)', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const scopes = { role: 'admin_of_group' as const, allowed_group_ids: ['src-ag'], no_filter: false };
    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('sadmin', scopes)))!;
    expect(res.status).toBe(404);
  });

  it('test_move_unreadable_source_503', async () => {
    // An in-scope, authorized move whose decoded source :key points at a session
    // whose inbound.db is unreadable → 503 session_unreadable, fail-closed
    // BEFORE any cancel/scheduleTask (the guard is pre-cancel, §3a).
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    // Make the source session's inbound.db unopenable by removing it (the
    // handler guards on fs.existsSync(sourceInbound)). Everything else — central
    // DB rows, target MG, wiring — stays valid so we hit the source-unreadable
    // branch specifically, not an earlier gate.
    fs.rmSync(path.join(TEST_DIR, 'v2-sessions', 'src-ag', 'src-sess', 'inbound.db'));

    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(503);
    expect((await readJson(res)).error).toBe('session_unreadable');

    // Pre-cancel guard: NO side effect occurred — no move_intent audit row was
    // written, and no target session/row was created.
    const auditRows = getDb().prepare("SELECT COUNT(*) AS c FROM scheduled_audit WHERE series_id = 'ser-1'").get() as {
      c: number;
    };
    expect(auditRows.c).toBe(0);
    expect(targetSessionId()).toBeNull();
  });

  // ── M1: move_intent persists the full target locator ──────────────────────────
  it('test_move_intent_stores_target_locator', async () => {
    // Force a path where the intent is written then left unresolved so its body
    // survives: a post-move invariant violation (E-2) leaves the intent. We get
    // there by pre-seeding TWO live ser-1 rows in the target channel-root session
    // — scheduleTask's idempotent UPDATE only touches one, so both stay live and
    // the post-move {source,target} count becomes 2 (invariant violated).
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    addSession('tgt-sess', 'tgt-ag', 'tgt-mg');
    const tgtInbound = seedSession('tgt-ag', 'tgt-sess').inbound;
    insertRow(tgtInbound, { id: 'stray-a', series_id: 'ser-1', status: 'pending' });
    insertRow(tgtInbound, { id: 'stray-b', series_id: 'ser-1', status: 'pending' });

    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    // Invariant violated (2 live rows post-move) → 500, intent left unresolved.
    expect(res.status).toBe(500);
    const intent = getDb()
      .prepare("SELECT detail_json, resolved_at FROM scheduled_audit WHERE action = 'move_intent'")
      .get() as { detail_json: string | null; resolved_at: string | null };
    expect(intent.resolved_at).toBeNull(); // E-2: NOT purged → recoverable
    const detail = JSON.parse(intent.detail_json!) as Record<string, unknown>;
    expect(detail.targetAgentGroupId).toBe('tgt-ag');
    expect(detail.targetMessagingGroupId).toBe('tgt-mg');
  });

  // ── E-2: post-move invariant violation → 500 + intent unresolved ───────────────
  it('test_move_invariant_violation_leaves_intent_unresolved', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    // Two pre-existing live ser-1 rows in the target session → after the move's
    // idempotent UPDATE, both remain → post-move count == 2.
    addSession('tgt-sess', 'tgt-ag', 'tgt-mg');
    const tgtInbound = seedSession('tgt-ag', 'tgt-sess').inbound;
    insertRow(tgtInbound, { id: 'stray-a', series_id: 'ser-1', status: 'pending' });
    insertRow(tgtInbound, { id: 'stray-b', series_id: 'ser-1', status: 'pending' });

    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(500);
    expect((await readJson(res)).error).toBe('move_failed');
    // Intent left unresolved so the recovery sweep can repair it.
    const intent = getDb().prepare("SELECT resolved_at FROM scheduled_audit WHERE action = 'move_intent'").get() as {
      resolved_at: string | null;
    };
    expect(intent.resolved_at).toBeNull();
    // No two-sided 'move' success audit was written.
    const moveRows = getDb().prepare("SELECT COUNT(*) AS c FROM scheduled_audit WHERE action = 'move'").get() as {
      c: number;
    };
    expect(moveRows.c).toBe(0);
  });

  // ── M2: compensation must NOT restore when the count is UNREADABLE ─────────────
  it('test_move_compensation_unreadable_no_spurious_restore', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    // Unwire the target so scheduleTask throws AFTER cancel (the compensation
    // path). The target session never gets created — but corrupt the SOURCE
    // inbound.db AFTER the cancel so the live-count read throws → unreadable →
    // the handler must NOT restore (fail-safe). We can't time the corruption
    // mid-handler, so instead: pre-seed a corrupt SECOND target session row that
    // the {source,target} count would read. Simpler + deterministic: unwire +
    // corrupt the target's would-be session dir so the count read throws.
    getDb().prepare("DELETE FROM messaging_group_agents WHERE agent_group_id = 'tgt-ag'").run();
    // Pre-create the target channel-root session pointer + a CORRUPT inbound.db so
    // the post-cancel compensation count read throws → unreadable.
    addSession('tgt-sess', 'tgt-ag', 'tgt-mg');
    const tgtDir = path.join(TEST_DIR, 'v2-sessions', 'tgt-ag', 'tgt-sess');
    fs.mkdirSync(tgtDir, { recursive: true });
    fs.writeFileSync(path.join(tgtDir, 'inbound.db'), 'this is not sqlite');

    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(500);
    // Unreadable count → NO restore → source stays terminal (cancelled), and the
    // move_restore_failed audit is written (recoverable, not silently healed).
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(0);
    const failRow = getDb()
      .prepare("SELECT COUNT(*) AS c FROM scheduled_audit WHERE action = 'move_restore_failed'")
      .get() as { c: number };
    expect(failRow.c).toBe(1);
  });

  // ── E-4: delta hash binds the move target ──────────────────────────────────────
  it('test_delta_hash_binds_target', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    // A second target MG wired to the SAME target group → identical secret
    // gains/losses, but a different target identity.
    addMg('tgt-mg2', 'discord', 'tgt:2', 'tgt-chan-2');
    wire('tgt-mg2', 'tgt-ag');
    // Hash computed for tgt-mg, replayed on an execute targeting tgt-mg2.
    const hashForMg1 = deltaHashFor('tgt-mg');
    const res = (await moveExecuteHandler(
      req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg2', confirmedDeltaHash: hashForMg1 }),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('delta_changed');
    // No cancel performed.
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(1);
  });

  // ── ADV-S1: corrupt source distinguishes 503 (read-throw) from 409 (empty) ─────
  it('test_move_corrupt_source_503_not_409', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    // Corrupt the source inbound.db so readSourceLiveRow THROWS (file exists but
    // isn't valid sqlite). Distinguished from an empty result (→ 409 stale_key).
    const srcPath = path.join(TEST_DIR, 'v2-sessions', 'src-ag', 'src-sess', 'inbound.db');
    fs.writeFileSync(srcPath, 'this is not sqlite');
    const res = (await moveExecuteHandler(req(moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(503);
    expect((await readJson(res)).reason).toBe('session_unreadable');
  });
});
