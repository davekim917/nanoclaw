import type { PendingApproval, PendingQuestion, Session } from '../types.js';
import { centralTransaction, withRawDb } from './central-lease.js';
import { getDb, hasTable } from './connection.js';

// ── Sessions ──

export const TASKS_SYSTEM_THREAD_ID = 'system:tasks';

/**
 * One constant, two executors (never a `*Sync` twin): `sessionStillActive` in `container-runner.ts` is a synchronous
 * `WakeGuard` that must run the SAME statement through the raw handle with nothing awaited before the spawn it
 * protects.
 */
export const SESSION_BY_ID_SQL = 'SELECT * FROM sessions WHERE id = ?';

export async function createSession(session: Session): Promise<void> {
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider, @status, @container_status, @last_active, @created_at)`,
    session,
  );
}

export async function getSession(id: string): Promise<Session | undefined> {
  return getDb().get<Session>(SESSION_BY_ID_SQL, id);
}

export async function findSession(messagingGroupId: string, threadId: string | null): Promise<Session | undefined> {
  if (threadId) {
    return getDb().get<Session>(
      'SELECT * FROM sessions WHERE messaging_group_id = ? AND thread_id = ? AND status = ?',
      messagingGroupId,
      threadId,
      'active',
    );
  }
  return getDb().get<Session>(
    'SELECT * FROM sessions WHERE messaging_group_id = ? AND thread_id IS NULL AND status = ?',
    messagingGroupId,
    'active',
  );
}

/**
 * Session lookup scoped to a specific agent group. Needed when multiple
 * agents are wired to the same messaging group + thread (fan-out) — the
 * plain `findSession` would return whichever agent's session happened to
 * be first and route to the wrong container.
 */
export async function findSessionForAgent(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
): Promise<Session | undefined> {
  if (threadId) {
    return getDb().get<Session>(
      "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ? AND status = 'active'",
      agentGroupId,
      messagingGroupId,
      threadId,
    );
  }
  return getDb().get<Session>(
    "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active'",
    agentGroupId,
    messagingGroupId,
  );
}

/**
 * Only sessions with `messaging_group_id IS NULL`, matching how agent-shared sessions are created, so an agent-shared
 * caller never lands in an mg-bound session of the same group.
 */
export async function findSessionByAgentGroup(agentGroupId: string): Promise<Session | undefined> {
  return getDb().get<Session>(
    `SELECT * FROM sessions
       WHERE agent_group_id = ?
         AND messaging_group_id IS NULL
         AND (thread_id IS NULL OR thread_id NOT LIKE 'system:%')
         AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
    agentGroupId,
  );
}

/**
 * Tasks must run in the channel-root session. `thread_id IS NULL` is load-bearing: without it a newer chat-thread
 * session for the same pair outranks the root and the task lands in the wrong inbound.db.
 */
export async function findSessionByAgentGroupAndMessagingGroup(
  agentGroupId: string,
  messagingGroupId: string,
): Promise<Session | undefined> {
  return getDb().get<Session>(
    "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    agentGroupId,
    messagingGroupId,
  );
}

export async function getSessionsByAgentGroup(agentGroupId: string): Promise<Session[]> {
  return getDb().all<Session>('SELECT * FROM sessions WHERE agent_group_id = ?', agentGroupId);
}

