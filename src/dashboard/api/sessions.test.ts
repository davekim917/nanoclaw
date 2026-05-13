import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { sessionsHandler, sessionsDetailHandler } from './sessions.js';
import type { AuthedRequestContext } from '../router.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    heartbeatPath: vi.fn().mockImplementation((_ag: string, sessId: string) => `/tmp/hb-${sessId}`),
  };
});

vi.mock('fs', async () => {
  return {
    default: {
      statSync: vi.fn().mockImplementation(() => {
        throw new Error('ENOENT');
      }),
      existsSync: vi.fn().mockReturnValue(false),
    },
  };
});

import fs from 'fs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function makeCtx(
  userId: string,
  opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {},
): AuthedRequestContext {
  return {
    user: { id: userId, kind: 'dashboard', display_name: userId, created_at: now() },
    scopes: {
      role: opts.no_filter ? 'owner' : 'admin_of_group',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? false,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function makeReq(url = 'http://localhost/dashboard/api/sessions'): Request {
  return new Request(url);
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function insertSession(sessId: string, agId: string, mgId: string | null = null): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    )
    .run(sessId, agId, mgId, now());
}

function setSessionFields(
  sessId: string,
  fields: Partial<{
    last_active: string;
    last_outbound_at: string;
    last_outbound_kind: string;
    title: string;
    archived_at: string;
  }>,
): void {
  const pairs = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(', ');
  const values = Object.values(fields);
  getDb()
    .prepare(`UPDATE sessions SET ${pairs} WHERE id = ?`)
    .run(...values, sessId);
}

function insertAttachedTask(opts: {
  taskId: string;
  childSessId: string;
  parentSessId: string;
  agentGroupId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  needsInput?: 0 | 1;
}): void {
  getDb()
    .prepare(
      `INSERT INTO tasks
         (task_id, idempotency_key, parent_session_id, parent_agent_group_id, child_session_id,
          status, task_content, request_hash, admitted_at, surface_mode, needs_input, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '## Goal\nx', 'h', ?, 'native_thread', ?, ?)`,
    )
    .run(
      opts.taskId,
      `key-${opts.taskId}`,
      opts.parentSessId,
      opts.agentGroupId,
      opts.childSessId,
      opts.status,
      now(),
      opts.needsInput ?? 0,
      now(),
    );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sessionsHandler — D4', () => {
  beforeEach(() => {
    vi.mocked(fs.statSync).mockReset();
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    setupDb();
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  it('test_sessions_owner_no_filter', async () => {
    insertSession('sess-1', 'ag-1');
    insertSession('sess-2', 'ag-1');
    insertSession('sess-3', 'ag-2');
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as { sessions: unknown[] };
    expect(body.sessions.length).toBe(3);
  });

  it('test_sessions_scoped_admin', async () => {
    insertSession('sess-1', 'ag-1');
    insertSession('sess-2', 'ag-2');
    const ctx = makeCtx('u1', { allowed_group_ids: ['ag-1'] });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as { sessions: Array<{ agent_group_id: string }> };
    expect(body.sessions.every((s) => s.agent_group_id === 'ag-1')).toBe(true);
  });

  it('test_sessions_container_status_derived_from_heartbeat', async () => {
    insertSession('sess-running', 'ag-1');
    insertSession('sess-idle', 'ag-1');
    insertSession('sess-stale', 'ag-1');
    insertSession('sess-unknown', 'ag-1');

    const nowMs = Date.now();
    vi.mocked(fs.statSync).mockImplementation((p) => {
      const pathStr = p as string;
      if (pathStr.includes('sess-running')) return { mtimeMs: nowMs - 10_000 } as fs.Stats;
      if (pathStr.includes('sess-idle')) return { mtimeMs: nowMs - 120_000 } as fs.Stats;
      if (pathStr.includes('sess-stale')) return { mtimeMs: nowMs - 400_000 } as fs.Stats;
      throw new Error('ENOENT');
    });

    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as { sessions: Array<{ session_id: string; container_status: string }> };

    const find = (id: string) => body.sessions.find((s) => s.session_id === id);
    expect(find('sess-running')?.container_status).toBe('running');
    expect(find('sess-idle')?.container_status).toBe('idle');
    expect(find('sess-stale')?.container_status).toBe('stale');
    expect(find('sess-unknown')?.container_status).toBe('unknown');
  });

  it('test_sessions_member_only_returns_member_groups', async () => {
    insertSession('sess-1', 'ag-1');
    insertSession('sess-2', 'ag-2');
    const ctx = makeCtx('u1', { allowed_group_ids: ['ag-1'] });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as { sessions: unknown[] };
    expect(body.sessions.length).toBe(1);
  });

  it('group_id filter narrows to one agent group', async () => {
    insertSession('sess-1', 'ag-1');
    insertSession('sess-2', 'ag-2');
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq('http://localhost/dashboard/api/sessions?group_id=ag-2'), {}, ctx);
    const body = (await resp!.json()) as { sessions: Array<{ agent_group_id: string }> };
    expect(body.sessions.length).toBe(1);
    expect(body.sessions[0]!.agent_group_id).toBe('ag-2');
  });

  it('group_id outside scope returns empty (§2a disclose-as-not-found)', async () => {
    insertSession('sess-1', 'ag-1');
    insertSession('sess-2', 'ag-2');
    const ctx = makeCtx('u1', { allowed_group_ids: ['ag-1'] });
    const resp = await sessionsHandler(makeReq('http://localhost/dashboard/api/sessions?group_id=ag-2'), {}, ctx);
    const body = (await resp!.json()) as { sessions: unknown[] };
    expect(body.sessions.length).toBe(0);
  });

  it('archived sessions hidden by default, surfaced with include_archived=1', async () => {
    insertSession('sess-live', 'ag-1');
    insertSession('sess-old', 'ag-1');
    setSessionFields('sess-old', { archived_at: now() });
    const ctx = makeCtx('u1', { no_filter: true });

    const respHidden = await sessionsHandler(makeReq(), {}, ctx);
    const bodyHidden = (await respHidden!.json()) as { sessions: Array<{ session_id: string }> };
    expect(bodyHidden.sessions.map((s) => s.session_id)).toEqual(['sess-live']);

    const respShown = await sessionsHandler(
      makeReq('http://localhost/dashboard/api/sessions?include_archived=1'),
      {},
      ctx,
    );
    const bodyShown = (await respShown!.json()) as { sessions: Array<{ session_id: string }> };
    expect(bodyShown.sessions.map((s) => s.session_id).sort()).toEqual(['sess-live', 'sess-old']);
  });

  it('attention_state: needs_me when attached task has needs_input=1', async () => {
    insertSession('parent-sess', 'ag-1');
    insertSession('child-sess', 'ag-1');
    insertAttachedTask({
      taskId: 'task-1',
      childSessId: 'child-sess',
      parentSessId: 'parent-sess',
      agentGroupId: 'ag-1',
      status: 'running',
      needsInput: 1,
    });
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq('http://localhost/dashboard/api/sessions?group_id=ag-1'), {}, ctx);
    const body = (await resp!.json()) as {
      sessions: Array<{ session_id: string; attention_state: string; attached_task_id: string | null }>;
    };
    const child = body.sessions.find((s) => s.session_id === 'child-sess');
    expect(child?.attention_state).toBe('needs_me');
    expect(child?.attached_task_id).toBe('task-1');
  });

  it('attached_task is null when the most recent task is terminal (completed/failed/cancelled)', async () => {
    insertSession('parent-sess-old', 'ag-1');
    insertSession('child-sess-old', 'ag-1');
    insertAttachedTask({
      taskId: 'task-done',
      childSessId: 'child-sess-old',
      parentSessId: 'parent-sess-old',
      agentGroupId: 'ag-1',
      status: 'completed',
    });
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq('http://localhost/dashboard/api/sessions?group_id=ag-1'), {}, ctx);
    const body = (await resp!.json()) as {
      sessions: Array<{ session_id: string; attached_task_id: string | null }>;
    };
    const child = body.sessions.find((s) => s.session_id === 'child-sess-old');
    expect(child?.attached_task_id).toBeNull();
  });

  it('stale boundary uses inbound timestamp only (recent outbound alone does NOT prevent stale)', async () => {
    insertSession('sess-out-only', 'ag-1');
    const longAgo = new Date(Date.now() - 48 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    setSessionFields('sess-out-only', { last_active: longAgo, last_outbound_at: recent });
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as { sessions: Array<{ session_id: string; attention_state: string }> };
    // Recent outbound (1 min) trips the 5-min "active" fallback even
    // though inbound is 48h old. Active wins; stale is gated on inbound.
    expect(body.sessions[0]?.attention_state).toBe('active');

    // Now move outbound back too — both timestamps 48h old. Stale wins.
    setSessionFields('sess-out-only', { last_outbound_at: longAgo });
    const resp2 = await sessionsHandler(makeReq(), {}, ctx);
    const body2 = (await resp2!.json()) as { sessions: Array<{ session_id: string; attention_state: string }> };
    expect(body2.sessions[0]?.attention_state).toBe('stale');

    // Outbound 23h old + inbound 48h old: outbound doesn't reset the
    // 24h stale boundary (only inbound does), so this should fall back
    // to `stale` rather than `idle`.
    const outbound23h = new Date(Date.now() - 23 * 3600_000).toISOString();
    setSessionFields('sess-out-only', { last_outbound_at: outbound23h });
    const resp3 = await sessionsHandler(makeReq(), {}, ctx);
    const body3 = (await resp3!.json()) as { sessions: Array<{ session_id: string; attention_state: string }> };
    expect(body3.sessions[0]?.attention_state).toBe('stale');
  });

  it('attention_state: needs_me when last outbound was chat-sdk:ask_question with no inbound since', async () => {
    insertSession('sess-q', 'ag-1');
    setSessionFields('sess-q', {
      last_active: '2026-05-01T00:00:00Z', // older
      last_outbound_at: '2026-05-13T00:00:00Z', // newer
      last_outbound_kind: 'chat-sdk:ask_question',
    });
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as { sessions: Array<{ session_id: string; attention_state: string }> };
    expect(body.sessions[0]?.attention_state).toBe('needs_me');
  });

  it('attention_state: active when container heartbeat is running', async () => {
    insertSession('sess-run', 'ag-1');
    setSessionFields('sess-run', {
      last_active: '2026-05-01T00:00:00Z',
      last_outbound_at: '2026-05-01T00:00:00Z',
    });
    const nowMs = Date.now();
    vi.mocked(fs.statSync).mockImplementation(() => ({ mtimeMs: nowMs - 10_000 }) as fs.Stats);
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as {
      sessions: Array<{ session_id: string; attention_state: string; container_status: string }>;
    };
    expect(body.sessions[0]?.attention_state).toBe('active');
    expect(body.sessions[0]?.container_status).toBe('running');
  });

  it('attention_state: stale when container down and no activity for 24h+', async () => {
    insertSession('sess-cold', 'ag-1');
    setSessionFields('sess-cold', {
      last_active: '2026-05-01T00:00:00Z',
      last_outbound_at: '2026-05-01T00:00:00Z',
    });
    // heartbeat is ENOENT (no container)
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as { sessions: Array<{ session_id: string; attention_state: string }> };
    expect(body.sessions[0]?.attention_state).toBe('stale');
  });

  it('newly-created session with NULL last_active falls back to created_at (not stale)', async () => {
    // A session created moments ago with no inbound traffic yet (e.g.,
    // agent-shared session waiting for its first wake) should land in
    // `idle`, not `stale`. Before Q4 fix, last_active=NULL → ageMs=Infinity
    // → stale immediately on the first inbox refresh.
    insertSession('sess-fresh', 'ag-1');
    // last_active stays NULL by default
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as { sessions: Array<{ session_id: string; attention_state: string }> };
    expect(body.sessions[0]?.attention_state).toBe('idle');
  });

  it('pending attached task keeps session in `active` (Q4 from codex checkpoint #3)', async () => {
    insertSession('p-sess', 'ag-1');
    insertSession('c-sess-pending', 'ag-1');
    insertAttachedTask({
      taskId: 'task-pending',
      childSessId: 'c-sess-pending',
      parentSessId: 'p-sess',
      agentGroupId: 'ag-1',
      status: 'pending',
    });
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq('http://localhost/dashboard/api/sessions?group_id=ag-1'), {}, ctx);
    const body = (await resp!.json()) as {
      sessions: Array<{ session_id: string; attention_state: string }>;
    };
    const child = body.sessions.find((s) => s.session_id === 'c-sess-pending');
    expect(child?.attention_state).toBe('active');
  });

  it('includes title, last_outbound_at, last_outbound_kind in response', async () => {
    insertSession('sess-t', 'ag-1');
    setSessionFields('sess-t', {
      title: 'XZO-71 — rollout fix',
      last_outbound_at: '2026-05-13T12:00:00Z',
      last_outbound_kind: 'chat-sdk:chat_message',
    });
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as {
      sessions: Array<{
        session_id: string;
        title: string | null;
        last_outbound_at: string | null;
        last_outbound_kind: string | null;
      }>;
    };
    const row = body.sessions[0]!;
    expect(row.title).toBe('XZO-71 — rollout fix');
    expect(row.last_outbound_at).toBe('2026-05-13T12:00:00Z');
    expect(row.last_outbound_kind).toBe('chat-sdk:chat_message');
  });
});

