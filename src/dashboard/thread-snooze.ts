/**
 * Thread snooze — the triage mode's `S` verdict (DESIGN.md §11).
 *
 *   POST /dashboard/api/threads/:id/snooze
 *   POST /dashboard/api/threads/:id/unsnooze
 *
 * **Why this is not archive.** `archived_at` is what DESIGN §5 computes the
 * `done` state from, so archiving a thread to hide it says "finished" about
 * work that is anything but, and nothing un-archives on activity — the thread
 * would never come back. A snooze is the opposite promise: hide it *until it
 * moves*.
 *
 * **Why there is no timer.** The snooze records the thread's activity stamp at
 * the moment it was taken and expires by comparison ({@link isSnoozed}). A
 * thread is snoozed for exactly as long as its newest activity has not moved
 * past that mark, so the sweep does not have to know this feature exists.
 *
 * **Role gate — deliberately stricter than the capability requires. Do not
 * "correct" it back.** On the merits a snooze needs only visibility: it changes
 * nothing an agent can see, the row is keyed by `user_id`, and the only reader
 * is this operator's own list. Gating it on visibility alone would be
 * defensible. It is gated on `hasAdminPrivilege` anyway — the same privilege
 * `archive.ts` demands — because it would otherwise be the ONE endpoint in this
 * surface where a scoped member may act, and a lone exception outlives the
 * argument that justified it: the next reader inherits the widening without the
 * reasoning. Opening it to members later is a decision someone can make with
 * this paragraph in front of them; discovering it was already open is not.
 *
 * §2a still applies on top: out-of-scope, unprivileged and nonexistent all
 * collapse to one 404, so the gate never discloses that a thread exists.
 */
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { parseUtcTimestampMs } from '../thread-context.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export interface ThreadSnoozeRow {
  thread_id: string;
  snoozed_at_activity: string | null;
}

/**
 * Is a snooze still in force?
 *
 * `snoozedAtActivity` is the thread's newest activity when the snooze was
 * taken. It holds while the thread has not moved past that mark; a snooze
 * taken on a thread with no activity at all (null) holds until it has any.
 */
export function isSnoozed(snoozedAtActivity: string | null | undefined, lastActivityAt: string | null): boolean {
  const s = parseUtcTimestampMs(snoozedAtActivity);
  const a = parseUtcTimestampMs(lastActivityAt);
  if (s === null) return a === null;
  return a === null || a <= s;
}

/**
 * The caller's snoozes for exactly the threads on the page, indexed by thread.
 *
 * One query per list build, bounded by the page — never a per-row lookup.
 * A read failure degrades to "nothing is snoozed", which shows the operator
 * more than they asked for rather than silently hiding live work.
 */
export async function readThreadSnoozes(userId: string, threadIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (threadIds.length === 0) return out;
  try {
    const rows = await getDb().all<ThreadSnoozeRow>(
      `SELECT thread_id, snoozed_at_activity
         FROM thread_snoozes
        WHERE user_id = ? AND thread_id IN (${threadIds.map(() => '?').join(', ')})`,
      userId,
      ...threadIds,
    );
    for (const r of rows) out.set(r.thread_id, r.snoozed_at_activity);
  } catch (err) {
    log.warn('thread-snooze: read failed — treating the page as un-snoozed', { err });
  }
  return out;
}

/**
 * The thread's newest activity, and whether the caller may see it at all.
 *
 * Mirrors the list path's synthetic-key rule (`session:<id>` for a session with
 * a NULL `thread_id`) so the same id the console renders addresses the same
 * thread here.
 */
async function loadThreadForSnooze(
  threadId: string,
  ctx: AuthedRequestContext,
): Promise<{ lastActivityAt: string | null } | null> {
  const rows = await getDb().all<{
    agent_group_id: string;
    last_outbound_at: string | null;
    last_active: string | null;
    created_at: string;
  }>(
    `SELECT agent_group_id, last_outbound_at, last_active, created_at
       FROM sessions
      WHERE status = 'active' AND COALESCE(thread_id, 'session:' || id) = ?`,
    threadId,
  );
  if (rows.length === 0) return null;

  const visible = ctx.scopes.no_filter
    ? rows
    : rows.filter((r) => ctx.scopes.allowed_group_ids.includes(r.agent_group_id));
  if (visible.length === 0) return null;
  // Admin on at least one agent group backing the thread — see the header on
  // why this is stricter than the capability needs. The activity mark below is
  // still taken over every VISIBLE session, so it compares like-for-like with
  // the `last_activity_at` the list computes.
  if (!visible.some((r) => hasAdminPrivilege(ctx.user.id, r.agent_group_id))) return null;

  let bestMs = -Infinity;
  for (const r of visible) {
    const ms = parseUtcTimestampMs(r.last_outbound_at ?? r.last_active ?? r.created_at);
    if (ms !== null && ms > bestMs) bestMs = ms;
  }
  // NORMALIZED, never stored verbatim. `sessions.last_outbound_at` is written
  // naive by `bumpLastOutbound` (see the note in api/threads.ts), so copying the
  // column through would mint a permanently naive column: migration 053's
  // normalizer runs off an explicit allowlist and skips tables it does not name,
  // so nothing downstream would ever fix it. Comparisons happen to survive
  // either shape because `isSnoozed` parses both sides, but a later
  // `MAX(col)` or `col >= ?` over a mixed column would silently pick the wrong
  // row — which is exactly the failure 053 exists to prevent.
  return { lastActivityAt: bestMs === -Infinity ? null : new Date(bestMs).toISOString() };
}

function threadIdOf(params: Record<string, string>): string {
  const raw = params['id'] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const NOT_FOUND = (): Response => json(404, { error: 'thread_not_found' });

export const threadSnoozeHandler: AuthHandler = async (_req, params, ctx) => {
  const threadId = threadIdOf(params);
  if (!threadId) return NOT_FOUND();
  const thread = await loadThreadForSnooze(threadId, ctx);
  if (!thread) return NOT_FOUND();

  try {
    await getDb().run(
      `INSERT INTO thread_snoozes (thread_id, user_id, snoozed_at_activity, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id, user_id)
       DO UPDATE SET snoozed_at_activity = excluded.snoozed_at_activity, created_at = excluded.created_at`,
      threadId,
      ctx.user.id,
      thread.lastActivityAt,
      new Date().toISOString(),
    );
  } catch (err) {
    log.warn('threadSnoozeHandler: DB error', { threadId, err });
    return json(500, { error: 'internal_error' });
  }

  return json(200, { thread_id: threadId, snoozed_at_activity: thread.lastActivityAt });
};

export const threadUnsnoozeHandler: AuthHandler = async (_req, params, ctx) => {
  const threadId = threadIdOf(params);
  if (!threadId) return NOT_FOUND();
  if (!(await loadThreadForSnooze(threadId, ctx))) return NOT_FOUND();

  try {
    await getDb().run(`DELETE FROM thread_snoozes WHERE thread_id = ? AND user_id = ?`, threadId, ctx.user.id);
  } catch (err) {
    log.warn('threadUnsnoozeHandler: DB error', { threadId, err });
    return json(500, { error: 'internal_error' });
  }

  return json(200, { thread_id: threadId });
};
