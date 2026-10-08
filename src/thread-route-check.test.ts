/**
 * The routing check for route-checked (`lb-`) keys: delivery cases run the real `deliverSessionMessages` against a
 * recording adapter, with Jev stubbed at the client (`askJev`), so no case makes a network call.
 */
import fs from 'fs';
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

vi.mock('./typesafe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./typesafe.js')>()),
  askJev: vi.fn(),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-thread-route-check') }));

import { closeDb, createAgentGroup, createMessagingGroup, initMigratedTestDb } from './db/index.js';
import { getDb } from './db/connection.js';
import { THREAD_KEY_PATTERN } from './db/thread-key-anchors.js';
import { deliverSessionMessages, runSweepDeliveryCycle, setDeliveryAdapter } from './delivery.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { archiveMessage, type ArchivedThreadMessage } from './message-archive.js';
import { openInboundDb } from './modules/mailbox/openers.js';
import { resolveTaskSession } from './session-manager.js';
import {
  checkThreadRoute,
  ROUTE_CHECK_DEADLINE_MS,
  ROUTE_CHECK_TOTAL_TIMEOUT_MS,
  threadView,
  type RouteCheckRequest,
} from './thread-route-check.js';
import { isRouteCheckedKey, splitThreadKey } from './thread-route-split.js';
import { ROUTE_CHECK_DELIVER_BY_MS } from './thread-route-verdict.js';
import { askJev, JEV_MODEL, type JevAnswer } from './typesafe.js';
import Database from 'better-sqlite3';

/** Sanitized from the live misroute; `request`/`response` are a live jev-1.13.0 exchange recorded off CI. */
const replay = JSON.parse(fs.readFileSync('src/test-fixtures/thread-route-replay-oct08.json', 'utf8')) as {
  postText: string;
  channelType: string;
  platformId: string;
  threadPlatformId: string;
  checkedAt: string;
  messages: ArchivedThreadMessage[];
  request: unknown;
  response: { answers: Record<string, JevAnswer> };
};

const PID = 'discord:111:222';
const jev = vi.mocked(askJev);

function now(): string {
  return new Date().toISOString();
}