export async function findSystemSession(agentGroupId: string, threadId: string): Promise<Session | undefined> {
  return getDb().get<Session>(
    `SELECT * FROM sessions
       WHERE agent_group_id = ?
         AND messaging_group_id IS NULL
         AND thread_id = ?
         AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
    agentGroupId,
    threadId,
  );
}

/** Per-task session thread id for a scheduled task series. */
export function taskThreadId(seriesId: string): string {
  return `${TASKS_SYSTEM_THREAD_ID}:${seriesId}`;
}

/**
 * Also accepts the bare `system:tasks`: nothing creates it any more, but an upgraded install can still hold one.
 * Derive a series id with `taskSeriesId()`, never by slicing.
 */
export function isTaskThread(threadId: string | null): boolean {
  return threadId === TASKS_SYSTEM_THREAD_ID || (threadId?.startsWith(`${TASKS_SYSTEM_THREAD_ID}:`) ?? false);
}

/**
 * Null when the thread names no series. Slicing the prefix off the bare 12-character form yields an EMPTY series id,
 * which `recordTaskRunOutcome` would write into the escalation ledger unguarded.
 */
export function taskSeriesId(threadId: string | null): string | null {
  const prefix = `${TASKS_SYSTEM_THREAD_ID}:`;
  if (!threadId?.startsWith(prefix)) return null;
  return threadId.slice(prefix.length) || null;
}

/**
 * The legacy bare-form disjunct stays: this is how `ncl tasks` and the pin audit enumerate task sessions, and
 * narrowing it would make a live task invisible, including to `cancel`.
 */
export async function findTaskSessions(agentGroupId: string): Promise<Session[]> {
  return getDb().all<Session>(
    `SELECT * FROM sessions
       WHERE agent_group_id = ?
         AND messaging_group_id IS NULL
         AND status = 'active'
         AND (thread_id = ? OR thread_id LIKE ?)
       ORDER BY created_at DESC`,
    agentGroupId,
    TASKS_SYSTEM_THREAD_ID,
    `${TASKS_SYSTEM_THREAD_ID}:%`,
  );
}

export async function getActiveSessions(): Promise<Session[]> {
  return getDb().all<Session>("SELECT * FROM sessions WHERE status = 'active'");
}

/**
 * Bounds the minute-cadence bulk loops (iterating every active session ever created blocked the event loop for
 * seconds). A session idle past the horizon has no deliverable outbound or ack traffic; anything scheduled in it is
 * the host sweep's quiet-cache job.
 */
export async function getSessionsActiveSince(sinceIso: string): Promise<Session[]> {
  return getDb().all<Session>(
    `SELECT * FROM sessions
       WHERE status = 'active'
         AND (container_status IN ('running', 'idle')
              OR datetime(COALESCE(last_active, created_at)) >= datetime(?))`,
    sinceIso,
  );
}

export async function getRunningSessions(): Promise<Session[]> {
  return getDb().all<Session>("SELECT * FROM sessions WHERE container_status IN ('running', 'idle')");
}

export async function updateSession(
  id: string,
  updates: Partial<Pick<Session, 'status' | 'container_status' | 'last_active' | 'agent_provider'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (key === 'last_active') {
      // MONOTONIC, never verbatim: an activity write in the same millisecond as `withQuietInvalidationSync`'s +1 ms
      // would put the column back to a queued flush's guard basis (A→B→A), and the flush would reinstall a mark over
      // work that just became due. No +1 ms here; only the invalidation needs a strict increase.
      fields.push(
        'last_active = CASE WHEN last_active IS NULL OR last_active < @last_active THEN @last_active ELSE last_active END',
      );
    } else {
      fields.push(`${key} = @${key}`);
    }
    values[key] = value;
  }
  // Moving `last_active` makes the persisted quiet mark (migration 068) stale, so it is nulled in the SAME statement,
  // never a second write a crash could lose. This and `withQuietInvalidationSync` are the only host writers of
  // `last_active`; a new raw-SQL writer must do the same, with the monotonic CASE above.
  if (updates.last_active !== undefined) fields.push('sweep_quiet_until = NULL');
  if (fields.length === 0) return;

  await getDb().run(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`, values);
}

/** Thrown, never swallowed. */
export class QuietInvalidationError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, cause: unknown) {
    super(`quiet-mark invalidation failed for session ${sessionId}`, { cause });
    this.name = 'QuietInvalidationError';
    this.sessionId = sessionId;
  }
}

/**
 * Runs a due-ness write with its quiet mark invalidated first, or not at all; the ONLY shape a due-ness write may
 * have. `write` must be the synchronous better-sqlite3 mutation itself, inside an already-open mailbox callback:
 * never a promise, never a mailbox open.
 * Safe against a sweep's `persistQuietSessionMarks` flush (guarded on `last_active IS <basis>`) in both orders: a
 * basis read before this UPDATE fails its guard (the new value is strictly greater, even within one millisecond), and
 * one read after sees the due row already committed, since nothing awaits between the UPDATE and `write()`.
 * Fail-closed: `changes !== 1` means no ACTIVE row to invalidate, and the write is abandoned rather than committed
 * into a session the sweep will never enumerate. `archived_at` is deliberately not in the predicate: archived
 * sessions still run and are still enumerated.
 */
