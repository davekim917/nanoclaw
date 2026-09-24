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

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { getRawDb } from './db/connection.js';
import { getDeliveredIds } from './modules/mailbox/ops/delivery.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter, withSessionDeliverySlot } from './delivery.js';
import { _clearSecretsForTest, registerSecrets } from './secret-scrubber.js';
import {
  _clearTaskListCooldownsForTest,
  ackInboundReceipt,
  settleTaskListOnKill,
  typingStatusFor,
} from './task-list-host.js';

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

function insertRow(
  sessionId: string,
  id: string,
  kind: string,
  content: object,
  route: { platformId?: string; threadId?: string | null; timestamp?: string } = {},
): void {
  const db = outbound(sessionId);
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, ?, ?, 'slack', ?, ?)`,
  ).run(
    id,
    route.timestamp ?? now(),
    kind,
    route.platformId ?? PLATFORM,
    route.threadId === undefined ? THREAD : route.threadId,
    JSON.stringify(content),
  );
  db.close();
}

/** Host-owned evidence: the host delivered `id` as platform message `platformMessageId`. */
function recordDelivered(sessionId: string, id: string, platformMessageId: string): void {
  const db = new Database(inboundDbPath('ag-1', sessionId));
  db.prepare(
    "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, ?, 'delivered', ?)",
  ).run(id, platformMessageId, now());
  db.close();
}

/** The list's visible post, delivered by the host, plus the runner's record pointing at it. */
function seedDeliveredList(sessionId: string, route: { platformId?: string; threadId?: string | null } = {}): void {
  insertRow(
    sessionId,
    'list-1',
    'task_list',
    { text: 'Migrating\n✱ Run it', taskList: { revision: 1 } },
    {
      ...route,
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    },
  );
  recordDelivered(sessionId, 'list-1', '1786621600.000100');
  writeListState(sessionId);
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
  _clearSecretsForTest();
  _clearTaskListCooldownsForTest();
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

  it('keeps 💭 progress for an agent-shared session, which has no conversation to show a list in', async () => {
    await seed();
    await createMessagingGroupAgent({
      id: 'mga-shared',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      default_model: null,
      default_effort: null,
      default_tone: null,
      instructions_profile: null,
      created_at: now(),
    });
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'agent-shared');
    expect(session.messaging_group_id).toBeNull();
    const calls = captureAdapter();
    insertRow(session.id, 'status-1', 'status', { text: '> 💭 thinking' });
    await deliverSessionMessages(session);
    expect(calls.map((c) => c.kind)).toEqual(['status']);
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
    seedDeliveredList(sessionId);
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

  it('edits where the host delivered the list, not where the container record claims', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    // A forged record naming another channel and message changes nothing.
    writeListState(sessionId, { platformId: 'slack:CVICTIM', platformMessageId: '1111111111.000001' });
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(1);
    expect(calls[0].content.messageId).toBe('1786621600.000100');
    expect(calls[0].threadId).toBe(THREAD);
  });

  it('refuses a list whose delivered post is outside the session’s own conversation', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId, { threadId: 'slack:C0AAA:1700000000.000001' });
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(0);
  });

  it('does nothing without host evidence that the post was delivered', async () => {
    const sessionId = await seed();
    writeListState(sessionId);
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(0);
  });

  it('leaves the list alone when an idle reaper ends a container that already finished working', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'chat-idle-reap');
    await settleTaskListOnKill(sessionId, 'scheduled-task-idle');
    expect(calls).toHaveLength(0);
  });

  it('leaves a finished list alone', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    writeListState(sessionId, { finished: true });
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(0);
  });

  it('never lets the dead container’s queued update revive the list, across a host restart; a later one does', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    insertRow(
      sessionId,
      'late-edit',
      'task_list',
      { operation: 'edit', messageId: '1786621600.000100', text: 'Migrating\n✓ Ran it\n✱ Verify' },
      { timestamp: new Date(Date.now() - 1_000).toISOString() },
    );
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(1);
    // Recorded delivered in inbound.db — durable, so no host restart replays it.
    expect(await delivered(sessionId)).toContain('late-edit');

    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    insertRow(
      sessionId,
      'resumed-edit',
      'task_list',
      { operation: 'edit', messageId: '1786621600.000100', text: 'Migrating\n✓ Ran it\n✓ Verified' },
      { timestamp: new Date(Date.now() + 1_000).toISOString() },
    );
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
    expect(calls[1].content.text).toBe('Migrating\n✓ Ran it\n✓ Verified');
  });

  it('drops an undelivered first post instead of letting it show a list nobody will finish', async () => {
    const sessionId = await seed();
    insertRow(
      sessionId,
      'list-1',
      'task_list',
      { text: 'Migrating\n✱ Run it' },
      {
        timestamp: new Date(Date.now() - 1_000).toISOString(),
      },
    );
    writeListState(sessionId);
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(0);
    expect(await delivered(sessionId)).toContain('list-1');
  });

  it('leaves a list updated after the kill began alone — it belongs to a newer container', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    writeListState(sessionId, { updatedAt: new Date(Date.now() + 60_000).toISOString() });
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(0);
  });

  it('leaves a list a replacement container re-saved unchanged alone — touchedAt, not the on-screen time, fences it', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    // An identical update keeps updatedAt (the time on screen) but stamps touchedAt.
    writeListState(sessionId, {
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      touchedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(0);
  });

  it('retries a rate-limited interrupted edit after the cooldown instead of losing it', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    const sent: string[] = [];
    let limited = true;
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _kind, content) {
        if (limited) {
          limited = false;
          throw new Error('slack rate_limited: Retry-After: 1');
        }
        sent.push((JSON.parse(content) as { text: string }).text);
        return 'plat-1';
      },
    });
    const started = Date.now();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(sent).toEqual(['Migrating\n✓ Ran it\n◌ Verify (interrupted)']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  });

  it('drops a rate-limited interrupted edit once a replacement container takes the list over', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _kind, content) {
        if (sent.length === 0) {
          sent.push('limited');
          // The replacement container re-saves the list while the edit waits.
          writeListState(sessionId, { touchedAt: new Date(Date.now() + 60_000).toISOString() });
          throw new Error('slack rate_limited: Retry-After: 1');
        }
        sent.push((JSON.parse(content) as { text: string }).text);
        return 'plat-1';
      },
    });
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(sent).toEqual(['limited']);
  });

  it('marks the replaced list interrupted while its replacement post is still undelivered', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    insertRow(
      sessionId,
      'list-2',
      'task_list',
      { text: 'Migrating\n✓ Ran it\n✱ Verify' },
      { timestamp: new Date(Date.now() - 1_000).toISOString() },
    );
    writeListState(sessionId, {
      postOutboundId: 'list-2',
      platformMessageId: null,
      supersedes: { outboundId: 'list-1', platformMessageId: '1786621600.000100' },
    });
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(1);
    expect(calls[0].content).toMatchObject({
      operation: 'edit',
      messageId: '1786621600.000100',
      text: 'Migrating\n✓ Ran it\n◌ Verify (interrupted)',
    });
    // The replacement never shows.
    expect(await delivered(sessionId)).toContain('list-2');
  });

  it('scrubs registered secrets from both interrupted fields', async () => {
    const sessionId = await seed();
    registerSecrets({ API_TOKEN: 'sk-live-abcdef123456' });
    seedDeliveredList(sessionId);
    writeListState(sessionId, {
      interruptedText: 'T\n◌ call sk-live-abcdef123456 (interrupted)',
      interruptedSubtext: 'stopped · sk-live-abcdef123456',
    });
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'absolute-ceiling');
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].content)).not.toContain('sk-live-abcdef123456');
  });

  it('never edits unowned: a drain that will not finish leaves the list as is', async () => {
    const sessionId = await seed();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    setDeliveryAdapter({
      async deliver() {
        await held;
        return 'plat-held';
      },
    });
    insertRow(sessionId, 'slow-reply', 'chat', { text: 'hello' });
    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    const drain = deliverSessionMessages(session);
    await vi.waitFor(async () =>
      expect(await withSessionDeliverySlot(sessionId, async () => 'ran', 50)).toBeUndefined(),
    );
    release();
    await drain;
    expect(await withSessionDeliverySlot(sessionId, async () => 'ran', 50)).toBe('ran');
  });

  it('lets an answer through while a list row waits out a rate limit, uncharged, then sends the row', async () => {
    const sessionId = await seed();
    const sent: string[] = [];
    let limited = true;
    setDeliveryAdapter({
      async deliver(_c, _p, _t, kind, content) {
        if (kind === 'task_list' && limited) throw new Error('slack rate_limited: Retry-After: 1');
        sent.push(`${kind}:${(JSON.parse(content) as { text: string }).text}`);
        return `plat-${sent.length}`;
      },
    });
    const base = Date.now();
    insertRow(
      sessionId,
      'list-edit',
      'task_list',
      { operation: 'edit', messageId: 'm-1', text: 'T\n✓ A' },
      {
        timestamp: new Date(base).toISOString(),
      },
    );
    insertRow(sessionId, 'answer', 'chat', { text: 'Done: A.' }, { timestamp: new Date(base + 1).toISOString() });
    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    await deliverSessionMessages(session);
    expect(sent).toEqual(['chat:Done: A.']);
    expect(await delivered(sessionId)).not.toContain('list-edit');

    // Inside the cooldown the row is not retried; after it, it goes out.
    limited = false;
    await deliverSessionMessages(session);
    expect(sent).toEqual(['chat:Done: A.']);
    await new Promise((r) => setTimeout(r, 1_100));
    await deliverSessionMessages(session);
    expect(sent).toEqual(['chat:Done: A.', 'task_list:T\n✓ A']);
  });

  it('holds a newer revision and other sessions’ lists until the platform cooldown ends', async () => {
    const sessionId = await seed();
    const sent: string[] = [];
    let limited = true;
    setDeliveryAdapter({
      async deliver(_c, _p, _t, kind, content) {
        if (kind === 'task_list' && limited) {
          limited = false;
          throw new Error('slack rate_limited: Retry-After: 1');
        }
        sent.push(`${kind}:${(JSON.parse(content) as { text: string }).text}`);
        return `plat-${sent.length}`;
      },
    });
    const base = Date.now();
    insertRow(
      sessionId,
      'rev-1',
      'task_list',
      { operation: 'edit', messageId: 'm-1', text: 'one' },
      { timestamp: new Date(base).toISOString() },
    );
    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    await deliverSessionMessages(session);
    expect(sent).toEqual([]);

    // A newer revision supersedes the cooling row, but inherits its cooldown.
    insertRow(
      sessionId,
      'rev-2',
      'task_list',
      { operation: 'edit', messageId: 'm-1', text: 'two' },
      { timestamp: new Date(base + 1).toISOString() },
    );
    await deliverSessionMessages(session);
    expect(sent).toEqual([]);

    // Another session's list on the same platform waits too.
    const other = await resolveSession('ag-1', 'mg-1', 'slack:C0AAA:1786621514.999999', 'per-thread');
    insertRow(
      other.session.id,
      'other-1',
      'task_list',
      { text: 'other list' },
      { threadId: 'slack:C0AAA:1786621514.999999' },
    );
    await deliverSessionMessages(other.session);
    expect(sent).toEqual([]);

    await new Promise((r) => setTimeout(r, 1_100));
    await deliverSessionMessages(session);
    await deliverSessionMessages(other.session);
    expect(sent).toEqual(['task_list:two', 'task_list:other list']);
  });

  it('retires a rate-limited first post that its answer overtook, instead of posting it below the answer', async () => {
    const sessionId = await seed();
    const sent: string[] = [];
    let limited = true;
    setDeliveryAdapter({
      async deliver(_c, _p, _t, kind, content) {
        if (kind === 'task_list' && limited) throw new Error('slack rate_limited: Retry-After: 1');
        sent.push(`${kind}:${(JSON.parse(content) as { text: string }).text}`);
        return `plat-${sent.length}`;
      },
    });
    const base = Date.now();
    insertRow(sessionId, 'first-post', 'task_list', { text: 'T\n✱ A' }, { timestamp: new Date(base).toISOString() });
    insertRow(sessionId, 'answer', 'chat', { text: 'Done: A.' }, { timestamp: new Date(base + 1).toISOString() });
    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    await deliverSessionMessages(session);
    expect(sent).toEqual(['chat:Done: A.']);
    // Recorded delivered with no platform id: the runner reads it as a failed post.
    expect(await delivered(sessionId)).toContain('first-post');
    limited = false;
    await new Promise((r) => setTimeout(r, 1_100));
    await deliverSessionMessages(session);
    expect(sent).toEqual(['chat:Done: A.']);
  });

  it('never makes the list the root the answer threads under (channel-level session)', async () => {
    await seed();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(session.thread_id).toBeNull();
    const calls = captureAdapter();
    const base = Date.now();
    const db = outbound(session.id);
    const add = db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
       VALUES (?, ?, ?, ?, 'slack', NULL, 'in-1', ?)`,
    );
    add.run('list-1', new Date(base).toISOString(), 'task_list', PLATFORM, JSON.stringify({ text: 'T\n✱ A' }));
    add.run('answer', new Date(base + 1).toISOString(), 'chat', PLATFORM, JSON.stringify({ text: 'Here it is' }));
    add.run('follow-up', new Date(base + 2).toISOString(), 'chat', PLATFORM, JSON.stringify({ text: 'One more' }));
    db.close();
    await deliverSessionMessages(session);
    // The answer is the turn's root; the follow-up threads under the ANSWER, not the list.
    expect(calls.map((c) => [c.kind, c.threadId])).toEqual([
      ['task_list', null],
      ['chat', null],
      ['chat', `${PLATFORM}:plat-2`],
    ]);
  });

  it('retires a first post that failed for any reason once its answer overtakes it', async () => {
    const sessionId = await seed();
    const sent: string[] = [];
    let fail = true;
    setDeliveryAdapter({
      async deliver(_c, _p, _t, kind, content) {
        if (kind === 'task_list' && fail) {
          fail = false;
          throw new Error('slack internal_error');
        }
        sent.push(`${kind}:${(JSON.parse(content) as { text: string }).text}`);
        return `plat-${sent.length}`;
      },
    });
    const base = Date.now();
    insertRow(sessionId, 'first-post', 'task_list', { text: 'T\n✱ A' }, { timestamp: new Date(base).toISOString() });
    insertRow(sessionId, 'answer', 'chat', { text: 'Done: A.' }, { timestamp: new Date(base + 1).toISOString() });
    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(sent).toEqual(['chat:Done: A.']);
  });

  it('marks interrupted a list a channel-level session posted in the thread it answered', async () => {
    await seed();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    seedDeliveredList(session.id);
    const calls = captureAdapter();
    await settleTaskListOnKill(session.id, 'absolute-ceiling');
    expect(calls).toHaveLength(1);
    expect(calls[0].threadId).toBe(THREAD);
  });

  it('sends only the newest of several queued edits to one list', async () => {
    const sessionId = await seed();
    const calls = captureAdapter();
    const base = Date.now();
    for (const [i, text] of ['one', 'two', 'three'].entries()) {
      insertRow(
        sessionId,
        `edit-${i}`,
        'task_list',
        { operation: 'edit', messageId: '1786621600.000100', text },
        { timestamp: new Date(base + i).toISOString() },
      );
    }
    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    await deliverSessionMessages(session);
    expect(calls.map((c) => c.content.text)).toEqual(['three']);
    const done = await delivered(sessionId);
    expect(['edit-0', 'edit-1', 'edit-2'].every((id) => done.has(id))).toBe(true);
  });

  it('shows the scrubbed item in the status line, never a registered secret', async () => {
    const sessionId = await seed();
    registerSecrets({ API_TOKEN: 'sk-live-abcdef123456' });
    captureAdapter();
    insertRow(sessionId, 'list-secret', 'task_list', {
      text: 'T\n✱ Call the API with sk-live-abcdef123456',
      taskList: { generation: 1, revision: 1, activeText: 'Call the API with sk-live-abcdef123456' },
    });
    const { session } = await resolveSession('ag-1', 'mg-1', THREAD, 'per-thread');
    await deliverSessionMessages(session);
    expect(typingStatusFor(sessionId)).not.toContain('sk-live-abcdef123456');
    expect(typingStatusFor(sessionId)).toMatch(/^is working: Call the API with /);
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
