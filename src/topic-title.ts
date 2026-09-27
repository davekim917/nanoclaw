/**
 * Haiku-generated titles for Discord threads the adapter auto-creates, applied by REST PATCH (the adapter has no
 * rename helper). Fire-and-forget from the router. Durable state is the `thread_titles` table.
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

const RETRY_MAX_ATTEMPTS = 5;
const RETRY_WINDOW_HOURS = 24;
// One per tick: bursts with the other title sweeps tripped per-account rate limits on healthy credentials.
const RETRY_BATCH_CAP = 1;

/** Undefined on failure: skip the rename. */
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
    // Error serialization drops custom props, so surface callHaiku's stderr explicitly.
    const stderr = (err as { stderr?: string }).stderr;
    log.warn('Topic title generation failed', { err, stderr });
    return undefined;
  }
}

/** `threadPlatformId` is bridge-encoded ("discord:guildId:channelId:threadId"); REST wants the last segment. */
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
 * Inverse of discord.ts's channelType-from-env mapping (`discord-<suffix>` → `DISCORD_BOT_TOKEN_<SUFFIX>`).
 * Falls back to the primary token rather than silently no-op-ing the rename.
 */
function resolveDiscordBotToken(channelType: string): string | undefined {
  const primary = process.env.DISCORD_BOT_TOKEN;
  if (channelType === 'discord') return primary;
  const suffix = channelType.startsWith('discord-') ? channelType.slice('discord-'.length) : '';
  if (!suffix) return primary;
  const envVar = `DISCORD_BOT_TOKEN_${suffix.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envVar] || primary;
}

/** Shared by the live path and the retry sweep so a retry never diverges. True on a confirmed rename. */
async function attemptThreadTitle(
  threadPlatformId: string,
  channelType: string,
  firstMessageText: string,
): Promise<boolean> {
  try {
    const botToken = resolveDiscordBotToken(channelType);
    if (!botToken) {
      log.warn('attemptThreadTitle: no bot token configured for channel', { channelType, threadPlatformId });
      await recordThreadTitleAttemptFailure(threadPlatformId);
      return false;
    }
    const title = await generateTopicTitle(firstMessageText);
    if (!title) {
      await recordThreadTitleAttemptFailure(threadPlatformId);
      return false;
    }
    const renamed = await renameDiscordThread(threadPlatformId, title, botToken);
    if (!renamed) {
      await recordThreadTitleAttemptFailure(threadPlatformId);
      return false;
    }
    await markThreadTitled(threadPlatformId, title);
    return true;
  } catch (err) {
    log.warn('attemptThreadTitle: rename threw', { err, threadPlatformId });
    try {
      await recordThreadTitleAttemptFailure(threadPlatformId);
    } catch (recErr) {
      log.warn('attemptThreadTitle: failed to record attempt failure', { err: recErr, threadPlatformId });
    }
    return false;
  }
}

// In-process race claim only (concurrent siblings engaging one opener); the `thread_titles` row is the durable
// idempotency guard.
const renamedThreads = new Set<string>();

export function _resetRenamedThreadsForTest(): void {
  renamedThreads.clear();
}

export async function maybeRenameNewThread(
  channelType: string,
  threadPlatformId: string | null,
  firstMessageText: string,
  inboundMessageId: string,
): Promise<void> {
  if (!threadPlatformId) return;
  if (!channelType.startsWith('discord')) return;

  // Title only a thread THIS message opened (it shares the message's snowflake); every other thread already has
  // a chosen name and no thread_titles row, so its first reply would otherwise retitle it.
  if (threadPlatformId.split(':').pop() !== inboundMessageId) return;

  // Durable check first: an archived session's thread gets a fresh session row off a follow-up message.
  let existing: ThreadTitleRow | undefined;
  try {
    existing = await getThreadTitleRow(threadPlatformId);
  } catch (err) {
    log.warn('maybeRenameNewThread: thread_titles lookup failed', { err, threadPlatformId });
  }
  if (existing?.title) return;

  const botToken = resolveDiscordBotToken(channelType);
  if (!botToken) {
    log.warn('maybeRenameNewThread: no bot token configured for channel', { channelType });
    return;
  }

  // Claimed synchronously before any await so racing siblings can't all pass.
  if (renamedThreads.has(threadPlatformId)) return;
  renamedThreads.add(threadPlatformId);

  if (!existing) {
    try {
      await insertThreadTitleClaim(threadPlatformId, channelType, firstMessageText);
    } catch (err) {
      log.warn('maybeRenameNewThread: failed to record thread_titles claim', { err, threadPlatformId });
    }
  }

  (async () => {
    let renamed = false;
    try {
      renamed = await attemptThreadTitle(threadPlatformId, channelType, firstMessageText);
    } finally {
      if (!renamed) renamedThreads.delete(threadPlatformId);
    }
  })().catch((err) => {
    log.warn('maybeRenameNewThread: title attempt failed', { err, threadPlatformId });
  });
}

// Re-entrancy guard: the sweep fires this without awaiting, so a slow tick can overlap the next.
let _retryInProgress = false;

/** Retries from the STORED `first_message`, never a later follow-up. */
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
    rows = await getPendingThreadTitleRetries(sinceIso, RETRY_MAX_ATTEMPTS, RETRY_BATCH_CAP);
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
      log.warn('retryPendingThreadTitles: attempt threw unexpectedly', { err, threadId: row.thread_id });
    }
  }
  return { attempted: rows.length, titled };
}