export function withQuietInvalidationSync<T>(sessionId: string, write: () => T): T {
  const now = new Date().toISOString();
  // Executes through `withRawDb`, so the caller must hold a `withCentralSync` block around both the invalidation and
  // the write. Outside one the raw access throws its own contract error, deliberately not wrapped as
  // `QuietInvalidationError`: it is a call-site bug, not a DB refusal.
  const changes = withRawDb((raw) => {
    try {
      return raw
        .prepare(
          `UPDATE sessions
              SET last_active = CASE
                    WHEN last_active IS NULL OR last_active < @now THEN @now
                    -- Strictly increasing even when the clock has not moved: see
                    -- the first ordering case above.
                    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_active, '+0.001 seconds')
                  END,
                  sweep_quiet_until = NULL
            WHERE id = @id
              AND status = 'active'`,
        )
        .run({ id: sessionId, now }).changes;
    } catch (err) {
      throw new QuietInvalidationError(sessionId, err);
    }
  });
  if (changes !== 1) {
    throw new QuietInvalidationError(
      sessionId,
      new Error(`no active session row to invalidate (${changes} rows matched)`),
    );
  }
  return write();
}

export interface QuietSessionMark {
  sessionId: string;
  /** ISO-8601 UTC. */
  quietUntil: string;
  /**
   * The row's `last_active` when the mark was computed: the write guard in `persistQuietSessionMarks`, not
   * decoration.
   */
  lastActive: string | null;
}

/**
 * One statement for the batch, called only on the quiet TRANSITION, never to re-confirm an existing mark.
 * The `last_active` guard is load-bearing: marks are flushed after the whole fan-out, and inbound arriving during a
 * yield bumps `last_active` and clears the column; an unconditional write would restore a stale expiry that a restart
 * would warm, skipping a genuinely due session. `IS`, not `=`, because `last_active` is nullable.
 */
export async function persistQuietSessionMarks(marks: readonly QuietSessionMark[]): Promise<void> {
  if (marks.length === 0) return;
  const byId: Record<string, { until: string; basis: string | null }> = {};
  for (const mark of marks) byId[mark.sessionId] = { until: mark.quietUntil, basis: mark.lastActive };
  await getDb().run(
    `UPDATE sessions
          SET sweep_quiet_until = json_extract(j.value, '$.until')
         FROM json_each(@marks) AS j
        WHERE sessions.id = j.key
          AND sessions.last_active IS json_extract(j.value, '$.basis')`,
    { marks: JSON.stringify(byId) },
  );
}

export interface WarmQuietSessionMark {
  id: string;
  sweep_quiet_until: string;
  last_active: string | null;
}

/**
 * Pure read: an expired mark is filtered, not cleared. `status = 'active'` makes a prune duty unnecessary, since a
 * mark on a closed session is unreachable and the reclaim deletes the row.
 */
export async function getWarmQuietSessionMarks(nowIso: string): Promise<WarmQuietSessionMark[]> {
  return getDb().all<WarmQuietSessionMark>(
    `SELECT id, sweep_quiet_until, last_active
         FROM sessions
        WHERE status = 'active'
          AND sweep_quiet_until IS NOT NULL
          AND datetime(sweep_quiet_until) > datetime(@now)`,
    { now: nowIso },
  );
}

/**
 * Also deletes the central rows keyed to the session that nothing else would ever clear: `cli_request_executions`
 * (retained on a terminal signal, not a clock) and `delivery_attempts` (no cascading FK). One central transaction.
 */
export async function deleteSession(id: string): Promise<void> {
  await centralTransaction(async () => {
    const db = getDb();
    await db.run('DELETE FROM cli_request_executions WHERE session_id = ?', id);
    await db.run('DELETE FROM delivery_attempts WHERE session_id = ?', id);
    await db.run('DELETE FROM sessions WHERE id = ?', id);
  }, 'deleteSession');
}

