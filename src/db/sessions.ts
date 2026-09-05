import type { PendingApproval, PendingQuestion, Session } from '../types.js';
import { getDb, getRawDb, hasTable } from './connection.js';

// ── Sessions ──

export const TASKS_SYSTEM_THREAD_ID = 'system:tasks';

/**
 * The `getSession` read, as a constant, so a synchronous guard-path caller can
 * execute the SAME statement through the raw handle.
 *
 * One constant, two executors — NOT a `*Sync` twin of the export
 * (docs/specs/upstream-async-central-db-seam/plan.md §4.5 I-1). The only such
 * caller is `sessionStillActive` in `container-runner.ts`: a `WakeGuard` is
 * `() => WakeGuardResult` and is evaluated with nothing awaited between it and
 * the spawn/insert it protects.
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
 * Find the active **agent-shared** session for an agent group — i.e. one
 * with `messaging_group_id IS NULL`. Agent-shared sessions are created with
 * mg=null on purpose (see resolveSession's agent-shared branch); this lookup
 * mirrors that so agent-shared callers don't silently land in an mg-bound
 * session of the same agent group.
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

/** True for any task session thread — a per-series one or the legacy shared one. */
export function isTaskThread(threadId: string | null): boolean {
  return threadId === TASKS_SYSTEM_THREAD_ID || (threadId?.startsWith(`${TASKS_SYSTEM_THREAD_ID}:`) ?? false);
}

