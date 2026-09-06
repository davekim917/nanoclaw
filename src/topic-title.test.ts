import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations, getRawDb } from './db/index.js';
import { getThreadTitleRow, insertThreadTitleClaim, recordThreadTitleAttemptFailure } from './db/thread-titles.js';

vi.mock('./llm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llm.js')>()),
  callHaiku: vi.fn(async () => 'Rollout fix'),
}));

import { callHaiku } from './llm.js';
import { maybeRenameNewThread, retryPendingThreadTitles, _resetRenamedThreadsForTest } from './topic-title.js';

const THREAD_ID = 'discord:11111111111111111:22222222222222222:33333333333333333';

async function setupDb(): Promise<void> {
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
}

/**
 * `maybeRenameNewThread` is fire-and-forget (returns before its internal
 * async IIFE settles). Poll instead of counting microtask hops — robust to
 * however many `await`s sit between here and the DB write.
 */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('maybeRenameNewThread — durable idempotency (migration 062)', () => {
  const originalToken = process.env.DISCORD_BOT_TOKEN;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await setupDb();
    // The in-process race-claim Set is module-level state that otherwise
    // leaks across tests (and across real host restarts it's simply gone) —
    // reset it so each test starts from a genuinely fresh process.
    _resetRenamedThreadsForTest();
    process.env.DISCORD_BOT_TOKEN = 'bot-token';
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(callHaiku).mockClear();
    vi.mocked(callHaiku).mockResolvedValue('Rollout fix');
  });

  afterEach(async () => {
    await closeDb();
    vi.unstubAllGlobals();
    if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalToken;
  });

  it('titles a genuinely new thread once', async () => {
    await maybeRenameNewThread('discord', THREAD_ID, 'first message about EXAMPLE-1 rollout');
    await waitUntil(() => fetchMock.mock.calls.length > 0);

    expect(callHaiku).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = await getThreadTitleRow(THREAD_ID);
    expect(row?.title).toBe('Rollout fix');
    expect(row?.first_message).toBe('first message about EXAMPLE-1 rollout');
  });

  it('does NOT re-title an already-titled thread when a new session is created for it (the archival regression)', async () => {
    // First message on a brand-new thread — titles successfully.
    await maybeRenameNewThread('discord', THREAD_ID, 'first message about EXAMPLE-1 rollout');
    await waitUntil(async () => (await getThreadTitleRow(THREAD_ID))?.title != null);
    expect(callHaiku).toHaveBeenCalledTimes(1);

    // Simulate storage-manager archiving the idle session and a HOST RESTART
    // (the in-memory renamedThreads Set — the pre-fix-only guard — is wiped;
    // a real restart would do exactly this). A follow-up message then
    // creates a brand-new session for the SAME thread, and the router calls
    // maybeRenameNewThread again with created=true — but this text is a
    // FOLLOW-UP, not the thread's original opener.
    _resetRenamedThreadsForTest();
    await maybeRenameNewThread('discord', THREAD_ID, 'a totally unrelated follow-up message weeks later');
    // Give the (non-existent) second attempt a chance to run before asserting
    // it never did.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Must not regenerate or re-PATCH — the DB row alone (not the Set) is
    // what must have prevented it.
    expect(callHaiku).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = await getThreadTitleRow(THREAD_ID);
    expect(row?.title).toBe('Rollout fix');
    expect(row?.first_message).toBe('first message about EXAMPLE-1 rollout');
  });

  it('resolves the sibling bot token for a discord-<suffix> channelType', async () => {
    process.env.DISCORD_BOT_TOKEN_EXAMPLE_AGENT = 'sibling-token';
    try {
      await maybeRenameNewThread('discord-example-agent', THREAD_ID, 'sibling thread opener');
      await waitUntil(() => fetchMock.mock.calls.length > 0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bot sibling-token');
    } finally {
      delete process.env.DISCORD_BOT_TOKEN_EXAMPLE_AGENT;
    }
  });
});

describe('retryPendingThreadTitles — host-sweep retry step', () => {
  const originalToken = process.env.DISCORD_BOT_TOKEN;
  let fetchMock: ReturnType<typeof vi.fn>;
  const NOW = '2026-08-31T12:00:00.000Z';

  beforeEach(async () => {
    await setupDb();
    _resetRenamedThreadsForTest();
    process.env.DISCORD_BOT_TOKEN = 'bot-token';
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(callHaiku).mockClear();
    vi.mocked(callHaiku).mockResolvedValue('Retried title');
  });

  afterEach(async () => {
    await closeDb();
    vi.unstubAllGlobals();
    if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalToken;
  });

  it('retries a failed row from its STORED original first_message, not a later follow-up', async () => {
    await insertThreadTitleClaim(THREAD_ID, 'discord', 'the ORIGINAL opening message', NOW);
    await recordThreadTitleAttemptFailure(THREAD_ID); // attempts=1, still under the cap

    const result = await retryPendingThreadTitles(NOW);

    expect(result).toEqual({ attempted: 1, titled: 1 });
    expect(callHaiku).toHaveBeenCalledTimes(1);
    // The prompt handed to Haiku must contain the ORIGINAL message — never a
    // follow-up, since none is stored anywhere for this row to regenerate from.
    expect(vi.mocked(callHaiku).mock.calls[0][0]).toContain('the ORIGINAL opening message');
    const row = await getThreadTitleRow(THREAD_ID);
    expect(row?.title).toBe('Retried title');
  });

  it('excludes rows past the attempt cap', async () => {
    await insertThreadTitleClaim(THREAD_ID, 'discord', 'opener', NOW);
    for (let i = 0; i < 5; i++) await recordThreadTitleAttemptFailure(THREAD_ID); // attempts=5, at the cap

    const result = await retryPendingThreadTitles(NOW);

    expect(result).toEqual({ attempted: 0, titled: 0 });
    expect(callHaiku).not.toHaveBeenCalled();
  });

  it('excludes rows older than the 24h retry window', async () => {
    const staleCreatedAt = '2026-08-29T12:00:00.000Z'; // 48h before NOW
    await insertThreadTitleClaim(THREAD_ID, 'discord', 'opener', staleCreatedAt);
    await recordThreadTitleAttemptFailure(THREAD_ID);

    const result = await retryPendingThreadTitles(NOW);

    expect(result).toEqual({ attempted: 0, titled: 0 });
    expect(callHaiku).not.toHaveBeenCalled();
  });

  it('caps at 1 retry per call even with more eligible rows (dropped from 3 — see src/topic-title.ts RETRY_BATCH_CAP)', async () => {
    for (let i = 1; i <= 5; i++) {
      await insertThreadTitleClaim(`discord:g:c:${i}`, 'discord', `opener ${i}`, NOW);
      await recordThreadTitleAttemptFailure(`discord:g:c:${i}`);
    }

    const result = await retryPendingThreadTitles(NOW);
    expect(result.attempted).toBe(1);
  });
});
