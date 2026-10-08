/**
 * Central archive of every chat message, in `data/archive.db` with an FTS5 table. A separate file from v2.db so
 * it can be mounted read-only into containers without exposing central state; hence its self-bootstrapping
 * schema outside the migration chain.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const ARCHIVE_PATH = path.join(DATA_DIR, 'archive.db');

/**
 * Per-agent-group counter of in-place rewrites (the upsert's `DO UPDATE`), which move neither `COUNT(*)` nor
 * `MAX(rowid)` and would otherwise slip past the archive projection's freshness stamp. Columns absent from the
 * `WHEN` clause are ones no write path updates; if one ever does, add it (the projection's dedup key includes it).
 */
export const ARCHIVE_MUTATION_MARKS_SQL = `
  CREATE TABLE IF NOT EXISTS archive_row_marks (
    agent_group_id TEXT PRIMARY KEY,
    mutations      INTEGER NOT NULL DEFAULT 0
  );
  CREATE TRIGGER IF NOT EXISTS messages_archive_mark_update
  AFTER UPDATE ON messages_archive
  WHEN old.text IS NOT new.text
    OR old.sender_name IS NOT new.sender_name
    OR old.channel_name IS NOT new.channel_name
  BEGIN
    INSERT INTO archive_row_marks (agent_group_id, mutations) VALUES (new.agent_group_id, 1)
    ON CONFLICT(agent_group_id) DO UPDATE SET mutations = mutations + 1;
  END;
  CREATE TRIGGER IF NOT EXISTS messages_archive_mark_delete
  AFTER DELETE ON messages_archive
  BEGIN
    INSERT INTO archive_row_marks (agent_group_id, mutations) VALUES (old.agent_group_id, 1)
    ON CONFLICT(agent_group_id) DO UPDATE SET mutations = mutations + 1;
  END;
`;

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

