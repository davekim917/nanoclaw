import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { closeDb, createAgentGroup, getRawDb, initTestDb, runMigrations } from '../../db/index.js';
import { groupsListHandler } from './groups.js';
import type { AuthedRequestContext } from '../router.js';

function now(): string {
  return new Date().toISOString();
}

function makeCtx(opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {}): AuthedRequestContext {
  return {
    user: { id: 'u1', kind: 'dashboard', display_name: 'u1', created_at: now() },
    scopes: {
      role: opts.no_filter ? 'owner' : 'member',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? false,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function makeReq(): Request {
  return new Request('http://localhost/dashboard/api/groups');
}

async function setupDb(): Promise<void> {
  await initTestDb();
  const db = getRawDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

describe('groupsListHandler', () => {
  beforeEach(async () => {
    await setupDb();
    createAgentGroup({
      id: 'ag-1',
      name: 'example-labs',
      folder: 'example-labs',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-2',
      name: 'example-dev',
      folder: 'example-dev',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({ id: 'ag-3', name: 'personal', folder: 'personal', agent_provider: null, created_at: now() });
  });
  afterEach(async () => {
    await closeDb();
    vi.clearAllMocks();
  });

  it('owner with no_filter returns every group', async () => {
    const res: Response = (await groupsListHandler(makeReq(), {}, makeCtx({ no_filter: true })))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: { id: string; name: string }[] };
    expect(body.groups.map((g) => g.id).sort()).toEqual(['ag-1', 'ag-2', 'ag-3']);
  });

  it('member sees only their allowed groups', async () => {
    const res: Response = (await groupsListHandler(makeReq(), {}, makeCtx({ allowed_group_ids: ['ag-1', 'ag-2'] })))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: { id: string; name: string }[] };
    expect(body.groups.map((g) => g.id).sort()).toEqual(['ag-1', 'ag-2']);
  });

  it('member with single group sees only that one', async () => {
    const res: Response = (await groupsListHandler(makeReq(), {}, makeCtx({ allowed_group_ids: ['ag-2'] })))!;
    const body = (await res.json()) as { groups: { id: string; name: string }[] };
    expect(body.groups).toEqual([{ id: 'ag-2', name: 'example-dev', workgroup_id: null }]);
  });

  // The console resolves a selected workgroup to its siblings client-side off
  // this column; without it the Schedule lens (keyed on agent_group_id) cannot
  // honour the workgroup filter.
  it('carries workgroup_id so the SPA can map a workgroup to its siblings', async () => {
    getRawDb().prepare(`INSERT INTO workgroups (id, created_at) VALUES ('example-labs', ?)`).run(now());
    getRawDb().prepare(`UPDATE agent_groups SET workgroup_id = 'example-labs' WHERE id IN ('ag-1', 'ag-2')`).run();

    const res: Response = (await groupsListHandler(makeReq(), {}, makeCtx({ no_filter: true })))!;
    const body = (await res.json()) as { groups: { id: string; workgroup_id: string | null }[] };
    expect(Object.fromEntries(body.groups.map((g) => [g.id, g.workgroup_id]))).toEqual({
      'ag-1': 'example-labs',
      'ag-2': 'example-labs',
      'ag-3': null,
    });
  });

  it('user with no allowed groups gets empty array (no leak)', async () => {
    const res: Response = (await groupsListHandler(makeReq(), {}, makeCtx({ allowed_group_ids: [] })))!;
    const body = (await res.json()) as { groups: unknown[] };
    expect(body.groups).toEqual([]);
  });

  it('rows are ordered by name', async () => {
    const res: Response = (await groupsListHandler(makeReq(), {}, makeCtx({ no_filter: true })))!;
    const body = (await res.json()) as { groups: { name: string }[] };
    expect(body.groups.map((g) => g.name)).toEqual(['example-dev', 'example-labs', 'personal']);
  });
});
