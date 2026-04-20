/**
 * Thread Search + Permalink Resolver MCP tools (Phase 2.9 + 2.10).
 *
 * Queries the host-maintained central archive mounted read-only at
 * /workspace/archive.db. Host writes on every chat inbound/outbound;
 * container reads via these tools.
 */
import { Database } from 'bun:sqlite';

import { findByName } from '../destinations.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const ARCHIVE_PATH = '/workspace/archive.db';

function log(msg: string): void {
  console.error(`[thread-search] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

let _db: Database | null = null;
function getDb(): Database | null {
  if (_db) return _db;
  try {
    _db = new Database(ARCHIVE_PATH, { readonly: true });
    return _db;
  } catch (e) {
    log(`Archive not available at ${ARCHIVE_PATH}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function currentAgentGroupId(): string | undefined {
  return process.env.NANOCLAW_AGENT_GROUP_ID || undefined;
}

function sanitizeFtsQuery(q: string): string {
  return q
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`)
    .join(' ');
}

interface SearchHitRow {
  thread_id: string | null;
  channel_type: string;
  channel_name: string | null;
  platform_id: string | null;
  latest_message_at: string;
  match_count: number;
  first_snippet: string | null;
}

export const searchThreadsTool: McpToolDefinition = {
  tool: {
    name: 'search_threads',
    description:
      'Full-text search of past conversations in this agent group. Returns threads that match the query, most recent first, with a snippet around each match. Use when the user asks things like "find the thread where we discussed X" or "what did we decide about Y last week".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keywords or phrase to search for.' },
        limit: { type: 'number', description: 'Max thread hits to return (default 10, max 30).' },
      },
      required: ['query'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const query = typeof args.query === 'string' ? args.query : '';
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 30) : 10;
    if (!query.trim()) return err('query is required');

    const db = getDb();
    if (!db) return err('archive database not mounted — host may be too old for thread search');

    const ag = currentAgentGroupId();
    if (!ag) return err('agent group id unavailable — NANOCLAW_AGENT_GROUP_ID not set');

    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return ok('No searchable tokens in query.');

    let rows: SearchHitRow[];
    try {
      rows = db
        .prepare(
          `SELECT
             a.thread_id,
             a.channel_type,
             MAX(a.channel_name) AS channel_name,
             a.platform_id,
             MAX(a.sent_at) AS latest_message_at,
             COUNT(*) AS match_count,
             (SELECT snippet(messages_archive_fts, 0, '[', ']', '…', 12)
              FROM messages_archive_fts
              WHERE messages_archive_fts MATCH @q AND rowid = a.rowid) AS first_snippet
           FROM messages_archive a
           JOIN messages_archive_fts f ON f.rowid = a.rowid
           WHERE a.agent_group_id = @ag
             AND messages_archive_fts MATCH @q
           GROUP BY a.thread_id, a.channel_type, a.platform_id
           ORDER BY latest_message_at DESC
           LIMIT @limit`,
        )
        .all({ ag, q: sanitized, limit }) as SearchHitRow[];
    } catch (e) {
      return err(`FTS search failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (rows.length === 0) return ok('No threads matched that query.');

    const lines = rows.map((r, i) => {
      const where = r.channel_name ? `#${r.channel_name}` : `${r.channel_type}:${r.platform_id}`;
      const loc = r.thread_id ? `${where} thread=${r.thread_id}` : where;
      return `${i + 1}. ${loc}\n   ${r.match_count} match(es), latest ${r.latest_message_at}\n   …${r.first_snippet ?? ''}…`;
    });
    return ok(`Found ${rows.length} thread(s):\n\n${lines.join('\n\n')}`);
  },
};

interface TranscriptRow {
  role: string;
  sender_name: string | null;
  text: string;
  sent_at: string;
  channel_name: string | null;
}

function parseSlackUrl(url: string): { channel: string; ts: string; threadTs?: string } | null {
  // https://<workspace>.slack.com/archives/<channel_id>/p<ts_without_dot>?thread_ts=<thread_ts>
  const m = url.match(/slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d+)(?:\?.*)?$/);
  if (!m) return null;
  const [, channel, sec, frac] = m;
  const ts = `${sec}.${frac}`;
  const threadTsMatch = url.match(/[?&]thread_ts=([0-9.]+)/);
  return { channel, ts, threadTs: threadTsMatch ? threadTsMatch[1] : undefined };
}

