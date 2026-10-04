/**
 * Current chat/thread routing for this session — written by the host on every
 * container wake (see src/session-manager.ts `writeSessionRouting`).
 *
 * Read by MCP tools to preserve the current thread when an explicitly named
 * destination resolves to the chat this session is bound to.
 */
import { getAgentMailbox } from '../mailbox/index.js';
import { getCurrentReplyRoute } from './session-state.js';

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export function getSessionRouting(): SessionRouting {
  const routing = getAgentMailbox().operations.getSessionRouting();
  return {
    channel_type: routing.channelType,
    platform_id: routing.platformId,
    thread_id: routing.threadId,
  };
}

/**
 * The thread a post to `platformId` continues: the answered message's thread when that message came from this chat,
 * else the session's bound thread when this is the session's own chat. A shared session's bound thread is null even
 * when the request arrived in a thread, so the bound thread alone sends a threaded answer to the channel root.
 * Compares by platform id, not channel type: siblings reach one chat through different channel types.
 */
export function inheritedThreadFor(platformId: string): string | null {
  const reply = getCurrentReplyRoute();
  if (reply?.threadId && reply.platformId === platformId) return reply.threadId;
  const session = getSessionRouting();
  return session.platform_id === platformId ? session.thread_id : null;
}

const TASK_THREAD_PREFIX = 'system:tasks:';

/** The task id encoded in this isolated task session's canonical thread id. */
export function getTaskSeriesId(): string | null {
  const threadId = getSessionRouting().thread_id;
  return threadId?.startsWith(TASK_THREAD_PREFIX) ? threadId.slice(TASK_THREAD_PREFIX.length) : null;
}
