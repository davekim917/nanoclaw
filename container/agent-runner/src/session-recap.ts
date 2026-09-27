/**
 * Rebuilds recent history from the session DBs for session-reset paths (stale
 * session, context-too-long). Not for credential rotation: the .jsonl resumes
 * cleanly there.
 */
import { readRecapInboundRows, readRecapOutboundRows } from './modules/mailbox/index.js';

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
 * Null when there is no history. Inbound rows are completed-only, so the
 * in-flight prompt is not duplicated in its own recap.
 */
export function buildSessionRecap(opts: SessionRecapOptions = {}): string | null {
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  let inRows: Array<{ timestamp: string; content: string }> = [];
  let outRows: Array<{ timestamp: string; content: string }> = [];

  try {
    inRows = readRecapInboundRows(maxMessages);
  } catch {
    // Tables missing (fresh session): no history.
  }

  try {
    outRows = readRecapOutboundRows(maxMessages);
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

  const trimmed = merged.slice(-maxMessages);

  const lines = trimmed.map((m) => `[${m.timestamp}] ${m.role}: ${m.text}`);
  let recap = lines.join('\n\n');

  if (recap.length > maxChars) {
    recap = recap.slice(-maxChars);
    const firstBoundary = recap.indexOf('\n\n');
    if (firstBoundary > 0) recap = recap.slice(firstBoundary + 2);
  }

  return recap;
}

export function wrapRecap(recap: string, reason: string): string {
  return (
    `<session-recap reason="${reason}">\n` +
    `The prior agent session was reset. Below is recent conversation history from this thread, restored from the local message DB. ` +
    `Use it as context for the user's next message — do NOT respond to these past turns as if they were new.\n\n` +
    recap +
    `\n</session-recap>\n\n`
  );
}
