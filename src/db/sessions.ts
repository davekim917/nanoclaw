import type { PendingApproval, PendingQuestion, Session } from '../types.js';
import { getDb, hasTable } from './connection.js';
import { log } from '../log.js';

// ── Sessions ──

export const TASKS_SYSTEM_THREAD_ID = 'system:tasks';

export function createSession(session: Session): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider, @status, @container_status, @last_active, @created_at)`,
    )
    .run(session);
}

export function getSession(id: string): Session | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
}

export function findSession(messagingGroupId: string, threadId: string | null): Session | undefined {
  if (threadId) {
    return getDb()
      .prepare('SELECT * FROM sessions WHERE messaging_group_id = ? AND thread_id = ? AND status = ?')
      .get(messagingGroupId, threadId, 'active') as Session | undefined;
  }
  return getDb()
    .prepare('SELECT * FROM sessions WHERE messaging_group_id = ? AND thread_id IS NULL AND status = ?')
    .get(messagingGroupId, 'active') as Session | undefined;
}

/**
 * Session lookup scoped to a specific agent group. Needed when multiple
 * agents are wired to the same messaging group + thread (fan-out) — the
 * plain `findSession` would return whichever agent's session happened to
 * be first and route to the wrong container.
 */
export function findSessionForAgent(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
): Session | undefined {
  if (threadId) {
    return getDb()
      .prepare(
        "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ? AND status = 'active'",
      )
      .get(agentGroupId, messagingGroupId, threadId) as Session | undefined;
  }
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active'",
    )
    .get(agentGroupId, messagingGroupId) as Session | undefined;
}

/**
 * Find the active **agent-shared** session for an agent group — i.e. one
 * with `messaging_group_id IS NULL`. Agent-shared sessions are created with
 * mg=null on purpose (see resolveSession's agent-shared branch); this lookup
 * mirrors that so agent-shared callers don't silently land in an mg-bound
 * session of the same agent group.
 */
export function findSessionByAgentGroup(agentGroupId: string): Session | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE agent_group_id = ?
         AND messaging_group_id IS NULL
         AND (thread_id IS NULL OR thread_id NOT LIKE 'system:%')
         AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(agentGroupId) as Session | undefined;
}

/**
 * Find an active threadless session scoped to a (agent_group_id,
 * messaging_group_id) pair. Used by scheduleTask: tasks must run in the
 * channel-root session, never inside a chat thread session — otherwise the
 * task fires inside a thread container with that thread's history as context
 * (and possibly a stopped container that never wakes for cron).
 *
 * `thread_id IS NULL` is the load-bearing filter. Without it, an existing
 * chat-thread session for the same (agent, MG) pair will outrank the
 * channel-root session because it's likely newer, and the task gets inserted
 * into the wrong inbound.db.
 */
export function findSessionByAgentGroupAndMessagingGroup(
  agentGroupId: string,
  messagingGroupId: string,
): Session | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    )
    .get(agentGroupId, messagingGroupId) as Session | undefined;
}

export function getSessionsByAgentGroup(agentGroupId: string): Session[] {
  return getDb().prepare('SELECT * FROM sessions WHERE agent_group_id = ?').all(agentGroupId) as Session[];
}

export function findSystemSession(agentGroupId: string, threadId: string): Session | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE agent_group_id = ?
         AND messaging_group_id IS NULL
         AND thread_id = ?
         AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(agentGroupId, threadId) as Session | undefined;
}

/** Per-task session thread id for a scheduled task series. */
export function taskThreadId(seriesId: string): string {
  return `${TASKS_SYSTEM_THREAD_ID}:${seriesId}`;
}

/** True for any task session thread — a per-series one or the legacy shared one. */
export function isTaskThread(threadId: string | null): boolean {
  return threadId === TASKS_SYSTEM_THREAD_ID || (threadId?.startsWith(`${TASKS_SYSTEM_THREAD_ID}:`) ?? false);
}

/** All active task sessions for a group — one per live series, plus any legacy shared one. */
export function findTaskSessions(agentGroupId: string): Session[] {
  return getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE agent_group_id = ?
         AND messaging_group_id IS NULL
         AND status = 'active'
         AND (thread_id = ? OR thread_id LIKE ?)
       ORDER BY created_at DESC`,
    )
    .all(agentGroupId, TASKS_SYSTEM_THREAD_ID, `${TASKS_SYSTEM_THREAD_ID}:%`) as Session[];
}

