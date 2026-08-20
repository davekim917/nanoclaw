/**
 * Thread-history backfill — the single place that decides what a thread's
 * platform history should contribute to a message that is about to wake an
 * agent.
 *
 * Two doors reach a session in a thread: an ordinary platform mention through
 * `src/router.ts`, and an agent-to-agent wake through
 * `src/modules/agent-to-agent/`. Both must ask the SAME question, because the
 * router's non-engaged skip (see the comment block at the skip in router.ts)
 * leaves messages that exist only in `messages_archive` and on the platform.
 * A door that doesn't backfill doesn't just miss context, it is the door those
 * messages are lost through.
 *
 * The rule is caller-agnostic on purpose. It is NOT "was this session just
 * created" — a session can be minted by any path — it is a property of the
 * session and the thread:
 *
 *   `sessions.engaged_at IS NULL`  ⇒  no agent has ever engaged in this
 *                                     thread  ⇒  nothing in it has been
 *                                     delivered  ⇒  replay from the top.
 *   `engaged_at` set               ⇒  replay only what is newer than the last
 *                                     thing this agent actually said (or, if
 *                                     it never said anything, than the moment
 *                                     it engaged).
 *
 * Callers must read the session BEFORE stamping `markSessionEngaged`, or the
 * cutoff describes the wake in progress instead of the state before it.
 *
 * Two entry points, one implementation. `buildThreadContextBlock` +
 * `withThreadContext` are the primitives the router uses on a JSON message
 * body; `prependThreadContext` is the composed form for callers holding plain
 * text. Both doors arrived here independently and both are load-bearing — this
 * is not redundancy to tidy away.
 */
import type { ChannelAdapter } from './channels/adapter.js';
import { log } from './log.js';
import type { Session } from './types.js';

/**
 * ── Accepted costs of replaying instead of accumulating ──
 *
 * 1. The replay is hard-capped at this many messages, and effectively one
 *    fewer: the triggering mention is excluded via `excludeMessageId`, but a
 *    thread longer than the cap loses its oldest messages regardless.
 * 2. Slack's `conversations.replies` is called once, with no cursor and
 *    `direction: backward`. Past roughly 200 messages that returns a stale
 *    EARLY window rather than the tail, so a very long thread replays its
 *    beginning, not its most recent activity.
 * 3. Replay reflects the platform's CURRENT state. Edits and deletes that
 *    happened after the fact are reflected as they now stand — the streamed
 *    copy an accumulate would have kept is gone.
 *
 * These are the price of not minting a session per un-engaged thread, and
 * they were accepted deliberately. Do not "fix" them by reinstating
 * accumulate-on-every-message; raise the cap or add cursoring instead.
 */
export const THREAD_CONTEXT_LIMIT = 50;

/**
 * Build the `[Thread context]` / `[New in thread since last response]` block
 * for a wake landing in `threadId`, or null when there is nothing to prepend.
 *
 * Never throws: a platform fetch failure degrades to "no context", exactly as
 * the inline version it replaced did. The caller still delivers the message.
 */
export interface ThreadContextOptions {
  /**
   * The session about to be woken. Its `engaged_at` IS the rule — there is
   * deliberately no `firstWake` flag, because "did this call create the row"
   * is the question that lost skipped messages whenever some other path got
   * to the session first.
   */
  session: Session;
  /**
   * The adapter that owns this conversation, already resolved by the caller —
   * `getChannelAdapter(event.instance ?? event.channelType)` on the router
   * side, `getChannelAdapter(mg.instance ?? mg.channel_type)` elsewhere. Taken
   * as a parameter rather than re-resolved here so both doors are provably
   * talking to the same instance, and so this module needs no registry import.
   */
  adapter: Pick<ChannelAdapter, 'fetchThreadHistory'> | null | undefined;
  /** Null (no thread, or thread policy stripped it) yields no block. */
  threadId: string | null;
  /** Platform id of the triggering message, so it isn't replayed to itself. */
  excludeMessageId?: string;
}

