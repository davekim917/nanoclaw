/**
 * Thread-history backfill for a message about to wake an agent. Both doors into a thread session (router
 * mention, agent-to-agent wake) must use it: the router's non-engaged skip leaves messages that exist only in
 * the archive and on the platform, so a door that doesn't backfill loses them.
 *
 * Rule: `sessions.engaged_at IS NULL` ⇒ replay from the top; otherwise replay only what is newer than this
 * agent's last outbound (or its engagement time). Callers must read the session BEFORE `markSessionEngaged`.
 */
import type { ChannelAdapter } from './channels/adapter.js';
import { log } from './log.js';
import type { Session } from './types.js';

/**
 * Accepted costs of replaying instead of accumulating: longer threads lose their oldest messages; Slack's
 * uncursored fetch returns a stale early window past ~200 messages; edits/deletes show as they now stand.
 * Don't reinstate accumulate-on-every-message; raise the cap or add cursoring instead.
 */
export const THREAD_CONTEXT_LIMIT = 50;

export interface ThreadContextOptions {
  /** Its `engaged_at` is the rule; a "did this call create the row" flag lost messages when another path won. */
  session: Session;
  adapter: Pick<ChannelAdapter, 'fetchThreadHistory'> | null | undefined;
  /** Null (no thread, or thread policy stripped it) yields no block. */
  threadId: string | null;
  /** Platform id of the triggering message, so it isn't replayed to itself. */
  excludeMessageId?: string;
}

/** Never throws: a platform fetch failure degrades to no context, and the caller still delivers. */
export async function buildThreadContextBlock(opts: ThreadContextOptions): Promise<string | null> {
  const adapter = opts.adapter;
  const threadId = opts.threadId;
  if (threadId === null) return null;
  // An adapter that cannot replay a thread must never let the router skip a message on the promise that it can.
  if (typeof adapter?.fetchThreadHistory !== 'function') return null;

  const engagedAtMs = parseUtcTimestampMs(opts.session.engaged_at);
  const sinceMs = engagedAtMs === null ? null : (parseUtcTimestampMs(opts.session.last_outbound_at) ?? engagedAtMs);

  try {
    const history = await adapter.fetchThreadHistory(threadId, {
      limit: THREAD_CONTEXT_LIMIT,
      excludeMessageId: opts.excludeMessageId,
    });
    // Anchors are not exempt from the cutoff: a Discord anchor predates the whole thread, so exempting it
    // re-prepends the same parent on every follow-up wake.
    const relevant =
      sinceMs === null
        ? history
        : history.filter((m) => {
            const messageMs = parseUtcTimestampMs(m.timestamp);
            return messageMs === null || messageMs > sinceMs;
          });
    if (relevant.length === 0) return null;
    const header = sinceMs === null ? 'Thread context' : 'New in thread since last response';
    return `[${header}]\n${relevant.map((m) => `${m.sender}: ${m.text}`).join('\n')}`;
  } catch (err) {
    log.warn('Thread-context fetch failed — proceeding without context', {
      sessionId: opts.session.id,
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const LATEST_MESSAGE_MARKER = '[Latest message]\n';

function join(block: string, text: string): string {
  return `${block}\n${LATEST_MESSAGE_MARKER}${text}`;
}

/** The message itself, without a thread-context prefix `withThreadContext` added. */
export function latestMessageText(text: string): string {
  const idx = text.lastIndexOf(LATEST_MESSAGE_MARKER);
  return idx === -1 ? text : text.slice(idx + LATEST_MESSAGE_MARKER.length);
}

export function withThreadContext(contentJson: string, block: string | null): string {
  if (block === null) return contentJson;
  const parsed = JSON.parse(contentJson) as Record<string, unknown>;
  parsed.text = join(block, typeof parsed.text === 'string' ? parsed.text : '');
  return JSON.stringify(parsed);
}

/** Takes raw text, not a JSON content string (that would embed the block as a literal); use `withThreadContext`. */
export async function prependThreadContext(text: string, opts: ThreadContextOptions): Promise<string> {
  const block = await buildThreadContextBlock(opts);
  return block === null ? text : join(block, text);
}

/**
 * Accepts ISO-8601 and SQLite's naive `YYYY-MM-DD HH:MM:SS` (read as UTC). Must keep accepting both: stored rows
 * still hold the naive shape, and a strict parser silently turns the cutoff into "replay everything".
 * The only parser for this job; add callers, not copies.
 */
export function parseUtcTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  let normalized = value.includes('T') ? value : value.replace(' ', 'T');
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized)) normalized += 'Z';
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}
