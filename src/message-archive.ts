/**
 * Central archive of every chat message v2 sees — inbound (from users)
 * and outbound (from agents). Stored in `data/archive.db` (separate from
 * v2.db so we can mount it read-only into agent containers) with an FTS5
 * virtual table over the text body.
 *
 * Host side (this module) writes on every chat inbound/outbound. Agent
 * containers read via the mount at `/workspace/archive.db` to power the
 * `search_threads` MCP tool (Phase 2.9) and `resolve_thread_link` (2.10).
 *
 * Design decisions:
 *  - Separate DB file (not a table in v2.db). Lets us mount RO into the
 *    container without exposing central state like pending_approvals,
 *    agent_groups, etc.
 *  - Self-bootstrapping schema on first open. Not part of v2.db's
 *    migration chain because the file lives outside v2.db.
 *  - FTS5 auto-sync via triggers. Inserts flow automatically into the
 *    virtual table.
 *  - `agent_group_id` in every row is our scoping key (v1 used
 *    `group_folder`; v2 uses the AG id).
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const ARCHIVE_PATH = path.join(DATA_DIR, 'archive.db');

/**
 * A per-agent-group counter of NON-APPEND changes to `messages_archive`.
 *
 * `messages_archive` is very nearly append-only, but not quite:
 * `upsertStmt` below carries `ON CONFLICT(id) DO UPDATE SET text = ...`, so
 * re-archiving a message id — an edited chat message, a redelivered outbound
 * row — rewrites the row in place. Row count and `MAX(rowid)` do not move when
 * that happens, which makes a cheap watermark unsound on its own: the archive
 * projection in `src/db/per-agent-projections.ts` keys its freshness stamp on
 * `COUNT(*)` and `MAX(rowid)` over one workgroup's rows, and an in-place edit
 * would slip past both and leave a container serving stale text forever.
 *
 * These triggers make the un-watermarkable changes countable. They fire only
 * when a row's projected content actually moves, so an idempotent re-archive of
 * identical text costs nothing and does not invalidate anybody's projection.
 * `sent_at`, `role`, `sender_id`, `messaging_group_id` and `thread_id` are not
 * in the `WHEN` clause because no write path updates them; if one ever does,
 * add it here — the projection's dedup key includes them.
 *
 * Kept as a side table rather than an `updated_at` column on `messages_archive`
 * itself: adding a column to the live multi-hundred-megabyte archive would need
 * a second index over it to be queryable per agent group, and this table is one
 * row per agent group.
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
  // Re-key the cache on the archive path. Under test, beforeEach wipes
  // DATA_DIR and the previously-cached connection points at an unlinked fd;
  // comparing paths catches the swap without requiring a test-only close API.
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
  // TRUNCATE (not WAL). We have one writer (host) and many cross-process
  // readers (containers reading via a read-only mount of archive.db only).
  // In WAL mode readers need access to the -wal and -shm sidecar files; we
  // don't mount those into the container, so WAL writes would be invisible
  // to the MCP tools. TRUNCATE flushes every write straight to the main
  // file, which containers see immediately. Write volume is per-chat-
  // message so the perf delta vs WAL is a non-issue.
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

/**
 * Create `archive_row_marks` and its triggers, and say so ONCE.
 *
 * The archive projection's freshness stamp fails closed while these are
 * absent — every spawn rebuilds, which is the pre-#360 behavior — so an
 * operator upgrading a live install needs to see the moment they appear. The
 * existence check reads `sqlite_master` rather than trusting the silence of
 * `IF NOT EXISTS`, which cannot tell "created" from "already there", and it
 * checks the triggers as well as the table so a partially-applied schema is
 * still reported.
 */
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

/**
 * Open the archive once at host startup so its schema exists before anything
 * reads it.
 *
 * `initSchema` is otherwise reached only through the lazy `openDb()`, which
 * runs on the first archive WRITE. On a host upgrading into #360 that means
 * `archive_row_marks` would not exist until some unrelated chat traffic
 * happened to arrive — and until it does, every archive projection stamp
 * reports an unknown mutation count and fails closed, so every spawn keeps
 * doing the full 19 s rebuild this release exists to remove. A boot that
 * spawns before anyone speaks would get none of the benefit.
 *
 * Idempotent and cheap: on every later boot the schema is already there and
 * this is a file open plus a `sqlite_master` lookup.
 */
