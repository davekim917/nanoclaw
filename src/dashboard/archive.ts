/**
 * Session archive / unarchive — operator-side dismiss primitives for the
 * inbox board.
 *
 * Archive is a soft-delete on the dashboard's default view.
 *
 * Auth model: owner / global-admin / scoped-admin can archive; members see
 * disclose-as-not-found per §2a.
 */
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { archiveSessionById, unarchiveSessionById, getSession } from '../db/sessions.js';
import { emitDashboardEvent } from './api/events.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

const SERVER_ERROR: Response = new Response(JSON.stringify({ error: 'internal_error' }), {
  status: 500,
  headers: { 'Content-Type': 'application/json' },
});

const OK = (body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

// ── Session archive / unarchive (inbox board) ─────────────────────────────────

interface SessionScope {
  id: string;
  agent_group_id: string;
  archived_at: string | null;
}

/**
 * Session-side equivalent of `loadAndAuthorize`. Same §2a + admin-role
 * collapse-to-404 pattern as the task variant.
 */
function loadSessionAndAuthorize(sessionId: string, ctx: AuthedRequestContext): SessionScope | null {
  const session = getSession(sessionId);
  if (!session) return null;
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(session.agent_group_id)) return null;
  if (!hasAdminPrivilege(ctx.user.id, session.agent_group_id)) return null;
  return {
    id: session.id,
    agent_group_id: session.agent_group_id,
    archived_at: (session as unknown as { archived_at: string | null }).archived_at ?? null,
  };
}

const SESSION_NOT_FOUND = (): Response =>
  new Response(JSON.stringify({ error: 'session_not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });

export const sessionArchiveHandler: AuthHandler = async (_req, params, ctx) => {
  const sessionId = params['id'] ?? '';
  const session = loadSessionAndAuthorize(sessionId, ctx);
  if (!session) return SESSION_NOT_FOUND();

  const archivedAt = new Date().toISOString();
  let flipped: boolean;
  try {
    flipped = archiveSessionById(sessionId, archivedAt);
  } catch (err) {
    log.warn('sessionArchiveHandler: DB error', { sessionId, err });
    return SERVER_ERROR;
  }

  // Only push SSE on a real change — re-archiving an already-archived row
  // would otherwise spam refetches across every open inbox tab.
  if (flipped) {
    emitDashboardEvent('session_event', {
      session_id: sessionId,
      agent_group_id: session.agent_group_id,
      kind: 'archived',
    });
  }

  return OK({ session_id: sessionId, archived_at: session.archived_at ?? archivedAt });
};

export const sessionUnarchiveHandler: AuthHandler = async (_req, params, ctx) => {
  const sessionId = params['id'] ?? '';
  const session = loadSessionAndAuthorize(sessionId, ctx);
  if (!session) return SESSION_NOT_FOUND();

  try {
    unarchiveSessionById(sessionId);
  } catch (err) {
    log.warn('sessionUnarchiveHandler: DB error', { sessionId, err });
    return SERVER_ERROR;
  }

  emitDashboardEvent('session_event', {
    session_id: sessionId,
    agent_group_id: session.agent_group_id,
    kind: 'unarchived',
  });

  return OK({ session_id: sessionId });
};