export function getActiveSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE status = 'active'").all() as Session[];
}

/**
 * Active sessions with recent activity (or a live container). Bounds the
 * minute-cadence bulk loops: iterating every active session ever created
 * (3k+ rows, synchronous SQLite each) was blocking the event loop 3-5s per
 * cycle. A session idle past the horizon has no deliverable outbound and no
 * ack traffic; anything scheduled in it is the host sweep's quiet-cache job.
 */
export function getSessionsActiveSince(sinceIso: string): Session[] {
  return getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE status = 'active'
         AND (container_status IN ('running', 'idle')
              OR datetime(COALESCE(last_active, created_at)) >= datetime(?))`,
    )
    .all(sinceIso) as Session[];
}

export function getRunningSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE container_status IN ('running', 'idle')").all() as Session[];
}

export function updateSession(
  id: string,
  updates: Partial<Pick<Session, 'status' | 'container_status' | 'last_active' | 'agent_provider'>>,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  // The host sweep's persisted quiet mark (migration 065) is a prediction of
  // when this session next has work — taken while `last_active` held some
  // earlier value. Moving `last_active` is precisely the event that says the
  // prediction is stale, so the mark dies in the SAME statement, never in a
  // second write a caller could forget or a crash could lose. This is the
  // durable half of the in-memory cache's `mark.lastActive === last_active`
  // check, and `updateSession` is the only writer of `last_active` in the host
  // — a future raw-SQL writer would silently reintroduce a mark that outlives
  // a newly due row.
  if (updates.last_active !== undefined) fields.push('sweep_quiet_until = NULL');
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

/**
 * Bump a session's central last_active to now. REQUIRED after any write that
 * changes when the session next has due work (task insert, process_after
 * edit, recurrence re-arm): the host-sweep quiet cache and the delivery
 * sweep's activity horizon both key on last_active, so a task written into a
 * quiet/dormant session without this bump sits unseen until the cache
 * expires — or, past the 7-day delivery horizon, indefinitely.
 */
export function touchSessionActivity(id: string): void {
  try {
    updateSession(id, { last_active: new Date().toISOString() });
  } catch (err) {
    // Advisory freshness hint — a failed bump must never abort the task
    // write it rides on. Worst case is the old behavior (cache skips until
    // expiry), loudly.
    log.warn('touchSessionActivity failed', { sessionId: id, err });
  }
}

/** One quiet mark to persist: the session, and the ISO instant its skip expires. */
export interface QuietSessionMark {
  sessionId: string;
  /** ISO-8601 UTC. */
  quietUntil: string;
}

/**
 * Persist a whole tick's newly-taken quiet marks.
 *
 * ONE statement for the batch, not one per session, and called only on the
 * quiet TRANSITION — never on a tick that merely re-confirms an existing mark.
 * A per-tick write of the ~840 rows the cache already holds would be a new
 * cost, not a saving; the whole point of the cache is that a quiet session
 * costs nothing per tick.
 *
 * Advisory: the caller treats a throw as "no mark", which degrades to a cold
 * sweep and never to a session skipped past due work.
 */
export function persistQuietSessionMarks(marks: readonly QuietSessionMark[]): void {
  if (marks.length === 0) return;
  const byId: Record<string, string> = {};
  for (const mark of marks) byId[mark.sessionId] = mark.quietUntil;
  getDb()
    .prepare(
      `UPDATE sessions
          SET sweep_quiet_until = j.value
         FROM json_each(@marks) AS j
        WHERE sessions.id = j.key`,
    )
    .run({ marks: JSON.stringify(byId) });
}

/** A persisted quiet mark, with the `last_active` the warm path re-bases it on. */
export interface WarmQuietSessionMark {
  id: string;
  sweep_quiet_until: string;
  last_active: string | null;
}

/**
 * Every still-valid persisted quiet mark, for `startHostSweep` to warm the
 * in-memory cache from. One query, no per-session DB opens.
 *
 * `status = 'active'` is what makes a prune duty unnecessary: a closed or
 * archiving session is never in the sweep's session list, so a mark left on
 * its row is unreachable rather than stale, and the reclaim deletes the row.
 * An expired mark is filtered here rather than cleared, so this is a pure read.
 */
export function getWarmQuietSessionMarks(nowIso: string): WarmQuietSessionMark[] {
  return getDb()
    .prepare(
      `SELECT id, sweep_quiet_until, last_active
         FROM sessions
        WHERE status = 'active'
          AND sweep_quiet_until IS NOT NULL
          AND datetime(sweep_quiet_until) > datetime(@now)`,
    )
    .all({ now: nowIso }) as WarmQuietSessionMark[];
}

/**
 * Delete a session and the central rows keyed to it.
 *
 * `cli_request_executions` (src/cli/request-ledger.ts) is retained on a
 * terminal signal rather than a clock, so its newest claim per session has no
 * age at which it expires — without this it would outlive the session forever.
 * A session with no row has no container and no delivery loop, so nothing is
 * left that could replay or re-execute the request the claim guarded.
 */
export function deleteSession(id: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM cli_request_executions WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  })();
}

/**
 * Mark every session whose central-DB container_status is 'running' or 'idle'
 * as 'stopped'. Called at host startup because session containers all use
 * `--rm` and don't survive the host process restart — leaving these rows
 * inconsistent makes the sweep waste cycles enforcing SLA against
 * phantom containers (e.g., the kill-ceiling and kill-claim warnings
 * observed against sessions whose docker container had been gone for
 * days). The in-memory activeContainers map starts empty after restart;
 * this brings central DB in line so a freshly-arrived inbound for an
 * orphaned session takes the cold-spawn path immediately rather than the
 * "thinks it's alive, try to kill, no-op" path. Returns the row count.
 */
export function resetPhantomContainerStatus(): number {
  const result = getDb()
    .prepare("UPDATE sessions SET container_status = 'stopped' WHERE container_status IN ('running', 'idle')")
    .run();
  return result.changes;
}

/**
 * Soft-dismiss a session from the inbox's default view. Returns true when
 * the row flipped from visible→archived (mirrors `archiveTaskById`'s
 * change-only contract so callers can gate SSE emits without doing a
 * second read). Archived sessions still process inbound traffic and run
 * their containers; archiving is purely an operator-side display flag.
 */
export function archiveSessionById(id: string, archivedAt: string = new Date().toISOString()): boolean {
  const result = getDb()
    .prepare(`UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL`)
    .run(archivedAt, id);
  return result.changes > 0;
}

export function unarchiveSessionById(id: string): void {
  getDb().prepare(`UPDATE sessions SET archived_at = NULL WHERE id = ?`).run(id);
}

/**
 * Bump `last_outbound_at` to now and stamp the kind tag for inbox attention-
 * state derivation. Called from delivery.ts after a successful host→platform
 * send so the central row doesn't fall behind the per-session outbound.db.
 *
 * `kind` is the granular tag — for `chat-sdk` messages the caller passes
 * `chat-sdk:<content.type>` (e.g., `chat-sdk:ask_question`) so the inbox
 * can distinguish question-prompts from ordinary chat without re-parsing.
 */
export function bumpLastOutbound(id: string, kind: string): void {
  // Bound ISO, NOT `datetime('now')`: that yields the naive
  // `YYYY-MM-DD HH:MM:SS` shape, and SQLite compares it against ISO values as
  // TEXT — at index 10 'T' (0x54) beats ' ' (0x20), so a naive 11pm row sorts
  // BELOW an ISO 7am one from the same day and `MAX(last_outbound_at)` (the
  // observatory's most-recent-activity read) picks the wrong session.
  getDb()
    .prepare(
      `UPDATE sessions
          SET last_outbound_at = ?,
              last_outbound_kind = ?
        WHERE id = ?`,
    )
    .run(new Date().toISOString(), kind, id);
}

/**
 * Record that an agent actually engaged in this session — a mention, a wake,
 * or an inbound agent-to-agent message. THE authority for "is this thread
 * engaged"; `mention-sticky` and the thread-history backfill both read it, so
 * every entry point that wakes a session must call this rather than inventing
 * its own notion of engagement.
 *
 * First-write-wins (`WHERE engaged_at IS NULL`): the column answers "when did
 * this thread first engage", which is a stable auditable fact, and both
 * readers only care about set-versus-NULL. Re-stamping on every turn would
 * turn it into a second `last_active` and cost a write per turn for nothing.
 *
 * Call it AFTER reading `engaged_at` for backfill purposes on the same wake —
 * the backfill's whole question is what the session looked like before this
 * engagement.
 */
export function markSessionEngaged(id: string): void {
  getDb()
    .prepare(`UPDATE sessions SET engaged_at = ? WHERE id = ? AND engaged_at IS NULL`)
    .run(new Date().toISOString(), id);
}

/**
 * Stamp a task session's routing — the `messaging_groups.platform_id` the
 * series was scheduled against ("where an unaddressed reply lands"), NOT a
 * claim about where it posts. See migration 056 and `resolveTaskSession`,
 * which is the only caller.
 *
 * Last-write-wins, unlike `markSessionEngaged`: a series re-pointed to another
 * channel (`scheduled-move` cancels in the source and re-`scheduleTask`s into
 * the target, which lands back here) must carry its CURRENT stamp, not the one
 * it was born with.
 *
 * Deliberately not folded into `createSession`'s INSERT: that insert is shared
 * with every ordinary chat session, and adding a named parameter there would
 * force every `Session` literal in the codebase to carry a field only task
 * sessions ever use.
 */
export function setTaskRoutingPlatformId(id: string, platformId: string): void {
  getDb().prepare('UPDATE sessions SET task_routing_platform_id = ? WHERE id = ?').run(platformId, id);
}

// ── Pending Questions ──

/**
 * Insert a pending question row. Idempotent: when delivery fails and retries,
 * the second attempt calls this with the same question_id — without `OR
 * IGNORE` that would throw UNIQUE and prevent the retry from reaching the
 * actual send step. Returns true if a new row was inserted.
 */
export function createPendingQuestion(pq: PendingQuestion): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_questions (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, question, options_json, created_at)
       VALUES (@question_id, @session_id, @message_out_id, @platform_id, @channel_type, @thread_id, @title, @question, @options_json, @created_at)`,
    )
    .run({
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
    });
  return result.changes > 0;
}

