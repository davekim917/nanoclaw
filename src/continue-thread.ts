/**
 * `continue_thread` on send_message/send_file (`content.continueThread`,
 * container/agent-runner/src/mcp-tools/core.ts): the first post under a
 * `thread_key` adopts an EXISTING thread in the same destination instead of
 * opening a new one, and the key's anchor records that thread, so every later
 * post under the key lands there too.
 *
 * The outbound row is container-written and never trusted (the same reason the
 * host re-checks `threadKey`, src/db/thread-key-anchors.ts). So the value
 * is only a pointer: it is resolved against the destination's own address, and
 * adopted only when the host has already seen that thread on that messaging
 * group — a session bound to it, or an archived message in it. Anything else
 * resolves to null and the caller posts exactly as it would without the arg.
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
 * Map the agent's value onto a thread of `platformId`, or null when it names
 * something else. Accepts the encoded id `search_threads` prints
 * (`<platform_id>:<thread>`), a bare thread id, a Discord channel/thread link,
 * or a Slack message permalink. Shape only — `resolveContinueThread` decides
 * whether the thread is real.
 */
export function continueThreadCandidate(raw: unknown, platformId: string): AdoptedThread | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > CONTINUE_THREAD_MAX_LENGTH) return null;

  const discord = DISCORD_URL.exec(value);
  if (discord) {
    const [, guild, first, second] = discord;
    // A thread is its own Discord channel, so /<guild>/<thread>[/<message>] names
    // it first. /<guild>/<this channel>/<message> is a message in the parent,
    // whose thread (if it started one) shares the message's id.
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
 * The thread to adopt, or null (logged: the caller then opens a new thread,
 * which is what the agent's post did before this argument existed). Evidence is the host's own record of the
 * thread on THIS messaging group: a session bound to (messaging group, thread)
 * — `idx_sessions_lookup` — or an archived message on the same channel
 * (channel_type + platform_id) in that thread. The archive covers threads the
 * agent was present in but never engaged, whose messages it still keeps.
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
    // An unreadable archive is no evidence; the post opens a new thread as before.
    return null;
  }
}