export async function buildThreadContextBlock(opts: ThreadContextOptions): Promise<string | null> {
  const adapter = opts.adapter;
  const threadId = opts.threadId;
  if (threadId === null) return null;
  // Capability gate, BY NAME. Only the chat-sdk bridge (Slack, Discord)
  // implements `fetchThreadHistory` in this checkout; `cli` does not, and the
  // adapters on the channels branch are unverified. An adapter that cannot
  // replay a thread cannot be a backfill target — and, upstream of this, must
  // never let the router skip a message on the promise that it can.
  if (typeof adapter?.fetchThreadHistory !== 'function') return null;

  // Read the pre-wake engagement state. NULL ⇒ unbackfilled history.
  const engagedAtMs = parseUtcTimestampMs(opts.session.engaged_at);
  const sinceMs = engagedAtMs === null ? null : (parseUtcTimestampMs(opts.session.last_outbound_at) ?? engagedAtMs);

  try {
    const history = await adapter.fetchThreadHistory(threadId, {
      limit: THREAD_CONTEXT_LIMIT,
      excludeMessageId: opts.excludeMessageId,
    });
    // Timestamp-only, anchors included. `isAnchor` deliberately does NOT
    // exempt a message from the cutoff: that exemption existed and was
    // removed in 993e4bee ("Fix stale thread context replay"), because a
    // Discord anchor is older than the whole thread by construction, so
    // exempting it re-prepends the same parent message on every single
    // follow-up wake forever. `src/router.test.ts` ("does not replay stale
    // anchors") is the standing contract. Anchors still arrive intact on the
    // engagement that matters — an unengaged session has no cutoff at all.
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

/** The one place the block and the trigger text are joined. */
function join(block: string, text: string): string {
  return `${block}\n[Latest message]\n${text}`;
}

/** Prepend a context block to the `text` field of a JSON message body. */
export function withThreadContext(contentJson: string, block: string | null): string {
  if (block === null) return contentJson;
  const parsed = JSON.parse(contentJson) as Record<string, unknown>;
  parsed.text = join(block, typeof parsed.text === 'string' ? parsed.text : '');
  return JSON.stringify(parsed);
}

/**
 * Composed entry point for callers holding PLAIN TEXT rather than a JSON
 * message body: fetch the block and prepend it in one call, returning `text`
 * unchanged when there is nothing to add. `buildThreadContextBlock` and
 * `withThreadContext` are the primitives; this is a two-line convenience over
 * them, not a second implementation.
 *
 * Note it takes raw text, NOT a JSON content string — passing serialized
 * content here would embed the block inside the JSON as a literal instead of
 * into its `text` field. Use `withThreadContext` for that.
 */
export async function prependThreadContext(text: string, opts: ThreadContextOptions): Promise<string> {
  const block = await buildThreadContextBlock(opts);
  return block === null ? text : join(block, text);
}

/**
 * Tolerant timestamp parse: accepts ISO-8601 and the naive
 * `YYYY-MM-DD HH:MM:SS` shape SQLite's `datetime('now')` produces, reading
 * the latter as UTC rather than local.
 *
 * IT MUST KEEP ACCEPTING BOTH SHAPES INDEFINITELY. Tightening it to
 * strict-ISO looks like an obvious cleanup and is not: naive values were
 * written for years, so every historical `last_outbound_at` / `engaged_at`
 * row still holds that shape. A strict parser returns null for them, the
 * cutoff silently becomes "no cutoff", and the backfill replays whole threads
 * for all pre-fix data without erroring anywhere. Fixing the writers does not
 * retire this tolerance; only rewriting the stored rows would.
 *
 * Moved here verbatim from a private definition in `router.ts` — it sits on
 * both sides of the cutoff comparison above, and it had no other home.
 *
 * **This is the ONLY parser for this job.** It had grown four independent
 * copies — one exported from `dashboard/api/observatory.ts` as `parseUtcMs`, and
 * private clones in `scheduled-mutations.ts` and `scheduled-move.ts` — all
 * solving the same problem with the same regex and none of them carrying the
 * paragraph above. Four copies is four chances to "clean up" the tolerance in a
 * file where the consequence is invisible. Add a caller here; do not add a
 * fifth definition.
 */
export function parseUtcTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  let normalized = value.includes('T') ? value : value.replace(' ', 'T');
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized)) normalized += 'Z';
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}