function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  await createAgentGroup({ id: 'ag-1', name: 'Watcher', folder: 'watcher', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: PID,
    name: 'watch',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await getDb().run(
    `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
     VALUES ('ag-1', 'watch', 'channel', 'mg-1', ?)`,
    now(),
  );
  jev.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

async function fireSession() {
  return (await resolveTaskSession('ag-1', 'watch-series')).session;
}

/** The opener is the thread's starter message (thread id = its id), as a sibling bot archives it; replies follow. */
function archiveThread(threadId: string, replies: number, lastAt = now()): void {
  const last = Date.parse(lastAt);
  archiveMessage({
    id: `${threadId}:sibling`,
    agentGroupId: 'ag-2',
    messagingGroupId: null,
    channelType: 'discord',
    channelName: null,
    platformId: PID,
    threadId: null,
    role: 'user',
    senderId: null,
    senderName: 'Dave',
    text: `Plan the monthly bonus calculation automation (${threadId})`,
    sentAt: new Date(last - (replies + 1) * 60_000).toISOString(),
  });
  for (let i = 0; i < replies; i++) {
    archiveMessage({
      id: `${threadId}-reply-${i}:sibling`,
      agentGroupId: 'ag-2',
      messagingGroupId: null,
      channelType: 'discord',
      channelName: null,
      platformId: PID,
      threadId: `${PID}:${threadId}`,
      role: 'user',
      senderId: null,
      senderName: 'Axie',
      text: `bonus plan step ${i}`,
      sentAt: new Date(last - (replies - 1 - i) * 60_000).toISOString(),
    });
  }
}

function insertPost(sessionId: string, msgId: string, content: Record<string, unknown>, ts = now()): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
     VALUES (?, ?, 'chat', ?, 'discord', NULL, ?, ?)`,
  ).run(msgId, ts, PID, `fire-${msgId}`, JSON.stringify(content));
  db.close();
}

function handoff(text: string, threadKey?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { text, ...(threadKey ? { threadKey } : {}), reporting: { version: 1, purpose: 'handoff' }, ...extra };
}

async function seedAnchor(threadKey: string, threadPlatformId: string): Promise<void> {
  await getDb().run(
    `INSERT INTO thread_key_anchors
       (agent_group_id, messaging_group_id, thread_key, thread_platform_id, created_at, last_used_at)
     VALUES ('ag-1', 'mg-1', ?, ?, ?, ?)`,
    threadKey,
    threadPlatformId,
    now(),
    now(),
  );
}

function keyRows(): Promise<Array<{ thread_key: string; thread_platform_id: string }>> {
  return getDb().all('SELECT thread_key, thread_platform_id FROM thread_key_anchors ORDER BY thread_key');
}

function checkRows(): Promise<Array<Record<string, unknown>>> {
  return getDb().all(
    `SELECT message_out_id, thread_key, check_point, candidate_thread_id, score, threshold, decision, model, error,
            split_thread_key
       FROM thread_route_checks ORDER BY id`,
  );
}

function noticeOf(sessionId: string, msgId: string): string | null {
  const db = openInboundDb(inboundDbPath('ag-1', sessionId));
  try {
    return (
      (db.prepare('SELECT notice FROM delivered WHERE message_out_id = ?').get(msgId) as { notice: string | null })
        ?.notice ?? null
    );
  } finally {
    db.close();
  }
}

/** Discord-shaped root ids, so a veto notice can carry a thread link. */
function recordingAdapter(): Array<{ threadId: string | null }> {
  const calls: Array<{ threadId: string | null }> = [];
  setDeliveryAdapter({
    async deliver(_ct, _pid, threadId) {
      calls.push({ threadId });
      return `90000000000000000${calls.length}`;
    },
  });
  return calls;
}

function scores(noul: number): void {
  jev.mockResolvedValue({ same_request: { type: 'noul', noul } });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delivery cycles, as the poll loops run them, until the row's background check has settled and the row is sent. */
async function deliverUntilSettled(session: Awaited<ReturnType<typeof fireSession>>): Promise<void> {
  for (let cycle = 0; cycle < 400; cycle++) {
    if ((await deliverSessionMessages(session)) === 'clean') return;
    await sleep(10);
  }
  throw new Error('row still undelivered after 400 cycles');
}

describe('routing check — scope', () => {
  it.each([
    ['throws', () => jev.mockRejectedValue(new Error('TypeSafe HTTP 503'))],
    ['hangs', () => jev.mockReturnValue(new Promise<Record<string, JevAnswer>>(() => {}))],
  ])('other keys and unkeyed posts route as before and never reach Jev (Jev %s)', async (_label, stub) => {
    stub();
    archiveThread('thr-live', 2);
    await seedAnchor('topic-b', 'thr-b');
    const session = await fireSession();
    insertPost(session.id, 'out-1', handoff('new ask', 'topic-a', { continueThread: 'thr-live' }));
    insertPost(session.id, 'out-2', handoff('follow-up', 'topic-b'));
    insertPost(session.id, 'out-3', handoff('unkeyed ask'));
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: `${PID}:thr-live` }, { threadId: `${PID}:thr-b` }, { threadId: null }]);
    expect(jev).not.toHaveBeenCalled();
    expect(await checkRows()).toEqual([]);
    expect(await keyRows()).toEqual([
      { thread_key: 'topic-a', thread_platform_id: 'thr-live' },
      { thread_key: 'topic-b', thread_platform_id: 'thr-b' },
    ]);
    for (const id of ['out-1', 'out-2', 'out-3']) expect(noticeOf(session.id, id)).toBeNull();
  });
});

describe('routing check — check points a and c (continue_thread adoption)', () => {
  it('an adopted thread scoring below the threshold is not adopted: the key opens a new thread, stored and noticed', async () => {
    archiveThread('thr-commissions', 3);
    scores(0.11);
    const session = await fireSession();
    insertPost(session.id, 'out-1', handoff('Bonus error ask', 'lb-dm-1', { continueThread: 'thr-commissions' }));
    const calls = recordingAdapter();

    await deliverUntilSettled(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect(await keyRows()).toEqual([{ thread_key: 'lb-dm-1', thread_platform_id: '900000000000000001' }]);
    expect(await checkRows()).toEqual([
      {
        message_out_id: 'out-1',
        thread_key: 'lb-dm-1',
        check_point: 'a',
        candidate_thread_id: 'thr-commissions',
        score: 0.11,
        threshold: 0.35,
        decision: 'veto',
        model: JEV_MODEL,
        error: null,
        split_thread_key: null,
      },
    ]);
    expect(noticeOf(session.id, 'out-1')).toBe(
      'ROUTING CHECK VETO: continue_thread thr-commissions is not working on this request (routing check score 0.11 ' +
        'is below 0.35). This post opened a NEW thread: https://discord.com/channels/111/900000000000000001. Keep ' +
        'using thread_key "lb-dm-1" for this request; it now points at the new thread.',
    );
  });

  it('an adopted thread scoring exactly the threshold is adopted as before', async () => {
    archiveThread('thr-live', 3);
    scores(0.35);
    const session = await fireSession();
    insertPost(session.id, 'out-1', handoff('Same pilot, names attached', 'lb-dm-2', { continueThread: 'thr-live' }));
    const calls = recordingAdapter();

    await deliverUntilSettled(session);

    expect(calls).toEqual([{ threadId: `${PID}:thr-live` }]);
    expect(await keyRows()).toEqual([{ thread_key: 'lb-dm-2', thread_platform_id: 'thr-live' }]);
    expect(await checkRows()).toMatchObject([{ check_point: 'a', decision: 'keep', score: 0.35 }]);
    expect(noticeOf(session.id, 'out-1')).toBeNull();
  });

  it('a thread last active outside the 48-hour window is scored the same way and stored as check point c', async () => {
    archiveThread('thr-old', 2, agoIso(3 * 24 * 60 * 60 * 1000));
    scores(0.25);
    const session = await fireSession();
    insertPost(session.id, 'out-1', handoff('Channel revenue ask', 'lb-dm-3', { continueThread: 'thr-old' }));
    const calls = recordingAdapter();

    await deliverUntilSettled(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect(await checkRows()).toMatchObject([{ check_point: 'c', decision: 'veto', score: 0.25 }]);
  });
});

describe("routing check — check point b (a post into the key's own earlier thread)", () => {
  it('a handoff scoring below the threshold moves to a split key; the earlier key keeps its thread; later posts follow their keys', async () => {
    archiveThread('thr-earlier', 4);
    await seedAnchor('lb-dm-b', 'thr-earlier');
    scores(0.03);
    const session = await fireSession();
    insertPost(session.id, 'out-1', handoff('Applicant screening script ask', 'lb-dm-b'));
    const calls = recordingAdapter();

    await deliverUntilSettled(session);

    const split = 'lb-dm-b.split-out-1';
    expect(calls).toEqual([{ threadId: null }]);
    expect(await keyRows()).toEqual([
      { thread_key: 'lb-dm-b', thread_platform_id: 'thr-earlier' },
      { thread_key: split, thread_platform_id: '900000000000000001' },
    ]);
    expect(await checkRows()).toMatchObject([
      { check_point: 'b', candidate_thread_id: 'thr-earlier', decision: 'veto', split_thread_key: split },
    ]);
    expect(noticeOf(session.id, 'out-1')).toBe(
      'ROUTING CHECK VETO: thread thr-earlier is not working on this request (routing check score 0.03 is below 0.35). ' +
        'This post opened a NEW thread: https://discord.com/channels/111/900000000000000001. Its thread_key is ' +
        `"${split}". Use thread_key "${split}" for this request's topic file, its dispatch and every later post about ` +
        'it. Thread_key "lb-dm-b" stays with the earlier request.',
    );

    // A work session's result under the earlier key, then the new request's result under its split key.
    insertPost(session.id, 'out-2', {
      text: 'Earlier review result',
      threadKey: 'lb-dm-b',
      reporting: { version: 1, purpose: 'decision' },
    });
    insertPost(session.id, 'out-3', {
      text: 'Screening draft',
      threadKey: split,
      reporting: { version: 1, purpose: 'decision' },
    });
    await deliverUntilSettled(session);

    expect(calls.slice(1)).toEqual([{ threadId: `${PID}:thr-earlier` }, { threadId: `${PID}:900000000000000001` }]);
    expect(jev).toHaveBeenCalledTimes(1);
  });

  it('a handoff scoring above the threshold threads under the key as before', async () => {
    archiveThread('thr-keys', 2);
    await seedAnchor('lb-dm-keys', 'thr-keys');
    scores(0.8);
    const session = await fireSession();
    insertPost(session.id, 'out-1', handoff('New keys for the same integration', 'lb-dm-keys'));
    const calls = recordingAdapter();

    await deliverUntilSettled(session);

    expect(calls).toEqual([{ threadId: `${PID}:thr-keys` }]);
    expect(await keyRows()).toEqual([{ thread_key: 'lb-dm-keys', thread_platform_id: 'thr-keys' }]);
    expect(await checkRows()).toMatchObject([
      { check_point: 'b', decision: 'keep', score: 0.8, split_thread_key: null },
    ]);
    expect(noticeOf(session.id, 'out-1')).toBeNull();
  });
});

