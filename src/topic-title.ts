/**
 * Topic-title generation for auto-created threads (Phase 5.11).
 *
 * v2's Chat SDK Discord adapter auto-creates a thread on every new
 * top-level @mention. The default title is a generic Slack-style
 * stamp ("thread created 4/17 8pm"), which makes thread archaeology
 * painful. This module:
 *
 *  1. Generates a 2–5 word topic title from the inbound message via
 *     Haiku.
 *  2. Renames the freshly-created thread via a direct Discord REST
 *     PATCH (the @chat-adapter/discord surface doesn't expose a
 *     rename helper, so we go to the REST endpoint directly — this
 *     is intentionally narrow and fits v2's "fit-into, don't
 *     rebuild-v1" principle).
 *
 * Fire-and-forget from the router: never blocks inbound processing,
 * never errors user-visibly. Failures log and move on.
 *
 * Durable state lives in the central `thread_titles` table (migration 062,
 * src/db/thread-titles.ts) — see `maybeRenameNewThread` below for why an
 * in-process Set alone was not enough.
 */
import { callHaiku } from './llm.js';
import { log } from './log.js';
import {
  getThreadTitleRow,
  insertThreadTitleClaim,
  markThreadTitled,
  recordThreadTitleAttemptFailure,
  getPendingThreadTitleRetries,
  type ThreadTitleRow,
} from './db/thread-titles.js';

const MAX_TITLE_LENGTH = 100; // Discord's thread-name limit is 100 chars
const TITLE_PROMPT_CAP = 500; // Truncate input to keep Haiku latency low

// Retry sweep tuning (see retryPendingThreadTitles, called from host-sweep.ts).
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_WINDOW_HOURS = 24;
const RETRY_BATCH_CAP = 3;

/**
 * Generate a short topic title from a message. Returns undefined on
 * failure — caller should just skip the rename in that case.
 */
export async function generateTopicTitle(messageText: string): Promise<string | undefined> {
  const cleaned = messageText.replace(/@\w+\s*/g, '').trim();
  if (!cleaned) return undefined;

  try {
    const raw = await callHaiku(
      `Generate a concise 2–5 word title that captures the topic of this message. Reply with only the title — no quotes, no punctuation, no explanation.\n\nMessage: ${cleaned.slice(0, TITLE_PROMPT_CAP)}`,
    );
    const title = raw.replace(/\*+/g, '').trim().slice(0, MAX_TITLE_LENGTH);
    return title || undefined;
  } catch (err) {
    // callHaiku attaches the subprocess stderr to err.stderr (see llm.ts:30),
    // but the default JSON serializer of Error doesn't pick up custom props,
    // so surface it explicitly. Without this, every "Topic title generation
    // failed" warn looks like "Command failed: claude -p ..." with no clue
    // why claude actually exited non-zero (auth, timeout, rate limit, etc.).
    const stderr = (err as { stderr?: string }).stderr;
    log.warn('Topic title generation failed', { err, stderr });
    return undefined;
  }
}

/**
 * Rename a Discord thread via REST. `threadPlatformId` is the bridge-
 * encoded form (e.g. "discord:guildId:channelId:threadId") — we peel
 * off the bare thread ID (last segment) since Discord's REST endpoint
 * just wants that.
 */
async function renameDiscordThread(threadPlatformId: string, newName: string, botToken: string): Promise<boolean> {
  const parts = threadPlatformId.split(':');
  const threadId = parts[parts.length - 1];
  if (!threadId || !/^\d+$/.test(threadId)) {
    log.warn('renameDiscordThread: unrecognized thread id format', { threadPlatformId });
    return false;
  }

  const res = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'nanoclaw-v2 (topic-title, v2)',
    },
    body: JSON.stringify({ name: newName }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<body unreadable>');
    log.warn('Discord thread rename failed', { threadId, status: res.status, body });
    return false;
  }
  log.info('Discord thread renamed', { threadId, title: newName });
  return true;
}

/**
 * Resolve the bot token for a Discord channelType. Mirrors the round-trip
 * `discord.ts`'s `parseDiscordWorkspaces` uses when building channelTypes
 * from env vars: bare `discord` → `DISCORD_BOT_TOKEN`; `discord-<suffix>` →
 * `DISCORD_BOT_TOKEN_<SUFFIX>` where SUFFIX is the channelType's suffix
 * upper-cased with `-` swapped back to `_` (the exact inverse of
 * `rawSuffix.toLowerCase().replace(/_/g, '-')` in discord.ts).
 *
 * Falls back to the primary bot token when a sibling-specific one is absent
 * (misconfiguration) rather than silently no-op-ing the whole rename.
 */