/** All active task sessions for a group — one per live series, plus any legacy shared one. */
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
 * Active sessions with recent activity (or a live container). Bounds the
 * minute-cadence bulk loops: iterating every active session ever created
 * (3k+ rows, synchronous SQLite each) was blocking the event loop 3-5s per
 * cycle. A session idle past the horizon has no deliverable outbound and no
 * ack traffic; anything scheduled in it is the host sweep's quiet-cache job.
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
      // MONOTONIC, never verbatim (Codex round 4, H1). Callers pass a raw
      // `new Date().toISOString()` (session-manager.ts, delivery admission),
      // which is millisecond-resolution — so an ordinary activity write landing
      // in the SAME millisecond as `withQuietInvalidationSync`'s strict +1 ms
      // would put the column back to the value a sweep's queued flush is
      // guarded on (`WHERE last_active IS <basis>`), and that flush would then
      // reinstall a mark over work that has just become due. An A→B→A step is
      // the whole vulnerability; forbidding the step down closes it. No +1 ms
      // here: only the invalidation needs a STRICT increase, and bumping on
      // every activity write would drift the column off wall-clock for no gain.
      fields.push(
        'last_active = CASE WHEN last_active IS NULL OR last_active < @last_active THEN @last_active ELSE last_active END',
      );
    } else {
      fields.push(`${key} = @${key}`);
    }
    values[key] = value;
  }
  // The host sweep's persisted quiet mark (migration 068) is a prediction of
  // when this session next has work — taken while `last_active` held some
  // earlier value. Moving `last_active` is precisely the event that says the
  // prediction is stale, so the mark dies in the SAME statement, never in a
  // second write a caller could forget or a crash could lose. This is the
  // durable half of the in-memory cache's `mark.lastActive === last_active`
  // check.
  //
  // `updateSession` and `withQuietInvalidationSync` are the only two writers of
  // `last_active` in the host (`createSession`'s INSERT aside), and both null
  // the mark in the same statement. A future raw-SQL writer would silently
  // reintroduce a mark that outlives a newly due row — and, unless it carried
  // the monotonic CASE above, the round-4 ABA with it.
  if (updates.last_active !== undefined) fields.push('sweep_quiet_until = NULL');
  if (fields.length === 0) return;

  await getDb().run(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`, values);
}

/** A central-DB quiet-mark invalidation that did not land. Thrown, never swallowed. */
export class QuietInvalidationError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, cause: unknown) {
    super(`quiet-mark invalidation failed for session ${sessionId}`, { cause });
    this.name = 'QuietInvalidationError';
    this.sessionId = sessionId;
  }
}

/**
 * Run a due-ness write with its quiet mark invalidated first, or not at all.
 *
 * This is the ONLY shape a due-ness write may have. `write` must be the
 * synchronous better-sqlite3 mutation itself, called from inside an
 * already-open mailbox callback — never a promise, never a mailbox open.
 *
 * ── Why synchronous-only, and why there is no second invalidation ──
 * The mark this clears is written by `persistQuietSessionMarks`, guarded by
 * `WHERE sessions.last_active IS <basis>`. Order a sweep's flush against this
 * helper and there are exactly two cases, both safe:
 *
 *   - The flush computed its basis BEFORE this UPDATE. The UPDATE moves
 *     `last_active` off that basis, so the flush's guard fails and the mark is
 *     never (re-)established. The value is always strictly greater, even inside
 *     one millisecond: `toISOString()` is millisecond resolution, so a
 *     same-millisecond write would otherwise republish the identical basis and
 *     leave the guard satisfied.
 *   - The flush computed its basis AFTER this UPDATE. Then it read a session
 *     whose due row is already committed — `write()` runs with no `await`
 *     between it and this statement, and better-sqlite3 is synchronous on the
 *     single host thread, so no sweep tick can observe the gap — and a mark
 *     taken over work it can see is a correct mark, not a stale one.
 *
 * An earlier revision bracketed the write with a second, swallowed
 * invalidation to cover an `await` in between (Codex round 2, H1). That is what
 * this shape removes: a best-effort second write is not a guarantee, and its
 * failure reproduced the very outcome it was added to prevent (round 3, H1).
 * No await, no window, no second write.
 *
 * ── Fail-closed, including on zero rows ──
 * The statement is written here rather than delegated to `updateSession`
 * because the affected-row count is the point (round 3, H2). `changes !== 1`
 * means no ACTIVE session row was there to invalidate — closed, archiving, or
 * deleted between the caller's discovery and this callback — and the mailbox
 * write is then abandoned rather than committed into a session the sweep will
 * never enumerate. `status = 'active'` is exactly the sweep's own enumeration
 * predicate (`getActiveSessions`) and `getWarmQuietSessionMarks`'.
 *
 * `archived_at` is deliberately NOT in the predicate, even though the column
 * exists on this table (migration 031). Archiving is an operator-side display
 * flag — an archived session still processes inbound traffic, still runs its
 * container, and is still enumerated by `getActiveSessions` — so refusing its
 * due-ness writes would break live sessions merely dismissed from the inbox
 * view. The predicate has to match what the sweep enumerates, and that is
 * `status` alone.
 */
export function withQuietInvalidationSync<T>(sessionId: string, write: () => T): T {
  const now = new Date().toISOString();
  let changes: number;
  try {
    changes = getRawDb()
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
  if (changes !== 1) {
    throw new QuietInvalidationError(
      sessionId,
      new Error(`no active session row to invalidate (${changes} rows matched)`),
    );
  }
  return write();
}

/** One quiet mark to persist: the session, the ISO instant its skip expires, and the basis it was computed on. */
export interface QuietSessionMark {
  sessionId: string;
  /** ISO-8601 UTC. */
  quietUntil: string;
  /**
   * The row's `last_active` at the moment the mark was computed. The write
   * guard, not decoration — see `persistQuietSessionMarks`.
   */
  lastActive: string | null;
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
 * ── The `last_active` guard is load-bearing, not belt-and-braces. ──
 * A mark is computed against the `last_active` the driver read at the START of
 * that session's sweep, but the batch is flushed only after the WHOLE fan-out,
 * and the driver yields to the event loop after every session. Inbound arriving
 * in one of those yields bumps `last_active` and clears this column (see
 * `updateSession`) — and an unconditional write would then put the now-stale
 * expiry straight back, so a restart before the next tick would warm it and
 * skip a session that is genuinely due, without ever opening its inbound.db.
 * Comparing the basis null-safely (`IS`, not `=`, because `last_active` is
 * nullable) makes that write a no-op for exactly the rows that moved. The
 * in-memory mark needs no equivalent: the next tick re-reads `last_active` and
 * invalidates it there.
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
 * Delete a session and the central rows keyed to it.
 *
 * `cli_request_executions` (src/cli/request-ledger.ts) is retained on a
 * terminal signal rather than a clock, so its newest claim per session has no
 * age at which it expires — without this it would outlive the session forever.
 * A session with no row has no container and no delivery loop, so nothing is
 * left that could replay or re-execute the request the claim guarded.
 *
 * Seam 3: stays SYNCHRONOUS — it IS one of the eleven pinned central raw
 * `db.transaction(...)` sites (plan §4.4), and the two DELETEs are atomic by
 * construction. Converts in PR 6.
 */
export function deleteSession(id: string): void {
  const db = getRawDb();
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
export async function resetPhantomContainerStatus(): Promise<number> {
  const result = await getDb().run(
    "UPDATE sessions SET container_status = 'stopped' WHERE container_status IN ('running', 'idle')",
  );
  return result.changes;
}

/**
 * Soft-dismiss a session from the inbox's default view. Returns true when
 * the row flipped from visible→archived (mirrors `archiveTaskById`'s
 * change-only contract so callers can gate SSE emits without doing a
 * second read). Archived sessions still process inbound traffic and run
 * their containers; archiving is purely an operator-side display flag.
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
 * Bump `last_outbound_at` to now and stamp the kind tag for inbox attention-
 * state derivation. Called from delivery.ts after a successful host→platform
 * send so the central row doesn't fall behind the per-session outbound.db.
 *
 * `kind` is the granular tag — for `chat-sdk` messages the caller passes
 * `chat-sdk:<content.type>` (e.g., `chat-sdk:ask_question`) so the inbox
 * can distinguish question-prompts from ordinary chat without re-parsing.
 */
export async function bumpLastOutbound(id: string, kind: string): Promise<void> {
  // Bound ISO, NOT `datetime('now')`: that yields the naive
  // `YYYY-MM-DD HH:MM:SS` shape, and SQLite compares it against ISO values as
  // TEXT — at index 10 'T' (0x54) beats ' ' (0x20), so a naive 11pm row sorts
  // BELOW an ISO 7am one from the same day and `MAX(last_outbound_at)` (the
  // observatory's most-recent-activity read) picks the wrong session.
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
export async function markSessionEngaged(id: string): Promise<void> {
  await getDb().run(
    `UPDATE sessions SET engaged_at = ? WHERE id = ? AND engaged_at IS NULL`,
    new Date().toISOString(),
    id,
  );
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

/** Exported for the guard seam's synchronous grant check (plan §4.5, I-1). */
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
 */
export async function getAskQuestionRender(
  id: string,
): Promise<
  { title: string; question?: string; options: import('../channels/ask-question.js').NormalizedOption[] } | undefined
> {
  const db = getDb();
  const q = await getPendingQuestion(id);
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

  const a = await db.get<{ title: string; question: string; options_json: string }>(
    'SELECT title, question, options_json FROM pending_approvals WHERE approval_id = ?',
    id,
  );
  const approvalRender = parseRender(a);
  if (approvalRender) return approvalRender;

  // Channel-registration + unknown-sender approvals persist title/options_json
  // the same way pending_approvals does — just SELECT and return.
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