describe('routing check — any failure opens a new thread', () => {
  const realAskJev = async (...args: Parameters<typeof askJev>) =>
    (await vi.importActual<typeof import('./typesafe.js')>('./typesafe.js')).askJev(...args);

  it.each<{
    label: string;
    archived: boolean;
    setup: () => Promise<unknown> | void;
    error: string;
    jevCalled: boolean;
  }>([
    {
      label: 'Jev errors',
      archived: true,
      setup: () => void jev.mockRejectedValue(new Error('TypeSafe HTTP 503')),
      error: 'TypeSafe HTTP 503',
      jevCalled: true,
    },
    {
      label: 'the gateway credential is missing',
      archived: true,
      setup: () => {
        for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(k, '');
        jev.mockImplementation(realAskJev);
      },
      error: 'TypeSafe: no OneCLI gateway proxy configured',
      jevCalled: true,
    },
    {
      label: 'the thread has no archived messages',
      archived: false,
      setup: () => scores(0.9),
      error: 'thread has no archived messages',
      jevCalled: false,
    },
    {
      label: 'the score cannot be stored',
      archived: true,
      setup: async () => {
        scores(0.9);
        await getDb().run('DROP TABLE thread_route_checks');
      },
      error: 'score not stored',
      jevCalled: true,
    },
  ])('$label', async ({ archived, setup, error, jevCalled }) => {
    if (archived) archiveThread('thr-prior', 2);
    await seedAnchor('lb-dm-x', 'thr-prior');
    await setup();
    const session = await fireSession();
    insertPost(session.id, 'out-1', handoff('A new ask', 'lb-dm-x'));
    const calls = recordingAdapter();

    await deliverUntilSettled(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect(await keyRows()).toEqual([
      { thread_key: 'lb-dm-x', thread_platform_id: 'thr-prior' },
      { thread_key: 'lb-dm-x.split-out-1', thread_platform_id: '900000000000000001' },
    ]);
    expect(noticeOf(session.id, 'out-1')).toContain(`the routing check failed (${error}`);
    expect(jev).toHaveBeenCalledTimes(jevCalled ? 1 : 0);
  });

  it('a Jev call that hangs never holds a delivery cycle; the cap cuts it off and the post opens a new thread', async () => {
    jev.mockReturnValue(new Promise<Record<string, JevAnswer>>(() => {}));
    archiveThread('thr-prior', 2);
    await seedAnchor('lb-dm-x', 'thr-prior');
    const session = await fireSession();
    // Queued 19.5 s ago: 0.5 s left before the deadline, then the 1 s grace.
    insertPost(session.id, 'out-1', handoff('A new ask', 'lb-dm-x'), agoIso(ROUTE_CHECK_DEADLINE_MS - 500));
    const calls = recordingAdapter();

    const started = Date.now();
    expect(await deliverSessionMessages(session)).toBe('pending');
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toEqual([]);

    await deliverUntilSettled(session);

    expect(Date.now() - started).toBeLessThan(ROUTE_CHECK_TOTAL_TIMEOUT_MS);
    expect(jev).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ threadId: null }]);
    expect(noticeOf(session.id, 'out-1')).toContain('routing check did not finish within');
  });

  it('a post the host reaches after the deadline is a veto without calling Jev', async () => {
    scores(0.9);
    archiveThread('thr-prior', 2);
    await seedAnchor('lb-dm-x', 'thr-prior');
    const session = await fireSession();
    insertPost(session.id, 'out-1', handoff('A new ask', 'lb-dm-x'), agoIso(ROUTE_CHECK_DEADLINE_MS + 10_000));
    const calls = recordingAdapter();

    await deliverUntilSettled(session);

    expect(jev).not.toHaveBeenCalled();
    expect(calls).toEqual([{ threadId: null }]);
    expect(await checkRows()).toMatchObject([{ decision: 'veto', error: 'deadline passed before the check ran' }]);
  });

  it("a check in flight for one session's post does not delay another session's post in the same cycle", async () => {
    let releaseJev: (answers: Record<string, JevAnswer>) => void = () => {};
    jev.mockReturnValue(new Promise((resolve) => (releaseJev = resolve)));
    archiveThread('thr-prior', 2);
    await seedAnchor('lb-dm-x', 'thr-prior');
    const watcher = await fireSession();
    const other = (await resolveTaskSession('ag-1', 'other-series')).session;
    insertPost(watcher.id, 'out-watch', handoff('A new ask', 'lb-dm-x'));
    insertPost(other.id, 'out-other', { text: 'an ordinary post' });
    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _threadId, _kind, content) {
        sent.push((JSON.parse(content) as { text: string }).text);
        return `90000000000000000${sent.length}`;
      },
    });

    const started = Date.now();
    await runSweepDeliveryCycle();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sent).toEqual(['an ordinary post']);
    expect(jev).toHaveBeenCalledTimes(1);

    releaseJev({ same_request: { type: 'noul', noul: 0.9 } });
    await deliverUntilSettled(watcher);
    expect(sent).toEqual(['an ordinary post', 'A new ask']);
  });

  it('a row retried after a failed post reuses its verdict and asks Jev once', async () => {
    scores(0.05);
    archiveThread('thr-prior', 2);
    await seedAnchor('lb-dm-x', 'thr-prior');
    const session = await fireSession();
    insertPost(session.id, 'out-1', handoff('A new ask', 'lb-dm-x'));
    const calls: Array<string | null> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push(threadId);
        if (calls.length === 1) throw new Error('platform hiccup');
        return '900000000000000009';
      },
    });

    await deliverUntilSettled(session);

    expect(calls).toEqual([null, null]);
    expect(jev).toHaveBeenCalledTimes(1);
    expect(await checkRows()).toHaveLength(1);
    expect(await keyRows()).toContainEqual({
      thread_key: 'lb-dm-x.split-out-1',
      thread_platform_id: '900000000000000009',
    });
  });

  it('a kept verdict whose post could not go out before the runner stopped waiting opens a new thread instead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    scores(0.8);
    archiveThread('thr-prior', 2);
    await seedAnchor('lb-dm-x', 'thr-prior');
    const session = await fireSession();
    insertPost(session.id, 'out-1', handoff('Same request, new input', 'lb-dm-x'));
    const calls = recordingAdapter();

    expect(await deliverSessionMessages(session)).toBe('pending');
    while ((await checkRows()).length === 0) await sleep(5);
    vi.setSystemTime(Date.now() + ROUTE_CHECK_DELIVER_BY_MS + 1_000);
    await deliverUntilSettled(session);

    expect(await checkRows()).toMatchObject([{ decision: 'keep', score: 0.8 }]);
    expect(calls).toEqual([{ threadId: null }]);
    expect(noticeOf(session.id, 'out-1')).toContain('kept verdict expired before delivery');
  });
});

