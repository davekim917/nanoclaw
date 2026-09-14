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

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('scheduled-move-test') }));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_DIR,
  GROUPS_DIR: `${TEST_DIR}/groups`,
}));

// A hook that fires INSIDE the move's mailbox acquisition, i.e. in the window
// the async funnel opened between the snapshot/verdict and the cancel. Real
// implementation otherwise, so every other case in this file is unaffected.
const duringMailboxAcquire = vi.hoisted(() => ({ run: null as (() => void) | null }));
// This hook fires exactly before execute's post-insert target-ownership proof
// reads the target row. It lets the test model a row disappearing after
// scheduleTask returns but before the move is allowed to claim success.
const beforeTargetOwnershipRead = vi.hoisted(() => ({
  run: null as ((sessionId: string, rowId: string) => void) | null,
}));
vi.mock('../../session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...actual,
    withExistingMailboxSession: async (agentGroupId: string, sessionId: string, action: never) => {
      const hook = duringMailboxAcquire.run;
      duringMailboxAcquire.run = null;
      hook?.();
      if (agentGroupId === 'tgt-ag' && beforeTargetOwnershipRead.run) {
        return actual.withExistingMailboxSession(
          agentGroupId,
          sessionId,
          (mailbox) =>
            (action as (target: unknown) => unknown)(
              new Proxy(mailbox as object, {
                get(target, property, receiver) {
                  const value = Reflect.get(target, property, receiver);
                  if (property !== 'getLiveTaskRowById' || typeof value !== 'function') return value;
                  return (...args: unknown[]) => {
                    const targetHook = beforeTargetOwnershipRead.run;
                    beforeTargetOwnershipRead.run = null;
                    targetHook?.(sessionId, String(args[0] ?? ''));
                    return value.apply(target, args);
                  };
                },
              }),
            ) as never,
        );
      }
      return actual.withExistingMailboxSession(agentGroupId, sessionId, action);
    },
  };
});

import { initTestDb, closeDb, getRawDb } from '../../db/connection.js';
import { openInboundDb, openOutboundDbWritable } from '../../modules/mailbox/openers.js';
import { ensureSchema } from '../../modules/mailbox/schema.js';
import { taskThreadId } from '../../db/sessions.js';
import { migration043 } from '../../db/migrations/043-scheduled-audit.js';
import { encodeKey, invalidateScheduledCache, _resetScheduledRateLimitForTesting } from './scheduled-shared.js';
import { movePreviewHandler, moveExecuteHandler, moveTaskAsHost, _setMoveTestOptions } from './scheduled-move.js';
import { computeSecretDelta, isCrossWorkgroup } from './scheduled-move.js';
import type { AuthedRequestContext } from '../router.js';

// Config is mocked to this test-only root because resolveTaskSession owns task
// session folder creation and uses DATA_DIR directly.
const NOW = Date.parse('2026-06-13T12:00:00Z');

