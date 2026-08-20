/**
 * GET /dashboard/api/sessions — enriched session inbox view.
 *
 * Returns the operator's full set of agent sessions with everything the
 * inbox board needs to render attention-state lanes (Needs me / Active /
 * Idle / Stale):
 *
 *   - container_status   — derived from heartbeat file mtime (heartbeat is
 *                          authoritative; the DB column lags by up to the
 *                          host sweep interval).
 *   - last_inbound_at    — last router-side write into the session's
 *                          inbound.db (aliased from `sessions.last_active`).
 *   - last_outbound_at /  — mirrored from outbound.db into the central row
 *     last_outbound_kind    by delivery.ts on each successful send. For
 *                          chat-sdk msgs the kind is the dotted form
 *                          `chat-sdk:<content.type>` so the inbox can
 *                          detect ask_question without re-parsing JSON.
 *   - attached_task_*    — left-join `tasks` on `child_session_id` so a
 *                          spawn-child session carries its parent task's
 *                          status + needs_input forward into the inbox row.
 *   - title              — Haiku-generated short label (C7); NULL until
 *                          the title sweep has run on the session.
 *   - archived_at        — operator dismiss flag (NULL = visible).
 *   - attention_state    — Computed per the locked rule set:
 *                            needs_me = task.needs_input=1
 *                                       OR (last out was chat-sdk
 *                                           ask_question AND no inbound
 *                                           since)
 *                            active   = container running OR task running
 *                                       OR pending scheduled recurrence
 *                                       OR last_active < 5min
 *                            idle     = last_active within 24h, none above
 *                            stale    = ≥24h AND container not running AND
 *                                       no pending recurrence
 *
 * Query params:
 *   - group_id          — restrict to one agent group; ids outside the
 *                         caller's scope return an empty list (§2a
 *                         disclose-as-not-found rather than 403).
 *   - include_archived  — when "1"/"true", surface archived sessions.
 *                         Default: hide them.
 *   - limit             — page cap; default 100, max 500.
 *
 * Never-engaged sessions (inbound arrived, but nothing ever woke the agent)
 * are always excluded — see the WHERE-clause comment below for the signal.
 * Unlike include_archived there is no toggle to surface them.
 *
 * Scheduled-recurrence is only checked for sessions that would otherwise
 * fall into the `stale` bucket — opening per-session inbound.db files is
 * expensive, and the check is purely a stale-false-positive guard.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { heartbeatPath } from '../../session-manager.js';
import { log } from '../../log.js';
import type { AuthHandler } from '../router.js';

export type AttentionState = 'needs_me' | 'active' | 'idle' | 'stale';
export type ContainerStatus = 'running' | 'idle' | 'stale' | 'unknown';

export interface SessionSummary {
  agent_group_id: string;
  session_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;

  // Identity / labels
  title: string | null;

  // Activity timestamps
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_outbound_kind: string | null;

  // Lifecycle
  archived_at: string | null;
  container_status: ContainerStatus;
  has_pending_recurrence: boolean;

  // Task linkage (NULL when the session is a direct-conversation session)
  attached_task_id: string | null;
  attached_task_status: string | null;
  attached_task_needs_input: boolean | null;

  // Computed lane
  attention_state: AttentionState;
}

const FIVE_MIN_MS = 5 * 60_000;
const ONE_DAY_MS = 24 * 60 * 60_000;

function deriveContainerStatus(agentGroupId: string, sessionId: string): ContainerStatus {
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
 * Check the session's inbound.db for at least one pending scheduled-recurrence
 * row. Only invoked for sessions on the stale-bucket boundary — opening 33
 * SQLite files per request would otherwise be a per-page-load tax.
 *
 * Failures (missing DB, unreadable file) return false: the worst that
 * happens is the session shows up under "stale" when it shouldn't, which is
 * recoverable by the next refresh once the file lands.
 */
