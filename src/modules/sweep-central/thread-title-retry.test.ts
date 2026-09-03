/**
 * F-4.3b (docs/specs/upstream-host-sweep-seam/plan.md §8, S2-PR4) — half of
 * "session-title and thread-title sweeps keep their caps, cooldowns and
 * backoffs". Ported from src/topic-title.test.ts (that file's own full
 * suite is untouched — this family PR only moved the tick:housekeeping
 * registration wrapper (T16), not topic-title.ts's own code).
 *
 * Kept in its own file, not central.test.ts: needs a full
 * `vi.mock('../../llm.js', ...)`, which conflicts with
 * session-title-sweep.test.ts's need for the REAL llm.js reset helpers —
 * `vi.mock` is hoisted per FILE, not per `describe` block.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { insertThreadTitleClaim, recordThreadTitleAttemptFailure } from '../../db/thread-titles.js';

vi.mock('../../llm.js', () => ({ callHaiku: vi.fn(async () => 'Rollout fix') }));

import { retryPendingThreadTitles } from '../../topic-title.js';

const THREAD_ID = 'discord:11111111111111111:22222222222222222:33333333333333333';
const NOW = '2026-08-31T12:00:00.000Z';

// Hermeticity (brief-common.md HARD RULE): retryPendingThreadTitles calls
// attemptThreadTitle, which PATCHes Discord over `fetch` when a bot token is
// configured. Explicitly clear the token (never inherit a real one from this
// shell) and stub fetch so a missing clear can't silently reach the network.
let originalToken: string | undefined;

beforeEach(() => {
  runMigrations(initTestDb());
  originalToken = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('thread-title-retry.test: real fetch attempted');
    }),
  );
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = originalToken;
});

describe('F-4.3b — thread-title retry keeps its batch cap, attempt cap and retry window', () => {
  it('excludes rows at the 5-attempt cap', async () => {
    insertThreadTitleClaim(THREAD_ID, 'discord', 'opener', NOW);
    for (let i = 0; i < 5; i++) recordThreadTitleAttemptFailure(THREAD_ID);
    expect(await retryPendingThreadTitles(NOW)).toEqual({ attempted: 0, titled: 0 });
  });

  it('excludes rows older than the 24h retry window', async () => {
    const staleId = `${THREAD_ID}:stale`;
    insertThreadTitleClaim(staleId, 'discord', 'opener', '2026-08-29T12:00:00.000Z'); // 48h before NOW
    recordThreadTitleAttemptFailure(staleId);
    expect(await retryPendingThreadTitles(NOW)).toEqual({ attempted: 0, titled: 0 });
  });

  it('caps at 1 retry per call even with more eligible rows (RETRY_BATCH_CAP)', async () => {
    for (let i = 1; i <= 5; i++) {
      insertThreadTitleClaim(`discord:g:c:${i}`, 'discord', `opener ${i}`, NOW);
      recordThreadTitleAttemptFailure(`discord:g:c:${i}`);
    }
    const result = await retryPendingThreadTitles(NOW);
    expect(result.attempted).toBe(1);
  });
});
