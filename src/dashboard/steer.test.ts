import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getDb } from '../db/index.js';
import { applySessionSteer, _resetRateLimitForTesting } from './steer.js';
import type { AuthedRequestContext } from './router.js';

// These imports resolve AFTER vi.mock hoisting — they are the vi.fn() instances.
import { writeSessionMessage as _wsmRaw } from '../session-manager.js';
import { readSessionInbound as _rsiRaw } from '../modules/mailbox/read-only.js';
import { wakeContainer as _wcRaw } from '../container-runner.js';
import { getChannelAdapter as _gcaRaw } from '../channels/channel-registry.js';
import { getMessagingGroup as _gmgRaw } from '../db/messaging-groups.js';
import { emitDashboardEvent as _edeRaw } from './api/events.js';

// Typed as mocks for use in test assertions / setup
const mockWriteSessionMessage = vi.mocked(_wsmRaw);
const mockReadSessionInbound = vi.mocked(_rsiRaw);
const mockWakeContainer = vi.mocked(_wcRaw);
const mockGetChannelAdapter = vi.mocked(_gcaRaw);
const mockGetMessagingGroup = vi.mocked(_gmgRaw);
const mockEmitDashboardEvent = vi.mocked(_edeRaw);

// ── Mocks ────────────────────────────────────────────────────────────────────
// Simple synchronous factories — vi.fn() created inside factory to avoid TDZ.

vi.mock('../session-manager.js', () => ({
  writeSessionMessage: vi.fn().mockResolvedValue(undefined),
  openInboundDb: vi.fn(),
  openOutboundDb: vi.fn(),
  inboundDbPath: vi.fn().mockReturnValue('/tmp/nonexistent.db'),
  heartbeatPath: vi.fn().mockReturnValue('/tmp/heartbeat'),
  resolveSession: vi.fn(),
  writeSessionRouting: vi.fn(),
}));

// The steer write path's partial-write probe reads through the mailbox
// module's read-only seam (PR 6); mocked at the seam, not at a raw opener.
vi.mock('../modules/mailbox/read-only.js', () => ({
  readSessionInbound: vi.fn().mockReturnValue(false),
  readSessionOutbound: vi.fn().mockReturnValue(undefined),
}));

// The sweep-family ops the steer path reaches transitively. Mocked at the op
// family rather than at the deleted `db/session-db.js` façade (mailbox seam
// PR 7) — same statements, one module further in.
vi.mock('../modules/mailbox/ops/sweep.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/mailbox/ops/sweep.js')>()),
  syncProcessingAcks: vi.fn(),
  countDueMessages: vi.fn().mockReturnValue(0),
  getProcessingClaims: vi.fn().mockReturnValue([]),
  deleteOrphanProcessingClaims: vi.fn().mockReturnValue(0),
  getContainerState: vi.fn().mockReturnValue(null),
  getMessageForRetry: vi.fn().mockReturnValue(null),
  markMessageFailed: vi.fn(),
  retryWithBackoff: vi.fn(),
}));

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getContainerSpawnedAt: vi.fn().mockReturnValue(0),
}));

vi.mock('../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn().mockReturnValue(undefined),
  registerChannelAdapter: vi.fn(),
  getActiveAdapters: vi.fn().mockReturnValue([]),
}));

vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn().mockReturnValue(undefined),
  createMessagingGroup: vi.fn(),
  getMessagingGroupByPlatform: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./api/events.js', () => ({
  emitDashboardEvent: vi.fn(),
  startSSEFeed: vi.fn(),
  stopSSEFeed: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function seedUser(id: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'dashboard', ?, ?)")
    .run(id, id, now());
}

function grantOwner(userId: string): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)",
    )
    .run(userId, now());
}

function grantAdmin(userId: string, agId: string): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)",
    )
    .run(userId, agId, now());
}

function grantMember(userId: string, agId: string): void {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)',
    )
    .run(userId, agId, now());
}

function seedSession(sessId: string, agId: string, threadId: string | null = null): void {
  // Use sessId as thread_id to avoid the UNIQUE(agent_group_id, messaging_group_id, thread_id) conflict
  // when multiple sessions share the same agent_group and no messaging_group
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at) VALUES (?, ?, NULL, ?, 'active', ?)",
    )
    .run(sessId, agId, threadId ?? sessId, now());
}