function hasPendingRecurrence(agentGroupId: string, sessionId: string, dataDir: string): boolean {
  const inboundPath = path.join(dataDir, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
  if (!fs.existsSync(inboundPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(inboundPath, { readonly: true });
    db.pragma('busy_timeout = 1000');
    const row = db
      .prepare(
        `SELECT 1 AS ok
           FROM messages_in
          WHERE status IN ('pending', 'paused')
            AND recurrence IS NOT NULL
          LIMIT 1`,
      )
      .get() as { ok: number } | undefined;
    return !!row;
  } catch (err) {
    log.warn('hasPendingRecurrence: probe failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    db?.close();
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

function deriveAttentionState(
  row: SessionJoinRow,
  containerStatus: ContainerStatus,
  hasRecurrence: boolean,
): AttentionState {
  const nowMs = Date.now();
  const lastInboundMs = row.last_active ? Date.parse(row.last_active) : 0;
  const lastOutboundMs = row.last_outbound_at ? Date.parse(row.last_outbound_at) : 0;

  // 1) needs_me — task-driven or chat-sdk question waiting on operator.
  if (row.attached_task_needs_input === 1) return 'needs_me';
  if (row.last_outbound_kind === 'chat-sdk:ask_question' && lastInboundMs < lastOutboundMs) {
    return 'needs_me';
  }

  // 2) active — current heartbeat or in-flight task; otherwise fall back to
  // "any activity within 5min" using the broader timestamp so a recent
  // outbound flush keeps the session in `active`. `pending` and `running`
  // attached-task statuses both count as in-flight from the operator's
  // POV — a queued task is still "this session is doing something".
  if (containerStatus === 'running') return 'active';
  if (row.attached_task_status === 'running' || row.attached_task_status === 'pending') return 'active';
  if (hasRecurrence) return 'active';
  const lastActivityMs = Math.max(lastInboundMs, lastOutboundMs);
  if (lastActivityMs && nowMs - lastActivityMs < FIVE_MIN_MS) return 'active';

  // 3) idle vs stale — the boundary is operator engagement. `last_active`
  // is inbound-only by schema. Newly created sessions can have no inbound
  // yet (e.g., agent-shared session that hasn't received its first wake
  // message) — for those we fall back to `created_at` so a 1-minute-old
  // session doesn't get classified `stale` on its first inbox refresh.
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
    // §2a: an out-of-scope group_id is treated as nonexistent, not refused —
    // the SQL filter naturally yields zero rows because the scope clause
    // above already restricts the row set. For owners (no_filter) we still
    // honor the explicit group_id filter.
    conditions.push('s.agent_group_id = ?');
    values.push(groupIdFilter);
  }

  if (!includeArchived) {
    conditions.push('s.archived_at IS NULL');
  }

  // Never-engaged sessions (an inbound message arrived but nothing ever
  // woke the agent — e.g. an unknown-sender or unmatched-engage-mode Slack
  // alert) still mint a session row and otherwise clutter the idle lane
  // forever. A session counts as engaged the moment ANY of these persist:
  //   - last_outbound_at   — an operator-visible reply was ever sent
  //                          (bumpLastOutbound in delivery.ts).
  //   - container_status   — the container is running/idle right now, so a
  //                          mid-first-turn session isn't hidden before it
  //                          has had a chance to reply.
  //   - t.task_id          — an in-flight (pending/running) task is
  //                          attached, mirroring the `active` attention
  //                          state's own definition of "doing something".
  // All three are already-selected central-DB columns — no per-session
  // file I/O, unlike the recurrence probe below. This is unconditional
  // (no toggle): the lane is meant to show real work only.
  conditions.push("(s.last_outbound_at IS NOT NULL OR s.container_status <> 'stopped' OR t.task_id IS NOT NULL)");

  values.push(limit);

  // Left-join the *most recent active* task for the child session so a
  // session shows its in-flight task's needs_input + status. The subquery
  // picks the newest pending/running row by admitted_at — if the worker
  // restarted, the historical row stays attached until the new one admits.
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
    rows = getDb()
      .prepare(sql)
      .all(...(values as Parameters<ReturnType<ReturnType<typeof getDb>['prepare']>['all']>)) as SessionJoinRow[];
  } catch (err) {
    log.warn('sessionsHandler: DB error', { err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sessions: SessionSummary[] = rows.map((row) => {
    const containerStatus = deriveContainerStatus(row.agent_group_id, row.id);
    // Only probe inbound.db for would-be-stale rows. Stale boundary uses
    // last_inbound (fallback created_at for never-inbounded sessions) so a
    // brand-new session-shared session doesn't trip the recurrence probe
    // on every refresh.
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
  });

  return new Response(JSON.stringify({ sessions }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

/* ─── Session detail (GET /dashboard/api/sessions/:id) ─────────────────────── */

export interface SessionTranscriptEntry {
  direction: 'in' | 'out';
  kind: string;
  seq: number;
  timestamp: string;
  text: string;
}

const TRANSCRIPT_TAIL = 50;

/**
 * Best-effort transcript reader. Opens the session's inbound + outbound DBs
 * read-only, pulls the last {@link TRANSCRIPT_TAIL} entries from each, and
 * merges them by seq so the operator sees the most-recent interleaved
 * conversation. Failures (DB missing, file corrupted) return an empty
 * array — the page renders the meta header either way.
 */
function readSessionTranscript(agentGroupId: string, sessionId: string): SessionTranscriptEntry[] {
  const out: SessionTranscriptEntry[] = [];

  function readSide(side: 'in' | 'out'): void {
    const file = side === 'in' ? 'inbound.db' : 'outbound.db';
    const table = side === 'in' ? 'messages_in' : 'messages_out';
    const p = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, file);
    if (!fs.existsSync(p)) return;
    let db: Database.Database | null = null;
    try {
      db = new Database(p, { readonly: true });
      db.pragma('busy_timeout = 1000');
      const rows = db
        .prepare(
          `SELECT seq, kind, timestamp, content
             FROM ${table}
            WHERE content IS NOT NULL AND content <> ''
            ORDER BY seq DESC
            LIMIT ?`,
        )
        .all(TRANSCRIPT_TAIL) as Array<{ seq: number; kind: string; timestamp: string; content: string }>;
      for (const r of rows) {
        let text: string;
        try {
          const parsed = JSON.parse(r.content) as { text?: unknown; prompt?: unknown; question?: unknown };
          text = String(parsed.text ?? parsed.prompt ?? parsed.question ?? r.content).trim();
        } catch {
          text = r.content;
        }
        out.push({ direction: side, kind: r.kind, seq: r.seq, timestamp: r.timestamp, text });
      }
    } catch (err) {
      log.warn('sessionsDetailHandler: transcript read failed', {
        side,
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      db?.close();
    }
  }

  readSide('in');
  readSide('out');
  // Newest first by seq; tail-trim the merged stream so we don't return >100
  // when both sides have full TRANSCRIPT_TAIL rows.
  out.sort((a, b) => b.seq - a.seq);
  return out.slice(0, TRANSCRIPT_TAIL);
}

export const sessionsDetailHandler: AuthHandler = async (_req, params, ctx) => {
  const sessionId = params['id'] ?? '';
  // Re-use the same SELECT shape from the list handler so the detail row
  // carries every field the inbox card already shows — saves the SPA from
  // round-tripping through the list endpoint just to render the header.
  const row = getDb()
    .prepare(
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
    )
    .get(sessionId) as SessionJoinRow | undefined;

  // §2a: nonexistent and out-of-scope both 404 with the same body. Same
  // collapse the steer + archive handlers use.
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

  const containerStatus = deriveContainerStatus(row.agent_group_id, row.id);
  const lastInboundMs = row.last_active ? Date.parse(row.last_active) : 0;
  const baselineMs = lastInboundMs || Date.parse(row.created_at);
  const couldBeStale =
    containerStatus !== 'running' &&
    row.attached_task_status !== 'running' &&
    row.attached_task_status !== 'pending' &&
    (!baselineMs || Date.now() - baselineMs >= ONE_DAY_MS);
  const hasRecurrence = couldBeStale ? hasPendingRecurrence(row.agent_group_id, row.id, DATA_DIR) : false;
  const attentionState = deriveAttentionState(row, containerStatus, hasRecurrence);

  const session: SessionSummary = {
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

  const transcript = readSessionTranscript(row.agent_group_id, row.id);

  return new Response(JSON.stringify({ session, transcript }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
