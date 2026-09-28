/**
 * GET /dashboard/api/sessions: the session inbox view with attention lanes (needs_me / active / idle / stale).
 * `container_status` comes from the heartbeat mtime (the DB column lags by up to a sweep); `last_inbound_at` is
 * `sessions.last_active`; `last_outbound_kind` is `chat-sdk:<content.type>` for chat-sdk messages so ask_question is
 * detectable without parsing JSON. An out-of-scope `group_id` returns an empty list, not a 403. Never-engaged
 * sessions are always excluded. The recurrence probe opens a per-session inbound.db, so it runs only for
 * would-be-stale rows.
 */
import fs from 'fs';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { readSessionInbound, readSessionOutbound, type MessageTailRow } from '../../modules/mailbox/index.js';
import { heartbeatPath } from '../../session-manager.js';
import { log } from '../../log.js';
import type { AuthHandler } from '../router.js';

type AttentionState = 'needs_me' | 'active' | 'idle' | 'stale';
export type ContainerStatus = 'running' | 'idle' | 'stale' | 'unknown';

interface SessionSummary {
  agent_group_id: string;
  session_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;

  title: string | null;

  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_outbound_kind: string | null;

  archived_at: string | null;
  container_status: ContainerStatus;
  has_pending_recurrence: boolean;

  // NULL when the session is a direct-conversation session.
  attached_task_id: string | null;
  attached_task_status: string | null;
  attached_task_needs_input: boolean | null;

  attention_state: AttentionState;
}

const FIVE_MIN_MS = 5 * 60_000;
const ONE_DAY_MS = 24 * 60 * 60_000;

/**
 * Liveness from the heartbeat file's mtime; `sessions.container_status` lags by up to a sweep interval and must not
 * be read.
 */
export function deriveContainerStatus(agentGroupId: string, sessionId: string): ContainerStatus {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(hbPath).mtimeMs;
  } catch {
    return 'unknown';
  }
  const ageMs = Date.now() - mtimeMs;
  if (ageMs < 60_000) return 'running';
  if (ageMs < 300_000) return 'idle';
  return 'stale';
}

/**
 * Only invoked for would-be-stale rows: opening every session's SQLite file per request is too expensive. Failures
 * return false (at worst a row shows as stale until the next refresh).
 */
