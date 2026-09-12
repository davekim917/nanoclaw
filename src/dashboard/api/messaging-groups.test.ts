import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  initTestDb,
  runMigrations,
  getRawDb,
} from '../../db/index.js';
import { messagingGroupsListHandler } from './messaging-groups.js';
import { clearCookieVerifier, requireAuth } from '../router.js';
import type { AuthedRequestContext } from '../router.js';

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
      role: (opts.no_filter ?? true) ? 'owner' : 'member',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? true,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function makeReq(): Request {
  return new Request('http://localhost/dashboard/api/messaging-groups');
}

function addUser(id: string): void {
  getRawDb()
    .prepare("INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'dashboard', ?, datetime('now'))")
    .run(id, id);
}

function grantRole(userId: string, role: string, agentGroupId: string | null): void {
  getRawDb()
    .prepare("INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES (?, ?, ?, datetime('now'))")
    .run(userId, role, agentGroupId);
}

async function setupDb(): Promise<void> {
  await initTestDb();
  const db = getRawDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

describe('messagingGroupsListHandler', () => {
  beforeEach(async () => {
    await setupDb();
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-1',
      name: '#general',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-2',
      channel_type: 'slack',
      platform_id: 'C123',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    // An agent group to scope a non-global role against (user_roles.agent_group_id
    // FK requires a real row when foreign_keys = ON).
    await createAgentGroup({
      id: 'ag-1',
      name: 'ag-1',
      folder: 'ag-1',
      agent_provider: null,
      created_at: now(),
    });

    addUser('owner-1');
    grantRole('owner-1', 'owner', null);

    addUser('gadmin-1');
    grantRole('gadmin-1', 'admin', null);

    addUser('sadmin-1');
    grantRole('sadmin-1', 'admin', 'ag-1'); // scoped admin — admin OF one agent group, not global

    addUser('member-1');
    grantRole('member-1', 'member', 'ag-1'); // scoped member

    addUser('nobody-1'); // no user_roles row at all
  });
  afterEach(async () => {
    await closeDb();
    vi.clearAllMocks();
  });

  it('lists every messaging group for an owner, falling back to channel_type:platform_id when name is null', async () => {
    const res: Response = (await messagingGroupsListHandler(makeReq(), {}, makeCtx('owner-1')))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messaging_groups: { id: string; name: string }[] };
    expect(body.messaging_groups.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'mg-1', name: '#general' },
      { id: 'mg-2', name: 'slack:C123' },
    ]);
  });

  it('lists every messaging group for a global admin', async () => {
    const res: Response = (await messagingGroupsListHandler(makeReq(), {}, makeCtx('gadmin-1')))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messaging_groups: { id: string; name: string }[] };
    expect(body.messaging_groups.map((m) => m.id).sort()).toEqual(['mg-1', 'mg-2']);
  });

  it("a workgroup-scoped admin gets an empty list, never another workgroup's groups", async () => {
    const res: Response = (await messagingGroupsListHandler(
      makeReq(),
      {},
      makeCtx('sadmin-1', { no_filter: false, allowed_group_ids: ['ag-1'] }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messaging_groups: unknown[] };
    expect(body.messaging_groups).toEqual([]);
  });

  it("a workgroup-scoped member gets an empty list, never another workgroup's groups", async () => {
    const res: Response = (await messagingGroupsListHandler(
      makeReq(),
      {},
      makeCtx('member-1', { no_filter: false, allowed_group_ids: ['ag-1'] }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messaging_groups: unknown[] };
    expect(body.messaging_groups).toEqual([]);
  });

  it('a user with no role at all gets an empty list', async () => {
    const res: Response = (await messagingGroupsListHandler(
      makeReq(),
      {},
      makeCtx('nobody-1', { no_filter: false, allowed_group_ids: [] }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messaging_groups: unknown[] };
    expect(body.messaging_groups).toEqual([]);
  });

  it('an unauthenticated request is rejected by requireAuth before reaching the handler', async () => {
    clearCookieVerifier(); // no verifier registered → cookieVerifier(...) → null → 401
    const spy = vi.fn(messagingGroupsListHandler);
    const authedHandler = requireAuth(spy);

    const req = new Request('http://localhost:3000/dashboard/api/messaging-groups');
    const result = await authedHandler(req, {}, { rawNodeReq: {} as http.IncomingMessage });

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    const body = (await result!.json()) as { error: string };
    expect(body.error).toBe('unauthenticated');
    expect(spy).not.toHaveBeenCalled();
  });
});
