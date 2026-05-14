/**
 * Walkie-talkie cross-bot state — see migration 034 for table shape.
 *
 * The protocol is opt-in: agents either emit `[over]` / `[out]` trailers
 * or they don't, and the router checks status only when deciding whether
 * to suppress fanout on bot-authored echoes. Most chats never touch the
 * table.
 */
import { getDb } from '../../db/connection.js';

export type WalkieStatus = 'active' | 'closed';

interface Row {
  status: WalkieStatus;
}

/**
 * Set the walkie-talkie status for a thread. Upserts the row.
 * `threadId` is normalized to '' for DMs / non-threaded channels.
 */
export function setWalkieStatus(messagingGroupId: string, threadId: string | null, status: WalkieStatus): void {
  const tid = threadId ?? '';
  getDb()
    .prepare(
      `INSERT INTO thread_walkie_state (messaging_group_id, thread_id, status, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (messaging_group_id, thread_id) DO UPDATE
         SET status = excluded.status, updated_at = excluded.updated_at`,
    )
    .run(messagingGroupId, tid, status);
}

/**
 * Read the walkie-talkie status for a thread. Returns 'active' as the
 * default (which matches "no row" — the protocol is opt-in).
 */
export function getWalkieStatus(messagingGroupId: string, threadId: string | null): WalkieStatus {
  const tid = threadId ?? '';
  const row = getDb()
    .prepare('SELECT status FROM thread_walkie_state WHERE messaging_group_id = ? AND thread_id = ?')
    .get(messagingGroupId, tid) as Row | undefined;
  return row?.status ?? 'active';
}

/**
 * Strip `[over]` and `[out]` trailers from an outbound chat message.
 * The trailer must be the last token of the message (optionally followed
 * by whitespace). Returns the cleaned text + the trailer (if found) so
 * the caller can act on it. Case-insensitive; tolerates `[OVER]` etc.
 *
 * The trailer is allowed to appear inside a trailing code block — we only
 * match outside backticks to avoid stripping content from a code sample.
 */
export interface TrailerParse {
  text: string;
  trailer: 'over' | 'out' | null;
}

const TRAILER_RE = /\s*\[(over|out)\]\s*$/i;

export function parseTrailer(content: string): TrailerParse {
  if (!content) return { text: content, trailer: null };
  // Don't strip from inside a fenced code block at the end of the message.
  // Heuristic: if the message ends with ``` (closing fence), trailers in
  // code blocks are preserved as content.
  const trimmed = content.trimEnd();
  if (trimmed.endsWith('```')) return { text: content, trailer: null };
  const m = trimmed.match(TRAILER_RE);
  if (!m) return { text: content, trailer: null };
  const trailer = m[1].toLowerCase() as 'over' | 'out';
  const text = trimmed.slice(0, -m[0].length).trimEnd();
  return { text, trailer };
}
