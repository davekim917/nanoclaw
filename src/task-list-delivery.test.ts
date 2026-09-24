/**
 * Live task list, host side (docs/specs/slack-task-list/plan.md): with the
 * switch on, task_list rows deliver and 💭 status rows stay internal; a
 * container killed mid-list leaves the list marked interrupted, and nothing
 * the dead container queued can revive it. The 💭 fallback (switch off) is
 * covered by delivery.test.ts.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups`, TASK_LIST_ENABLED: true };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-task-list-delivery') }));

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { getRawDb } from './db/connection.js';
import { getDeliveredIds } from './modules/mailbox/ops/delivery.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { _resetInterruptedTaskListsForTest, ackInboundReceipt, settleTaskListOnKill } from './task-list-host.js';

const PLATFORM = 'slack:C0AAA';
const THREAD = 'slack:C0AAA:1786621514.008659';

function now(): string {
  return new Date().toISOString();
}

async function seed(): Promise<string> {
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: PLATFORM,
    name: 'Room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
  return session.id;
}

function outbound(sessionId: string): Database.Database {
  return new Database(outboundDbPath('ag-1', sessionId));
}

function insertRow(sessionId: string, id: string, kind: string, content: object): void {
  const db = outbound(sessionId);
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, ?, ?, 'slack', ?, ?)`,
  ).run(id, now(), kind, PLATFORM, THREAD, JSON.stringify(content));
  db.close();
}

function writeListState(sessionId: string, overrides: Record<string, unknown> = {}): void {
  const db = outbound(sessionId);
  const state = {
    version: 1,
    generation: 1,
    revision: 4,
    title: 'Migrating',
    items: [
      { text: 'Ran it', status: 'done' },
      { text: 'Verify', status: 'in_progress' },
    ],
    channelType: 'slack',
    platformId: PLATFORM,
    threadId: THREAD,
    postOutboundId: 'list-1',
    postSeq: 3,
    platformMessageId: '1786621600.000100',
    postedAt: now(),
    updatedAt: now(),
    finished: false,
    interruptedText: 'Migrating\n✓ Ran it\n◌ Verify (interrupted)',
    interruptedSubtext: 'stopped · todos as of <!date^1^{time} ({ago})|3:00 PM>',
    text: 'Migrating\n✓ Ran it\n✱ Verify',
    subtext: 'todos as of <!date^1^{time} ({ago})|3:00 PM>',
    ...overrides,
  };
  db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
    'task_list',
    JSON.stringify(state),
    now(),
  );
  db.close();
}

type Call = { kind: string; threadId: string | null; content: Record<string, unknown> };

function captureAdapter(): Call[] {
  const calls: Call[] = [];
  setDeliveryAdapter({
    async deliver(_channelType, _platformId, threadId, kind, content) {
      calls.push({ kind, threadId, content: JSON.parse(content) as Record<string, unknown> });
      return `plat-${calls.length}`;
    },
  });
  return calls;
}

async function delivered(sessionId: string): Promise<Set<string>> {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  try {
    return getDeliveredIds(db);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initTestDb();
  runMigrations(getRawDb());
  _resetInterruptedTaskListsForTest();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('task list delivery (switch on)', () => {
  it('keeps 💭 status rows internal: recorded delivered, never posted', async () => {
    const sessionId = await seed();
    const calls = captureAdapter();
    insertRow(sessionId, 'status-1', 'status', { text: '> 💭 thinking' });
    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(0);
    expect(await delivered(sessionId)).toContain('status-1');
  });

  it('posts a task list through the channel path with its footer', async () => {
    const sessionId = await seed();
    const calls = captureAdapter();
    insertRow(sessionId, 'list-1', 'task_list', {
      text: 'Migrating\n✱ Run it',
      subtext: 'todos as of <!date^1^{time} ({ago})|3:00 PM>',
      taskList: { generation: 1, revision: 1, activeText: 'Run it' },
    });
    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('task_list');
    expect(calls[0].threadId).toBe(THREAD);
    expect(calls[0].content.subtext).toContain('todos as of');
  });

  it('marks an unfinished list interrupted when its container is killed mid-work', async () => {
    const sessionId = await seed();
    writeListState(sessionId);
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toEqual([
      {
        kind: 'task_list',
        threadId: THREAD,
        content: {
          operation: 'edit',
          messageId: '1786621600.000100',
          text: 'Migrating\n✓ Ran it\n◌ Verify (interrupted)',
          subtext: 'stopped · todos as of <!date^1^{time} ({ago})|3:00 PM>',
        },
      },
    ]);
  });

  it('leaves the list alone when an idle reaper ends a container that already finished working', async () => {
    const sessionId = await seed();
    writeListState(sessionId);
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'chat-idle-reap');
    await settleTaskListOnKill(sessionId, 'scheduled-task-idle');
    expect(calls).toHaveLength(0);
  });

  it('leaves a finished list alone', async () => {
    const sessionId = await seed();
    writeListState(sessionId, { finished: true });
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(0);
  });

  it('never lets the dead container’s queued update revive the list; a newer container’s does', async () => {
    const sessionId = await seed();
    writeListState(sessionId, { revision: 4 });
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(1);

    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    insertRow(sessionId, 'late-edit', 'task_list', {
      operation: 'edit',
      messageId: '1786621600.000100',
      text: 'Migrating\n✓ Ran it\n✱ Verify',
      taskList: { generation: 1, revision: 4, activeText: 'Verify' },
    });
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);
    expect(await delivered(sessionId)).toContain('late-edit');

    insertRow(sessionId, 'resumed-edit', 'task_list', {
      operation: 'edit',
      messageId: '1786621600.000100',
      text: 'Migrating\n✓ Ran it\n✓ Verified',
      taskList: { generation: 1, revision: 5, activeText: null },
    });
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
    expect(calls[1].content.text).toBe('Migrating\n✓ Ran it\n✓ Verified');
  });

  it('adds the 👀 receipt on Slack only', async () => {
    await seed();
    const calls = captureAdapter();
    ackInboundReceipt('slack', PLATFORM, THREAD, '1786621700.000200', undefined);
    ackInboundReceipt('discord', 'discord:1:2', null, '999', undefined);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls).toEqual([
      {
        kind: 'chat',
        threadId: THREAD,
        content: { operation: 'reaction', messageId: '1786621700.000200', emoji: 'eyes' },
      },
    ]);
  });
});
