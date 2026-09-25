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

/**
 * Test seam: hand the tools an archive handle instead of opening ARCHIVE_PATH;
 * `null` drops it so the next call opens the path again. Tests must use this
 * rather than `mock.module('bun:sqlite')`: bun module mocks are process-global
 * and `mock.restore()` does not undo them, so every later test file's session
 * DBs would be built from the mock class.
 */
export function _setArchiveDbForTest(db: Database | null): void {
  _db = db;
}

/**
 * When sibling copies of one conversation pool into one.
 *
 * In a workgroup each sibling bot archives the same conversation under its
 * own channel_type (`slack-acme`, `slack-acme-codex`, ...). Those multi-bot
 * types reuse the base platform's adapter, which emits a platform_id carrying
 * the BASE prefix (`slack:C123`) for every bot — `namespacedPlatformId` in
 * src/platform-id.ts. That prefix is the evidence two rows are one
 * conversation: pool on it, and only on it. Native adapters (WhatsApp,
 * Signal, iMessage) emit unprefixed ids, and `whatsapp` / `whatsapp-cloud`
 * are distinct platforms, not base and variant (`isChannelVariant`,
 * src/types.ts) — those rows keep matching on their exact channel_type.
 */
export function channelFamily(channelType: string): string {
  const dash = channelType.indexOf('-');
  return dash > 0 ? channelType.slice(0, dash) : channelType;
}

export function isPooled(channelType: string, platformId: string): boolean {
  return platformId.startsWith(`${channelFamily(channelType)}:`);
}

/** isPooled in SQL, over the row aliased `t`. */
const POOLED_SQL = (t: string): string =>
  `substr(${t}.platform_id, 1, instr(${t}.channel_type || '-', '-')) = ` +
  `substr(${t}.channel_type, 1, instr(${t}.channel_type || '-', '-') - 1) || ':'`;

function sanitizeFtsQuery(q: string): string {
  // FTS5 treats space-separated terms as implicit AND. For chat-sized
  // messages that's far too strict — "docker container build" almost
  // never appears all-three-in-one-message. Join with OR so any term
  // matches; BM25 then ranks rows by how many rare terms they hit.
  const terms = q
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`);
  return terms.join(' OR ');
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
      'Full-text search of past conversations in this agent group. Returns threads ranked by relevance (BM25), with a snippet around each match. Use when the user asks things like "find the thread where we discussed X" or "what did we decide about Y last week".',
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

    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return ok('No searchable tokens in query.');

    // A thread's copy under the caller's own adapter wins the displayed
    // channel_type, so read_thread on the result reads the caller's copy.
    let ownChannelType = '';
    try {
      ownChannelType = getSessionRouting().channel_type ?? '';
    } catch {
      // best-effort: without routing, any sibling's copy is shown
    }
    let rows: SearchHitRow[];
    try {
      rows = db
        .prepare(
          // bun:sqlite named params: both the SQL placeholder AND the JS
          // object keys must carry the `$` prefix (unlike better-sqlite3 on
          // the host, which auto-strips). Using `@name` here produced a
          // "datatype mismatch" at runtime because bun left the params
          // unbound. See CLAUDE.md container-runtime gotchas.
          // BM25 ordering. bm25() returns a negative score, lower = better.
          // The MATERIALIZED hint is load-bearing: without it SQLite inlines
          // the CTE and rewrites the query into a shape where bm25() runs
          // outside its FTS5 MATCH context — the vtab then errors with
          // "unable to use function bm25 in the requested context". Forcing
          // materialization computes scores in the FTS-only block, then the
          // outer query joins on rowid and aggregates per thread.
          `WITH matches AS MATERIALIZED (
             SELECT rowid, bm25(messages_archive_fts) AS score
             FROM messages_archive_fts
             WHERE messages_archive_fts MATCH $q
           )
           SELECT
             a.thread_id,
             CASE WHEN ${POOLED_SQL('a')}
               THEN COALESCE(
                 (SELECT b.channel_type FROM messages_archive b
                   WHERE b.channel_type = $own AND b.platform_id = a.platform_id AND b.thread_id IS a.thread_id
                   LIMIT 1),
                 MIN(a.channel_type))
               ELSE MIN(a.channel_type)
             END AS channel_type,
             MAX(a.channel_name) AS channel_name,
             a.platform_id,
             MAX(a.sent_at) AS latest_message_at,
             COUNT(*) AS match_count,
             MIN(m.score) AS best_score,
             (SELECT snippet(messages_archive_fts, 0, '[', ']', '…', 12)
              FROM messages_archive_fts
              WHERE messages_archive_fts MATCH $q AND rowid = a.rowid
              LIMIT 1) AS first_snippet
           FROM messages_archive a
           JOIN matches m ON m.rowid = a.rowid
           -- One row per conversation: sibling copies pool, see POOLED_SQL.
           GROUP BY CASE WHEN ${POOLED_SQL('a')} THEN '' ELSE a.channel_type END, a.platform_id, a.thread_id
           ORDER BY best_score ASC
           LIMIT $limit`,
        )
        .all({ $q: sanitized, $limit: limit, $own: ownChannelType }) as SearchHitRow[];
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
           WHERE channel_type LIKE ?
             AND platform_id = ?
             AND thread_id = ?
           ORDER BY sent_at ASC
           LIMIT ?`,
        )
        .all(channelType, platformId, threadId, limit) as TranscriptRow[];
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
/**
 * Resolve the channel the caller wants to read from, plus — importantly —
 * the default `thread_id` to use when the caller didn't pin one.
 *
 * The default-thread rule exists because `read_thread` without a thread_id
 * used to fall back to "most recent thread in the channel", which is wrong
 * when the agent is already mid-conversation inside a specific thread: the
 * "most recent" row may well be a different thread that happened to get a
 * message 30 seconds ago. This led to hallucinated cross-thread answers
 * (see the example-data/example incident). Now: if the resolved channel is the same
 * channel as the current session, the session's own thread_id is returned
 * as the default. Callers that want a different thread must pass
 * `thread_id` explicitly.
 */