export function getPendingQuestion(questionId: string): PendingQuestion | undefined {
  const row = getDb().prepare('SELECT * FROM pending_questions WHERE question_id = ?').get(questionId) as
    | (Omit<PendingQuestion, 'options'> & { options_json: string })
    | undefined;
  if (!row) return undefined;
  const { options_json, ...rest } = row;
  return { ...rest, options: JSON.parse(options_json) };
}

export function deletePendingQuestion(questionId: string): void {
  getDb().prepare('DELETE FROM pending_questions WHERE question_id = ?').run(questionId);
}

// ── Pending Approvals ──

/**
 * Insert a pending approval row. Idempotent for the same reason as
 * createPendingQuestion: delivery retries with the same approval_id must not
 * fail on UNIQUE before the send step gets a chance to succeed.
 */
export function createPendingApproval(
  pa: Partial<PendingApproval> &
    Pick<
      PendingApproval,
      'approval_id' | 'request_id' | 'action' | 'payload' | 'created_at' | 'title' | 'options_json'
    >,
): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_approvals
         (approval_id, session_id, request_id, action, payload, created_at,
          agent_group_id, channel_type, platform_id, instance, thread_id, platform_message_id, expires_at, status,
          title, question, options_json, approver_user_id)
       VALUES
         (@approval_id, @session_id, @request_id, @action, @payload, @created_at,
          @agent_group_id, @channel_type, @platform_id, @instance, @thread_id, @platform_message_id, @expires_at, @status,
          @title, @question, @options_json, @approver_user_id)`,
    )
    .run({
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
    });
  return result.changes > 0;
}

export function getPendingApprovalsBySession(sessionId: string): PendingApproval[] {
  return getDb()
    .prepare('SELECT * FROM pending_approvals WHERE session_id = ? AND status = ?')
    .all(sessionId, 'pending') as PendingApproval[];
}

export function getPendingApprovalByRequestId(requestId: string): PendingApproval | undefined {
  return getDb()
    .prepare('SELECT * FROM pending_approvals WHERE request_id = ? AND status = ?')
    .get(requestId, 'pending') as PendingApproval | undefined;
}

export function updatePendingApprovalMessageId(approvalId: string, platformMessageId: string | null): void {
  getDb()
    .prepare('UPDATE pending_approvals SET platform_message_id = ? WHERE approval_id = ?')
    .run(platformMessageId, approvalId);
}

export function getPendingApproval(approvalId: string): PendingApproval | undefined {
  return getDb().prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId) as
    | PendingApproval
    | undefined;
}

export function updatePendingApprovalStatus(approvalId: string, status: PendingApproval['status']): void {
  getDb().prepare('UPDATE pending_approvals SET status = ? WHERE approval_id = ?').run(status, approvalId);
}

/**
 * Compare-and-swap on an approval's status. Returns true only for the caller
 * that actually moved the row from `from` to `to`.
 *
 * This is the claim primitive for row-keyed resolution: a card stays clickable
 * across a host restart, so two paths can race for the same row (an admin
 * click and the expiry sweep, or a click that arrives while the pre-TTL timer
 * is firing). An unconditional UPDATE lets both "win" and the request gets
 * decided twice. Single-statement UPDATE ... WHERE status = ? is atomic in
 * SQLite, so the loser sees changes === 0 and backs off.
 */
export function transitionPendingApprovalStatus(
  approvalId: string,
  from: PendingApproval['status'],
  to: PendingApproval['status'],
): boolean {
  const result = getDb()
    .prepare('UPDATE pending_approvals SET status = ? WHERE approval_id = ? AND status = ?')
    .run(to, approvalId, from);
  return result.changes > 0;
}

/**
 * Park an approval in the "rejected, awaiting reason" hold: the admin clicked
 * "Reject with reason…" and we're waiting for their one-line reply. `expiresAt`
 * is the deadline after which the host sweep finalizes a plain reject (so a
 * ghosted hold never strands the requesting agent). Reuses the otherwise-unused
 * `expires_at` column on module-initiated rows.
 */
export function markApprovalAwaitingReason(approvalId: string, expiresAt: string): void {
  getDb()
    .prepare("UPDATE pending_approvals SET status = 'awaiting_reason', expires_at = ? WHERE approval_id = ?")
    .run(expiresAt, approvalId);
}

/** Awaiting-reason approvals whose reply window has elapsed — the sweep's ghost set. */
export function getExpiredAwaitingReasonApprovals(nowIso: string): PendingApproval[] {
  return getDb()
    .prepare(
      "SELECT * FROM pending_approvals WHERE status = 'awaiting_reason' AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .all(nowIso) as PendingApproval[];
}

export function deletePendingApproval(approvalId: string): void {
  getDb().prepare('DELETE FROM pending_approvals WHERE approval_id = ?').run(approvalId);
}

export function getPendingApprovalsByAction(action: string): PendingApproval[] {
  return getDb().prepare('SELECT * FROM pending_approvals WHERE action = ?').all(action) as PendingApproval[];
}

/**
 * Resolve ask_question render metadata (title + normalized options) for any
 * card, regardless of whether it was persisted as a pending_question (generic
 * ask_user_question) or a pending_approval (self-mod / OneCLI credential).
 */
export function getAskQuestionRender(
  id: string,
): { title: string; question?: string; options: import('../channels/ask-question.js').NormalizedOption[] } | undefined {
  const q = getPendingQuestion(id);
  if (q) return { title: q.title, question: q.question, options: q.options };

  const parseRender = (
    row: { title: string; question?: string; options_json: string } | undefined,
  ):
    | { title: string; question?: string; options: import('../channels/ask-question.js').NormalizedOption[] }
    | undefined => {
    if (!row) return undefined;
    try {
      const options = JSON.parse(row.options_json);
      if (!Array.isArray(options)) return undefined;
      // A blank legacy title must not make an otherwise-valid indexed card
      // undecodable. The title is display-only; options are the authority.
      return {
        title: row.title || '❓ Question',
        question: row.question,
        options: options as import('../channels/ask-question.js').NormalizedOption[],
      };
    } catch {
      // Corrupt legacy metadata must never turn an index into an arbitrary
      // approval response. The bridge leaves the card pending instead.
      return undefined;
    }
  };

  const a = getDb()
    .prepare('SELECT title, question, options_json FROM pending_approvals WHERE approval_id = ?')
    .get(id) as { title: string; question: string; options_json: string } | undefined;
  const approvalRender = parseRender(a);
  if (approvalRender) return approvalRender;

  // Channel-registration + unknown-sender approvals persist title/options_json
  // the same way pending_approvals does — just SELECT and return.
  if (hasTable(getDb(), 'pending_channel_approvals')) {
    const c = getDb()
      .prepare('SELECT title, question, options_json FROM pending_channel_approvals WHERE messaging_group_id = ?')
      .get(id) as { title: string; question: string; options_json: string } | undefined;
    const channelRender = parseRender(c);
    if (channelRender) return channelRender;
  }

  if (hasTable(getDb(), 'pending_sender_approvals')) {
    const s = getDb()
      .prepare('SELECT title, question, options_json FROM pending_sender_approvals WHERE id = ?')
      .get(id) as { title: string; question: string; options_json: string } | undefined;
    const senderRender = parseRender(s);
    if (senderRender) return senderRender;
  }

  return undefined;
}
