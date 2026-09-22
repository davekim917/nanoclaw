/**
 * `continue_thread`: the first post under a thread_key adopting an existing
 * thread (src/continue-thread.ts, wired in `deliverMessage`, src/delivery.ts).
 * Delivery cases run the real `deliverSessionMessages` against a recording
 * adapter, with the same fixtures as the keyed-anchor suite in delivery.test.ts.
 */
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-continue-thread') }));

import { closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDb, initDb } from './db/connection.js';
import { resolveSession, resolveTaskSession } from './session-manager.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { archiveHasThread, archiveMessage } from './message-archive.js';
import { continueThreadCandidate } from './continue-thread.js';
import { log } from './log.js';

function now(): string {
  return new Date().toISOString();
}

async function seed(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  for (const [id, platformId] of [
    ['mg-1', 'telegram:123'],
    ['mg-2', 'telegram:999'],
  ]) {
    await createMessagingGroup({
      id,
      channel_type: 'telegram',
      platform_id: platformId,
      name: id,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await getDb().run(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-1', ?, 'channel', ?, ?)`,
      id,
      id,
      now(),
    );
  }
}

async function taskSession(series = 'series-1') {
  return (await resolveTaskSession('ag-1', series)).session;
}

/** A thread the host has seen on a messaging group, the way it normally learns one: a session bound to it. */
async function threadSession(messagingGroupId: string, threadId: string): Promise<void> {
  await resolveSession('ag-1', messagingGroupId, threadId, 'per-thread');
}

function insertChat(sessionId: string, msgId: string, content: Record<string, unknown>, ts = now()): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
     VALUES (?, ?, 'chat', 'telegram:123', 'telegram', NULL, ?, ?)`,
  ).run(msgId, ts, `fire-${msgId}`, JSON.stringify(content));
  db.close();
}

function archiveRow(channelType: string, platformId: string, threadId: string): void {
  archiveMessage({
    id: `arch-${channelType}-${threadId}`,
    agentGroupId: 'ag-1',
    messagingGroupId: null,
    channelType,
    channelName: null,
    platformId,
    threadId,
    role: 'user',
    senderId: null,
    senderName: 'operator',
    text: 'the work in flight',
    sentAt: now(),
  });
}

function keyRows(): Promise<Array<{ thread_key: string; thread_platform_id: string }>> {
  return getDb().all('SELECT thread_key, thread_platform_id FROM thread_key_anchors ORDER BY thread_key');
}

function recordingAdapter(opts: { failThreaded?: boolean } = {}): Array<{ threadId: string | null }> {
  const calls: Array<{ threadId: string | null }> = [];
  setDeliveryAdapter({
    async deliver(_ct, _pid, threadId) {
      calls.push({ threadId });
      if (opts.failThreaded && threadId !== null) throw new Error('Unknown Channel');
      return `plat-${calls.length}`;
    },
  });
  return calls;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // Migrated through a throwaway handle so this file never names the raw
  // central handle (src/db/raw-db-ratchet.test.ts), as in
  // src/stop-intent-recovery.test.ts:299-305.
  const dbPath = path.join(TEST_DIR, `central-${crypto.randomUUID()}.db`);
  const migrated = new Database(dbPath);
  runMigrations(migrated);
  migrated.close();
  await initDb(dbPath, { role: 'test' });
  await seed();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('continueThreadCandidate — shape only', () => {
  const discord = 'discord:111:222';

  it('accepts the encoded id search_threads prints, and a bare id, for this destination', () => {
    expect(continueThreadCandidate('discord:111:222:333', discord)).toEqual({
      threadId: 'discord:111:222:333',
      threadPlatformId: '333',
    });
    expect(continueThreadCandidate(' 333 ', discord)?.threadId).toBe('discord:111:222:333');
  });

  it('reads a Discord link: a thread is its own channel; a parent-channel message link names its thread', () => {
    expect(continueThreadCandidate('https://discord.com/channels/111/333', discord)?.threadId).toBe(
      'discord:111:222:333',
    );
    expect(continueThreadCandidate('https://discord.com/channels/111/333/444', discord)?.threadId).toBe(
      'discord:111:222:333',
    );
    expect(continueThreadCandidate('https://discord.com/channels/111/222/555', discord)?.threadId).toBe(
      'discord:111:222:555',
    );
    expect(continueThreadCandidate('https://discord.com/channels/111/222', discord)).toBeNull();
  });

  it('reads a Slack permalink, preferring thread_ts', () => {
    expect(continueThreadCandidate('https://acme.slack.com/archives/C1/p1712345678123456', 'slack:C1')).toEqual({
      threadId: 'slack:C1:1712345678.123456',
      threadPlatformId: '1712345678.123456',
    });
    expect(
      continueThreadCandidate(
        'https://acme.slack.com/archives/C1/p1712345999000001?thread_ts=1712345678.123456&cid=C1',
        'slack:C1',
      )?.threadId,
    ).toBe('slack:C1:1712345678.123456');
  });

  it('refuses anything addressed to another destination or malformed', () => {
    expect(continueThreadCandidate('discord:111:999:333', discord)).toBeNull();
    expect(continueThreadCandidate('https://discord.com/channels/999/333', discord)).toBeNull();
    expect(continueThreadCandidate('https://acme.slack.com/archives/C2/p1712345678123456', 'slack:C1')).toBeNull();
    expect(continueThreadCandidate('has space', discord)).toBeNull();
    expect(continueThreadCandidate('', discord)).toBeNull();
    expect(continueThreadCandidate(42, discord)).toBeNull();
    expect(continueThreadCandidate('9'.repeat(600), discord)).toBeNull();
  });
});

describe('delivery — continueThread adopts an existing thread for a new key', () => {
  it('adopts a same-channel thread the host has a session for, and records it as the key anchor', async () => {
    await threadSession('mg-1', 'telegram:123:thr-live');
    const session = await taskSession();
    insertChat(session.id, 'out-1', { text: 'topic', threadKey: 'topic-a', continueThread: 'thr-live' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:thr-live' }]);
    expect(await keyRows()).toEqual([{ thread_key: 'topic-a', thread_platform_id: 'thr-live' }]);
  });

  it('adopts a thread known only from the archive (the agent never engaged there)', async () => {
    archiveMessage({
      id: 'arch-1',
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      channelType: 'telegram',
      channelName: null,
      platformId: 'telegram:123',
      threadId: 'telegram:123:thr-archived',
      role: 'user',
      senderId: null,
      senderName: 'operator',
      text: 'the work in flight',
      sentAt: now(),
    });
    const session = await taskSession();
    insertChat(session.id, 'out-1', {
      text: 'topic',
      threadKey: 'topic-a',
      continueThread: 'telegram:123:thr-archived',
    });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:thr-archived' }]);
    expect(await keyRows()).toEqual([{ thread_key: 'topic-a', thread_platform_id: 'thr-archived' }]);
  });

  it('adopts a thread archived only by a sibling bot on the same conversation (pooled channel family)', async () => {
    archiveRow('telegram-codex', 'telegram:123', 'telegram:123:thr-sibling');
    const session = await taskSession();
    insertChat(session.id, 'out-1', { text: 'topic', threadKey: 'topic-a', continueThread: 'thr-sibling' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:thr-sibling' }]);
  });

  it('archiveHasThread keeps exact channel_type matching for an unprefixed native id', () => {
    archiveRow('native-cloud', '5550001', '5550001:thr-x');
    expect(archiveHasThread('native-cloud', '5550001', '5550001:thr-x')).toBe(true);
    expect(archiveHasThread('native', '5550001', '5550001:thr-x')).toBe(false);
  });

  it('a second post under the key threads into the adopted thread', async () => {
    await threadSession('mg-1', 'telegram:123:thr-live');
    const session = await taskSession();
    insertChat(session.id, 'out-1', { text: 'opening', threadKey: 'topic-a', continueThread: 'thr-live' });
    const calls = recordingAdapter();
    await deliverSessionMessages(session);

    insertChat(session.id, 'out-2', { text: 'result', threadKey: 'topic-a' });
    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:thr-live' }, { threadId: 'telegram:123:thr-live' }]);
    expect(await keyRows()).toEqual([{ thread_key: 'topic-a', thread_platform_id: 'thr-live' }]);
  });

  it('rejects a thread from another messaging group: new root thread, a warn log', async () => {
    // Real thread, wrong destination: seen on mg-2 (telegram:999), posted to mg-1.
    await threadSession('mg-2', 'telegram:999:thr-other');
    const session = await taskSession();
    insertChat(session.id, 'out-1', { text: 'a', threadKey: 'topic-a', continueThread: 'thr-other' });
    insertChat(session.id, 'out-2', { text: 'b', threadKey: 'topic-b', continueThread: 'telegram:999:thr-other' });
    const calls = recordingAdapter();
    const warn = vi.spyOn(log, 'warn');

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }, { threadId: null }]);
    expect(await keyRows()).toEqual([
      { thread_key: 'topic-a', thread_platform_id: 'plat-1' },
      { thread_key: 'topic-b', thread_platform_id: 'plat-2' },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'continueThread is not a known thread on this destination — opening a new keyed thread',
      expect.objectContaining({ id: 'out-1', threadKey: 'topic-a', continueThread: 'thr-other' }),
    );
  });

  it('rejects a thread id the host has never seen anywhere', async () => {
    const session = await taskSession();
    insertChat(session.id, 'out-1', { text: 'a', threadKey: 'topic-a', continueThread: 'thr-made-up' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect(await keyRows()).toEqual([{ thread_key: 'topic-a', thread_platform_id: 'plat-1' }]);
  });

  it('an existing live anchor wins over the argument', async () => {
    await threadSession('mg-1', 'telegram:123:thr-live');
    await getDb().run(
      `INSERT INTO thread_key_anchors
         (agent_group_id, messaging_group_id, thread_key, thread_platform_id, created_at, last_used_at)
       VALUES ('ag-1', 'mg-1', 'topic-a', 'plat-root', ?, ?)`,
      now(),
      now(),
    );
    const session = await taskSession();
    insertChat(session.id, 'out-1', { text: 'x', threadKey: 'topic-a', continueThread: 'thr-live' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:plat-root' }]);
    expect(await keyRows()).toEqual([{ thread_key: 'topic-a', thread_platform_id: 'plat-root' }]);
  });

  it('a failed post into the adopted thread falls back to root and records the root', async () => {
    await threadSession('mg-1', 'telegram:123:thr-archived-on-platform');
    const session = await taskSession();
    insertChat(session.id, 'out-1', {
      text: 'x',
      threadKey: 'topic-a',
      continueThread: 'thr-archived-on-platform',
    });
    const calls = recordingAdapter({ failThreaded: true });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:thr-archived-on-platform' }, { threadId: null }]);
    expect(await keyRows()).toEqual([{ thread_key: 'topic-a', thread_platform_id: 'plat-2' }]);
  });

  it('is ignored without a thread key', async () => {
    await threadSession('mg-1', 'telegram:123:thr-live');
    const session = await taskSession();
    insertChat(session.id, 'out-1', { text: 'x', continueThread: 'thr-live' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect(await keyRows()).toEqual([]);
  });
});
