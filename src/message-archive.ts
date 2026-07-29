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
import { createHash } from 'crypto';

import Database from 'better-sqlite3';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const ARCHIVE_PATH = path.join(DATA_DIR, 'archive.db');

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

    CREATE TABLE IF NOT EXISTS memory_curation_episodes (
      episode_key          TEXT PRIMARY KEY,
      workgroup_id         TEXT NOT NULL,
      messaging_group_id   TEXT NOT NULL,
      thread_id            TEXT NOT NULL,
      pending_rowid        INTEGER NOT NULL,
      handled_rowid        INTEGER NOT NULL DEFAULT 0,
      not_before           TEXT NOT NULL,
      lease_owner          TEXT,
      lease_expires_at     TEXT,
      attempt_count        INTEGER NOT NULL DEFAULT 0,
      last_error_class     TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_curation_due
      ON memory_curation_episodes(not_before, pending_rowid, handled_rowid);

    CREATE TABLE IF NOT EXISTS memory_curation_calls (
      id                   TEXT PRIMARY KEY,
      workgroup_id         TEXT NOT NULL,
      started_at           TEXT NOT NULL,
      credential_slot      TEXT,
      outcome              TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_curation_calls_started
      ON memory_curation_calls(started_at);

    CREATE TABLE IF NOT EXISTS memory_curation_credentials (
      credential_slot      TEXT PRIMARY KEY,
      unavailable_until    TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error_class     TEXT,
      updated_at           TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_curation_state (
      workgroup_id                       TEXT PRIMARY KEY,
      accepted_updates_since_maintenance INTEGER NOT NULL DEFAULT 0,
      maintenance_pending                INTEGER NOT NULL DEFAULT 0,
      not_before                         TEXT NOT NULL,
      lease_owner                        TEXT,
      lease_expires_at                   TEXT,
      updated_at                         TEXT NOT NULL
    );
  `);
  try {
    db.exec('ALTER TABLE memory_curation_calls ADD COLUMN credential_slot TEXT');
  } catch {
    // column already exists
  }
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

const upsertStmt = () =>
  openDb().prepare(
    `INSERT INTO messages_archive
       (id, agent_group_id, messaging_group_id, channel_type, channel_name, platform_id, thread_id, role, sender_id, sender_name, text, sent_at)
     VALUES (@id, @agentGroupId, @messagingGroupId, @channelType, @channelName, @platformId, @threadId, @role, @senderId, @senderName, @text, @sentAt)
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       sender_name = excluded.sender_name,
       channel_name = COALESCE(excluded.channel_name, channel_name)
     WHERE excluded.text IS NOT NULL`,
  );

export function upsertArchiveMessage(msg: ArchiveMessage): void {
  if (!msg.text || msg.text.length === 0) return;
  try {
    upsertStmt().run(msg);
  } catch (err) {
    log.warn('Failed to upsert archive message', { id: msg.id, err });
  }
}

export const MEMORY_CURATION_DEBOUNCE_MS = 5 * 60_000;
export const MEMORY_CURATION_LEASE_MS = 10 * 60_000;
// The sweep can start at most one job per minute. Two model attempts per job
// (one exhausted OAuth slot plus its healthy sibling) therefore peak at
// 120/hour and 2,880/day. These are runaway guards, not normal-throughput
// throttles: the daily cushion prevents an around-the-clock single-key outage
// from pausing successful work on the other key.
export const MEMORY_CURATION_HOURLY_LIMIT = 120;
export const MEMORY_CURATION_DAILY_LIMIT = 3000;
export const MEMORY_CURATION_CALL_RETENTION_MS = 2 * 24 * 60 * 60_000;
export const MEMORY_MAINTENANCE_UPDATE_THRESHOLD = 50;
// 75% of GENERATED_MEMORY_MAX_BYTES, kept in proportion by hand: importing the
// value from curator-contract.ts would close a runtime cycle, since that module
// already imports this one. Left at 192 KiB it fired every sweep for any
// workgroup past the old cap, claiming and completing a job that does nothing.
export const MEMORY_MAINTENANCE_SIZE_THRESHOLD = 768 * 1024;

export interface MemoryCurationEpisode {
  episodeKey: string;
  workgroupId: string;
  messagingGroupId: string | null;
  threadId: string | null;
  pendingRowid: number;
  handledRowid: number;
  claimedThroughRowid: number;
  leaseOwner: string;
  attemptCount: number;
}

interface MemoryCurationEpisodeRow {
  episode_key: string;
  workgroup_id: string;
  messaging_group_id: string;
  thread_id: string;
  pending_rowid: number;
  handled_rowid: number;
  lease_owner: string | null;
  attempt_count: number;
}

export interface MemoryCurationArchiveRow extends ArchiveEvidenceRow {
  rowid: number;
}

export interface MemoryMaintenanceJob {
  workgroupId: string;
  acceptedUpdates: number;
  leaseOwner: string;
}

function memoryCurationEpisodeKey(workgroupId: string, messagingGroupId: string, threadId: string): string {
  return createHash('sha256').update(`${workgroupId}\0${messagingGroupId}\0${threadId}`).digest('hex');
}

function upsertArchiveMessageOrThrow(db: Database.Database, msg: ArchiveMessage): number {
  if (!msg.text || msg.text.length === 0) throw new Error('archive message text is required');
  db.prepare(
    `INSERT INTO messages_archive
       (id, agent_group_id, messaging_group_id, channel_type, channel_name, platform_id, thread_id, role, sender_id, sender_name, text, sent_at)
     VALUES (@id, @agentGroupId, @messagingGroupId, @channelType, @channelName, @platformId, @threadId, @role, @senderId, @senderName, @text, @sentAt)
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       sender_name = excluded.sender_name,
       channel_name = COALESCE(excluded.channel_name, channel_name)
     WHERE excluded.text IS NOT NULL`,
  ).run(msg);
  const row = db.prepare('SELECT rowid FROM messages_archive WHERE id = ?').get(msg.id) as
    | { rowid: number }
    | undefined;
  if (!row) throw new Error('archive upsert did not produce a row');
  return row.rowid;
}

/**
 * Archive a user/assistant message and advance its workgroup episode cursor in
 * one archive.db transaction. Model work is deliberately absent from this path.
 */
export function archiveMessageAndScheduleMemoryCuration(
  msg: ArchiveMessage,
  workgroupId: string,
  options: { nowMs?: number; debounceMs?: number } = {},
): boolean {
  if (!msg.text || msg.text.length === 0) return false;
  if (!workgroupId) throw new Error('workgroup id is required for memory curation');
  const db = openDb();
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const notBefore = new Date(nowMs + (options.debounceMs ?? MEMORY_CURATION_DEBOUNCE_MS)).toISOString();
  const messagingGroupId = msg.messagingGroupId ?? '';
  const threadId = msg.threadId ?? '';
  const episodeKey = memoryCurationEpisodeKey(workgroupId, messagingGroupId, threadId);
  const tx = db.transaction(() => {
    const rowid = upsertArchiveMessageOrThrow(db, msg);
    db.prepare(
      `INSERT INTO memory_curation_episodes
         (episode_key, workgroup_id, messaging_group_id, thread_id, pending_rowid, handled_rowid,
          not_before, lease_owner, lease_expires_at, attempt_count, last_error_class, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, 0, NULL, ?, ?)
       ON CONFLICT(episode_key) DO UPDATE SET
         pending_rowid = MAX(memory_curation_episodes.pending_rowid, excluded.pending_rowid),
         not_before = excluded.not_before,
         updated_at = excluded.updated_at`,
    ).run(episodeKey, workgroupId, messagingGroupId, threadId, rowid, notBefore, now, now);
  });
  tx();
  return true;
}

function toMemoryCurationEpisode(row: MemoryCurationEpisodeRow, owner: string): MemoryCurationEpisode {
  return {
    episodeKey: row.episode_key,
    workgroupId: row.workgroup_id,
    messagingGroupId: row.messaging_group_id || null,
    threadId: row.thread_id || null,
    pendingRowid: row.pending_rowid,
    handledRowid: row.handled_rowid,
    claimedThroughRowid: row.pending_rowid,
    leaseOwner: owner,
    attemptCount: row.attempt_count,
  };
}

export function claimMemoryCurationEpisode(
  owner: string,
  options: { nowMs?: number; leaseMs?: number } = {},
): MemoryCurationEpisode | null {
  if (!owner) throw new Error('memory curation lease owner is required');
  const db = openDb();
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + (options.leaseMs ?? MEMORY_CURATION_LEASE_MS)).toISOString();
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT episode_key, workgroup_id, messaging_group_id, thread_id,
                pending_rowid, handled_rowid, lease_owner, attempt_count
           FROM memory_curation_episodes
          WHERE pending_rowid > handled_rowid
            AND not_before <= ?
            AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          ORDER BY not_before ASC, updated_at ASC
          LIMIT 1`,
      )
      .get(now, now) as MemoryCurationEpisodeRow | undefined;
    if (!row) return null;
    const result = db
      .prepare(
        `UPDATE memory_curation_episodes
            SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE episode_key = ?
            AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(owner, leaseExpiresAt, now, row.episode_key, now);
    return result.changes === 1 ? toMemoryCurationEpisode(row, owner) : null;
  })();
}

export function readMemoryCurationEpisodeMessages(
  episode: MemoryCurationEpisode,
  memberAgentGroupIds: string[],
  limit = 20,
): MemoryCurationArchiveRow[] {
  const ids = [...new Set(memberAgentGroupIds)].filter(Boolean).sort();
  if (ids.length === 0 || limit <= 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = openDb()
    .prepare(
      `SELECT rowid, id, agent_group_id, messaging_group_id, channel_type, channel_name,
              platform_id, thread_id, role, sender_id, sender_name, text, sent_at
         FROM messages_archive
        WHERE rowid > ?
          AND rowid <= ?
          AND agent_group_id IN (${placeholders})
          AND COALESCE(messaging_group_id, '') = ?
          AND COALESCE(thread_id, '') = ?
          AND role IN ('user', 'assistant')
        ORDER BY rowid ASC
        LIMIT ?`,
    )
    .all(
      episode.handledRowid,
      episode.claimedThroughRowid,
      ...ids,
      episode.messagingGroupId ?? '',
      episode.threadId ?? '',
      limit,
    ) as Array<ArchiveSqlRow & { rowid: number }>;
  return rows.map((row) => ({ ...toEvidence(row, 'current-thread'), rowid: row.rowid }));
}

export function completeMemoryCurationEpisode(
  episode: MemoryCurationEpisode,
  options: { nowMs?: number } = {},
): boolean {
  const now = new Date(options.nowMs ?? Date.now()).toISOString();
  const result = openDb()
    .prepare(
      `UPDATE memory_curation_episodes
          SET handled_rowid = MAX(handled_rowid, ?),
              lease_owner = NULL,
              lease_expires_at = NULL,
              attempt_count = 0,
              last_error_class = NULL,
              updated_at = ?
        WHERE episode_key = ? AND lease_owner = ?`,
    )
    .run(episode.claimedThroughRowid, now, episode.episodeKey, episode.leaseOwner);
  return result.changes === 1;
}

function retryDelayMs(attempt: number, errorClass: string): number {
  if (errorClass === 'quota' || errorClass === 'auth') {
    return Math.min(30 * 60_000, 5 * 60_000 * 2 ** Math.max(0, attempt - 1));
  }
  if (errorClass === 'timeout' || errorClass === 'provider_5xx') {
    return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
  }
  if (attempt >= 8) return 24 * 60 * 60_000;
  return Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.max(0, attempt - 1));
}

export function failMemoryCurationEpisode(
  episode: MemoryCurationEpisode,
  errorClass: string,
  options: { nowMs?: number } = {},
): boolean {
  const nowMs = options.nowMs ?? Date.now();
  const attempt = episode.attemptCount + 1;
  const now = new Date(nowMs).toISOString();
  const notBefore = new Date(nowMs + retryDelayMs(attempt, errorClass)).toISOString();
  const result = openDb()
    .prepare(
      `UPDATE memory_curation_episodes
          SET lease_owner = NULL,
              lease_expires_at = NULL,
              attempt_count = ?,
              last_error_class = ?,
              not_before = ?,
              updated_at = ?
        WHERE episode_key = ? AND lease_owner = ?`,
    )
    .run(attempt, errorClass.slice(0, 80), notBefore, now, episode.episodeKey, episode.leaseOwner);
  return result.changes === 1;
}

export function recordMemoryCurationCall(
  id: string,
  workgroupId: string,
  options: { nowMs?: number; credentialSlot?: string } = {},
): boolean {
  const startedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const result = openDb()
    .prepare(
      `INSERT OR IGNORE INTO memory_curation_calls
         (id, workgroup_id, started_at, credential_slot, outcome)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(id, workgroupId, startedAt, options.credentialSlot ?? null);
  return result.changes === 1;
}

export function finishMemoryCurationCall(id: string, outcome: string): void {
  openDb().prepare('UPDATE memory_curation_calls SET outcome = ? WHERE id = ?').run(outcome.slice(0, 40), id);
}

export function memoryCurationAdmission(options: { nowMs?: number; hourlyLimit?: number; dailyLimit?: number } = {}): {
  allowed: boolean;
  hourly: number;
  daily: number;
  hourlyLimit: number;
  dailyLimit: number;
} {
  const db = openDb();
  const nowMs = options.nowMs ?? Date.now();
  const retentionStart = new Date(nowMs - MEMORY_CURATION_CALL_RETENTION_MS).toISOString();
  const hourStart = new Date(nowMs - 60 * 60_000).toISOString();
  const now = new Date(nowMs);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const { hourly, daily } = db.transaction(() => {
    db.prepare('DELETE FROM memory_curation_calls WHERE started_at < ?').run(retentionStart);
    const rollingHour = (
      db.prepare('SELECT COUNT(*) AS count FROM memory_curation_calls WHERE started_at >= ?').get(hourStart) as {
        count: number;
      }
    ).count;
    const utcDay = (
      db.prepare('SELECT COUNT(*) AS count FROM memory_curation_calls WHERE started_at >= ?').get(dayStart) as {
        count: number;
      }
    ).count;
    return { hourly: rollingHour, daily: utcDay };
  })();
  const hourlyLimit = options.hourlyLimit ?? MEMORY_CURATION_HOURLY_LIMIT;
  const dailyLimit = options.dailyLimit ?? MEMORY_CURATION_DAILY_LIMIT;
  return {
    allowed: hourly < hourlyLimit && daily < dailyLimit,
    hourly,
    daily,
    hourlyLimit,
    dailyLimit,
  };
}

export interface MemoryCurationCredentialSelection {
  slot: string | null;
  retryAt: string | null;
  unavailableSlots: string[];
}

/**
 * Persisted round-robin selection. Credential values never enter archive.db;
 * only caller-supplied slot labels are stored. Slots in cooldown are skipped.
 */
export function selectMemoryCurationCredential(
  availableSlots: string[],
  options: { nowMs?: number } = {},
): MemoryCurationCredentialSelection {
  const slots = [...new Set(availableSlots)].filter(Boolean);
  if (slots.length === 0) return { slot: null, retryAt: null, unavailableSlots: [] };
  const db = openDb();
  const now = new Date(options.nowMs ?? Date.now()).toISOString();
  const placeholders = slots.map(() => '?').join(',');
  const states = db
    .prepare(
      `SELECT credential_slot, unavailable_until
         FROM memory_curation_credentials
        WHERE credential_slot IN (${placeholders})`,
    )
    .all(...slots) as Array<{ credential_slot: string; unavailable_until: string | null }>;
  const unavailableBySlot = new Map(states.map((row) => [row.credential_slot, row.unavailable_until]));
  const unavailableSlots = slots.filter((slot) => {
    const until = unavailableBySlot.get(slot);
    return Boolean(until && until > now);
  });
  const eligible = new Set(slots.filter((slot) => !unavailableSlots.includes(slot)));
  if (eligible.size === 0) {
    const retryAt =
      unavailableSlots
        .map((slot) => unavailableBySlot.get(slot))
        .filter((value): value is string => Boolean(value))
        .sort()[0] ?? null;
    return { slot: null, retryAt, unavailableSlots };
  }
  const last = db
    .prepare(
      `SELECT credential_slot
         FROM memory_curation_calls
        WHERE credential_slot IN (${placeholders})
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(...slots) as { credential_slot: string } | undefined;
  const start = last ? (slots.indexOf(last.credential_slot) + 1) % slots.length : 0;
  for (let offset = 0; offset < slots.length; offset++) {
    const slot = slots[(start + offset) % slots.length]!;
    if (eligible.has(slot)) return { slot, retryAt: null, unavailableSlots };
  }
  return { slot: null, retryAt: null, unavailableSlots };
}

function credentialCooldownMs(consecutiveFailures: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return Math.min(24 * 60 * 60_000, Math.max(60_000, retryAfterMs));
  }
  return Math.min(30 * 60_000, 15 * 60_000 * 2 ** Math.max(0, consecutiveFailures - 1));
}

export function markMemoryCurationCredentialUnavailable(
  slot: string,
  errorClass: 'quota' | 'auth',
  options: { nowMs?: number; retryAfterMs?: number | null } = {},
): string {
  if (!slot) throw new Error('memory curation credential slot is required');
  const db = openDb();
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  return db.transaction(() => {
    const prior = db
      .prepare(
        `SELECT consecutive_failures
           FROM memory_curation_credentials
          WHERE credential_slot = ?`,
      )
      .get(slot) as { consecutive_failures: number } | undefined;
    const consecutiveFailures = (prior?.consecutive_failures ?? 0) + 1;
    const unavailableUntil = new Date(
      nowMs + credentialCooldownMs(consecutiveFailures, options.retryAfterMs ?? null),
    ).toISOString();
    db.prepare(
      `INSERT INTO memory_curation_credentials
         (credential_slot, unavailable_until, consecutive_failures, last_error_class, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(credential_slot) DO UPDATE SET
         unavailable_until = excluded.unavailable_until,
         consecutive_failures = excluded.consecutive_failures,
         last_error_class = excluded.last_error_class,
         updated_at = excluded.updated_at`,
    ).run(slot, unavailableUntil, consecutiveFailures, errorClass, now);
    return unavailableUntil;
  })();
}

export function markMemoryCurationCredentialAvailable(slot: string, options: { nowMs?: number } = {}): void {
  if (!slot) throw new Error('memory curation credential slot is required');
  const now = new Date(options.nowMs ?? Date.now()).toISOString();
  openDb()
    .prepare(
      `INSERT INTO memory_curation_credentials
         (credential_slot, unavailable_until, consecutive_failures, last_error_class, updated_at)
       VALUES (?, NULL, 0, NULL, ?)
       ON CONFLICT(credential_slot) DO UPDATE SET
         unavailable_until = NULL,
         consecutive_failures = 0,
         last_error_class = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(slot, now);
}

export function recordAcceptedGeneratedMemory(
  workgroupId: string,
  contentBytes: number,
  options: { nowMs?: number } = {},
): void {
  const now = new Date(options.nowMs ?? Date.now()).toISOString();
  const sizePending = contentBytes > MEMORY_MAINTENANCE_SIZE_THRESHOLD ? 1 : 0;
  openDb()
    .prepare(
      `INSERT INTO memory_curation_state
         (workgroup_id, accepted_updates_since_maintenance, maintenance_pending,
          not_before, lease_owner, lease_expires_at, updated_at)
       VALUES (?, 1, ?, ?, NULL, NULL, ?)
       ON CONFLICT(workgroup_id) DO UPDATE SET
         accepted_updates_since_maintenance =
           memory_curation_state.accepted_updates_since_maintenance + 1,
         maintenance_pending = CASE
           WHEN memory_curation_state.accepted_updates_since_maintenance + 1 >= ?
             OR ? = 1
           THEN 1 ELSE memory_curation_state.maintenance_pending END,
         not_before = excluded.not_before,
         updated_at = excluded.updated_at`,
    )
    .run(workgroupId, sizePending, now, now, MEMORY_MAINTENANCE_UPDATE_THRESHOLD, sizePending);
}

export function claimMemoryMaintenance(
  owner: string,
  options: { nowMs?: number; leaseMs?: number } = {},
): MemoryMaintenanceJob | null {
  if (!owner) throw new Error('memory maintenance lease owner is required');
  const db = openDb();
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + (options.leaseMs ?? MEMORY_CURATION_LEASE_MS)).toISOString();
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT workgroup_id, accepted_updates_since_maintenance
           FROM memory_curation_state
          WHERE maintenance_pending = 1
            AND not_before <= ?
            AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          ORDER BY updated_at ASC
          LIMIT 1`,
      )
      .get(now, now) as { workgroup_id: string; accepted_updates_since_maintenance: number } | undefined;
    if (!row) return null;
    const result = db
      .prepare(
        `UPDATE memory_curation_state
            SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE workgroup_id = ?
            AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(owner, leaseExpiresAt, now, row.workgroup_id, now);
    return result.changes === 1
      ? {
          workgroupId: row.workgroup_id,
          acceptedUpdates: row.accepted_updates_since_maintenance,
          leaseOwner: owner,
        }
      : null;
  })();
}

export function completeMemoryMaintenance(job: MemoryMaintenanceJob, options: { nowMs?: number } = {}): boolean {
  const now = new Date(options.nowMs ?? Date.now()).toISOString();
  const result = openDb()
    .prepare(
      `UPDATE memory_curation_state
          SET accepted_updates_since_maintenance = 0,
              maintenance_pending = 0,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = ?
        WHERE workgroup_id = ? AND lease_owner = ?`,
    )
    .run(now, job.workgroupId, job.leaseOwner);
  return result.changes === 1;
}

export function failMemoryMaintenance(
  job: MemoryMaintenanceJob,
  options: { nowMs?: number; retryMs?: number } = {},
): boolean {
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const notBefore = new Date(nowMs + (options.retryMs ?? 6 * 60 * 60_000)).toISOString();
  const result = openDb()
    .prepare(
      `UPDATE memory_curation_state
          SET lease_owner = NULL,
              lease_expires_at = NULL,
              not_before = ?,
              updated_at = ?
        WHERE workgroup_id = ? AND lease_owner = ?`,
    )
    .run(notBefore, now, job.workgroupId, job.leaseOwner);
  return result.changes === 1;
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
          ORDER BY current_rank ASC, score ASC
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