function isoIn(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

async function setupCentralDb(): Promise<void> {
  await initTestDb();
  const db = getRawDb();
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
      container_status TEXT DEFAULT 'stopped', last_active TEXT, created_at TEXT NOT NULL,
      -- Migration 056: a move re-schedules into the target, which re-stamps
      -- the series' routing through resolveTaskSession.
      task_routing_platform_id TEXT,
      -- Migration 068: the host sweep's persisted quiet mark. Load-bearing —
      -- both the compensation restore and scheduleTask wrap their write in
      -- withQuietInvalidationSync, which nulls this column in the same
      -- statement that moves last_active. Without the column that UPDATE
      -- throws, and the helper is fail-closed, so the write it guards does not
      -- happen at all.
      sweep_quiet_until TEXT
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
  getRawDb()
    .prepare(
      "INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, workgroup_id) VALUES (?, ?, ?, 'claude', datetime('now'), ?)",
    )
    .run(id, id, folder, workgroupId);
}
function addWorkgroup(id: string, secrets: string[]): void {
  getRawDb()
    .prepare('INSERT INTO workgroups (id, display_name, onecli_secrets) VALUES (?, ?, ?)')
    .run(id, id, JSON.stringify(secrets));
}
function addMg(id: string, channelType: string, platformId: string, name: string): void {
  getRawDb()
    .prepare(
      "INSERT INTO messaging_groups (id, channel_type, platform_id, name, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run(id, channelType, platformId, name);
}
function wire(mgId: string, agId: string): void {
  getRawDb()
    .prepare(
      "INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at) VALUES (?, ?, ?, datetime('now'))",
    )
    .run(`mga-${mgId}-${agId}`, mgId, agId);
}
function addTaskSession(id: string, agentGroupId: string, seriesId = 'ser-1'): void {
  getRawDb()
    .prepare(
      "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at) VALUES (?, ?, NULL, ?, 'active', 'stopped', datetime('now'))",
    )
    .run(id, agentGroupId, taskThreadId(seriesId));
}
function addUser(id: string): void {
  getRawDb().prepare("INSERT INTO users (id, kind, created_at) VALUES (?, 'phone', datetime('now'))").run(id);
}
function grant(uid: string, role: string, ag: string | null): void {
  getRawDb()
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
    scheduled_for?: string | null;
    content?: string;
    platform_id?: string;
    channel_type?: string;
    /**
     * 0 = inert, 1 = admitted. Defaults to 0 because that is what
     * `insertTaskRow` writes: a scheduled occurrence is inert until the sweep
     * admits it. Omitting the column let SQLite apply its DEFAULT 1, so every
     * fixture row here looked ALREADY ADMITTED — invisible while nothing read
     * the column, and wrong the moment the move started requiring an inert row.
     */
    trigger?: 0 | 1;
  },
): void {
  const db = openInboundDb(inboundPath);
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages_in').get() as { m: number }).m + 2;
  const processAfter = row.process_after ?? isoIn(3600_000);
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, scheduled_for, recurrence, series_id, content, platform_id, channel_type, "trigger")
     VALUES (@id, @seq, 'task', @ts, @status, @processAfter, @scheduledFor, @recurrence, @seriesId, @content, @platformId, @channelType, @trigger)`,
  ).run({
    trigger: row.trigger ?? 0,
    id: row.id,
    seq,
    ts: isoIn(-3600_000),
    status: row.status ?? 'pending',
    processAfter,
    // Mirrors what every real insert path stamps unless a test arms them apart.
    scheduledFor: row.scheduled_for === undefined ? processAfter : row.scheduled_for,
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
function malformedReq(): Request {
  return new Request('http://x/m', {
    method: 'POST',
    body: '{',
    headers: { 'Content-Type': 'application/json' },
  });
}
async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await setupCentralDb();
  invalidateScheduledCache();
  _resetScheduledRateLimitForTesting();
  duringMailboxAcquire.run = null;
  beforeTargetOwnershipRead.run = null;
  _setMoveTestOptions({ dataDir: TEST_DIR, nowMs: NOW });
});

afterEach(async () => {
  _setMoveTestOptions(null);
  await closeDb();
  vi.restoreAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ── Common fixture: source group/session/series + a target group/channel ──────
function seedMoveFixture(opts?: {
  sourceStatus?: string;
  sourceProcessAfter?: string | null;
  sourceScheduledFor?: string | null;
  sourceContent?: string;
}): { key: string } {
  addWorkgroup('wg-1', ['Anthropic', 'Linear']);
  addGroup('src-ag', 'src-folder', 'wg-1');
  addGroup('tgt-ag', 'tgt-folder', 'wg-1');
  addMg('src-mg', 'discord', 'src:1', 'src-chan');
  addMg('tgt-mg', 'discord', 'tgt:1', 'tgt-chan');
  wire('src-mg', 'src-ag');
  wire('tgt-mg', 'tgt-ag'); // target wired by default
  addTaskSession('src-sess', 'src-ag');
  setGroupSecrets('src-folder', ['Anthropic']); // effective source = wg ∪ group = {Anthropic, Linear}
  setGroupSecrets('tgt-folder', ['Datafold-Prod']); // effective target = {Anthropic, Linear, Datafold-Prod}
  const { inbound } = seedSession('src-ag', 'src-sess');
  insertRow(inbound, {
    id: 'r1',
    series_id: 'ser-1',
    status: opts?.sourceStatus ?? 'pending',
    process_after: opts?.sourceProcessAfter ?? isoIn(3600_000),
    ...(opts?.sourceContent === undefined ? {} : { content: opts.sourceContent }),
    ...(opts?.sourceScheduledFor === undefined ? {} : { scheduled_for: opts.sourceScheduledFor }),
  });
  addUser('owner');
  grant('owner', 'owner', null);
  addUser('sadmin');
  grant('sadmin', 'admin', 'src-ag');
  return { key: encodeKey('src-ag', 'src-sess', 'ser-1') };
}

// ── D1: preview ────────────────────────────────────────────────────────────────
describe('movePreviewHandler', () => {
  it('uses the production data-root defaults when no test seam is configured', async () => {
    const { key } = seedMoveFixture();
    _setMoveTestOptions(null);
    const res = (await movePreviewHandler(
      req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(200);
  });

  it('rejects malformed JSON before resolving a move key', async () => {
    const { key } = seedMoveFixture();
    const res = (await movePreviewHandler(malformedReq(), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('invalid_request');
  });

  it('does not disclose an invalid move locator', async () => {
    seedMoveFixture();
    const res = (await movePreviewHandler(
      req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
      { key: 'not-a-move-key' },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(404);
  });

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

  // Codex round: `scheduled_for` is added lazily by the first WRITABLE open of
  // a session, and the preview read opens read-only. On an upgraded install it
  // therefore meets sessions that still lack the column, and naming it threw —
  // reported as `unreadable`, so preview claimed the series had no script and
  // execute answered 503. The dashboard serves from host start, long before the
  // sweep migrates any given session, so this was every move on a fresh deploy.
  it('previews a session whose inbound.db predates the scheduled_for column', async () => {
    const { key } = seedMoveFixture();
    // The pre-migration on-disk shape, produced from the migrated one.
    const inbound = path.join(TEST_DIR, 'v2-sessions', 'src-ag', 'src-sess', 'inbound.db');
    const db = openInboundDb(inbound);
    try {
      db.exec('ALTER TABLE messages_in DROP COLUMN scheduled_for');
    } finally {
      db.close();
    }

    const res = (await movePreviewHandler(
      req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;

    expect(res.status).toBe(200);
    const body = await readJson(res);
    // The row was read, not swallowed as unreadable.
    expect(body.scriptPresent).toBe(true);
    expect(body.wiringOk).toBe(true);
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

  it('treats a missing group container file as an empty per-group secret scope', async () => {
    const { key } = seedMoveFixture();
    fs.rmSync(path.join(TEST_DIR, 'groups', 'tgt-folder', 'container.json'));
    const res = (await movePreviewHandler(
      req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(200);
    expect((await readJson(res)).gains).toEqual([]);
  });

  it('treats malformed group configuration as an empty per-group secret scope', async () => {
    const { key } = seedMoveFixture();
    fs.writeFileSync(path.join(TEST_DIR, 'groups', 'tgt-folder', 'container.json'), '{');
    const res = (await movePreviewHandler(
      req({ targetAgentGroupId: 'tgt-ag', targetMessagingGroupId: 'tgt-mg' }),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(res.status).toBe(200);
    expect((await readJson(res)).gains).toEqual([]);
  });

  it('test_preview_unwired_target', async () => {
    const { key } = seedMoveFixture();
    // Remove the target wiring.
    getRawDb().prepare("DELETE FROM messaging_group_agents WHERE agent_group_id = 'tgt-ag'").run();
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
    seedMoveFixture();
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
async function deltaHashFor(targetMessagingGroupId = 'tgt-mg'): Promise<string> {
  // effective(src) = {Anthropic, Linear}; effective(tgt) = {Anthropic, Linear, Datafold-Prod}.
  // The hash now binds the move target identity (E-4) — pass the MG id used at execute.
  return (
    await computeSecretDelta(
      'src-ag',
      'src-folder',
      'tgt-ag',
      'tgt-folder',
      targetMessagingGroupId,
      path.join(TEST_DIR, 'groups'),
    )
  ).deltaHash;
}

function liveRowsForSeries(
  agentGroupId: string,
  sessionId: string,
  seriesId: string,
): Array<{
  id: string;
  status: string;
  process_after: string | null;
  scheduled_for: string | null;
  recurrence: string | null;
  content: string;
}> {
  const p = path.join(TEST_DIR, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
  if (!fs.existsSync(p)) return [];
  const db = openInboundDb(p);
  const rows = db
    .prepare(
      "SELECT id, status, process_after, scheduled_for, recurrence, content FROM messages_in WHERE series_id = ? AND kind = 'task' AND status IN ('pending','paused')",
    )
    .all(seriesId) as Array<{
    id: string;
    status: string;
    process_after: string | null;
    scheduled_for: string | null;
    recurrence: string | null;
    content: string;
  }>;
  db.close();
  return rows;
}

/** Target session id for (tgt-ag, ser-1) — scheduleTask creates a per-series system session. */
function targetSessionId(): string | null {
  const row = getRawDb()
    .prepare(
      "SELECT id FROM sessions WHERE agent_group_id = 'tgt-ag' AND messaging_group_id IS NULL AND thread_id = ? AND status='active' LIMIT 1",
    )
    .get(taskThreadId('ser-1')) as { id: string } | undefined;
  return row?.id ?? null;
}

async function moveBody(over?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return {
    targetAgentGroupId: 'tgt-ag',
    targetMessagingGroupId: 'tgt-mg',
    confirmedDeltaHash: await deltaHashFor(),
    ...over,
  };
}

describe('moveExecuteHandler', () => {
  it('test_move_one_live_row_invariant', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) }); // far future, unclaimed → move allowed
    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);
    expect((await readJson(res)).moved).toBe(true);

    // Source row terminal (no live row); exactly one live recurrence-set row in target.
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(0);
    const tgtSess = targetSessionId();
    expect(tgtSess).toBeTruthy();
    const tgtLive = liveRowsForSeries('tgt-ag', tgtSess!, 'ser-1');
    expect(tgtLive).toHaveLength(1);
    expect(tgtLive[0].recurrence).toBe('0 9 * * *');
    const source = openInboundDb(path.join(TEST_DIR, 'v2-sessions', 'src-ag', 'src-sess', 'inbound.db'));
    const receipts = source
      .prepare(
        "SELECT COUNT(*) AS c FROM messages_in WHERE id LIKE 'scheduled-move-cancel:%' AND kind = 'system' AND status = 'completed'",
      )
      .get() as { c: number };
    source.close();
    expect(receipts.c).toBe(1);
  });

  it('host task move uses the same transaction without creating a dashboard identity', async () => {
    seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const moved = await moveTaskAsHost({
      sourceAgentGroupId: 'src-ag',
      sourceSessionId: 'src-sess',
      seriesId: 'ser-1',
      targetAgentGroupId: 'tgt-ag',
      targetMessagingGroupId: 'tgt-mg',
    });

    expect(moved).toMatchObject({ moved: true, secretGainsCount: 1, secretLossesCount: 0 });
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(0);
    expect(liveRowsForSeries('tgt-ag', targetSessionId()!, 'ser-1')).toHaveLength(1);
    const audit = getRawDb()
      .prepare("SELECT actor FROM scheduled_audit WHERE action = 'move' ORDER BY ts LIMIT 1")
      .get() as { actor: string };
    expect(audit.actor).toBe('host');
  });

  it('host task move refuses an unknown source without fabricating a dashboard error', async () => {
    seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    await expect(
      moveTaskAsHost({
        sourceAgentGroupId: 'missing-source',
        sourceSessionId: 'missing-session',
        seriesId: 'missing-series',
        targetAgentGroupId: 'tgt-ag',
        targetMessagingGroupId: 'tgt-mg',
      }),
    ).rejects.toThrow('task move source or target was not found');
  });

  it('host task move reports target conflicts with its stable operator reason', async () => {
    seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    addTaskSession('tgt-sess', 'tgt-ag');
    insertRow(seedSession('tgt-ag', 'tgt-sess').inbound, { id: 'existing-target', series_id: 'ser-1' });

    await expect(
      moveTaskAsHost({
        sourceAgentGroupId: 'src-ag',
        sourceSessionId: 'src-sess',
        seriesId: 'ser-1',
        targetAgentGroupId: 'tgt-ag',
        targetMessagingGroupId: 'tgt-mg',
      }),
    ).rejects.toThrow('task move failed: target_conflict');
  });

  it('leaves the move intent unresolved when the post-insert target ownership proof loses its row', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    beforeTargetOwnershipRead.run = (sessionId, targetRowId) => {
      const target = openInboundDb(path.join(TEST_DIR, 'v2-sessions', 'tgt-ag', sessionId, 'inbound.db'));
      try {
        // Keep a live same-series row so the later count-only invariant stays
        // satisfied. This must fail on exact ownership, not merely count zero.
        target.prepare("UPDATE messages_in SET id = 'unowned-target-row' WHERE id = ?").run(targetRowId);
      } finally {
        target.close();
      }
    };

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;

    expect(res.status).toBe(500);
    expect((await readJson(res)).reason).toBe('invariant_violated');
    expect(liveRowsForSeries('tgt-ag', targetSessionId()!, 'ser-1')).toMatchObject([{ id: 'unowned-target-row' }]);
    const intent = getRawDb().prepare("SELECT resolved_at FROM scheduled_audit WHERE action = 'move_intent'").get() as {
      resolved_at: string | null;
    };
    expect(intent.resolved_at).toBeNull();
  });

  it('preserves the complete source task envelope across a move', async () => {
    const content = JSON.stringify({
      prompt: 'do thing',
      script: 'echo hi',
      scriptHost: true,
      threadAnchor: false,
      originSessionId: 'origin-session',
      muteChat: true,
      chatLimit: 1,
      quietStatus: true,
      flagIntent: { turnModel: 'opus', turnEffort: 'high' },
    });
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000), sourceContent: content });

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);
    const target = liveRowsForSeries('tgt-ag', targetSessionId()!, 'ser-1');
    expect(target).toHaveLength(1);
    expect(target[0]!.content).toBe(content);
  });

  it('rejects malformed JSON before applying the interactive rate limit', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const res = (await moveExecuteHandler(malformedReq(), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('invalid_request');
  });

  it('requires both target identifiers and never treats a missing target as a stale delta', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const res = (await moveExecuteHandler(req({}), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('invalid_request');
  });

  it('refuses an invalid stored task pin before cancelling the source occurrence', async () => {
    const { key } = seedMoveFixture({
      sourceProcessAfter: isoIn(10 * 3600_000),
      sourceContent: JSON.stringify({ prompt: 'do thing', flagIntent: { turnModel: 'not-a-real-model' } }),
    });
    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('target_pin_invalid');
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(1);
  });

  it('does not disclose a missing target agent or messaging group', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const missingAgent = (await moveExecuteHandler(
      req(await moveBody({ targetAgentGroupId: 'missing-agent' })),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(missingAgent.status).toBe(404);

    const missingMessagingGroup = (await moveExecuteHandler(
      req(await moveBody({ targetMessagingGroupId: 'missing-messaging-group' })),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;
    expect(missingMessagingGroup.status).toBe(404);
  });

  // The move approves ONE occurrence and writes a move_intent naming that row
  // id. Acquiring the mailbox is now async, so between the verdict and the
  // cancel the approved occurrence can complete and recurrence can arm a
  // successor. A series-wide cancel would consume the successor, report a
  // nonzero touch and move the stale snapshot on top of it. This drives that
  // exact interleave through the acquisition hook above.
  it('a successor armed during mailbox acquisition is left alone, and the move reports stale_key', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const srcInbound = path.join(TEST_DIR, 'v2-sessions', 'src-ag', 'src-sess', 'inbound.db');

    duringMailboxAcquire.run = () => {
      // The approved occurrence finishes...
      const db = openInboundDb(srcInbound);
      db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'r1'").run();
      db.close();
      // ...and recurrence arms the next one.
      insertRow(srcInbound, {
        id: 'r2',
        series_id: 'ser-1',
        status: 'pending',
        process_after: isoIn(24 * 3600_000),
      });
    };

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('stale_key');

    // The successor is untouched and still live...
    const srcLive = liveRowsForSeries('src-ag', 'src-sess', 'ser-1');
    expect(srcLive).toHaveLength(1);
    expect(srcLive[0]!.id).toBe('r2');
    expect(srcLive[0]!.recurrence).toBe('0 9 * * *');
    // ...and nothing was inserted into the target from the stale snapshot.
    const tgtSess = targetSessionId();
    expect(tgtSess === null || liveRowsForSeries('tgt-ag', tgtSess, 'ser-1')).toBeTruthy();
    if (tgtSess) expect(liveRowsForSeries('tgt-ag', tgtSess, 'ser-1')).toHaveLength(0);
    const intent = getRawDb().prepare("SELECT resolved_at FROM scheduled_audit WHERE action = 'move_intent'").get() as {
      resolved_at: string | null;
    };
    expect(intent.resolved_at).toBeTruthy();
  });

  // The sibling of the successor case, and the one an id-scoped cancel alone
  // does NOT catch: a concurrent dashboard run-now admits the SAME occurrence
  // during the acquisition window. The row keeps its id and its `pending`
  // status — admission mutates in place — so only the fields the verdict reads
  // reveal it. Cancelling here would consume an occurrence that is armed to
  // fire, and the move would recreate the stale snapshot in the target.
  it('an occurrence admitted during mailbox acquisition is left alone, and the move reports stale_key', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const srcInbound = path.join(TEST_DIR, 'v2-sessions', 'src-ag', 'src-sess', 'inbound.db');

    duringMailboxAcquire.run = () => {
      // Exactly what run-now's admission does: arm the row where it stands.
      const db = openInboundDb(srcInbound);
      db.prepare('UPDATE messages_in SET "trigger" = 1, process_after = ? WHERE id = \'r1\'').run(isoIn(0));
      db.close();
    };

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('stale_key');

    // The occurrence is untouched: still live, still armed, not cancelled.
    const srcLive = liveRowsForSeries('src-ag', 'src-sess', 'ser-1');
    expect(srcLive).toHaveLength(1);
    expect(srcLive[0]!.id).toBe('r1');
    expect(srcLive[0]!.status).toBe('pending');
    // ...and nothing was written into the target from the stale snapshot.
    const tgtSess = targetSessionId();
    if (tgtSess) expect(liveRowsForSeries('tgt-ag', tgtSess, 'ser-1')).toHaveLength(0);
  });

  it('resolves a losing overlapping move intent rather than letting recovery resurrect the winner source', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const srcInbound = path.join(TEST_DIR, 'v2-sessions', 'src-ag', 'src-sess', 'inbound.db');

    duringMailboxAcquire.run = () => {
      // The competing move has already won the exact source occurrence and
      // installed its own target row before this request reaches its cancel.
      const source = openInboundDb(srcInbound);
      source.prepare("UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE id = 'r1'").run();
      source.close();
      addTaskSession('winner-tgt-sess', 'tgt-ag');
      const target = seedSession('tgt-ag', 'winner-tgt-sess').inbound;
      insertRow(target, { id: 'winner-target-row', series_id: 'ser-1', content: JSON.stringify({ prompt: 'winner' }) });
    };

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('stale_key');
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(0);
    expect(liveRowsForSeries('tgt-ag', 'winner-tgt-sess', 'ser-1')).toMatchObject([{ id: 'winner-target-row' }]);
    const intent = getRawDb().prepare("SELECT resolved_at FROM scheduled_audit WHERE action = 'move_intent'").get() as {
      resolved_at: string | null;
    };
    expect(intent.resolved_at).toBeTruthy();
  });

  // The claim half of the same guard: a container holding a processing claim
  // on the approved occurrence means it is mid-fire, whatever the row says.
  it('an occurrence claimed during mailbox acquisition is left alone', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const outbound = path.join(TEST_DIR, 'v2-sessions', 'src-ag', 'src-sess', 'outbound.db');

    duringMailboxAcquire.run = () => {
      const db = openOutboundDbWritable(outbound);
      db.prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('r1', 'processing', ?)").run(
        new Date().toISOString(),
      );
      db.close();
    };

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(1);
  });

  it("a successful move carries the occurrence's slot, not its retry deadline", async () => {
    // The source row crashed and was deferred: process_after is a backoff
    // deadline ten hours out, scheduled_for is still the 9:00 slot. Stamping
    // the destination from process_after would change the occurrence's identity
    // as a side effect of moving it.
    const slot = isoIn(-30 * 60_000);
    const { key } = seedMoveFixture({
      sourceProcessAfter: isoIn(10 * 3600_000),
      sourceScheduledFor: slot,
    });

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);

    const tgtLive = liveRowsForSeries('tgt-ag', targetSessionId()!, 'ser-1');
    expect(tgtLive).toHaveLength(1);
    expect(tgtLive[0]!.process_after).toBe(isoIn(10 * 3600_000));
    expect(tgtLive[0]!.scheduled_for).toBe(slot);
  });

  // Codex round: a move PERSISTS the source slot into another session DB, so a
  // naive `YYYY-MM-DD HH:MM:SS` left by a pre-upgrade writer would be copied
  // in as-is — a value `new Date()` reads as LOCAL time and string comparisons
  // rank against ISO ones. Displaying it wrong was the earlier finding; storing
  // it wrong is this one.
  it('normalizes a naive legacy slot to ISO UTC when it carries it into the target', async () => {
    const { key } = seedMoveFixture({
      sourceProcessAfter: isoIn(10 * 3600_000),
      sourceScheduledFor: '2026-01-05 09:00:00',
    });

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);

    const tgtLive = liveRowsForSeries('tgt-ag', targetSessionId()!, 'ser-1');
    expect(tgtLive).toHaveLength(1);
    // Same instant, canonical shape — not the raw string it was read as.
    expect(tgtLive[0]!.scheduled_for).toBe('2026-01-05T09:00:00.000Z');
  });

  it('the paused staged path restores the run time without clobbering the slot', async () => {
    // The staged insert arms a grace process_after, then restores the real one.
    // That second write must not drag scheduled_for along with it.
    const slot = isoIn(-72 * 3600_000);
    const { key } = seedMoveFixture({
      sourceStatus: 'paused',
      sourceProcessAfter: isoIn(-48 * 3600_000),
      sourceScheduledFor: slot,
    });

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(200);

    const tgtLive = liveRowsForSeries('tgt-ag', targetSessionId()!, 'ser-1');
    expect(tgtLive).toHaveLength(1);
    expect(tgtLive[0]!.status).toBe('paused');
    expect(tgtLive[0]!.process_after).toBe(isoIn(-48 * 3600_000));
    expect(tgtLive[0]!.scheduled_for).toBe(slot);
  });

  it('same-agent paused move reuses one system session without double-counting or breaking staged restore', async () => {
    const { key } = seedMoveFixture({ sourceStatus: 'paused', sourceProcessAfter: isoIn(-48 * 3600_000) });
    wire('tgt-mg', 'src-ag');
    const confirmedDeltaHash = (
      await computeSecretDelta('src-ag', 'src-folder', 'src-ag', 'src-folder', 'tgt-mg', path.join(TEST_DIR, 'groups'))
    ).deltaHash;

    const res = (await moveExecuteHandler(
      req({ targetAgentGroupId: 'src-ag', targetMessagingGroupId: 'tgt-mg', confirmedDeltaHash }),
      { key },
      ctxFor('owner', OWNER_SCOPES),
    ))!;

    expect(res.status).toBe(200);
    expect((await readJson(res)).moved).toBe(true);
    const live = liveRowsForSeries('src-ag', 'src-sess', 'ser-1');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: 'paused', process_after: isoIn(-48 * 3600_000) });
    const db = openInboundDb(path.join(TEST_DIR, 'v2-sessions', 'src-ag', 'src-sess', 'inbound.db'));
    const routing = db
      .prepare("SELECT platform_id, channel_type FROM messages_in WHERE series_id = 'ser-1' AND status = 'paused'")
      .get() as { platform_id: string; channel_type: string };
    db.close();
    expect(routing).toEqual({ platform_id: 'tgt:1', channel_type: 'discord' });
  });

  it('test_move_paused_stages_insert_never_due_pending', async () => {
    // Paused source with a PAST-due process_after (paused >1 cycle).
    const { key } = seedMoveFixture({ sourceStatus: 'paused', sourceProcessAfter: isoIn(-48 * 3600_000) });
    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
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
    await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES));
    // A move_intent audit row was written, then resolved (resolved_at set, body purged).
    const intent = getRawDb()
      .prepare("SELECT detail_json, resolved_at FROM scheduled_audit WHERE action = 'move_intent'")
      .get() as { detail_json: string | null; resolved_at: string | null } | undefined;
    expect(intent).toBeDefined();
    expect(intent!.resolved_at).toBeTruthy(); // resolved on success
    expect(intent!.detail_json).toBeNull(); // body purged (F5)
  });

  it('writes TWO-sided move audit sharing a correlation_id', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES));
    const moveRows = getRawDb()
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
      req(await moveBody({ confirmedDeltaHash: 'stale-hash' })),
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
    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
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
    getRawDb().prepare("DELETE FROM messaging_group_agents WHERE agent_group_id = 'tgt-ag'").run();

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;

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
    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('stale_key');
  });

  it('non-manage caller → 404 (gate)', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    const scopes = { role: 'admin_of_group' as const, allowed_group_ids: ['src-ag'], no_filter: false };
    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('sadmin', scopes)))!;
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

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(503);
    expect((await readJson(res)).error).toBe('session_unreadable');

    // Pre-cancel guard: NO side effect occurred — no move_intent audit row was
    // written, and no target session/row was created.
    const auditRows = getRawDb()
      .prepare("SELECT COUNT(*) AS c FROM scheduled_audit WHERE series_id = 'ser-1'")
      .get() as {
      c: number;
    };
    expect(auditRows.c).toBe(0);
    expect(targetSessionId()).toBeNull();
  });

  it('refuses a pre-existing target series before it can overwrite target work', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    addTaskSession('tgt-sess', 'tgt-ag');
    const tgtInbound = seedSession('tgt-ag', 'tgt-sess').inbound;
    insertRow(tgtInbound, { id: 'stray-a', series_id: 'ser-1', status: 'pending' });

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('target_conflict');
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(1);
    const target = liveRowsForSeries('tgt-ag', 'tgt-sess', 'ser-1');
    expect(target).toHaveLength(1);
    expect(target[0]!.id).toBe('stray-a');
    expect(
      (
        getRawDb().prepare("SELECT COUNT(*) AS c FROM scheduled_audit WHERE action = 'move_intent'").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it('refuses a hidden pending manual run behind a terminal recurring target strand', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    addTaskSession('tgt-sess', 'tgt-ag');
    const tgtInbound = seedSession('tgt-ag', 'tgt-sess').inbound;
    insertRow(tgtInbound, { id: 'terminal-chain', series_id: 'ser-1', status: 'completed', recurrence: '0 9 * * *' });
    insertRow(tgtInbound, {
      id: 'manual-run',
      series_id: 'ser-1',
      recurrence: null,
      content: JSON.stringify({ prompt: 'preserve manual run' }),
    });

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('target_conflict');
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(1);
    const target = liveRowsForSeries('tgt-ag', 'tgt-sess', 'ser-1');
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({ id: 'manual-run', content: JSON.stringify({ prompt: 'preserve manual run' }) });
  });

  it('restores the source when a target collision materializes after preflight', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    duringMailboxAcquire.run = () => {
      addTaskSession('tgt-sess', 'tgt-ag');
      const target = seedSession('tgt-ag', 'tgt-sess').inbound;
      insertRow(target, { id: 'late-target', series_id: 'ser-1', content: JSON.stringify({ prompt: 'late work' }) });
    };

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(409);
    expect((await readJson(res)).reason).toBe('target_conflict');
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(1);
    const target = liveRowsForSeries('tgt-ag', 'tgt-sess', 'ser-1');
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({ id: 'late-target', content: JSON.stringify({ prompt: 'late work' }) });
    const intent = getRawDb().prepare("SELECT resolved_at FROM scheduled_audit WHERE action = 'move_intent'").get() as {
      resolved_at: string | null;
    };
    expect(intent.resolved_at).toBeTruthy();
  });

  // Codex round 2, H2. The move cancels the source, then AWAITS the target
  // insert. A sweep tick landing in that await sees a source with no live task
  // and can mark it quiet. The compensation puts the pending row back — due work
  // behind a mark taken during the await, which S2-PR15 would carry across a
  // restart. Asserted on the central sessions row, not the funnel.
  it('the compensation restore clears the source session quiet mark', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    getRawDb().prepare("DELETE FROM messaging_group_agents WHERE agent_group_id = 'tgt-ag'").run();

    // The mark a sweep took while the target insert was in flight.
    const stale = '2026-06-01T00:00:00.000Z';
    getRawDb()
      .prepare("UPDATE sessions SET last_active = ?, sweep_quiet_until = '2099-01-01T00:00:00.000Z' WHERE id = ?")
      .run(stale, 'src-sess');

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBeGreaterThanOrEqual(500);
    // The restore must actually have happened, or the assertion below is vacuous.
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(1);

    const row = getRawDb()
      .prepare('SELECT last_active, sweep_quiet_until FROM sessions WHERE id = ?')
      .get('src-sess') as {
      last_active: string | null;
      sweep_quiet_until: string | null;
    };
    expect(row.sweep_quiet_until, 'the restored task is hidden behind a live quiet mark').toBeNull();
    expect(row.last_active).not.toBe(stale);
  });

  it('refuses an unreadable existing target before cancelling the source', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    // A target system session is present, but its inbound database is corrupt.
    // It is not safe to treat that as an empty target and learn only after the
    // source was cancelled.
    addTaskSession('tgt-sess', 'tgt-ag');
    const tgtDir = path.join(TEST_DIR, 'v2-sessions', 'tgt-ag', 'tgt-sess');
    fs.mkdirSync(tgtDir, { recursive: true });
    fs.writeFileSync(path.join(tgtDir, 'inbound.db'), 'this is not sqlite');

    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(503);
    expect((await readJson(res)).reason).toBe('session_unreadable');
    expect(liveRowsForSeries('src-ag', 'src-sess', 'ser-1')).toHaveLength(1);
    expect(
      (
        getRawDb().prepare("SELECT COUNT(*) AS c FROM scheduled_audit WHERE action = 'move_intent'").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  // ── E-4: delta hash binds the move target ──────────────────────────────────────
  it('test_delta_hash_binds_target', async () => {
    const { key } = seedMoveFixture({ sourceProcessAfter: isoIn(10 * 3600_000) });
    // A second target MG wired to the SAME target group → identical secret
    // gains/losses, but a different target identity.
    addMg('tgt-mg2', 'discord', 'tgt:2', 'tgt-chan-2');
    wire('tgt-mg2', 'tgt-ag');
    // Hash computed for tgt-mg, replayed on an execute targeting tgt-mg2.
    const hashForMg1 = await deltaHashFor('tgt-mg');
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
    const res = (await moveExecuteHandler(req(await moveBody()), { key }, ctxFor('owner', OWNER_SCOPES)))!;
    expect(res.status).toBe(503);
    expect((await readJson(res)).reason).toBe('session_unreadable');
  });
});

// ── isCrossWorkgroup unit tests ───────────────────────────────────────────────
describe('isCrossWorkgroup', () => {
  beforeEach(async () => {
    await setupCentralDb();
    addWorkgroup('wg-alpha', []);
    addWorkgroup('wg-beta', []);
  });

  it('returns false for two agents sharing the same workgroup_id', async () => {
    addGroup('a1', 'folder-a1', 'wg-alpha');
    addGroup('a2', 'folder-a2', 'wg-alpha');
    expect(await isCrossWorkgroup('a1', 'a2')).toBe(false);
  });

  it('returns true for two agents in different workgroups', async () => {
    addGroup('a1', 'folder-a1', 'wg-alpha');
    addGroup('b1', 'folder-b1', 'wg-beta');
    expect(await isCrossWorkgroup('a1', 'b1')).toBe(true);
  });

  it('returns true when both agents are orphans (workgroup_id === null)', async () => {
    addGroup('orphan-1', 'folder-orphan-1', null);
    addGroup('orphan-2', 'folder-orphan-2', null);
    expect(await isCrossWorkgroup('orphan-1', 'orphan-2')).toBe(true);
  });

  it('returns true when only one side is orphaned', async () => {
    addGroup('orphan', 'folder-orphan', null);
    addGroup('paired', 'folder-paired', 'wg-alpha');
    expect(await isCrossWorkgroup('orphan', 'paired')).toBe(true);
    expect(await isCrossWorkgroup('paired', 'orphan')).toBe(true);
  });
});