function resolveDiscordBotToken(channelType: string): string | undefined {
  const primary = process.env.DISCORD_BOT_TOKEN;
  if (channelType === 'discord') return primary;
  const suffix = channelType.startsWith('discord-') ? channelType.slice('discord-'.length) : '';
  if (!suffix) return primary;
  const envVar = `DISCORD_BOT_TOKEN_${suffix.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envVar] || primary;
}

/**
 * Generate a title and apply it via REST, then persist the outcome to
 * `thread_titles`. Shared by the real-time path (`maybeRenameNewThread`)
 * and the host-sweep retry step (`retryPendingThreadTitles`) so both use
 * IDENTICAL rename + bookkeeping logic — a retry must never diverge from
 * what the original attempt would have done.
 *
 * Returns true on a confirmed rename.
 */
async function attemptThreadTitle(
  threadPlatformId: string,
  channelType: string,
  firstMessageText: string,
): Promise<boolean> {
  try {
    const botToken = resolveDiscordBotToken(channelType);
    if (!botToken) {
      log.warn('attemptThreadTitle: no bot token configured for channel', { channelType, threadPlatformId });
      recordThreadTitleAttemptFailure(threadPlatformId);
      return false;
    }
    const title = await generateTopicTitle(firstMessageText);
    if (!title) {
      recordThreadTitleAttemptFailure(threadPlatformId);
      return false;
    }
    const renamed = await renameDiscordThread(threadPlatformId, title, botToken);
    if (!renamed) {
      recordThreadTitleAttemptFailure(threadPlatformId);
      return false;
    }
    markThreadTitled(threadPlatformId, title);
    return true;
  } catch (err) {
    log.warn('attemptThreadTitle: rename threw', { err, threadPlatformId });
    try {
      recordThreadTitleAttemptFailure(threadPlatformId);
    } catch (recErr) {
      log.warn('attemptThreadTitle: failed to record attempt failure', { err: recErr, threadPlatformId });
    }
    return false;
  }
}

/**
 * Fire-and-forget: generate a title for the first message in a
 * freshly-created thread and rename the thread. Only runs when the
 * channel is Discord and `sessionCreated` is true (meaning this is
 * the first message in this thread from v2's perspective).
 *
 * Call from the router after `resolveSession` returns `created=true`.
 * Does not await internally — returns an already-scheduled promise so
 * the router can continue without blocking.
 */
// Synchronous, in-process race-claim ONLY — dedupes concurrent siblings that
// land here in the same tick of the same process (e.g. two @-mentioned
// siblings both engaging the same opening message: both would hit this
// function, and the LAST to finish would clobber the first's title, plus
// double the PATCH volume into Discord's tight rename rate limit). This Set
// is reset on every host restart and knows nothing about session archival —
// it is NOT the idempotency guard. The `thread_titles` DB row (checked at
// the top of maybeRenameNewThread) is the durable, cross-restart,
// cross-archival answer: once a row has a non-NULL title, this function
// returns immediately regardless of what's in this Set.
//
// ponytail: unbounded Set, one short string per thread ever titled in this
// process's lifetime. At this install's volume (~hundreds) it's negligible;
// add an LRU cap only if a host ever titles millions of threads without
// restarting.
const renamedThreads = new Set<string>();

/** Test-only: clear the in-process race-claim set to simulate a fresh host process. */
export function _resetRenamedThreadsForTest(): void {
  renamedThreads.clear();
}

export function maybeRenameNewThread(
  channelType: string,
  threadPlatformId: string | null,
  firstMessageText: string,
): void {
  if (!threadPlatformId) return;
  // Only Discord for now. Slack creates threads from the parent
  // message's ts (no rename possible without message edit). Telegram
  // is threadless. Others: add when they ship.
  if (!channelType.startsWith('discord')) return;

  // Durable idempotency check FIRST, before any other work: a thread that
  // already has a title must never be retitled — not across a host restart,
  // and not when storage-manager archives an idle session and the thread's
  // next message creates a fresh session row (which re-triggers this
  // function with `created=true` off a FOLLOW-UP message, not the thread's
  // original opener). This was the actual regression: the old in-memory-Set-
  // only guard had no memory of threads titled in a previous process, or
  // before the current session existed.
  let existing: ThreadTitleRow | undefined;
  try {
    existing = getThreadTitleRow(threadPlatformId);
  } catch (err) {
    log.warn('maybeRenameNewThread: thread_titles lookup failed', { err, threadPlatformId });
  }
  if (existing?.title) return;

  const botToken = resolveDiscordBotToken(channelType);
  if (!botToken) {
    // Was log.debug — invisible at default log level, which made a
    // misconfigured per-channel token a silent, permanent no-op.
    log.warn('maybeRenameNewThread: no bot token configured for channel', { channelType });
    return;
  }

  // Claim the thread synchronously BEFORE any await so concurrent siblings
  // racing through here can't all pass the guard. Released on failure below so
  // a later call for this thread in this process (e.g. a new session created
  // on it after archival, if the retry sweep hasn't already caught it) can
  // retry.
  if (renamedThreads.has(threadPlatformId)) return;
  renamedThreads.add(threadPlatformId);

  if (!existing) {
    try {
      insertThreadTitleClaim(threadPlatformId, channelType, firstMessageText);
    } catch (err) {
      log.warn('maybeRenameNewThread: failed to record thread_titles claim', { err, threadPlatformId });
    }
  }

  (async () => {
    let renamed = false;
    try {
      renamed = await attemptThreadTitle(threadPlatformId, channelType, firstMessageText);
    } finally {
      // Keep the claim only on a confirmed rename. A failed generation or a
      // rejected PATCH (e.g. 429) releases it so a later call in THIS process
      // gets another shot; the DB `attempts` counter is the durable failure
      // record either way.
      if (!renamed) renamedThreads.delete(threadPlatformId);
    }
  })();
}

/**
 * Host-sweep retry step (see src/host-sweep.ts): picks up threads whose
 * titling attempts all failed (e.g. callHaiku's retries exhausted a 429
 * window) and retries from the STORED `first_message` — never a later
 * follow-up, which is the exact bug this whole mechanism exists to fix.
 *
 * Capped at RETRY_BATCH_CAP per tick so a backlog of permanently-broken
 * threads (e.g. a deleted Discord thread) can't itself become a Haiku/
 * Discord-REST quota hog.
 */
// Re-entrancy guard, same reasoning as session-title-sweep.ts's
// `sweepInProgress`: this is fired from host-sweep.ts via a non-awaited
// `void import(...).then(...)`, so a slow tick (network hang) can still be
// in flight when the next 60s tick fires. Without this, two overlapping
// calls could pick the SAME candidate rows and double the Haiku + Discord-
// REST spend for them.
let _retryInProgress = false;

export async function retryPendingThreadTitles(
  nowIso: string = new Date().toISOString(),
): Promise<{ attempted: number; titled: number }> {
  if (_retryInProgress) return { attempted: 0, titled: 0 };
  _retryInProgress = true;
  try {
    return await _retryPendingThreadTitlesLocked(nowIso);
  } finally {
    _retryInProgress = false;
  }
}

async function _retryPendingThreadTitlesLocked(nowIso: string): Promise<{ attempted: number; titled: number }> {
  const sinceIso = new Date(Date.parse(nowIso) - RETRY_WINDOW_HOURS * 3600_000).toISOString();
  let rows: ThreadTitleRow[];
  try {
    rows = getPendingThreadTitleRetries(sinceIso, RETRY_MAX_ATTEMPTS, RETRY_BATCH_CAP);
  } catch (err) {
    log.warn('retryPendingThreadTitles: candidate query failed', { err });
    return { attempted: 0, titled: 0 };
  }

  let titled = 0;
  for (const row of rows) {
    try {
      const renamed = await attemptThreadTitle(row.thread_id, row.channel_type, row.first_message);
      if (renamed) titled++;
    } catch (err) {
      // attemptThreadTitle already catches internally and records the
      // failure; this is defense-in-depth so one unexpected throw can't
      // abandon the rest of the retry batch.
      log.warn('retryPendingThreadTitles: attempt threw unexpectedly', { err, threadId: row.thread_id });
    }
  }
  return { attempted: rows.length, titled };
}
