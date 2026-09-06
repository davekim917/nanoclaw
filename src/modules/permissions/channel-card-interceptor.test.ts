/**
 * Unit tests for the channel-card interceptor seam (B2/D24, T4 PR 4).
 *
 * Covers:
 *  - registerChannelCardInterceptor + consult order: the interceptor runs
 *    before any card work for its channel type only
 *  - 'handled' → no card delivered, no pending_channel_approvals row, and
 *    requestChannelApproval returns false (the fork-specific half: no
 *    pending row was retained, so the router must not mark a replay
 *    pending for this event)
 *  - 'card' → today's flow proceeds unchanged
 *  - interceptor throw → card fallback (a broken module never makes
 *    escalations vanish)
 *  - in-flight dedupe still short-circuits before the interceptor
 *  - registrations are order-independent (the reset helper clears the map
 *    between cases)
 *  - no fork module registers an interceptor (source-scan tripwire)
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, getRawDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup } from '../../types.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

// Mock container runner — prevent actual docker spawn.
vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery adapter.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
  registerDeliveryAction: vi.fn(),
  onDeliveryAdapterReady: vi.fn(),
}));

// Mock ensureUserDm — look up the owner's preconfigured DM row instead of
// hitting a real openDM RPC. Second arg (options) is ignored; these tests
// don't exercise instance/privacySafeLogs behavior, which is user-dm.test.ts's job.
vi.mock('./user-dm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./user-dm.js')>()),
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getRawDb } = await import('../../db/connection.js');
    return getRawDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-channel-card-interceptor') }));

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initTestDb();
  runMigrations(getRawDb());

  // Reset registrations between cases — the map is module-global, so a
  // later `it` must not depend on (or be broken by) an earlier one's
  // registration. This is what pins "registrations are order-independent".
  const { _resetChannelCardInterceptorsForTesting } = await import('./channel-approval.js');
  _resetChannelCardInterceptorsForTesting();

  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });

  await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  getRawDb()
    .prepare(`INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`)
    .run('telegram:owner', 'telegram', 'mg-dm-owner', now());

  deliverMock.mockClear();
});

afterEach(async () => {
  const { _resetChannelCardInterceptorsForTesting } = await import('./channel-approval.js');
  _resetChannelCardInterceptorsForTesting();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

async function unwiredChannel(id: string, channelType = 'telegram'): Promise<MessagingGroup> {
  const mg: MessagingGroup = {
    id,
    channel_type: channelType,
    platform_id: `chan-${id}`,
    instance: channelType,
    name: null,
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  };
  await createMessagingGroup(mg);
  return mg;
}

function mention(mg: MessagingGroup): InboundEvent {
  return {
    channelType: mg.channel_type,
    platformId: mg.platform_id,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: now(),
      isMention: true,
      isGroup: true,
      content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text: '@bot hi' }),
    },
  };
}

function pendingCount(): number {
  return (getRawDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
}

describe('channel-card interceptor seam', () => {
  it("'handled' suppresses the card", async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    const interceptor = vi.fn().mockResolvedValue('handled');
    registerChannelCardInterceptor('telegram', interceptor);

    const mg = await unwiredChannel('mg-a');
    const event = mention(mg);
    const retained = await requestChannelApproval({ messagingGroupId: mg.id, event });

    expect(interceptor).toHaveBeenCalledTimes(1);
    expect(interceptor).toHaveBeenCalledWith(expect.objectContaining({ id: mg.id }), event);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(pendingCount()).toBe(0);
    // Fork-specific half: no pending row was retained for this event, so the
    // router must not call markReplayPending() for it.
    expect(retained).toBe(false);
  });

  it("'card' proceeds with today's flow", async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    registerChannelCardInterceptor('telegram', vi.fn().mockResolvedValue('card'));

    const mg = await unwiredChannel('mg-b');
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string) as { type: string };
    expect(payload.type).toBe('ask_question');
    expect(pendingCount()).toBe(1);
  });

  it('an interceptor throw falls back to the card', async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    registerChannelCardInterceptor('telegram', vi.fn().mockRejectedValue(new Error('boom')));

    const mg = await unwiredChannel('mg-c');
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });

    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(pendingCount()).toBe(1);
  });

  it('only consulted for its own channel type', async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    const interceptor = vi.fn().mockResolvedValue('handled');
    registerChannelCardInterceptor('slack', interceptor);

    const mg = await unwiredChannel('mg-d'); // telegram
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });

    expect(interceptor).not.toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('the in-flight dedupe short-circuits before the interceptor', async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    const interceptor = vi.fn().mockResolvedValue('card');
    registerChannelCardInterceptor('telegram', interceptor);

    const mg = await unwiredChannel('mg-e');
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });

    expect(interceptor).toHaveBeenCalledTimes(1); // second call died at the pending-row check
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('registrations are order-independent', async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    // A prior case in this suite (run in any order) may have registered a
    // 'telegram' interceptor — the beforeEach reset must have cleared it, or
    // this case would silently inherit someone else's mock behavior.
    const mg = await unwiredChannel('mg-f');
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });
    expect(deliverMock).toHaveBeenCalledTimes(1); // today's card flow, no leaked interceptor

    const interceptor = vi.fn().mockResolvedValue('handled');
    registerChannelCardInterceptor('telegram', interceptor);
    const mg2 = await unwiredChannel('mg-f2');
    await requestChannelApproval({ messagingGroupId: mg2.id, event: mention(mg2) });
    expect(interceptor).toHaveBeenCalledTimes(1);
  });

  it('no fork module registers an interceptor', async () => {
    const fs2 = await import('node:fs');
    const path = await import('node:path');
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const SELF = 'src/modules/permissions/channel-card-interceptor.test.ts';
    const DEFINER = 'src/modules/permissions/channel-approval.ts';

    function walk(dir: string, out: string[]): void {
      for (const entry of fs2.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
    }
    const files: string[] = [];
    walk(path.join(repoRoot, 'src'), files);

    const callSites: string[] = [];
    for (const file of files) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      if (rel === SELF || rel === DEFINER) continue;
      const content = fs2.readFileSync(file, 'utf8');
      if (content.includes('registerChannelCardInterceptor(')) callSites.push(rel);
    }
    expect(callSites).toEqual([]);
  });
});
