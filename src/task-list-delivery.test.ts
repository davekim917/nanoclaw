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
  initMigratedTestDb,
} from './db/index.js';
import { resolveGroupTimezone } from './container-config.js';
import { withCentralSync, withRawDb } from './db/central-lease.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { archiveSessionById, createPendingApproval, createPendingQuestion, updateSession } from './db/sessions.js';
import { log } from './log.js';
import { getDeliveredIds } from './modules/mailbox/ops/delivery.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import { formatLocalTime } from './timezone.js';
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
  await initMigratedTestDb();
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

  it('marks an unfinished list stopped when an idle reaper ends its container, too', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'chat-idle-reap');
    expect(calls).toHaveLength(1);
    expect(calls[0].content.subtext).toContain('stopped');
  });

  it('still settles a list record too large or too long for the kill follow-up to read as evidence', async () => {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    writeListState(sessionId, {
      padding: 'x'.repeat(200 * 1024),
      history: Array.from({ length: 100 }, (_unused, index) => index),
    });
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'chat-idle-reap');
    expect(calls).toHaveLength(1);
    expect(calls[0].content.subtext).toContain('stopped');
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

describe('the kill label says only what the host knows for certain', () => {
  /** What the runner wrote after its own leading state. */
  const DETAIL = 'todos as of <!date^1^{time} ({ago})|3:00 PM>';
  const RUNNER_LABEL = `stopped · ${DETAIL}`;
  const HOUR = 60 * 60_000;
  const LISTED_AT = '2026-03-04T05:06:07.000Z';

  /** A list last changed on screen at LISTED_AT and saved just now, as every runner save stamps it. */
  function current(): Record<string, unknown> {
    return { updatedAt: LISTED_AT, touchedAt: now() };
  }

  /** The tail of a label the host composed: its own literal and its own rendering of the record's instant. */
  async function asOf(timezone?: string): Promise<string> {
    return `todos as of ${formatLocalTime(LISTED_AT, timezone ?? (await resolveGroupTimezone('ag-1')))}`;
  }

  function insertInbound(
    sessionId: string,
    row: { id: string; processAfter?: string; trigger?: number; content?: string },
  ): void {
    const db = new Database(inboundDbPath('ag-1', sessionId));
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, process_after, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat', ?, 'pending', ?, ?, ?)`,
    ).run(
      row.id,
      now(),
      row.trigger ?? 1,
      row.processAfter ?? null,
      row.content ?? JSON.stringify({ text: 'check the deploy' }),
    );
    db.close();
  }

  const WAIT_CONTENT = JSON.stringify({ text: 'check the deploy', _system: { kind: 'agent_scheduled_wake' } });

  /** The row the `wait` action writes: its id prefix and system kind, inert until admission. */
  function armWait(sessionId: string, name: string, processAfter: string): void {
    insertInbound(sessionId, { id: `schedule-wake-${name}`, processAfter, trigger: 0, content: WAIT_CONTENT });
  }

  const inHours = (hours: number): string => new Date(Date.now() + hours * HOUR).toISOString();

  async function label(sessionId: string): Promise<unknown> {
    const calls = captureAdapter();
    await settleTaskListOnKill(sessionId, 'chat-idle-reap');
    expect(calls).toHaveLength(1);
    return calls[0].content.subtext;
  }

  function setOutboundState(sessionId: string, key: string, value: unknown): void {
    const db = outbound(sessionId);
    db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      key,
      JSON.stringify(value),
      now(),
    );
    db.close();
  }

  async function listed(overrides: Record<string, unknown> = current()): Promise<string> {
    const sessionId = await seed();
    seedDeliveredList(sessionId);
    writeListState(sessionId, overrides);
    return sessionId;
  }

  it('keeps the runner’s label when nothing is queued', async () => {
    const sessionId = await listed();
    expect(await label(sessionId)).toBe(RUNNER_LABEL);
  });

  it.each([
    ['a message that is due', (sessionId: string) => insertInbound(sessionId, { id: 'human-1' })],
    [
      'a saved continuation',
      (sessionId: string) =>
        setOutboundState(sessionId, 'work_continuation', {
          id: 'cont-1',
          task: 'finish the rehearsal',
          phase: 'queued',
          chain: 1,
          resume_attempts: 0,
        }),
    ],
    [
      'a batch the container had claimed',
      (sessionId: string) => {
        insertInbound(sessionId, { id: 'human-1' });
        const db = outbound(sessionId);
        db.prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)").run(
          'human-1',
          now(),
        );
        db.close();
      },
    ],
    [
      'a recovery wake already queued',
      (sessionId: string) => {
        insertInbound(sessionId, { id: 'reap-respawn-1790000000000', trigger: 0 });
        insertInbound(sessionId, { id: 'recall-reap-respawn-1790000000000', trigger: 0 });
      },
    ],
  ])('never claims the session is resuming: %s leaves the runner’s label', async (_l, arrange) => {
    const sessionId = await listed();
    arrange(sessionId);
    expect(await label(sessionId)).toBe(RUNNER_LABEL);
  });

  it('paused with the next check, in the group’s timezone, when the agent armed a wait', async () => {
    const sessionId = await listed();
    const nextCheck = inHours(3);
    armWait(sessionId, 'a', nextCheck);
    await ensureContainerConfig('ag-1');
    await updateContainerConfigScalars('ag-1', { timezone: 'Asia/Tokyo' });

    expect(await label(sessionId)).toBe(
      `paused · next check ${formatLocalTime(nextCheck, 'Asia/Tokyo')} · ${await asOf('Asia/Tokyo')}`,
    );
    expect(formatLocalTime(nextCheck, 'Asia/Tokyo')).not.toBe(formatLocalTime(nextCheck, 'America/Anchorage'));
  });

  it('names the earliest of several waits', async () => {
    const sessionId = await listed();
    const sooner = inHours(2);
    armWait(sessionId, 'later', inHours(5));
    armWait(sessionId, 'sooner', sooner);
    armWait(sessionId, 'latest', inHours(9));
    expect(await label(sessionId)).toBe(
      `paused · next check ${formatLocalTime(sooner, await resolveGroupTimezone('ag-1'))} · ${await asOf()}`,
    );
  });

  it.each([
    ['a context row', 'context-1', undefined],
    ['a recovery wake', 'ceiling-respawn-tool-fictional', undefined],
    ['a row that only resembles a wait', 'reschedule-wake-1', WAIT_CONTENT],
    ['a row with the wait prefix that the wait action did not write', 'schedule-wake-forwarded', undefined],
    ['a row with the wait prefix whose content is not JSON', 'schedule-wake-garbled', '{not json'],
  ])('a future row that is not a wait (%s) is not a check the agent promised', async (_l, id, content) => {
    const sessionId = await listed();
    insertInbound(sessionId, { id, processAfter: inHours(3), trigger: 0, content });
    expect(await label(sessionId)).toBe(RUNNER_LABEL);
  });

  it('a wait that has already come due is no longer a next check', async () => {
    const sessionId = await listed();
    armWait(sessionId, 'a', new Date(Date.now() - 60_000).toISOString());
    expect(await label(sessionId)).toBe(RUNNER_LABEL);
  });

  it('a wait that already ran is not a next check', async () => {
    const sessionId = await listed();
    armWait(sessionId, 'a', inHours(3));
    const db = new Database(inboundDbPath('ag-1', sessionId));
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'schedule-wake-a'").run();
    db.close();
    expect(await label(sessionId)).toBe(RUNNER_LABEL);
  });

  it('an unanswered card is not something the host labels: answering it wakes nothing', async () => {
    const sessionId = await listed();
    const postedAt = new Date(Date.now() - HOUR).toISOString();
    await createPendingApproval({
      approval_id: 'appr-1',
      session_id: sessionId,
      request_id: 'req-1',
      action: 'request_choice',
      payload: '{}',
      created_at: postedAt,
      title: 'Ship it?',
      options_json: '[]',
    });
    await createPendingQuestion({
      question_id: 'q-1',
      session_id: sessionId,
      message_out_id: 'out-1',
      platform_id: PLATFORM,
      channel_type: 'slack',
      thread_id: THREAD,
      title: 'Which region?',
      question: 'Which region should the rehearsal use?',
      options: [],
      created_at: postedAt,
    });
    expect(await label(sessionId)).toBe(RUNNER_LABEL);
  });

  describe('a session that takes no wake keeps the runner’s label', () => {
    const ENDED = [
      ['archived', (sessionId: string) => archiveSessionById(sessionId)],
      ['closed', (sessionId: string) => updateSession(sessionId, { status: 'closed' })],
    ] as const;

    it.each(ENDED)('%s, holding a wait', async (_state, end) => {
      const sessionId = await listed();
      armWait(sessionId, 'a', inHours(1));
      await end(sessionId);
      expect(await label(sessionId)).toBe(RUNNER_LABEL);
    });
  });

  it('keeps the runner’s own label when every open item waits on someone', async () => {
    const sessionId = await listed({
      ...current(),
      items: [{ text: 'Merge the fix', status: 'waiting', waitingOn: 'Dana' }],
      interruptedSubtext: `waiting on Dana · ${DETAIL}`,
    });
    expect(await label(sessionId)).toBe(`waiting on Dana · ${DETAIL}`);
  });

  it('a record from an older runner gets the host’s label too: nothing in it comes from the record but an instant', async () => {
    const sessionId = await listed({ updatedAt: LISTED_AT });
    const nextCheck = inHours(3);
    armWait(sessionId, 'a', nextCheck);
    expect(await label(sessionId)).toBe(
      `paused · next check ${formatLocalTime(nextCheck, await resolveGroupTimezone('ag-1'))} · ${await asOf()}`,
    );
  });

  it.each([
    ['a forged second line', 'todos as of now\n# forged state @everyone'],
    ['an oversized footer', `todos as of ${'x'.repeat(20_000)}`],
  ])('a host-composed label carries none of the container’s label text: %s', async (_l, hostile) => {
    const sessionId = await listed({
      ...current(),
      subtext: hostile,
      interruptedSubtext: `stopped · ${hostile}`,
      interruptedDetail: hostile,
    });
    const nextCheck = inHours(3);
    armWait(sessionId, 'a', nextCheck);
    expect(await label(sessionId)).toBe(
      `paused · next check ${formatLocalTime(nextCheck, await resolveGroupTimezone('ag-1'))} · ${await asOf()}`,
    );
  });

  it.each([['not a time'], [42], [undefined]])(
    'keeps the runner’s label when the record’s on-screen stamp is %j, not an instant',
    async (updatedAt) => {
      const sessionId = await listed({ updatedAt, touchedAt: now() });
      armWait(sessionId, 'a', inHours(3));
      expect(await label(sessionId)).toBe(RUNNER_LABEL);
    },
  );

  it('still sends the interrupted edit, under the runner’s label, when the label cannot be composed', async () => {
    const sessionId = await listed();
    armWait(sessionId, 'a', inHours(3));
    await withCentralSync(() =>
      withRawDb((db) => db.exec('ALTER TABLE container_configs RENAME TO container_configs_gone')),
    );
    await expect(resolveGroupTimezone('ag-1')).rejects.toThrow('container_configs');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    expect(await label(sessionId)).toBe(RUNNER_LABEL);
    expect(warn).toHaveBeenCalledWith(
      'Task list kill label unavailable — keeping the runner’s own',
      expect.objectContaining({ sessionId }),
    );
  });

  it('still marks the list interrupted, under the runner’s label, when the session’s rows cannot be read', async () => {
    const sessionId = await listed();
    armWait(sessionId, 'a', inHours(3));
    const db = new Database(inboundDbPath('ag-1', sessionId));
    db.exec('ALTER TABLE messages_in RENAME COLUMN process_after TO process_after_gone');
    db.close();

    expect(await label(sessionId)).toBe(RUNNER_LABEL);
  });

  it('scrubs a registered secret from a label the runner wrote', async () => {
    registerSecrets({ API_TOKEN: 'sk-live-abcdef123456' });
    const sessionId = await listed({ ...current(), interruptedSubtext: 'stopped · todos as of sk-live-abcdef123456' });
    const subtext = await label(sessionId);
    expect(subtext).toMatch(/^stopped · todos as of /);
    expect(subtext).not.toContain('sk-live-abcdef123456');
  });
});