describe('routing check — what Jev is asked', () => {
  it('shows the thread as the backtest did: opener cut at 240, count, newest five non-host messages cut at 300, scrubbed', () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    const msg = (id: string, senderName: string, text: string, i: number): ArchivedThreadMessage => ({
      id,
      senderName,
      text,
      sentAt: new Date(Date.UTC(2026, 9, 8, 12, i)).toISOString(),
    });
    const messages = [
      msg('t1:sibling', 'Dave', `Open   ask\n${'o'.repeat(300)}`, 0),
      ...[1, 2, 3, 4, 5].map((i) => msg(`r${i}`, i % 2 ? 'Axie' : 'Dave', `reply ${i}`, i)),
      msg('host-copy', 'assistant', 'the host copy of reply 5', 6),
      msg('r6', 'Dave', `token ${token} ${'x'.repeat(400)}`, 7),
    ];

    expect(threadView('t1', messages)).toEqual({
      opened_by: 'Dave',
      opening_message: `Open ask ${'o'.repeat(231)}...`,
      message_count: 8,
      latest_messages: [
        { from: 'Dave', text: 'reply 2' },
        { from: 'Axie', text: 'reply 3' },
        { from: 'Dave', text: 'reply 4' },
        { from: 'Axie', text: 'reply 5' },
        { from: 'Dave', text: `token [REDACTED] ${'x'.repeat(283)}...` },
      ],
    });
    expect(threadView('t1', messages.slice(0, 1))).not.toHaveProperty('latest_messages');
  });

  it('replays the 2026-10-08 misroute: its opening post into thread 1557445336749052006 is vetoed', async () => {
    const req: RouteCheckRequest = {
      via: 'adopt',
      threadKey: 'lb-slack-dm-replay',
      postText: replay.postText,
      channelType: replay.channelType,
      platformId: replay.platformId,
      threadPlatformId: replay.threadPlatformId,
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      sessionId: 'sess-replay',
      messageOutId: 'out-replay',
      queuedAt: replay.checkedAt,
    };
    const ask = vi.fn(async (state: unknown, questions: unknown) => {
      expect({ model: JEV_MODEL, state, questions }).toEqual(replay.request);
      return replay.response.answers as Record<string, JevAnswer>;
    });

    const verdict = await checkThreadRoute(req, {
      ask,
      readThread: () => replay.messages,
      now: () => Date.parse(replay.checkedAt),
    });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(verdict).toEqual({ keep: false, checkPoint: 'a', score: 0.05, error: null });
  });

  it.each<[string, Record<string, JevAnswer>, string | null]>([
    ['just below the threshold', { same_request: { type: 'noul', noul: 0.3499 } }, null],
    ['out of range', { same_request: { type: 'noul', noul: 1.2 } }, 'malformed Jev answer'],
    ['missing', {}, 'malformed Jev answer'],
  ])('a score %s is a veto', async (_label, answers, error) => {
    const opener: ArchivedThreadMessage = { id: 'thr-x:sibling', senderName: 'Dave', text: 'opener', sentAt: now() };
    const verdict = await checkThreadRoute(
      {
        via: 'anchor',
        threadKey: 'lb-k',
        postText: 'ask',
        channelType: 'discord',
        platformId: PID,
        threadPlatformId: 'thr-x',
        agentGroupId: 'ag-1',
        messagingGroupId: 'mg-1',
        sessionId: 's',
        messageOutId: 'o',
        queuedAt: now(),
      },
      { ask: async () => answers, readThread: () => [opener], now: Date.now },
    );
    expect(verdict).toMatchObject({ keep: false, error });
  });
});

