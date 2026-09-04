import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { closeDb, createMessagingGroup, initTestDb, runMigrations, getRawDb } from '../../db/index.js';
import { messagingGroupsListHandler } from './messaging-groups.js';
import type { AuthedRequestContext } from '../router.js';

function now(): string {
  return new Date().toISOString();
}

function makeCtx(): AuthedRequestContext {
  return {
    user: { id: 'u1', kind: 'dashboard', display_name: 'u1', created_at: now() },
    scopes: { role: 'owner', allowed_group_ids: [], no_filter: true },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function makeReq(): Request {
  return new Request('http://localhost/dashboard/api/messaging-groups');
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
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-1',
      name: '#general',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'slack',
      platform_id: 'C123',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  });
  afterEach(async () => {
    await closeDb();
    vi.clearAllMocks();
  });

  it('lists every messaging group, falling back to channel_type:platform_id when name is null', async () => {
    const res: Response = (await messagingGroupsListHandler(makeReq(), {}, makeCtx()))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messaging_groups: { id: string; name: string }[] };
    expect(body.messaging_groups.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'mg-1', name: '#general' },
      { id: 'mg-2', name: 'slack:C123' },
    ]);
  });
});