function openDb(): Database.Database {
  // Re-keyed on the path: under test the cached connection can point at an unlinked fd.
  if (_db && _dbPath === ARCHIVE_PATH && fs.existsSync(ARCHIVE_PATH)) return _db;
  if (_db) {
    try {
      _db.close();
    } catch {
      // swallow — stale handle
    }
    _db = null;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(ARCHIVE_PATH);
  // TRUNCATE, not WAL: containers mount only archive.db, not the -wal/-shm sidecars, so WAL writes are invisible.
  db.pragma('journal_mode = TRUNCATE');
  db.pragma('synchronous = NORMAL');
  initSchema(db);
  _db = db;
  _dbPath = ARCHIVE_PATH;
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_archive (
      id                  TEXT PRIMARY KEY,
      agent_group_id      TEXT NOT NULL,
      messaging_group_id  TEXT,
      channel_type        TEXT NOT NULL,
      channel_name        TEXT,
      platform_id         TEXT,
      thread_id           TEXT,
      role                TEXT NOT NULL,     -- 'user' | 'assistant' | 'system'
      sender_id           TEXT,
      sender_name         TEXT,
      text                TEXT NOT NULL,
      sent_at             TEXT NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Additive migration for pre-existing archives that were created
    -- without the channel_name column. No-op if the column already
    -- exists (we swallow the SQLITE_ERROR below).
  `);
  try {
    db.exec('ALTER TABLE messages_archive ADD COLUMN channel_name TEXT');
  } catch {
    // column already exists
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archive_ag_sent ON messages_archive(agent_group_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_archive_thread ON messages_archive(agent_group_id, thread_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_archive_channel ON messages_archive(channel_type, platform_id, thread_id);
    -- Covering index for the archive-change fingerprint
    -- (pollArchiveOnce, every 10s). Without it that poll scans the table and
    -- reads every row's text — it was the single largest disk consumer on the
    -- box, and the resulting IO saturation is what stalled the host's event
    -- loop. Keep the column order aligned with that query's filters.
    CREATE INDEX IF NOT EXISTS idx_archive_fingerprint
      ON messages_archive(agent_group_id, role, channel_type, sent_at);

    -- Pre-turn sender recall (recentConversationSenders, once per turn).
    -- Without it the planner falls back to idx_archive_fingerprint, whose
    -- leading agent_group_id constraint matches ~half the table for a
    -- multi-member workgroup, then temp-B-tree sorts all of it for a LIMIT
    -- 100. Column order is load-bearing in three parts:
    --   messaging_group_id, role  — the two real equalities, most selective
    --     first: on the live archive a messaging group holds a median 252 /
    --     mean 1,735 / max 11,294 of the 145,752 rows, where role='user'
    --     alone matches 123,423.
    --   sent_at, id               — the ORDER BY, in order, so the LIMIT walks
    --     the index backwards instead of sorting. id is the UNIQUE primary
    --     key, which is what makes that ordering total and the plan swap
    --     result-preserving; sent_at alone ties on 47k live values.
    --   agent_group_id, thread_id, sender_name, sender_id — after the sort
    --     columns, to make the index covering. The residual filters (member
    --     scope, thread) are not index constraints, so without these every
    --     walked entry costs a table lookup: dropping the trailing columns
    --     costs 19ms vs 2.1ms on the busiest messaging group in the install,
    --     and the planner reports plain INDEX instead of COVERING INDEX.
    --     sender_id joined the trailing set when the canonical-name preference
    --     match started reading it too — an existing install's index predates
    --     that column, so it is dropped and recreated below rather than left
    --     silently non-covering under CREATE INDEX IF NOT EXISTS.
    -- Measured against a copy of the 309MiB / 145,752-row live archive, six
    -- member agent groups of one workgroup: 134ms -> 2.1ms, identical for a hot
    -- thread and for a fresh thread whose rows do not exist. Index costs
    -- +24.3MiB and ~1.4-2.0s to build; archive INSERT p50 is unchanged
    -- (7.5ms -> 6.5ms, within noise — the TRUNCATE-journal fsync dominates the
    -- write).
  `);
  const convRecentColumns = db.prepare(`PRAGMA index_info(idx_archive_conv_recent)`).all() as Array<{
    name: string;
  }>;
  if (convRecentColumns.length > 0 && !convRecentColumns.some((col) => col.name === 'sender_id')) {
    db.exec('DROP INDEX idx_archive_conv_recent');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archive_conv_recent
      ON messages_archive(messaging_group_id, role, sent_at, id,
                          agent_group_id, thread_id, sender_name, sender_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_archive_fts USING fts5(
      text,
      sender_name,
      content='messages_archive',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_archive_ai AFTER INSERT ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(rowid, text, sender_name)
      VALUES (new.rowid, new.text, new.sender_name);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_archive_ad AFTER DELETE ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
      VALUES ('delete', old.rowid, old.text, old.sender_name);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_archive_au AFTER UPDATE ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
      VALUES ('delete', old.rowid, old.text, old.sender_name);
      INSERT INTO messages_archive_fts(rowid, text, sender_name)
      VALUES (new.rowid, new.text, new.sender_name);
    END;
  `);
  ensureArchiveRowMarks(db);
}

/** Reads `sqlite_master` because `IF NOT EXISTS` can't tell "created" from "already there". */
function ensureArchiveRowMarks(db: Database.Database): void {
  const present = new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE name IN ('archive_row_marks', 'messages_archive_mark_update', 'messages_archive_mark_delete')`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (present.size === 3) {
    db.exec(ARCHIVE_MUTATION_MARKS_SQL);
    return;
  }
  const startedAt = Date.now();
  db.exec(ARCHIVE_MUTATION_MARKS_SQL);
  log.info('Archive row-marks schema created', { ms: Date.now() - startedAt });
}

/** Otherwise the schema appears only on the first archive write, and until then every spawn does a full rebuild. */
export function ensureArchiveSchema(): void {
  openDb();
}

export function __resetArchiveConnectionForTest(): void {
  if (!_db) return;
  try {
    _db.close();
  } catch {
    // stale handle
  }
  _db = null;
  _dbPath = null;
}

export interface ArchiveMessage {
  id: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  channelType: string;
  channelName: string | null;
  platformId: string | null;
  threadId: string | null;
  role: 'user' | 'assistant' | 'system';
  senderId: string | null;
  senderName: string | null;
  text: string;
  sentAt: string;
}

/** The ONLY statement in the host that writes `messages_archive`; the freshness stamp depends on that (test-held). */
export const ARCHIVE_UPSERT_SQL = `INSERT INTO messages_archive
       (id, agent_group_id, messaging_group_id, channel_type, channel_name, platform_id, thread_id, role, sender_id, sender_name, text, sent_at)
     VALUES (@id, @agentGroupId, @messagingGroupId, @channelType, @channelName, @platformId, @threadId, @role, @senderId, @senderName, @text, @sentAt)
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       sender_name = excluded.sender_name,
       channel_name = COALESCE(excluded.channel_name, channel_name)
     WHERE excluded.text IS NOT NULL`;

const upsertStmt = () => openDb().prepare(ARCHIVE_UPSERT_SQL);

export function upsertArchiveMessage(msg: ArchiveMessage): void {
  if (!msg.text || msg.text.length === 0) return;
  try {
    upsertStmt().run(msg);
  } catch (err) {
    log.warn('Failed to upsert archive message', { id: msg.id, err });
  }
}

/** Throws rather than swallowing: when the router skips a message, the archive row is its only copy. */
export function archiveMessage(msg: ArchiveMessage): boolean {
  if (!msg.text || msg.text.length === 0) return false;
  upsertStmt().run(msg);
  return true;
}

/**
 * Matched by channel address, not messaging group (task outbound rows carry none). Sibling bots' copies pool by
 * channel family, the same rule as `search_threads`; an unprefixed native id keeps exact channel_type matching.
 */
export function archiveHasThread(channelType: string, platformId: string, threadId: string): boolean {
  const row = openDb()
    .prepare(
      `SELECT 1 FROM messages_archive
        WHERE (channel_type = ? OR channel_type = ? OR channel_type LIKE ?) AND platform_id = ? AND thread_id = ?
        LIMIT 1`,
    )
    .get(...pooledChannelTypes(channelType, platformId), platformId, threadId);
  return row !== undefined;
}

function pooledChannelTypes(channelType: string, platformId: string): [string, string, string | null] {
  const dash = channelType.indexOf('-');
  const family = dash > 0 ? channelType.slice(0, dash) : channelType;
  const pooled = platformId.startsWith(`${family}:`);
  return [channelType, pooled ? family : channelType, pooled ? `${family}-%` : null];
}

export interface ArchivedThreadMessage {
  id: string;
  senderName: string | null;
  text: string;
  sentAt: string;
}

/**
 * One thread's messages, oldest first, pooled like `archiveHasThread`: its replies plus its starter message, which a
 * Discord thread shares its id with (`<id>` or `<id>:<agent group>`). Sibling copies of one message collapse on
 * (time, text), so a message counts once.
 */
export function readArchivedThread(
  channelType: string,
  platformId: string,
  threadPlatformId: string,
): ArchivedThreadMessage[] {
  // The pooled channel types are listed by an index skip-scan first: a LIKE against channel_type makes the planner
  // scan the whole archive instead of seeking idx_archive_channel.
  const rows = openDb()
    .prepare(
      `WITH RECURSIVE kinds(v) AS (
         SELECT MIN(channel_type) FROM messages_archive
         UNION ALL
         SELECT (SELECT MIN(channel_type) FROM messages_archive WHERE channel_type > v) FROM kinds WHERE v IS NOT NULL)
       SELECT id, sender_name AS senderName, text, sent_at AS sentAt FROM messages_archive
        WHERE channel_type IN (SELECT v FROM kinds WHERE v = ? OR v = ? OR v LIKE ?)
          AND platform_id = ? AND thread_id IN (?, ?)
       UNION
       SELECT id, sender_name, text, sent_at FROM messages_archive
        WHERE (id = ? OR (id >= ? AND id < ?)) AND platform_id = ?
       ORDER BY sentAt`,
    )
    .all(
      ...pooledChannelTypes(channelType, platformId),
      platformId,
      threadPlatformId,
      `${platformId}:${threadPlatformId}`,
      threadPlatformId,
      `${threadPlatformId}:`,
      `${threadPlatformId};`,
      platformId,
    ) as ArchivedThreadMessage[];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify([row.sentAt, row.text.slice(0, 200)]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ArchiveEvidenceRow {
  id: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  channelType: string;
  channelName: string | null;
  platformId: string | null;
  threadId: string | null;
  role: string;
  senderId: string | null;
  senderName: string | null;
  text: string;
  sentAt: string;
  rank: 'exact-link' | 'current-thread' | 'workgroup';
}

interface ArchiveSqlRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  channel_type: string;
  channel_name: string | null;
  platform_id: string | null;
  thread_id: string | null;
  role: string;
  sender_id: string | null;
  sender_name: string | null;
  text: string;
  sent_at: string;
}

function toEvidence(row: ArchiveSqlRow, rank: ArchiveEvidenceRow['rank']): ArchiveEvidenceRow {
  return {
    id: row.id,
    agentGroupId: row.agent_group_id,
    messagingGroupId: row.messaging_group_id,
    channelType: row.channel_type,
    channelName: row.channel_name,
    platformId: row.platform_id,
    threadId: row.thread_id,
    role: row.role,
    senderId: row.sender_id,
    senderName: row.sender_name,
    text: row.text,
    sentAt: row.sent_at,
    rank,
  };
}

function trustedMemberClause(memberAgentGroupIds: string[]): { sql: string; params: string[] } {
  const ids = [...new Set(memberAgentGroupIds)].sort();
  if (ids.length === 0) return { sql: '0', params: [] };
  return { sql: `agent_group_id IN (${ids.map(() => '?').join(',')})`, params: ids };
}

const ARCHIVE_FTS_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'com',
  'for',
  'from',
  'how',
  'http',
  'https',
  'in',
  'is',
  'it',
  'of',
  'on',
  'that',
  'the',
  'this',
  'to',
  'was',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
  'www',
]);

/** FTS5 query shape shared with the container thread-search tool: OR quoted, non-trivial tokens. */
export function sanitizeArchiveFtsQuery(query: string): string {
  const terms = query
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}_\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((term) => term.length > 1 && !ARCHIVE_FTS_STOP_WORDS.has(term))
    .slice(0, 24)
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  return terms.join(' OR ');
}

/** Newest first; deterministic, no ranking or FTS. */
export function recentConversationSenders(input: {
  memberAgentGroupIds: string[];
  messagingGroupId: string | null;
  threadId: string | null;
  rowLimit?: number;
  nameLimit?: number;
}): Array<{ senderName: string; senderId: string | null }> {
  if (input.memberAgentGroupIds.length === 0 || !input.messagingGroupId) return [];
  const scope = trustedMemberClause(input.memberAgentGroupIds);
  const rows = openDb()
    .prepare(
      `SELECT sender_name, sender_id
         FROM messages_archive
        WHERE ${scope.sql}
          AND role = 'user'
          AND sender_name IS NOT NULL
          AND messaging_group_id = ?
          AND ((? IS NOT NULL AND thread_id = ?) OR (? IS NULL AND thread_id IS NULL))
        ORDER BY sent_at DESC, id DESC
        LIMIT ?`,
    )
    .all(
      ...scope.params,
      input.messagingGroupId,
      input.threadId,
      input.threadId,
      input.threadId,
      input.rowLimit ?? 100,
    ) as Array<{ sender_name: string; sender_id: string | null }>;
  const senders: Array<{ senderName: string; senderId: string | null }> = [];
  const seenKeys = new Set<string>();
  for (const row of rows) {
    // Dedupe on sender_id, not name, so two people sharing a display name aren't collapsed.
    const key = row.sender_id ?? `name:${row.sender_name}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    senders.push({ senderName: row.sender_name, senderId: row.sender_id });
    if (senders.length >= (input.nameLimit ?? 8)) break;
  }
  return senders;
}

/** FTS generates candidates only; the pre-turn builder scores and bounds them. */
export function searchArchiveEvidence(input: {
  memberAgentGroupIds: string[];
  query: string;
  currentMessagingGroupId: string | null;
  currentThreadId: string | null;
  currentNormalizedContent: string;
  candidateLimit: number;
}): ArchiveEvidenceRow[] {
  if (input.memberAgentGroupIds.length === 0) return [];
  const fts = sanitizeArchiveFtsQuery(input.query);
  if (!fts || input.candidateLimit <= 0) return [];
  const scope = trustedMemberClause(input.memberAgentGroupIds);
  const candidateLimit = Math.max(1, Math.floor(input.candidateLimit));
  const rows = openDb()
    .prepare(
      `WITH matches AS MATERIALIZED (
         SELECT messages_archive_fts.rowid AS rowid,
                bm25(messages_archive_fts) AS score,
                CASE
                  WHEN (? IS NOT NULL AND scoped.thread_id = ?)
                    OR (? IS NULL AND scoped.messaging_group_id = ? AND scoped.thread_id IS NULL)
                  THEN 0 ELSE 1
                END AS current_rank
           FROM messages_archive_fts
           JOIN messages_archive scoped ON scoped.rowid = messages_archive_fts.rowid
          WHERE messages_archive_fts MATCH ?
            AND scoped.${scope.sql}
          -- rowid completes the sort key. current_rank and score alone are not
          -- unique — on the live archive 14,627 (current_rank, score) groups hold
          -- more than one row, and for a typical query the LIMIT lands inside one
          -- of them, so WHICH tied rows survive the cut would otherwise be the
          -- planner's choice rather than ours. rowid is unique, so this makes the
          -- order total and the surviving set reproducible.
          --
          -- This does not change today's output: SQLite already returns FTS
          -- matches in rowid order and its sorter preserves that for equal keys,
          -- verified byte-identical on real data across MATERIALIZED /
          -- NOT MATERIALIZED / reversed-join-order plans. It pins that incidental
          -- behavior so a future SQLite, index, or query edit cannot silently
          -- reshuffle delivered evidence.
          ORDER BY current_rank ASC, score ASC, messages_archive_fts.rowid ASC
          LIMIT ?
       )
       SELECT a.id, a.agent_group_id, a.messaging_group_id, a.channel_type,
              a.channel_name, a.platform_id, a.thread_id, a.role, a.sender_id,
              a.sender_name, a.text, a.sent_at, m.score
         FROM messages_archive a
         JOIN matches m ON m.rowid = a.rowid
        WHERE trim(a.text) <> trim(?)
        ORDER BY m.current_rank ASC, m.score ASC, a.sent_at DESC, a.id ASC
        LIMIT ?`,
    )
    .all(
      input.currentThreadId,
      input.currentThreadId,
      input.currentThreadId,
      input.currentMessagingGroupId,
      fts,
      ...scope.params,
      candidateLimit * 8,
      input.currentNormalizedContent,
      candidateLimit,
    ) as Array<ArchiveSqlRow & { score: number }>;
  return rows.map((row) => {
    const isCurrentThread =
      input.currentThreadId !== null
        ? row.thread_id === input.currentThreadId
        : row.thread_id === null && row.messaging_group_id === input.currentMessagingGroupId;
    return toEvidence(row, isCurrentThread ? 'current-thread' : 'workgroup');
  });
}

export type ArchivePermalink =
  | { kind: 'slack'; url: string; channel: string; timestamp: string; threadTimestamp: string | null }
  | { kind: 'discord'; url: string; guild: string; channel: string; message: string | null };

/** Parse every supported permalink from untrusted current input without using it for authorization. */
export function parseArchivePermalinks(content: string): ArchivePermalink[] {
  const urls = content.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  const parsed: ArchivePermalink[] = [];
  for (const rawUrl of urls.slice(0, 8)) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      continue;
    }
    if (/(^|\.)slack\.com$/i.test(url.hostname)) {
      const match = url.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d+)$/i);
      if (!match) continue;
      parsed.push({
        kind: 'slack',
        url: rawUrl,
        channel: match[1]!,
        timestamp: `${match[2]}.${match[3]}`,
        threadTimestamp: url.searchParams.get('thread_ts'),
      });
      continue;
    }
    if (/^(?:www\.)?discord(?:app)?\.com$/i.test(url.hostname)) {
      const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/);
      if (!match) continue;
      parsed.push({
        kind: 'discord',
        url: rawUrl,
        guild: match[1]!,
        channel: match[2]!,
        message: match[3] ?? null,
      });
    }
  }
  return parsed;
}

/** Resolve parsed permalinks against exact archive routing, still bounded to trusted member ids. */
export function queryArchiveExactLinks(input: {
  memberAgentGroupIds: string[];
  normalizedContent: string;
  candidateLimit: number;
}): ArchiveEvidenceRow[] {
  if (input.memberAgentGroupIds.length === 0) return [];
  const links = parseArchivePermalinks(input.normalizedContent);
  if (links.length === 0 || input.candidateLimit <= 0) return [];
  const scope = trustedMemberClause(input.memberAgentGroupIds);
  const db = openDb();
  const selected: ArchiveEvidenceRow[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const remaining = Math.max(0, Math.floor(input.candidateLimit) - selected.length);
    if (remaining === 0) break;
    let rows: ArchiveSqlRow[];
    if (link.kind === 'slack') {
      const threadId = `slack:${link.channel}:${link.threadTimestamp ?? link.timestamp}`;
      rows = db
        .prepare(
          `SELECT id, agent_group_id, messaging_group_id, channel_type, channel_name,
                  platform_id, thread_id, role, sender_id, sender_name, text, sent_at
             FROM messages_archive
            WHERE ${scope.sql}
              AND channel_type LIKE 'slack%'
              AND platform_id = ?
              AND thread_id = ?
            ORDER BY sent_at ASC, id ASC
            LIMIT ?`,
        )
        .all(...scope.params, `slack:${link.channel}`, threadId, remaining) as ArchiveSqlRow[];
    } else {
      const platformId = `discord:${link.guild}:${link.channel}`;
      const encodedChannel = `discord:${link.guild}:${link.channel}`;
      const encodedThreadSuffix = `discord:${link.guild}:%:${link.channel}`;
      if (link.message) {
        // Thread rows keep the parent channel in platform_id and the thread in thread_id; match both identities.
        rows = db
          .prepare(
            `SELECT id, agent_group_id, messaging_group_id, channel_type, channel_name,
                    platform_id, thread_id, role, sender_id, sender_name, text, sent_at
               FROM messages_archive
              WHERE ${scope.sql}
                AND channel_type LIKE 'discord%'
                AND (id = ? OR id LIKE ?)
                AND (
                  platform_id = ?
                  OR thread_id = ?
                  OR thread_id = ?
                  OR thread_id LIKE ?
                )
              ORDER BY sent_at ASC, id ASC
              LIMIT ?`,
          )
          .all(
            ...scope.params,
            link.message,
            `${link.message}:%`,
            platformId,
            link.channel,
            encodedChannel,
            encodedThreadSuffix,
            remaining,
          ) as ArchiveSqlRow[];

        // Outbound rows lack the platform message id; fall back to a real thread, never to a whole channel.
        if (rows.length === 0) {
          rows = db
            .prepare(
              `SELECT id, agent_group_id, messaging_group_id, channel_type, channel_name,
                      platform_id, thread_id, role, sender_id, sender_name, text, sent_at
                 FROM messages_archive
                WHERE ${scope.sql}
                  AND channel_type LIKE 'discord%'
                  AND (thread_id = ? OR thread_id = ? OR thread_id LIKE ?)
                ORDER BY sent_at ASC, id ASC
                LIMIT ?`,
            )
            .all(...scope.params, link.channel, encodedChannel, encodedThreadSuffix, remaining) as ArchiveSqlRow[];
        }
      } else {
        rows = db
          .prepare(
            `SELECT id, agent_group_id, messaging_group_id, channel_type, channel_name,
                    platform_id, thread_id, role, sender_id, sender_name, text, sent_at
               FROM messages_archive
              WHERE ${scope.sql}
                AND channel_type LIKE 'discord%'
                AND (
                  platform_id = ?
                  OR thread_id = ?
                  OR thread_id = ?
                  OR thread_id LIKE ?
                )
              ORDER BY sent_at ASC, id ASC
              LIMIT ?`,
          )
          .all(
            ...scope.params,
            platformId,
            link.channel,
            encodedChannel,
            encodedThreadSuffix,
            remaining,
          ) as ArchiveSqlRow[];
      }
    }
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      selected.push(toEvidence(row, 'exact-link'));
    }
  }
  return selected;
}
