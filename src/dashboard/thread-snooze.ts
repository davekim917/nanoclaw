/**
 * Thread snooze: the triage `S` verdict (`POST .../snooze`, `.../unsnooze`). Not archive: archiving says "finished"
 * and nothing un-archives on activity. A snooze hides a thread until it moves.
 * No timer: the snooze records the thread's activity stamp and expires by comparison ({@link isSnoozed}).
 * Role gate deliberately stricter than the capability needs; do not "correct" it. A snooze only needs visibility, but
 * it is gated on `hasAdminPrivilege` so it is not the one endpoint on this surface where a scoped member may act.
 * Out-of-scope, unprivileged and nonexistent all collapse to one 404.
 */
import { withCentralSync } from '../db/central-lease.js';
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { parseUtcTimestampMs } from '../thread-context.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface ThreadSnoozeRow {
  thread_id: string;
  snoozed_at_activity: string | null;
}

/**
 * Holds while the thread's newest activity has not moved past `snoozedAtActivity`; a snooze on a thread with no
 * activity (null) holds until it has any.
 */
export function isSnoozed(snoozedAtActivity: string | null | undefined, lastActivityAt: string | null): boolean {
  const s = parseUtcTimestampMs(snoozedAtActivity);
  const a = parseUtcTimestampMs(lastActivityAt);
  if (s === null) return a === null;
  return a === null || a <= s;
}

/**
 * One query per page. A read failure degrades to "nothing is snoozed": showing more beats silently hiding live work.
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

/** Uses the list path's `session:<id>` synthetic-key rule so the rendered id addresses the same thread. */
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
  // The activity mark is taken over every VISIBLE session so it compares like-for-like with the list's
  // `last_activity_at`.
  const admin = await withCentralSync(
    () => visible.some((r) => hasAdminPrivilege(ctx.user.id, r.agent_group_id)),
    'thread snooze authority',
  );
  if (!admin) return null;

  let bestMs = -Infinity;
  for (const r of visible) {
    const ms = parseUtcTimestampMs(r.last_outbound_at ?? r.last_active ?? r.created_at);
    if (ms !== null && ms > bestMs) bestMs = ms;
  }
  // NORMALIZED, never stored verbatim: `last_outbound_at` is written naive, and migration 053's normalizer skips
  // tables it does not name, so a copied value would leave a permanently mixed-format column that later `MAX()` or
  // `>=` comparisons would get wrong.
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