describe('route-checked keys and the split key', () => {
  it('scopes to lb- keys only', () => {
    expect(['lb-slack-x-dm', 'lb-meeting-1'].every(isRouteCheckedKey)).toBe(true);
    expect(['topic-a', 'LB-x', 'xlb-1', 'job-a-run-1'].some(isRouteCheckedKey)).toBe(false);
  });

  it('derives a valid lb- key from the row id, the same for a retried row, within the key length cap', () => {
    expect(splitThreadKey('lb-slack-D0-dm-1791482063.163859', 'msg-1791-ab12')).toBe(
      'lb-slack-D0-dm-1791482063.163859.split-msg-1791-ab12',
    );
    const long = splitThreadKey(`lb-${'k'.repeat(125)}`, 'msg-1791498680231-75j5wc');
    expect(long.length).toBeLessThanOrEqual(128);
    expect(long.startsWith('lb-')).toBe(true);
    expect(long.endsWith('.split-msg-1791498680231-75j5wc')).toBe(true);
    expect(THREAD_KEY_PATTERN.test(long)).toBe(true);
  });

  it('holds the same scope and split key as the runner, which waits longer than the host can still decide', () => {
    // Two copies of one rule across the host/container boundary (no shared modules).
    expect(fs.readFileSync('container/agent-runner/src/thread-route-split.ts', 'utf8')).toBe(
      fs.readFileSync('src/thread-route-split.ts', 'utf8'),
    );
    const runner = fs.readFileSync('container/agent-runner/src/mcp-tools/route-check-ack.ts', 'utf8');
    const wait = Number(/ROUTE_CHECK_ACK_WAIT_MS = ([\d_]+);/.exec(runner)?.[1].replaceAll('_', ''));
    expect(ROUTE_CHECK_DELIVER_BY_MS).toBeGreaterThan(ROUTE_CHECK_DEADLINE_MS + ROUTE_CHECK_TOTAL_TIMEOUT_MS);
    expect(wait).toBeGreaterThanOrEqual(ROUTE_CHECK_DELIVER_BY_MS + 5_000);
  });
});
