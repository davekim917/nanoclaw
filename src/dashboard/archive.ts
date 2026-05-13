/**
 * Archive / unarchive / bulk-archive — operator-side dismiss primitives.
 *
 * Archive is a soft-delete on the dashboard's default view. The row stays
 * in `tasks`; `archived_at IS NOT NULL` filters it out of the default
 * board (tasks list API gates on `archived_at IS NULL` unless the caller
 * passes `?include_archived=1`).
 *
 * Auth model mirrors `steer.ts`: owner / global-admin / scoped-admin can
 * archive; members see disclose-as-not-found per §2a. Bulk-archive runs
 * with the same gate, scoped to one agent_group at a time so a member of
 * group A can't accidentally clear group B.
 */
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import {
  archiveTaskById,
  unarchiveTaskById,
  bulkArchiveByGroupAndStatus,
  type TerminalTaskStatus,
} from '../modules/orchestrator-dispatch/db/tasks.js';
import { emitDashboardEvent } from './api/events.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

interface TaskScope {
  task_id: string;
  parent_agent_group_id: string;
  status: string;
  archived_at: string | null;
}

const NOT_FOUND = (error = 'task_not_found'): Response =>
  new Response(JSON.stringify({ error }), { status: 404, headers: { 'Content-Type': 'application/json' } });

const SERVER_ERROR: Response = new Response(JSON.stringify({ error: 'internal_error' }), {
  status: 500,
  headers: { 'Content-Type': 'application/json' },
});

const BAD_REQUEST = (error: string): Response =>
  new Response(JSON.stringify({ error }), { status: 400, headers: { 'Content-Type': 'application/json' } });

const OK = (body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/**
 * Shared preamble for /archive and /unarchive: load the task, verify it
 * exists, the caller has scope on its agent_group, AND the caller has
 * admin role over that group. All three failures collapse to 404 per §2a.
 */
function loadAndAuthorize(taskId: string, ctx: AuthedRequestContext): TaskScope | null {
  const task = getDb()
    .prepare('SELECT task_id, parent_agent_group_id, status, archived_at FROM tasks WHERE task_id = ?')
    .get(taskId) as TaskScope | undefined;
  if (!task) return null;
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(task.parent_agent_group_id)) return null;
  if (!hasAdminPrivilege(ctx.user.id, task.parent_agent_group_id)) return null;
  return task;
}

export const archiveHandler: AuthHandler = async (_req, params, ctx) => {
  const taskId = params['id'] ?? '';
  const task = loadAndAuthorize(taskId, ctx);
  if (!task) return NOT_FOUND();

  let archivedAt: string | null;
  try {
    archivedAt = new Date().toISOString();
    archiveTaskById(taskId, archivedAt);
  } catch (err) {
    log.warn('archiveHandler: DB error', { taskId, err });
    return SERVER_ERROR;
  }

  emitDashboardEvent('task_event', {
    task_id: taskId,
    kind: 'archived',
    agent_group_id: task.parent_agent_group_id,
  });

  return OK({ task_id: taskId, archived_at: task.archived_at ?? archivedAt });
};

export const unarchiveHandler: AuthHandler = async (_req, params, ctx) => {
  const taskId = params['id'] ?? '';
  const task = loadAndAuthorize(taskId, ctx);
  if (!task) return NOT_FOUND();

  try {
    unarchiveTaskById(taskId);
  } catch (err) {
    log.warn('unarchiveHandler: DB error', { taskId, err });
    return SERVER_ERROR;
  }

  emitDashboardEvent('task_event', {
    task_id: taskId,
    kind: 'unarchived',
    agent_group_id: task.parent_agent_group_id,
  });

  return OK({ task_id: taskId });
};

const BULK_STATUSES: ReadonlySet<TerminalTaskStatus> = new Set<TerminalTaskStatus>([
  'failed',
  'completed',
  'cancelled',
]);

export const bulkArchiveHandler: AuthHandler = async (req, _params, ctx) => {
  let body: { status?: string; group_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return BAD_REQUEST('invalid_request');
  }
  const status = body.status as TerminalTaskStatus | undefined;
  const groupId = body.group_id;

  if (!status || !BULK_STATUSES.has(status)) return BAD_REQUEST('invalid_status');
  // group_id is required so a caller can't sweep across all visible groups
  // in one call (a missed scope would be high-blast-radius).
  if (!groupId) return BAD_REQUEST('group_id_required');

  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(groupId)) return NOT_FOUND('group_not_found');
  if (!hasAdminPrivilege(ctx.user.id, groupId)) return NOT_FOUND('group_not_found');

  let archived: number;
  try {
    archived = bulkArchiveByGroupAndStatus(groupId, status);
  } catch (err) {
    log.warn('bulkArchiveHandler: DB error', { groupId, status, err });
    return SERVER_ERROR;
  }

  if (archived > 0) {
    emitDashboardEvent('task_event', {
      task_id: null,
      kind: 'bulk_archived',
      agent_group_id: groupId,
      archived_status: status,
      archived_count: archived,
    });
  }

  return OK({ archived });
};