function parseDiscordUrl(url: string): { guild: string; channel: string; message: string } | null {
  const m = url.match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  const [, guild, channel, message] = m;
  return { guild, channel, message };
}

export const resolveThreadLinkTool: McpToolDefinition = {
  tool: {
    name: 'resolve_thread_link',
    description:
      'Load the messages from a pasted Slack or Discord thread link. Returns the thread as a transcript (sender, text, timestamp). Use when the user pastes a URL and asks to "reference this thread".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Slack or Discord message/thread URL.' },
        limit: { type: 'number', description: 'Max messages to return (default 200).' },
      },
      required: ['url'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const url = typeof args.url === 'string' ? args.url : '';
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 500) : 200;
    if (!url.trim()) return err('url is required');

    const db = getDb();
    if (!db) return err('archive database not mounted');

    const ag = currentAgentGroupId();
    if (!ag) return err('agent group id unavailable');

    // Figure out channel_type + platform_id + thread_id we should load.
    let channelType: string | null = null;
    let platformId: string | null = null;
    let threadId: string | null = null;

    const slack = parseSlackUrl(url);
    if (slack) {
      // The channelType in v2 may be 'slack' or 'slack-<workspace>'. Query by
      // LIKE so we catch either convention without being told which.
      channelType = 'slack%';
      platformId = `slack:${slack.channel}`;
      threadId = slack.threadTs
        ? `slack:${slack.channel}:${slack.threadTs}`
        : `slack:${slack.channel}:${slack.ts}`;
    } else {
      const dc = parseDiscordUrl(url);
      if (dc) {
        channelType = 'discord';
        platformId = `discord:${dc.guild}:${dc.channel}`;
        threadId = dc.message;
      }
    }

    if (!channelType || !platformId) {
      return err('Could not parse URL — only Slack and Discord thread links are supported.');
    }

    let rows: TranscriptRow[];
    try {
      rows = db
        .prepare(
          `SELECT role, sender_name, text, sent_at, channel_name
           FROM messages_archive
           WHERE agent_group_id = ?
             AND channel_type LIKE ?
             AND platform_id = ?
             AND thread_id = ?
           ORDER BY sent_at ASC
           LIMIT ?`,
        )
        .all(ag, channelType, platformId, threadId, limit) as TranscriptRow[];
    } catch (e) {
      return err(`lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (rows.length === 0) return ok('No archived messages found for that link.');

    const channelName = rows.find((r) => r.channel_name)?.channel_name ?? null;
    const header = channelName
      ? `Thread transcript from #${channelName} (${rows.length} message(s)):`
      : `Thread transcript (${rows.length} message(s)):`;
    const transcript = rows
      .map((r) => `[${r.sent_at}] ${r.sender_name ?? r.role}: ${r.text}`)
      .join('\n');
    return ok(`${header}\n\n${transcript}`);
  },
};

/**
 * Shared routing resolution: a caller can address a thread either by a
 * destination name ("channel key") from the agent's destinations map, or
 * by raw (channel_type, platform_id). If neither is given, fall back to
 * the session's own routing — so the agent can say "read this thread"
 * and get the current conversation's transcript.
 */
function resolveRouting(args: {
  channel?: unknown;
  channel_type?: unknown;
  platform_id?: unknown;
}): { channelType: string; platformId: string; channelName: string | null } | string {
  const channelName = typeof args.channel === 'string' ? args.channel.trim() : '';
  if (channelName) {
    const dest = findByName(channelName);
    if (!dest) return `destination ${JSON.stringify(channelName)} not found in this session's map`;
    if (dest.type !== 'channel' || !dest.channelType || !dest.platformId) {
      return `destination ${JSON.stringify(channelName)} is not a channel (type=${dest.type})`;
    }
    return { channelType: dest.channelType, platformId: dest.platformId, channelName: dest.displayName };
  }
  const ct = typeof args.channel_type === 'string' ? args.channel_type : '';
  const pid = typeof args.platform_id === 'string' ? args.platform_id : '';
  if (ct && pid) return { channelType: ct, platformId: pid, channelName: null };
  // Fall back to current session routing.
  try {
    const r = getSessionRouting();
    if (!r.channel_type || !r.platform_id) {
      return 'session routing incomplete (missing channel_type or platform_id)';
    }
    return { channelType: r.channel_type, platformId: r.platform_id, channelName: null };
  } catch {
    return 'no channel/channel_type+platform_id provided and session routing unavailable';
  }
}