export function ensureArchiveSchema(): void {
  openDb();
}

/**
 * Test hook — drop the cached connection so the next open behaves like a fresh
 * host boot against an archive that already exists on disk.
 *
 * Needed because that is the ONLY way to exercise the `sqlite_master` gate in
 * `ensureArchiveRowMarks`: the connection cache otherwise short-circuits every
 * call after the first within one process.
 */
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

/**
 * The ONLY statement in the host that writes `messages_archive`.
 *
 * Exported so tests can exercise the real thing rather than a hand-copied
 * lookalike, and so `src/archive-write-path.test.ts` can hold the invariant
 * that no second write path appears: the `archive_row_marks` triggers above,
 * and therefore the archive projection's freshness stamp, are correct only
 * because every mutation the archive can undergo goes through here.
 *
 * Note the `DO UPDATE`: this is an upsert, not an append. Re-archiving a
 * message id rewrites the row in place, which is exactly what the marks
 * triggers exist to count.
 */
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

/**
 * Archive a user/assistant message.
 *
 * Throws on write failure rather than swallowing: router.ts's non-engaged
 * session skip treats the boolean as a DURABILITY PRECONDITION — when it skips,
 * the archive row is the message's only remaining copy — so a silent failure
 * there would make the message cease to exist. `upsertArchiveMessage` is the
 * best-effort variant for callers that do have another copy.
 */
export function archiveMessage(msg: ArchiveMessage): boolean {
  if (!msg.text || msg.text.length === 0) return false;
  upsertStmt().run(msg);
  return true;
}

/**
 * Whether any archived message sits in `threadId` on this channel as one
 * adapter type sees it (channel_type + platform_id — `idx_archive_channel`).
 * Outbound rows from task sessions carry no messaging_group_id, so the channel
 * is matched by its address rather than by messaging group id. Used by src/continue-thread.ts as evidence
 * that a thread really exists on a destination.
 */
export function archiveHasThread(channelType: string, platformId: string, threadId: string): boolean {
  const row = openDb()
    .prepare('SELECT 1 FROM messages_archive WHERE channel_type = ? AND platform_id = ? AND thread_id = ? LIMIT 1')
    .get(channelType, platformId, threadId);
  return row !== undefined;
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

/**
 * Distinct senders of recent inbound messages in the current conversation,
 * newest first. Deterministic key set for per-person preference recall — no
 * ranking, no FTS. `senderId` is the archive's stable per-message sender key
 * (e.g. `slack:U123`) — the preference lane resolves it against the central
 * `users` table to match on canonical `display_name`, not just the per-message
 * `sender_name`, so a platform rename doesn't silently break a preference file.
 */
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
    // Dedupe on stable sender_id where we have one — falling back to name
    // for legacy/anonymous rows — so two different people who happen to
    // share a display name aren't collapsed into one (rows are newest
    // first, so a renamed sender_id still keeps only its newest name).
    const key = row.sender_id ?? `name:${row.sender_name}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    senders.push({ senderName: row.sender_name, senderId: row.sender_id });
    if (senders.length >= (input.nameLimit ?? 8)) break;
  }
  return senders;
}

/**
 * Retrieve bounded archive message candidates for a trusted workgroup member
 * set. FTS performs candidate generation only; the pre-turn builder applies
 * its deterministic lexical score and excerpt bounds.
 */
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
        // Discord message links are /channels/<guild>/<channel-or-thread>/<message>.
        // Inbound archive ids retain the platform message id as
        // `<message>:<agent-group>`. Thread rows, however, retain the parent
        // channel in platform_id and the thread channel in the final thread_id
        // segment. Match both identities; neither one alone is sufficient.
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

        // Outbound archive rows predate storage of the returned platform
        // message id. If the exact id is unavailable, a URL whose channel
        // component is a real thread still resolves to that bounded thread;
        // never broaden a missing root-channel message to the whole channel.
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
