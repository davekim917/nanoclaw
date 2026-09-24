/**
 * The 👀 receipt (docs/specs/slack-task-list/plan.md) acknowledges a message
 * an agent actually took, so it fires only after the inbound row is durable:
 * a duplicate delivery or a failed insert never gets one.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR, state } = vi.hoisted(() => ({
  TEST_DIR: uniqueTmpRoot('test-router-receipt'),
  state: { failInsert: false },
}));

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => ({
  ...(await vi.importActual<typeof import('./config.js')>('./config.js')),
  DATA_DIR: TEST_DIR,
  TASK_LIST_ENABLED: true,
}));

vi.mock('./task-list-host.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./task-list-host.js')>()),
  ackInboundReceipt: vi.fn(),
}));

vi.mock('./session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./session-manager.js')>();
  return {
    ...real,
    writeSessionMessageIfNew: vi.fn((...args: Parameters<typeof real.writeSessionMessageIfNew>) =>
      state.failInsert ? Promise.reject(new Error('session db unavailable')) : real.writeSessionMessageIfNew(...args),
    ),
  };
});

import type { InboundEvent } from './channels/adapter.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initMigratedTestDb,
} from './db/index.js';
import { ackInboundReceipt } from './task-list-host.js';

function now(): string {
  return new Date().toISOString();
}

function humanMessage(id: string): InboundEvent {
  return {
    channelType: 'slack',
    platformId: 'slack:C0AAA',
    threadId: null,
    message: {
      id,
      kind: 'chat-sdk',
      timestamp: now(),
      content: JSON.stringify({ text: 'run the migration', author: { userId: 'U1', fullName: 'Dana', isBot: false } }),
    },
  };
}

beforeEach(async () => {
  state.failInsert = false;
  vi.mocked(ackInboundReceipt).mockClear();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C0AAA',
    name: 'Room',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('receipt reaction', () => {
  it('fires once for a message the agent took, not again for its duplicate delivery', async () => {
    const { routeInbound } = await import('./router.js');
    await routeInbound(humanMessage('1786621700.000200'));
    await routeInbound(humanMessage('1786621700.000200'));
    expect(vi.mocked(ackInboundReceipt).mock.calls.map((c) => c[3])).toEqual(['1786621700.000200']);
  });

  it('never fires when the inbound row could not be written', async () => {
    const { routeInbound } = await import('./router.js');
    state.failInsert = true;
    await routeInbound(humanMessage('1786621700.000300')).catch(() => undefined);
    expect(ackInboundReceipt).not.toHaveBeenCalled();
  });
});