function resolveRouting(args: {
  channel?: unknown;
  channel_type?: unknown;
  platform_id?: unknown;
}):
  | { channelType: string; platformId: string; channelName: string | null; sessionThreadId: string | null }
  | string {
  let sessionRouting: { channel_type: string | null; platform_id: string | null; thread_id: string | null } = {
    channel_type: null,
    platform_id: null,
    thread_id: null,
  };
  try {
    sessionRouting = getSessionRouting();
  } catch {
    // best-effort — session routing is only used to default thread_id
  }
  const sessionThreadIdForChannel = (ct: string, pid: string): string | null =>
    sessionRouting.channel_type === ct && sessionRouting.platform_id === pid ? sessionRouting.thread_id : null;

  const channelName = typeof args.channel === 'string' ? args.channel.trim() : '';
  if (channelName) {
    const dest = findByName(channelName);
    if (!dest) return `destination ${JSON.stringify(channelName)} not found in this session's map`;
    if (dest.type !== 'channel' || !dest.channelType || !dest.platformId) {
      return `destination ${JSON.stringify(channelName)} is not a channel (type=${dest.type})`;
    }
    return {
      channelType: dest.channelType,
      platformId: dest.platformId,
      channelName: dest.displayName,
      sessionThreadId: sessionThreadIdForChannel(dest.channelType, dest.platformId),
    };
  }
  const ct = typeof args.channel_type === 'string' ? args.channel_type : '';
  const pid = typeof args.platform_id === 'string' ? args.platform_id : '';
  if (ct && pid) {
    return {
      channelType: ct,
      platformId: pid,
      channelName: null,
      sessionThreadId: sessionThreadIdForChannel(ct, pid),
    };
  }
  // Fall back to current session routing entirely.
  if (!sessionRouting.channel_type || !sessionRouting.platform_id) {
    return 'no channel/channel_type+platform_id provided and session routing unavailable';
  }
  return {
    channelType: sessionRouting.channel_type,
    platformId: sessionRouting.platform_id,
    channelName: null,
    sessionThreadId: sessionRouting.thread_id,
  };
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
      'Read the archived transcript of a thread. Designed for cross-thread lookups ("what did we decide in #other-channel", "pull up the thread about Y") AND for recovering deep context inside the current thread when recent history isn\'t enough. When `thread_id` is omitted the tool returns the single most recent thread in the resolved channel — and refuses if the resolved channel is the same as the current session, because "most recent" is unreliable in busy channels (it could pick a sibling thread). To read the current thread, pass `thread_id` explicitly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: 'Destination name from the agent\'s destinations map.' },
        channel_type: { type: 'string', description: 'Raw channel_type (e.g. "slack", "discord"). Used with platform_id.' },
        platform_id: { type: 'string', description: 'Raw platform id. Used with channel_type.' },
        thread_id: { type: 'string', description: 'Specific thread id to load. If omitted, loads the most recent thread in the channel — refused when that channel is the current session\'s channel (pass thread_id explicitly).' },
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

    // Example Data/example guard: refuse the current channel's "most recent thread"
    // fallback. The bug it prevents is silently picking a sibling thread
    // when the channel has many concurrent ones. Passing `thread_id`
    // explicitly is allowed — including for the current session — so the
    // agent can pull deep history when the per-session recap window is
    // too short.
    if (!threadId && routing.sessionThreadId) {
      return err(
        'no thread_id provided and the resolved channel matches the current session — ' +
          'pass thread_id explicitly (use the current session\'s thread_id to read this thread\'s archive)',
      );
    }

    // Pooled conversations read every sibling's copy (see isPooled); anything
    // else reads exactly its own channel_type.
    const pooled = isPooled(routing.channelType, routing.platformId);
    const family = pooled ? channelFamily(routing.channelType) : routing.channelType;
    const familyLike = pooled ? `${family}-%` : null; // LIKE NULL never matches

    let resolvedThreadId = threadId;
    if (!resolvedThreadId) {
      try {
        const latest = db
          .prepare(
            `SELECT thread_id FROM messages_archive
             WHERE (channel_type = ? OR channel_type LIKE ?) AND platform_id = ?
             ORDER BY sent_at DESC LIMIT 1`,
          )
          .get(family, familyLike, routing.platformId) as { thread_id: string | null } | undefined;
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
           WHERE (channel_type = ? OR channel_type LIKE ?)
             AND platform_id = ?
             AND (thread_id = ? OR (thread_id IS NULL AND ? IS NULL))
           ORDER BY sent_at ASC
           LIMIT ?`,
        )
        .all(family, familyLike, routing.platformId, resolvedThreadId, resolvedThreadId, limit) as TranscriptRow[];
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
      'Read the most recent archived thread in another named channel. ONLY call this when the user explicitly asks to review the most recent conversation in a DIFFERENT channel (e.g. "catch me up on #eng-ops"). Do NOT call this to recover context for the thread you are currently in — for that, use `read_current_thread`.',
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

export const readCurrentThreadTool: McpToolDefinition = {
  tool: {
    name: 'read_current_thread',
    description:
      'Read the archived transcript of the THREAD YOU ARE IN. Use when the user asks you to review history beyond what you already have in context — e.g. after a session reset, after compaction, or when they reference messages from earlier in the same conversation that you no longer remember. Pulls from the host-maintained archive (host writes every chat in/out), so it contains the full thread regardless of how the SDK\'s session state evolved.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default 200, max 500).' },
      },
    },
  },
  handler: async (args: Record<string, unknown>) => {
    let session: { channel_type: string | null; platform_id: string | null; thread_id: string | null };
    try {
      session = getSessionRouting();
    } catch (e) {
      return err(`session routing unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!session.channel_type || !session.platform_id) {
      return err('session routing unavailable — no current thread to read');
    }
    if (!session.thread_id) {
      return err(
        'this session has no thread_id (the channel adapter does not use threads) — there is no separate thread archive to read',
      );
    }
    return readThreadTool.handler({
      channel_type: session.channel_type,
      platform_id: session.platform_id,
      thread_id: session.thread_id,
      limit: args.limit,
    });
  },
};

export const threadSearchTools: McpToolDefinition[] = [
  searchThreadsTool,
  resolveThreadLinkTool,
  readThreadTool,
  readThreadByKeyTool,
  readCurrentThreadTool,
];

registerTools(threadSearchTools);