function hasPendingRecurrence(agentGroupId: string, sessionId: string, dataDir: string): boolean {
  try {
    return (
      readSessionInbound({ agentGroupId, sessionId, dataDir }, (mailbox) => mailbox.hasPendingRecurrence()) ?? false
    );
  } catch (err) {
    log.warn('hasPendingRecurrence: probe failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

interface SessionJoinRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  last_active: string | null;
  last_outbound_at: string | null;
  last_outbound_kind: string | null;
  title: string | null;
  archived_at: string | null;
  created_at: string;
  attached_task_id: string | null;
  attached_task_status: string | null;
  attached_task_needs_input: number | null;
}

function summarizeSession(row: SessionJoinRow): SessionSummary {
  const containerStatus = deriveContainerStatus(row.agent_group_id, row.id);
  // Falls back to created_at for never-inbounded sessions, so a brand-new session does not trip the probe on every
  // refresh.
  const lastInboundMs = row.last_active ? Date.parse(row.last_active) : 0;
  const baselineMs = lastInboundMs || Date.parse(row.created_at);
  const couldBeStale =
    containerStatus !== 'running' &&
    row.attached_task_status !== 'running' &&
    row.attached_task_status !== 'pending' &&
    (!baselineMs || Date.now() - baselineMs >= ONE_DAY_MS);
  const hasRecurrence = couldBeStale ? hasPendingRecurrence(row.agent_group_id, row.id, DATA_DIR) : false;
  const attentionState = deriveAttentionState(row, containerStatus, hasRecurrence);
  return {
    agent_group_id: row.agent_group_id,
    session_id: row.id,
    messaging_group_id: row.messaging_group_id,
    thread_id: row.thread_id,
    title: row.title,
    last_inbound_at: row.last_active,
    last_outbound_at: row.last_outbound_at,
    last_outbound_kind: row.last_outbound_kind,
    archived_at: row.archived_at,
    container_status: containerStatus,
    has_pending_recurrence: hasRecurrence,
    attached_task_id: row.attached_task_id,
    attached_task_status: row.attached_task_status,
    attached_task_needs_input: row.attached_task_needs_input === null ? null : row.attached_task_needs_input === 1,
    attention_state: attentionState,
  };
}

function deriveAttentionState(
  row: SessionJoinRow,
  containerStatus: ContainerStatus,
  hasRecurrence: boolean,
): AttentionState {
  const nowMs = Date.now();
  const lastInboundMs = row.last_active ? Date.parse(row.last_active) : 0;
  const lastOutboundMs = row.last_outbound_at ? Date.parse(row.last_outbound_at) : 0;

  if (row.attached_task_needs_input === 1) return 'needs_me';
  if (row.last_outbound_kind === 'chat-sdk:ask_question' && lastInboundMs < lastOutboundMs) {
    return 'needs_me';
  }

  // A queued (`pending`) attached task counts as in flight too.
  if (containerStatus === 'running') return 'active';
  if (row.attached_task_status === 'running' || row.attached_task_status === 'pending') return 'active';
  if (hasRecurrence) return 'active';
  const lastActivityMs = Math.max(lastInboundMs, lastOutboundMs);
  if (lastActivityMs && nowMs - lastActivityMs < FIVE_MIN_MS) return 'active';

  // `last_active` is inbound-only; a session with no inbound yet falls back to `created_at` so it is not `stale` on
  // its first refresh.
  const baselineMs = lastInboundMs || Date.parse(row.created_at);
  const ageMs = baselineMs ? nowMs - baselineMs : Infinity;
  if (ageMs >= ONE_DAY_MS) return 'stale';
  return 'idle';
}

export const sessionsHandler: AuthHandler = async (req, _params, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);
  const groupIdFilter = url.searchParams.get('group_id');
  const includeArchivedRaw = url.searchParams.get('include_archived');
  const includeArchived = includeArchivedRaw === '1' || includeArchivedRaw === 'true';

  const conditions: string[] = ["s.status = 'active'"];
  const values: unknown[] = [];

  if (!ctx.scopes.no_filter) {
    const ids = ctx.scopes.allowed_group_ids;
    if (ids.length === 0) {
      return new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const placeholders = ids.map(() => '?').join(', ');
    conditions.push(`s.agent_group_id IN (${placeholders})`);
    values.push(...ids);
  }

  if (groupIdFilter) {
    // An out-of-scope group_id yields zero rows (the scope clause already restricts), not a refusal.
    conditions.push('s.agent_group_id = ?');
    values.push(groupIdFilter);
  }

  if (!includeArchived) {
    conditions.push('s.archived_at IS NULL');
  }

  // Never-engaged sessions (an inbound arrived but nothing woke the agent) would clutter the idle lane forever.
  conditions.push("(s.last_outbound_at IS NOT NULL OR s.container_status <> 'stopped' OR t.task_id IS NOT NULL)");

  values.push(limit);

  // The newest pending/running task for the child session; a restarted worker's historical row stays attached until
  // the new one admits.
  const sql = `
    SELECT s.id,
           s.agent_group_id,
           s.messaging_group_id,
           s.thread_id,
           s.last_active,
           s.last_outbound_at,
           s.last_outbound_kind,
           s.title,
           s.archived_at,
           s.created_at,
           t.task_id          AS attached_task_id,
           t.status           AS attached_task_status,
           t.needs_input      AS attached_task_needs_input
      FROM sessions s
 LEFT JOIN (
              -- Only in-flight tasks count as "attached" for the inbox.
              -- A long-completed task should not keep its child session
              -- forever pinned to its status / needs_input fields.
              SELECT task_id, child_session_id, status, needs_input, admitted_at,
                     ROW_NUMBER() OVER (PARTITION BY child_session_id ORDER BY admitted_at DESC) AS rn
                FROM tasks
               WHERE child_session_id IS NOT NULL
                 AND status IN ('pending', 'running')
            ) t ON t.child_session_id = s.id AND t.rn = 1
     WHERE ${conditions.join(' AND ')}
  ORDER BY COALESCE(s.last_outbound_at, s.last_active, s.created_at) DESC
     LIMIT ?
  `;

  let rows: SessionJoinRow[];
  try {
    rows = await getDb().all<SessionJoinRow>(sql, ...values);
  } catch (err) {
    log.warn('sessionsHandler: DB error', { err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sessions: SessionSummary[] = rows.map(summarizeSession);

  return new Response(JSON.stringify({ sessions }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

/**
 * Who produced an INBOUND transcript entry. Nullable as a whole, never half an identity: either the row names its
 * author or it names nobody.
 */
export interface TranscriptAuthor {
  name: string;
  /** Null only for a legacy row that stored a name and no id. */
  id: string | null;
  /**
   * The platform's own `isBot` flag (the reliable bot test, unlike the platform-id prefix). `null` means the row
   * predates the flag: unknown, never guessed.
   */
  is_bot: boolean | null;
}

export interface SessionTranscriptEntry {
  direction: 'in' | 'out';
  kind: string;
  seq: number;
  timestamp: string;
  text: string;
  /**
   * Null for host-generated `system`/`task` inbound, pre-metadata rows, or unparseable content; always null on
   * `direction: 'out'`.
   */
  author: TranscriptAuthor | null;
}

const TRANSCRIPT_TAIL = 50;

/**
 * host-sweep stamps its own notices with sender `'system'`; that is the host, not a participant, so it resolves to no
 * author.
 */
const SYSTEM_SENDER_ID = 'system';

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * Pure and total: takes whatever `JSON.parse` produced (including `undefined`) and never throws. Name precedence:
 * `author.fullName` → `author.userName` → `senderName` → `sender`.
 * `author.isMe` is deliberately ignored: it means "the author is the connected bot", which is always false in an
 * inbound queue. `isBot` is the axis needed.
 */
export function resolveTranscriptAuthor(content: unknown): TranscriptAuthor | null {
  if (!content || typeof content !== 'object') return null;
  const c = content as { author?: unknown; sender?: unknown; senderName?: unknown; senderId?: unknown };
  const a = (c.author && typeof c.author === 'object' ? c.author : null) as {
    fullName?: unknown;
    userName?: unknown;
    userId?: unknown;
    isBot?: unknown;
  } | null;

  const id = nonEmptyString(a?.userId) ?? nonEmptyString(c.senderId);
  if (id === SYSTEM_SENDER_ID) return null;

  const name =
    nonEmptyString(a?.fullName) ??
    nonEmptyString(a?.userName) ??
    nonEmptyString(c.senderName) ??
    nonEmptyString(c.sender);
  if (!name) return null;

  return { name, id, is_bot: typeof a?.isBot === 'boolean' ? a.isBot : null };
}

/**
 * Best-effort: reads the last TRANSCRIPT_TAIL entries from each side read-only and merges by seq. Failures return an
 * empty array.
 */
export function readSessionTranscript(agentGroupId: string, sessionId: string): SessionTranscriptEntry[] {
  const out: SessionTranscriptEntry[] = [];
  const location = { agentGroupId, sessionId };

  function readSide(side: 'in' | 'out'): void {
    let rows: MessageTailRow[] | undefined;
    try {
      rows =
        side === 'in'
          ? readSessionInbound(location, (mailbox) => mailbox.listInboundTail(TRANSCRIPT_TAIL))
          : readSessionOutbound(location, (mailbox) => mailbox.listOutboundTail(TRANSCRIPT_TAIL));
    } catch (err) {
      log.warn('sessionsDetailHandler: transcript read failed', {
        side,
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!rows) return;
    for (const r of rows) {
      let text: string;
      // Hoisted so the author is read from the same parse as the text.
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.content);
        const p = parsed as { text?: unknown; prompt?: unknown; question?: unknown };
        text = String(p.text ?? p.prompt ?? p.question ?? r.content).trim();
      } catch {
        text = r.content;
      }
      out.push({
        direction: side,
        kind: r.kind,
        seq: r.seq,
        timestamp: r.timestamp,
        text,
        // Only the inbound side is resolved; outbound identity rides on `agent_name`.
        author: side === 'in' ? resolveTranscriptAuthor(parsed) : null,
      });
    }
  }

  readSide('in');
  readSide('out');
  out.sort((a, b) => b.seq - a.seq);
  return out.slice(0, TRANSCRIPT_TAIL);
}

export const sessionsDetailHandler: AuthHandler = async (_req, params, ctx) => {
  const sessionId = params['id'] ?? '';
  const row = await getDb().get<SessionJoinRow>(
    `SELECT s.id, s.agent_group_id, s.messaging_group_id, s.thread_id,
            s.last_active, s.last_outbound_at, s.last_outbound_kind,
            s.title, s.archived_at, s.created_at,
            t.task_id          AS attached_task_id,
            t.status           AS attached_task_status,
            t.needs_input      AS attached_task_needs_input
       FROM sessions s
  LEFT JOIN (
                SELECT task_id, child_session_id, status, needs_input, admitted_at,
                       ROW_NUMBER() OVER (PARTITION BY child_session_id ORDER BY admitted_at DESC) AS rn
                  FROM tasks
                 WHERE child_session_id IS NOT NULL
                   AND status IN ('pending', 'running')
              ) t ON t.child_session_id = s.id AND t.rn = 1
      WHERE s.id = ?`,
    sessionId,
  );

  // Nonexistent and out-of-scope both 404 with the same body.
  if (!row) {
    return new Response(JSON.stringify({ error: 'session_not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(row.agent_group_id)) {
    return new Response(JSON.stringify({ error: 'session_not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = summarizeSession(row);

  const transcript = readSessionTranscript(row.agent_group_id, row.id);

  return new Response(JSON.stringify({ session, transcript }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
