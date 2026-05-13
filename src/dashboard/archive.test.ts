import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getDb } from '../db/index.js';
import { insertTaskAtomic } from '../modules/orchestrator-dispatch/db/tasks.js';
import { archiveHandler, unarchiveHandler, bulkArchiveHandler } from './archive.js';
import type { AuthedRequestContext } from './router.js';

vi.mock('./api/events.js', () => ({
  emitDashboardEvent: vi.fn(),
}));

vi.mock('../modules/permissions/db/user-roles.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/permissions/db/user-roles.js')>();
  return {
    ...real,
    // Default to true; flipped per-case where exercise needs a member-role scope.
    hasAdminPrivilege: vi.fn(() => true),
  };
});

function now(): string {
  return new Date().toISOString();
}

function makeCtx(opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {}): AuthedRequestContext {
  return {
    user: { id: 'u1', kind: 'dashboard', display_name: 'u1', created_at: now() },
    scopes: {
      role: opts.no_filter ? 'owner' : 'admin_of_group',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? false,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function makeReq(url: string, body?: Record<string, unknown>): Request {
  return new Request(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

function insertTask(
  taskId: string,
  agId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' = 'failed',
): void {
  insertTaskAtomic({
    task_id: taskId,
    idempotency_key: taskId,
    parent_session_id: 'sess-1',
    parent_agent_group_id: agId,
    parent_messaging_group_id: null,
    child_session_id: null,
    status,
    task_content: 'do something',
    request_hash: 'hash-x',
    deadline: null,
    parent_platform_message_id: null,
    child_platform_thread_id: null,
    child_messaging_group_id: null,
    admitted_at: now(),
    started_at: null,
    completed_at: status === 'completed' ? now() : null,
    failed_at: status === 'failed' ? now() : null,
    cancelled_at: null,
    last_progress_at: null,
    last_progress_message: null,
    fail_reason: null,
    result_summary: null,
    dispatch_completion_attempts: 0,
    completion_lease_at: null,
    surface_mode: 'headless',
  });
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function seedSession(): void {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, created_at) VALUES (?, ?, NULL, ?)',
    )
    .run('sess-1', 'ag-1', now());
}

describe('archiveHandler', () => {
  beforeEach(() => {
    setupDb();
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    seedSession();
  });
  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  it('sets archived_at and returns 200 for in-scope admin', async () => {
    insertTask('t1', 'ag-1', 'failed');
    const ctx = makeCtx({ allowed_group_ids: ['ag-1'] });
    const resp = await archiveHandler(makeReq('http://localhost/dashboard/api/tasks/t1/archive'), { id: 't1' }, ctx);
    expect(resp!.status).toBe(200);

    const row = getDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('t1') as {
      archived_at: string | null;
    };
    expect(row.archived_at).not.toBeNull();
  });

  it('returns 404 for out-of-scope task (disclose-as-not-found)', async () => {
    // task lives in ag-2 but caller only has scope on ag-1
    insertTask('t1', 'ag-2', 'failed');
    const ctx = makeCtx({ allowed_group_ids: ['ag-1'] });
    const resp = await archiveHandler(makeReq('http://localhost/dashboard/api/tasks/t1/archive'), { id: 't1' }, ctx);
    expect(resp!.status).toBe(404);

    const row = getDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('t1') as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
  });

  it('returns 404 for non-existent task', async () => {
    const ctx = makeCtx({ no_filter: true });
    const resp = await archiveHandler(
      makeReq('http://localhost/dashboard/api/tasks/nope/archive'),
      { id: 'nope' },
      ctx,
    );
    expect(resp!.status).toBe(404);
  });

  it('idempotent: archiving an already-archived task is a no-op', async () => {
    insertTask('t1', 'ag-1', 'failed');
    getDb().prepare(`UPDATE tasks SET archived_at = ? WHERE task_id = 't1'`).run('2026-05-12T00:00:00.000Z');
    const ctx = makeCtx({ no_filter: true });
    const resp = await archiveHandler(makeReq('http://localhost/dashboard/api/tasks/t1/archive'), { id: 't1' }, ctx);
    expect(resp!.status).toBe(200);

    const row = getDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('t1') as {
      archived_at: string;
    };
    // SQL guard `AND archived_at IS NULL` means the original timestamp is preserved
    expect(row.archived_at).toBe('2026-05-12T00:00:00.000Z');
  });
});

describe('unarchiveHandler', () => {
  beforeEach(() => {
    setupDb();
    seedAgentGroup('ag-1');
    seedSession();
  });
  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  it('clears archived_at and returns 200', async () => {
    insertTask('t1', 'ag-1', 'failed');
    getDb().prepare(`UPDATE tasks SET archived_at = ? WHERE task_id = 't1'`).run(now());

    const ctx = makeCtx({ no_filter: true });
    const resp = await unarchiveHandler(
      makeReq('http://localhost/dashboard/api/tasks/t1/unarchive'),
      { id: 't1' },
      ctx,
    );
    expect(resp!.status).toBe(200);

    const row = getDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('t1') as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
  });

  it('returns 404 for out-of-scope task', async () => {
    insertTask('t1', 'ag-1', 'failed');
    const ctx = makeCtx({ allowed_group_ids: ['ag-9'] });
    const resp = await unarchiveHandler(
      makeReq('http://localhost/dashboard/api/tasks/t1/unarchive'),
      { id: 't1' },
      ctx,
    );
    expect(resp!.status).toBe(404);
  });
});

describe('bulkArchiveHandler', () => {
  beforeEach(() => {
    setupDb();
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    seedSession();
    getDb()
      .prepare('INSERT OR IGNORE INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)')
      .run('sess-2', 'ag-2', now());
  });
  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  it('archives all failed tasks in scope and returns count', async () => {
    insertTask('t1', 'ag-1', 'failed');
    insertTask('t2', 'ag-1', 'failed');
    insertTask('t3', 'ag-1', 'completed'); // wrong status — not touched
    const ctx = makeCtx({ allowed_group_ids: ['ag-1'] });
    const resp = await bulkArchiveHandler(
      makeReq('http://localhost/dashboard/api/tasks/bulk-archive', { status: 'failed', group_id: 'ag-1' }),
      {},
      ctx,
    );
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as { archived: number };
    expect(body.archived).toBe(2);

    const archived = getDb()
      .prepare(`SELECT task_id FROM tasks WHERE archived_at IS NOT NULL ORDER BY task_id`)
      .all() as Array<{ task_id: string }>;
    expect(archived.map((r) => r.task_id)).toEqual(['t1', 't2']);
  });

  it('does not cross group boundaries', async () => {
    insertTask('t1', 'ag-1', 'failed');
    insertTask('t2', 'ag-2', 'failed');
    const ctx = makeCtx({ no_filter: true });
    await bulkArchiveHandler(
      makeReq('http://localhost/dashboard/api/tasks/bulk-archive', { status: 'failed', group_id: 'ag-1' }),
      {},
      ctx,
    );
    const t2 = getDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('t2') as {
      archived_at: string | null;
    };
    expect(t2.archived_at).toBeNull();
  });

  it('returns 404 for out-of-scope group (disclose-as-not-found)', async () => {
    insertTask('t1', 'ag-2', 'failed');
    const ctx = makeCtx({ allowed_group_ids: ['ag-1'] });
    const resp = await bulkArchiveHandler(
      makeReq('http://localhost/dashboard/api/tasks/bulk-archive', { status: 'failed', group_id: 'ag-2' }),
      {},
      ctx,
    );
    expect(resp!.status).toBe(404);
    const t1 = getDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('t1') as {
      archived_at: string | null;
    };
    expect(t1.archived_at).toBeNull();
  });

  it('rejects invalid status with 400', async () => {
    const ctx = makeCtx({ no_filter: true });
    const resp = await bulkArchiveHandler(
      makeReq('http://localhost/dashboard/api/tasks/bulk-archive', { status: 'running', group_id: 'ag-1' }),
      {},
      ctx,
    );
    expect(resp!.status).toBe(400);
  });

  it('rejects missing group_id with 400', async () => {
    const ctx = makeCtx({ no_filter: true });
    const resp = await bulkArchiveHandler(
      makeReq('http://localhost/dashboard/api/tasks/bulk-archive', { status: 'failed' }),
      {},
      ctx,
    );
    expect(resp!.status).toBe(400);
  });
});