describe('sessionsDetailHandler', () => {
  beforeEach(() => {
    vi.mocked(fs.statSync).mockReset();
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    setupDb();
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  it('returns 200 with enriched session payload + empty transcript when no DBs present', async () => {
    insertSession('sess-detail', 'ag-1');
    setSessionFields('sess-detail', { title: 'meeting prep' });
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsDetailHandler(
      makeReq('http://localhost/dashboard/api/sessions/sess-detail'),
      { id: 'sess-detail' },
      ctx,
    );
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as {
      session: { session_id: string; title: string | null; attention_state: string };
      transcript: unknown[];
    };
    expect(body.session.session_id).toBe('sess-detail');
    expect(body.session.title).toBe('meeting prep');
    expect(body.session.attention_state).toBeTruthy();
    expect(body.transcript).toEqual([]);
  });

  it('returns 404 session_not_found for nonexistent session', async () => {
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsDetailHandler(
      makeReq('http://localhost/dashboard/api/sessions/sess-NOPE'),
      { id: 'sess-NOPE' },
      ctx,
    );
    expect(resp!.status).toBe(404);
    const body = (await resp!.json()) as { error: string };
    expect(body.error).toBe('session_not_found');
  });

  it('§2a — out-of-scope session returns 404, same body as nonexistent', async () => {
    insertSession('sess-other-group', 'ag-2');
    const ctx = makeCtx('u1', { allowed_group_ids: ['ag-1'] });
    const resp = await sessionsDetailHandler(
      makeReq('http://localhost/dashboard/api/sessions/sess-other-group'),
      { id: 'sess-other-group' },
      ctx,
    );
    expect(resp!.status).toBe(404);
    const body = (await resp!.json()) as { error: string };
    expect(body.error).toBe('session_not_found');
  });
});