function renderTranscript(rows: TranscriptRow[], header: string): string {
  if (rows.length === 0) return 'No archived messages found.';
  const transcript = rows
    .map((r) => `[${r.sent_at}] ${r.sender_name ?? r.role}: ${r.text}`)
    .join('\n');
  return `${header}\n\n${transcript}`;
}

export const readThreadTool: McpToolDefinition = {
  tool: {
    name: 'read_thread',
    description:
      'Read the archived transcript of a specific thread. Pass either `channel` (a destination name from your destinations map) or `channel_type` + `platform_id` to scope the lookup. Omit both to read from the current session. Pass `thread_id` to pin a specific thread, otherwise the most recent thread in that channel is returned.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: 'Destination name from the agent\'s destinations map.' },
        channel_type: { type: 'string', description: 'Raw channel_type (e.g. "slack", "discord"). Used with platform_id.' },
        platform_id: { type: 'string', description: 'Raw platform id. Used with channel_type.' },
        thread_id: { type: 'string', description: 'Specific thread id to load. If omitted, loads the most recent thread in the channel.' },
        limit: { type: 'number', description: 'Max messages to return (default 200, max 500).' },
      },
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const routing = resolveRouting(args);
    if (typeof routing === 'string') return err(routing);
    const threadId = typeof args.thread_id === 'string' && args.thread_id.trim() ? args.thread_id.trim() : null;
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 500) : 200;

    const db = getDb();
    if (!db) return err('archive database not mounted');
    const ag = currentAgentGroupId();
    if (!ag) return err('agent group id unavailable');

    let resolvedThreadId = threadId;
    if (!resolvedThreadId) {
      try {
        const latest = db
          .prepare(
            `SELECT thread_id FROM messages_archive
             WHERE agent_group_id = ? AND channel_type = ? AND platform_id = ?
             ORDER BY sent_at DESC LIMIT 1`,
          )
          .get(ag, routing.channelType, routing.platformId) as { thread_id: string | null } | undefined;
        resolvedThreadId = latest?.thread_id ?? null;
      } catch (e) {
        return err(`thread lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    let rows: TranscriptRow[];
    try {
      rows = db
        .prepare(
          `SELECT role, sender_name, text, sent_at, channel_name
           FROM messages_archive
           WHERE agent_group_id = ?
             AND channel_type = ?
             AND platform_id = ?
             AND (thread_id = ? OR (thread_id IS NULL AND ? IS NULL))
           ORDER BY sent_at ASC
           LIMIT ?`,
        )
        .all(ag, routing.channelType, routing.platformId, resolvedThreadId, resolvedThreadId, limit) as TranscriptRow[];
    } catch (e) {
      return err(`lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const channelLabel = routing.channelName ?? `${routing.channelType}:${routing.platformId}`;
    const threadLabel = resolvedThreadId ? ` thread=${resolvedThreadId}` : '';
    const header = `Thread transcript from ${channelLabel}${threadLabel} (${rows.length} message(s)):`;
    return ok(renderTranscript(rows, header));
  },
};

export const readThreadByKeyTool: McpToolDefinition = {
  tool: {
    name: 'read_thread_by_key',
    description:
      'Read the most recent thread from a channel, addressed by its destination name (the `name` field in the agent\'s destinations map — e.g. "eng-ops"). Convenience wrapper around read_thread when you only know the human name of the channel.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Destination name (key) from the destinations map.' },
        limit: { type: 'number', description: 'Max messages to return (default 200, max 500).' },
      },
      required: ['key'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const key = typeof args.key === 'string' ? args.key.trim() : '';
    if (!key) return err('key is required');
    return readThreadTool.handler({ channel: key, limit: args.limit });
  },
};

export const threadSearchTools: McpToolDefinition[] = [
  searchThreadsTool,
  resolveThreadLinkTool,
  readThreadTool,
  readThreadByKeyTool,
];

registerTools(threadSearchTools);
