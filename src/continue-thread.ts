/**
 * `continue_thread` on send_message/send_file: the first post under a `thread_key` adopts an EXISTING thread in the
 * destination. The container-written value is only a pointer: adopted only when the host already saw that thread on
 * that messaging group; anything else resolves to null and the post proceeds as without the arg.
 */
import { getDb } from './db/connection.js';
import { log } from './log.js';
import { archiveHasThread } from './message-archive.js';

/** Longest value considered at all; the runner caps what it writes at the same length. */
const CONTINUE_THREAD_MAX_LENGTH = 512;

/** One thread segment of an encoded thread id — no `:`, so it cannot re-address the channel part. */
const THREAD_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const DISCORD_URL = /^https:\/\/(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)(?:\/(\d+))?\/?$/;
const SLACK_URL = /^https:\/\/[A-Za-z0-9.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(.*))?$/;

export interface AdoptedThread {
  /** The encoded thread id adapters decode: `<platform_id>:<thread>`. */
  threadId: string;
  /** The `<thread>` part — what `thread_key_anchors.thread_platform_id` stores. */
  threadPlatformId: string;
}

export interface ContinueThreadDestination {
  messagingGroupId: string;
  channelType: string;
  platformId: string;
}

function adopt(platformId: string, segment: string | undefined): AdoptedThread | null {
  if (!segment || !THREAD_SEGMENT.test(segment)) return null;
  return { threadId: `${platformId}:${segment}`, threadPlatformId: segment };
}

/**
 * Shape only (resolveContinueThread decides reality): an encoded `<platform_id>:<thread>`, a bare thread id, a
 * Discord channel/thread link or a Slack permalink; null when it names something other than `platformId`.
 */
export function continueThreadCandidate(raw: unknown, platformId: string): AdoptedThread | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > CONTINUE_THREAD_MAX_LENGTH) return null;

  const discord = DISCORD_URL.exec(value);
  if (discord) {
    const [, guild, first, second] = discord;
    // /<guild>/<thread>[/<message>] names a thread; /<guild>/<parent>/<message> names a message whose thread shares
    // its id.
    if (platformId === `discord:${guild}:${first}`) return adopt(platformId, second);
    if (!platformId.startsWith(`discord:${guild}:`)) return null;
    return adopt(platformId, first);
  }

  const slack = SLACK_URL.exec(value);
  if (slack) {
    const [, channel, sec, frac, query] = slack;
    if (platformId !== `slack:${channel}`) return null;
    const threadTs = query ? new URLSearchParams(query).get('thread_ts') : null;
    if (threadTs !== null) return /^\d{10}\.\d{6}$/.test(threadTs) ? adopt(platformId, threadTs) : null;
    return adopt(platformId, `${sec}.${frac}`);
  }

  if (value.startsWith(`${platformId}:`)) return adopt(platformId, value.slice(platformId.length + 1));
  return adopt(platformId, value);
}

/**
 * The thread to adopt, or null (logged). Evidence: a session bound to (messaging group, thread), or an archived
 * message on the same channel in that thread (threads the agent saw but never engaged).
 */
export async function resolveContinueThread(
  raw: unknown,
  dest: ContinueThreadDestination,
  logContext: Record<string, unknown>,
): Promise<AdoptedThread | null> {
  const adopted = await confirmedThread(raw, dest);
  if (!adopted) {
    log.warn('continueThread is not a known thread on this destination — opening a new keyed thread', {
      ...logContext,
      continueThread: String(raw).slice(0, 200),
    });
  }
  return adopted;
}

async function confirmedThread(raw: unknown, dest: ContinueThreadDestination): Promise<AdoptedThread | null> {
  const candidate = continueThreadCandidate(raw, dest.platformId);
  if (!candidate) return null;
  const session = await getDb().get(
    'SELECT 1 FROM sessions WHERE messaging_group_id = ? AND thread_id = ? LIMIT 1',
    dest.messagingGroupId,
    candidate.threadId,
  );
  if (session) return candidate;
  try {
    return archiveHasThread(dest.channelType, dest.platformId, candidate.threadId) ? candidate : null;
  } catch {
    // An unreadable archive is no evidence.
    return null;
  }
}