/**
 * Run at host startup so orphaned rows take the cold-spawn path immediately and the sweep stops enforcing SLAs
 * against phantom containers. Returns the row count.
 */
export async function resetPhantomContainerStatus(): Promise<number> {
  const result = await getDb().run(
    "UPDATE sessions SET container_status = 'stopped' WHERE container_status IN ('running', 'idle')",
  );
  return result.changes;
}

/**
 * Returns true only when the row flipped to archived, so callers can gate SSE emits without a second read. Archiving
 * is display-only: the session still processes traffic and runs its container.
 */
export async function archiveSessionById(id: string, archivedAt: string = new Date().toISOString()): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL`,
    archivedAt,
    id,
  );
  return result.changes > 0;
}

export async function unarchiveSessionById(id: string): Promise<void> {
  await getDb().run(`UPDATE sessions SET archived_at = NULL WHERE id = ?`, id);
}

/**
 * Keeps the central row in step with the per-session outbound.db after a platform send. `kind` is granular
 * (`chat-sdk:<content.type>`) so the inbox can tell question prompts from chat without re-parsing.
 */
export async function bumpLastOutbound(id: string, kind: string): Promise<void> {
  // Bound ISO, NOT `datetime('now')`: SQLite compares the naive shape as TEXT, so a naive 11pm row sorts below an ISO
  // 7am row of the same day and `MAX(last_outbound_at)` picks the wrong session.
  await getDb().run(
    `UPDATE sessions
          SET last_outbound_at = ?,
              last_outbound_kind = ?
        WHERE id = ?`,
    new Date().toISOString(),
    kind,
    id,
  );
}

/**
 * THE authority for "is this thread engaged" (`mention-sticky` and the thread-history backfill read it), so every
 * entry point that wakes a session must call it. First-write-wins. Call it AFTER a backfill on the same wake reads
 * `engaged_at`: the backfill needs the pre-engagement state.
 */
export async function markSessionEngaged(id: string): Promise<void> {
  await getDb().run(
    `UPDATE sessions SET engaged_at = ? WHERE id = ? AND engaged_at IS NULL`,
    new Date().toISOString(),
    id,
  );
}

/**
 * The `platform_id` the series was scheduled against (where an unaddressed reply lands), NOT where it posts
 * (migration 056). Last-write-wins, unlike `markSessionEngaged`: a series moved to another channel must carry its
 * CURRENT stamp.
 */
export async function setTaskRoutingPlatformId(id: string, platformId: string): Promise<void> {
  await getDb().run('UPDATE sessions SET task_routing_platform_id = ? WHERE id = ?', platformId, id);
}

// ── Pending Questions ──

/**
 * Insert a pending question row. Idempotent: when delivery fails and retries,
 * the second attempt calls this with the same question_id — without `OR
 * IGNORE` that would throw UNIQUE and prevent the retry from reaching the
 * actual send step. Returns true if a new row was inserted.
 */
export async function createPendingQuestion(pq: PendingQuestion): Promise<boolean> {
  const result = await getDb().run(
    `INSERT OR IGNORE INTO pending_questions (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, question, options_json, created_at)
       VALUES (@question_id, @session_id, @message_out_id, @platform_id, @channel_type, @thread_id, @title, @question, @options_json, @created_at)`,
    {
      question_id: pq.question_id,
      session_id: pq.session_id,
      message_out_id: pq.message_out_id,
      platform_id: pq.platform_id,
      channel_type: pq.channel_type,
      thread_id: pq.thread_id,
      title: pq.title,
      question: pq.question,
      options_json: JSON.stringify(pq.options),
      created_at: pq.created_at,
    },
  );
  return result.changes > 0;
}

export async function getPendingQuestion(questionId: string): Promise<PendingQuestion | undefined> {
  const row = await getDb().get<Omit<PendingQuestion, 'options'> & { options_json: string }>(
    'SELECT * FROM pending_questions WHERE question_id = ?',
    questionId,
  );
  if (!row) return undefined;
  const { options_json, ...rest } = row;
  return { ...rest, options: JSON.parse(options_json) };
}

export async function deletePendingQuestion(questionId: string): Promise<void> {
  await getDb().run('DELETE FROM pending_questions WHERE question_id = ?', questionId);
}

// ── Pending Approvals ──

/**
 * Insert a pending approval row. Idempotent for the same reason as
 * createPendingQuestion: delivery retries with the same approval_id must not
 * fail on UNIQUE before the send step gets a chance to succeed.
 *
 * Returns false when `INSERT OR IGNORE` skipped the row. That is also the
 * RESERVATION signal: a UNIQUE index can make this insert an atomic claim on
 * a column other than the PK, and `request_choice` relies on exactly that —
 * migration 078's partial unique index on `request_id` for live choice cards
 * (src/db/migrations/078-choice-request-reservation.ts). So a false here
 * means "some other row already holds this request_id", and
 * `requestApprovalOutcome` (src/modules/approvals/primitive.ts) turns it into
 * 'duplicate-request' instead of posting a second card. A foreign-key
 * violation is NOT swallowed by OR IGNORE — SQLite aborts those regardless of
 * the conflict resolution algorithm — so a false is always a uniqueness
 * conflict, never a missing parent row.
 */
export async function createPendingApproval(
  pa: Partial<PendingApproval> &
    Pick<
      PendingApproval,
      'approval_id' | 'request_id' | 'action' | 'payload' | 'created_at' | 'title' | 'options_json'
    >,
): Promise<boolean> {
  const result = await getDb().run(
    `INSERT OR IGNORE INTO pending_approvals
         (approval_id, session_id, request_id, action, payload, created_at,
          agent_group_id, channel_type, platform_id, instance, thread_id, platform_message_id, expires_at, status,
          title, question, options_json, approver_user_id)
       VALUES
         (@approval_id, @session_id, @request_id, @action, @payload, @created_at,
          @agent_group_id, @channel_type, @platform_id, @instance, @thread_id, @platform_message_id, @expires_at, @status,
          @title, @question, @options_json, @approver_user_id)`,
    {
      session_id: null,
      agent_group_id: null,
      channel_type: null,
      platform_id: null,
      instance: null,
      thread_id: null,
      platform_message_id: null,
      expires_at: null,
      status: 'pending',
      question: '',
      approver_user_id: null,
      ...pa,
    },
  );
  return result.changes > 0;
}

export async function getPendingApprovalsBySession(sessionId: string): Promise<PendingApproval[]> {
  return getDb().all<PendingApproval>(
    'SELECT * FROM pending_approvals WHERE session_id = ? AND status = ?',
    sessionId,
    'pending',
  );
}

export async function getPendingApprovalByRequestId(requestId: string): Promise<PendingApproval | undefined> {
  return getDb().get<PendingApproval>(
    'SELECT * FROM pending_approvals WHERE request_id = ? AND status = ?',
    requestId,
    'pending',
  );
}

export async function updatePendingApprovalMessageId(
  approvalId: string,
  platformMessageId: string | null,
): Promise<void> {
  await getDb().run(
    'UPDATE pending_approvals SET platform_message_id = ? WHERE approval_id = ?',
    platformMessageId,
    approvalId,
  );
}

/** For the guard seam's synchronous grant check. */
export const PENDING_APPROVAL_BY_ID_SQL = 'SELECT * FROM pending_approvals WHERE approval_id = ?';

export async function getPendingApproval(approvalId: string): Promise<PendingApproval | undefined> {
  return getDb().get<PendingApproval>(PENDING_APPROVAL_BY_ID_SQL, approvalId);
}

export async function updatePendingApprovalStatus(
  approvalId: string,
  status: PendingApproval['status'],
): Promise<void> {
  await getDb().run('UPDATE pending_approvals SET status = ? WHERE approval_id = ?', status, approvalId);
}

/**
 * Compare-and-swap: true only for the caller that moved the row. A card stays clickable across restarts, so a click
 * and the expiry sweep can race; the loser sees 0 changes and backs off.
 */
export async function transitionPendingApprovalStatus(
  approvalId: string,
  from: PendingApproval['status'],
  to: PendingApproval['status'],
): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE pending_approvals SET status = ? WHERE approval_id = ? AND status = ?',
    to,
    approvalId,
    from,
  );
  return result.changes > 0;
}

/**
 * Park an approval in the "rejected, awaiting reason" hold: the admin clicked
 * "Reject with reason…" and we're waiting for their one-line reply. `expiresAt`
 * is the deadline after which the host sweep finalizes a plain reject (so a
 * ghosted hold never strands the requesting agent). Reuses the otherwise-unused
 * `expires_at` column on module-initiated rows.
 */
export async function markApprovalAwaitingReason(approvalId: string, expiresAt: string): Promise<void> {
  await getDb().run(
    "UPDATE pending_approvals SET status = 'awaiting_reason', expires_at = ? WHERE approval_id = ?",
    expiresAt,
    approvalId,
  );
}

/** Awaiting-reason approvals whose reply window has elapsed — the sweep's ghost set. */
export async function getExpiredAwaitingReasonApprovals(nowIso: string): Promise<PendingApproval[]> {
  return getDb().all<PendingApproval>(
    "SELECT * FROM pending_approvals WHERE status = 'awaiting_reason' AND expires_at IS NOT NULL AND expires_at <= ?",
    nowIso,
  );
}

export async function deletePendingApproval(approvalId: string): Promise<void> {
  await getDb().run('DELETE FROM pending_approvals WHERE approval_id = ?', approvalId);
}

export async function getPendingApprovalsByAction(action: string): Promise<PendingApproval[]> {
  return getDb().all<PendingApproval>('SELECT * FROM pending_approvals WHERE action = ?', action);
}

/**
 * Resolve ask_question render metadata (title + normalized options) for any
 * card, regardless of whether it was persisted as a pending_question (generic
 * ask_user_question) or a pending_approval (self-mod / OneCLI credential).
 *
 * A pending_approval wins when both hold the id. Approval ids are host-minted
 * and question ids are whatever the agent wrote, so an agent's row reusing an
 * approval's id must never decide what a click on the real card means.
 */
export async function getAskQuestionRender(id: string): Promise<
  | {
      title: string;
      question?: string;
      options: import('../channels/ask-question.js').NormalizedOption[];
      /** pending_approvals rows only, so a reader classifies the card from this same read. */
      action?: string;
    }
  | undefined
> {
  const db = getDb();

  const parseRender = (
    row: { title: string; question?: string; options_json: string } | undefined,
  ):
    | { title: string; question?: string; options: import('../channels/ask-question.js').NormalizedOption[] }
    | undefined => {
    if (!row) return undefined;
    try {
      const options = JSON.parse(row.options_json);
      if (!Array.isArray(options)) return undefined;
      // A blank legacy title must not make an otherwise-valid card undecodable; options are the authority.
      return {
        title: row.title || '❓ Question',
        question: row.question,
        options: options as import('../channels/ask-question.js').NormalizedOption[],
      };
    } catch {
      // Corrupt metadata must never turn an index into an arbitrary approval response; the card stays pending.
      return undefined;
    }
  };

  const a = await db.get<{ title: string; question: string; options_json: string; action: string }>(
    'SELECT title, question, options_json, action FROM pending_approvals WHERE approval_id = ?',
    id,
  );
  if (a) {
    // Corrupt approval options leave the click unresolved rather than fall through to an agent's row.
    const approvalRender = parseRender(a);
    return approvalRender ? { ...approvalRender, action: a.action } : undefined;
  }

  const q = await getPendingQuestion(id);
  if (q) return { title: q.title, question: q.question, options: q.options };

  if (await hasTable(db, 'pending_channel_approvals')) {
    const c = await db.get<{ title: string; question: string; options_json: string }>(
      'SELECT title, question, options_json FROM pending_channel_approvals WHERE messaging_group_id = ?',
      id,
    );
    const channelRender = parseRender(c);
    if (channelRender) return channelRender;
  }

  if (await hasTable(db, 'pending_sender_approvals')) {
    const s = await db.get<{ title: string; question: string; options_json: string }>(
      'SELECT title, question, options_json FROM pending_sender_approvals WHERE id = ?',
      id,
    );
    const senderRender = parseRender(s);
    if (senderRender) return senderRender;
  }

  return undefined;
}