function makeCtx(
  userId: string,
  opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {},
): AuthedRequestContext {
  return {
    user: { id: userId, kind: 'dashboard', display_name: `user-${userId}`, created_at: now() },
    scopes: {
      role: opts.no_filter ? 'owner' : 'admin_of_group',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? false,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

const VALID_IKEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('applySessionSteer — C5', () => {
  beforeEach(() => {
    _resetRateLimitForTesting();
    mockWriteSessionMessage.mockReset();
    mockWriteSessionMessage.mockResolvedValue(undefined);
    mockReadSessionInbound.mockReset();
    mockReadSessionInbound.mockReturnValue(false);
    mockWakeContainer.mockReset();
    mockWakeContainer.mockResolvedValue(true);
    mockGetChannelAdapter.mockReset();
    mockGetChannelAdapter.mockReturnValue(undefined);
    mockGetMessagingGroup.mockReset();
    mockGetMessagingGroup.mockReturnValue(undefined);
    mockEmitDashboardEvent.mockReset();
    setupDb();
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    seedSession('sess-direct', 'ag-1'); // direct conversation session, no MG
    seedUser('owner-s');
    grantOwner('owner-s');
    seedUser('member-s');
    grantMember('member-s', 'ag-1');
    seedUser('admin-s');
    grantAdmin('admin-s', 'ag-1');
  });

  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  it('writes to the session inbound DB and returns 202 with session_id', async () => {
    const ctx = makeCtx('owner-s', { no_filter: true });
    const r = await applySessionSteer('sess-direct', { idempotency_key: VALID_IKEY, text: 'hi' }, ctx);
    expect(r.status).toBe(202);
    expect(r.body['target_type']).toBe('session');
    expect(r.body['target_id']).toBe('sess-direct');
    expect(r.body['session_id']).toBe('sess-direct');
    expect(r.body['task_id']).toBeUndefined();
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
    const writeCall = mockWriteSessionMessage.mock.calls[0]!;
    expect(writeCall[0]).toBe('ag-1');
    expect(writeCall[1]).toBe('sess-direct');
    const payload = JSON.parse((writeCall[2] as { content: string }).content) as Record<string, unknown>;
    expect(payload['_via']).toBe('dashboard');
    expect((payload['_steer'] as Record<string, unknown>)['session_id']).toBe('sess-direct');
  });

  it('returns 404 session_not_found for non-existent session', async () => {
    const ctx = makeCtx('owner-s', { no_filter: true });
    const r = await applySessionSteer('sess-NOPE', { idempotency_key: VALID_IKEY, text: 'hi' }, ctx);
    expect(r.status).toBe(404);
    expect(r.body['error']).toBe('session_not_found');
  });

  it('§2a: returns 404 not 403 for sessions outside scope', async () => {
    seedSession('sess-other', 'ag-2');
    const ctx = makeCtx('admin-s', { allowed_group_ids: ['ag-1'] });
    const r = await applySessionSteer('sess-other', { idempotency_key: VALID_IKEY, text: 'hi' }, ctx);
    expect(r.status).toBe(404);
    expect(r.body['error']).toBe('session_not_found');
  });

  it('member role cannot steer a session — 404 disclose-as-not-found', async () => {
    const ctx = makeCtx('member-s', { allowed_group_ids: ['ag-1'] });
    const r = await applySessionSteer('sess-direct', { idempotency_key: VALID_IKEY, text: 'hi' }, ctx);
    expect(r.status).toBe(404);
    expect(r.body['error']).toBe('session_not_found');
  });

  it('echoes to the session messaging group + thread when present', async () => {
    // Re-seed the session WITH a messaging_group + thread_id so the echo
    // picks up the thread-mode branch.
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO messaging_groups
           (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
         VALUES ('mg-s', 'slack', 'C-s', 'slack', 'echo-ch', 1, 'public', datetime('now'))`,
      )
      .run();
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO sessions
           (id, agent_group_id, messaging_group_id, thread_id, status, created_at)
         VALUES ('sess-echo', 'ag-1', 'mg-s', 'thread-42', 'active', ?)`,
      )
      .run(now());

    const deliverMock = vi.fn().mockResolvedValue(undefined);
    mockGetMessagingGroup.mockReturnValue({
      id: 'mg-s',
      channel_type: 'slack',
      platform_id: 'C-s',
      name: 'echo-ch',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    mockGetChannelAdapter.mockReturnValue({ deliver: deliverMock } as unknown as ReturnType<typeof _gcaRaw>);

    const ctx = makeCtx('owner-s', { no_filter: true });
    const r = await applySessionSteer('sess-echo', { idempotency_key: VALID_IKEY, text: 'check in' }, ctx);
    expect(r.status).toBe(202);
    // Echo fires via setImmediate
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deliverMock).toHaveBeenCalledWith(
      'C-s',
      'thread-42',
      expect.objectContaining({
        kind: 'chat',
        content: expect.objectContaining({ text: expect.stringContaining('check in') }),
      }),
    );
  });

  it('agent-shared sessions (no MG) skip echo as headless', async () => {
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    mockGetChannelAdapter.mockReturnValue({ deliver: deliverMock } as unknown as ReturnType<typeof _gcaRaw>);
    const ctx = makeCtx('owner-s', { no_filter: true });
    const r = await applySessionSteer('sess-direct', { idempotency_key: VALID_IKEY, text: 'hi' }, ctx);
    expect(r.status).toBe(202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deliverMock).not.toHaveBeenCalled();
  });
});
