import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getDb } from '../db/index.js';
import { sessionArchiveHandler, sessionUnarchiveHandler } from './archive.js';
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

describe('sessionArchiveHandler / sessionUnarchiveHandler', () => {
  beforeEach(() => {
    setupDb();
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    seedSession();
    // Seed a second session in a different group for scope tests.
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, status, created_at) VALUES ('sess-other', 'ag-2', NULL, 'active', ?)",
      )
      .run(now());
  });

  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  it('archives a session, returns archived_at, emits session_event', async () => {
    const { emitDashboardEvent } = await import('./api/events.js');
    const ctx = makeCtx({ no_filter: true });
    const resp = await sessionArchiveHandler(
      makeReq('http://localhost/dashboard/api/sessions/sess-1/archive'),
      { id: 'sess-1' },
      ctx,
    );
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as { session_id: string; archived_at: string };
    expect(body.session_id).toBe('sess-1');
    expect(body.archived_at).toBeTruthy();

    const row = getDb().prepare('SELECT archived_at FROM sessions WHERE id = ?').get('sess-1') as {
      archived_at: string | null;
    };
    expect(row.archived_at).not.toBeNull();

    expect(vi.mocked(emitDashboardEvent)).toHaveBeenCalledWith(
      'session_event',
      expect.objectContaining({ session_id: 'sess-1', kind: 'archived', agent_group_id: 'ag-1' }),
    );
  });

  it('§2a — session in another group returns 404 not 403', async () => {
    const ctx = makeCtx({ allowed_group_ids: ['ag-1'] });
    const resp = await sessionArchiveHandler(
      makeReq('http://localhost/dashboard/api/sessions/sess-other/archive'),
      { id: 'sess-other' },
      ctx,
    );
    expect(resp!.status).toBe(404);
    const body = (await resp!.json()) as { error: string };
    expect(body.error).toBe('session_not_found');
  });

  it('non-admin gets 404 (member role disclose-as-not-found)', async () => {
    const userRoles = await import('../modules/permissions/db/user-roles.js');
    vi.mocked(userRoles.hasAdminPrivilege).mockReturnValueOnce(false);
    const ctx = makeCtx({ allowed_group_ids: ['ag-1'] });
    const resp = await sessionArchiveHandler(
      makeReq('http://localhost/dashboard/api/sessions/sess-1/archive'),
      { id: 'sess-1' },
      ctx,
    );
    expect(resp!.status).toBe(404);
  });

  it('archiving an already-archived row suppresses the SSE emit', async () => {
    const { emitDashboardEvent } = await import('./api/events.js');
    getDb().prepare("UPDATE sessions SET archived_at = ? WHERE id = 'sess-1'").run(now());
    vi.mocked(emitDashboardEvent).mockClear();

    const ctx = makeCtx({ no_filter: true });
    const resp = await sessionArchiveHandler(
      makeReq('http://localhost/dashboard/api/sessions/sess-1/archive'),
      { id: 'sess-1' },
      ctx,
    );
    expect(resp!.status).toBe(200);
    expect(vi.mocked(emitDashboardEvent)).not.toHaveBeenCalled();
  });

  it('unarchives a session, emits session_event with kind=unarchived', async () => {
    getDb().prepare("UPDATE sessions SET archived_at = ? WHERE id = 'sess-1'").run(now());
    const { emitDashboardEvent } = await import('./api/events.js');
    vi.mocked(emitDashboardEvent).mockClear();

    const ctx = makeCtx({ no_filter: true });
    const resp = await sessionUnarchiveHandler(
      makeReq('http://localhost/dashboard/api/sessions/sess-1/unarchive'),
      { id: 'sess-1' },
      ctx,
    );
    expect(resp!.status).toBe(200);

    const row = getDb().prepare('SELECT archived_at FROM sessions WHERE id = ?').get('sess-1') as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();

    expect(vi.mocked(emitDashboardEvent)).toHaveBeenCalledWith(
      'session_event',
      expect.objectContaining({ session_id: 'sess-1', kind: 'unarchived', agent_group_id: 'ag-1' }),
    );
  });

  it('unarchive on nonexistent session returns 404', async () => {
    const ctx = makeCtx({ no_filter: true });
    const resp = await sessionUnarchiveHandler(
      makeReq('http://localhost/dashboard/api/sessions/sess-NOPE/unarchive'),
      { id: 'sess-NOPE' },
      ctx,
    );
    expect(resp!.status).toBe(404);
  });
});
