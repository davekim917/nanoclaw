import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    TIMEZONE: 'UTC',
  };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-slack-subject') }));

// Records the options the gate threads through while leaving the read itself
// real — every other case in this file runs against genuine session DBs.
const readOptions = vi.hoisted(() => ({ last: undefined as unknown }));
vi.mock('../mailbox/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mailbox/index.js')>();
  return {
    ...actual,
    readSessionInbound: ((location: never, action: never, options?: never) => {
      readOptions.last = options;
      return actual.readSessionInbound(location, action, options);
    }) as typeof actual.readSessionInbound,
  };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup, getRawDb } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, taskThreadId, TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { initSessionFolder } from '../../session-manager.js';
import { openInboundDb } from '../../modules/mailbox/openers.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { Session } from '../../types.js';
import { resolveSlackSafetyMessagingGroupId } from './task-slack-subject.js';

const NOW = '2026-08-19T00:00:00.000Z';
const GROUP = 'ag-mr';
const DM_PLATFORM = 'discord:1:dm';
const CHANNEL_PLATFORM = 'discord:1:chan';

function makeSession(id: string, threadId: string | null, mgId: string | null = null): Session {
  const session: Session = {
    id,
    agent_group_id: GROUP,
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: NOW,
  };
  createSession(session);
  initSessionFolder(GROUP, id);
  return session;
}

/** Insert a task row the way the scheduler does — destination on the row itself. */
function addTaskRow(sessionId: string, channelType: string, platformId: string, seq = 2): void {
  const db = openInboundDb(inboundDbPath(GROUP, sessionId));
  try {
    db.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, channel_type, platform_id, content)
       VALUES (?, ?, ?, 'pending', 0, 'task', ?, ?, ?)`,
    ).run(`task-${seq}`, seq, NOW, channelType, platformId, JSON.stringify({ prompt: 'x' }));
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initTestDb();
  runMigrations(getRawDb());
  createAgentGroup({ id: GROUP, name: GROUP, folder: GROUP, agent_provider: null, created_at: NOW });
  createMessagingGroup({
    id: 'mg-dm',
    channel_type: 'discord',
    platform_id: DM_PLATFORM,
    name: 'dm',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  } as never);
  createMessagingGroup({
    id: 'mg-chan',
    channel_type: 'discord',
    platform_id: CHANNEL_PLATFORM,
    name: 'chan',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  } as never);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('resolveSlackSafetyMessagingGroupId', () => {
  it('passes a chat session through unchanged', () => {
    const s = makeSession('sess-chat', 'discord:1:chan:99', 'mg-chan');
    expect(resolveSlackSafetyMessagingGroupId(s)).toBe('mg-chan');
  });

  it('resolves a task session to the destination it posts to', () => {
    // The regression: this used to return null, so the gate fail-closed and
    // every scheduled fire spawned under the `-noslack` identity.
    const s = makeSession('sess-task', taskThreadId('career-journal-daily-c1fe'));
    addTaskRow('sess-task', 'discord', DM_PLATFORM);
    expect(resolveSlackSafetyMessagingGroupId(s)).toBe('mg-dm');
  });

  // The read funnel defaults to the console fan-out's 1s busy_timeout and no
  // journal recovery. The `withInboundDb` this replaced opened READ-WRITE with
  // busy_timeout 5000, and a read-write open is what rolls a hot journal back.
  // Defaulting here would make the SPAWN GATE stricter than the code it
  // replaced: a contended session, or one whose host write was interrupted,
  // would fail to resolve its route and fall through to the fail-closed null —
  // which is what spawns every scheduled fire under the `-noslack` identity.
  it("threads the replaced open's 5s timeout and journal recovery, not the fan-out defaults", () => {
    const s = makeSession('sess-task-opts', taskThreadId('career-journal-daily-c1fe'));
    addTaskRow('sess-task-opts', 'discord', DM_PLATFORM);
    readOptions.last = undefined;

    resolveSlackSafetyMessagingGroupId(s);

    expect(readOptions.last).toEqual({ busyTimeoutMs: 5000, recoverJournal: true });
  });

  it('resolves a task pointed at a shared channel to that channel, not to null', () => {
    // Still non-owner-safe once the gate judges it — but the gate must get a
    // real subject so the decision is about the destination, not about the
    // absence of one.
    const s = makeSession('sess-task-chan', taskThreadId('smoke-abcd'));
    addTaskRow('sess-task-chan', 'discord', CHANNEL_PLATFORM);
    expect(resolveSlackSafetyMessagingGroupId(s)).toBe('mg-chan');
  });

  it('follows the newest row when the destination was retargeted', () => {
    const s = makeSession('sess-task-moved', taskThreadId('moved-1234'));
    addTaskRow('sess-task-moved', 'discord', CHANNEL_PLATFORM, 2);
    addTaskRow('sess-task-moved', 'discord', DM_PLATFORM, 4);
    expect(resolveSlackSafetyMessagingGroupId(s)).toBe('mg-dm');
  });

  it('fail-closes on the legacy shared task session (many series, no single subject)', () => {
    const s = makeSession('sess-legacy', TASKS_SYSTEM_THREAD_ID);
    addTaskRow('sess-legacy', 'discord', DM_PLATFORM);
    expect(resolveSlackSafetyMessagingGroupId(s)).toBeNull();
  });

  it('fail-closes when the task has no destination recorded', () => {
    const s = makeSession('sess-nodest', taskThreadId('nodest-1'));
    expect(resolveSlackSafetyMessagingGroupId(s)).toBeNull();
  });

  it('fail-closes when the destination resolves to no messaging group', () => {
    const s = makeSession('sess-unknown', taskThreadId('unknown-1'));
    addTaskRow('sess-unknown', 'discord', 'discord:1:vanished');
    expect(resolveSlackSafetyMessagingGroupId(s)).toBeNull();
  });

  it('fail-closes on a non-task session with no messaging group (admin shell)', () => {
    const s = makeSession('sess-admin', null);
    expect(resolveSlackSafetyMessagingGroupId(s)).toBeNull();
  });
});
