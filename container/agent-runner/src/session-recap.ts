/**
 * Session recap: rebuild a recent-conversation transcript from the
 * per-session DBs (messages_in + messages_out) so the agent can recover
 * context after the SDK transcript is lost.
 *
 * Only runs on session-reset paths — see poll-loop.ts:
 *   - stale-session error (transcript .jsonl missing or session id unknown)
 *   - context-too-long retry (continuation cleared because the cumulative
 *     prompt exceeded the model's context window)
 *
 * NOT used on credential rotation: the .jsonl is local to the container
 * and resumes cleanly under the new token, so no recap is needed there.
 */
import { getInboundDb, getOutboundDb } from './db/connection.js';

const DEFAULT_MAX_MESSAGES = 30;
const DEFAULT_MAX_CHARS = 12_000;

interface RecapRow {
  role: 'user' | 'assistant';
  timestamp: string;
  text: string;
}

function parseText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.text === 'string') return parsed.text;
    return content;
  } catch {
    return content;
  }
}

export interface SessionRecapOptions {
  maxMessages?: number;
  maxChars?: number;
}

/**
 * Build a chronological transcript of the most recent completed turns
 * for this session. Returns null if nothing is available (e.g. this is
 * the first message of a brand-new session).
 *
 * Inbound rows are filtered to status='completed' so the user's current
 * in-flight prompt (status='processing') doesn't end up duplicated in
 * its own recap.
 */
export function buildSessionRecap(opts: SessionRecapOptions = {}): string | null {
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  let inRows: Array<{ timestamp: string; content: string }> = [];
  let outRows: Array<{ timestamp: string; content: string }> = [];

  try {
    inRows = getInboundDb()
      .prepare(
        `SELECT timestamp, content FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')
           AND status = 'completed'
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(maxMessages) as Array<{ timestamp: string; content: string }>;
  } catch {
    // Tables missing (test harness, fresh session). Treat as no history.
  }

  try {
    outRows = getOutboundDb()
      .prepare(
        `SELECT timestamp, content FROM messages_out
         WHERE kind = 'chat'
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(maxMessages) as Array<{ timestamp: string; content: string }>;
  } catch {
    // Same as above.
  }

  const merged: RecapRow[] = [
    ...inRows.map((r) => ({
      role: 'user' as const,
      timestamp: r.timestamp,
      text: parseText(r.content),
    })),
    ...outRows.map((r) => ({
      role: 'assistant' as const,
      timestamp: r.timestamp,
      text: parseText(r.content),
    })),
  ]
    .filter((r) => r.text && r.text.trim().length > 0)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (merged.length === 0) return null;

  // Keep the most recent `maxMessages` after merge — the inbound and
  // outbound caps above are independent, so the merged list can have up
  // to 2*maxMessages entries.
  const trimmed = merged.slice(-maxMessages);

  const lines = trimmed.map((m) => `[${m.timestamp}] ${m.role}: ${m.text}`);
  let recap = lines.join('\n\n');

  // Char budget. Trim from the front and snap to the next message
  // boundary so we never start a recap mid-message.
  if (recap.length > maxChars) {
    recap = recap.slice(-maxChars);
    const firstBoundary = recap.indexOf('\n\n');
    if (firstBoundary > 0) recap = recap.slice(firstBoundary + 2);
  }

  return recap;
}

/**
 * Wrap a recap string in a marker block. The agent should treat the
 * contents as restored history, not new user input — the framing tells
 * it not to respond to or quote past turns as if they just arrived.
 */
export function wrapRecap(recap: string, reason: string): string {
  return (
    `<session-recap reason="${reason}">\n` +
    `The prior agent session was reset. Below is recent conversation history from this thread, restored from the local message DB. ` +
    `Use it as context for the user's next message — do NOT respond to these past turns as if they were new.\n\n` +
    recap +
    `\n</session-recap>\n\n`
  );
}
