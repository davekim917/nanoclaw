/**
 * REST route handlers for the NanoClaw Web UI API gateway.
 *
 * All list endpoints use paginated DB functions and return
 * { data, total, limit, offset }. Group-scoped endpoints require ?group=.
 */
import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';

import {
  countMemoriesKeyword,
  getAllTasksPaginated,
  getBacklogPaginated,
  getRecentMessages,
  getSessionsV2Full,
  getSessionV2ByKey,
  getShipLogPaginated,
  getTaskById,
  getTaskRunLogs,
  getTasksForGroupPaginated,
  listMemoriesPaginated,
  searchMemoriesKeyword,
  updateTask,
} from '../db.js';
import { logger } from '../logger.js';
import { searchThreads } from '../thread-search.js';
import { BodyParseError, parseJsonBody } from './cors.js';
import {
  getInstalledSkills,
  getInstallJob,
  searchMarketplace,
  startSkillInstall,
} from './skills.js';
import type { ActiveSession, Capabilities } from './types.js';

// --- Deps ---

export interface RouteDeps {
  sendMessage: (
    groupJid: string,
    threadId: string | undefined,
    text: string,
  ) => boolean;
  getRegisteredGroups: () => Array<{
    jid: string;
    name: string;
    folder: string;
  }>;
  startSession: (groupJid: string, text: string) => boolean;
  getCapabilities: () => Capabilities;
  activeSessions: () => Map<string, ActiveSession>;
  addSseClient: (res: ServerResponse, req: IncomingMessage) => void;
  onSkillInstallProgress: (
    jobId: string,
    output: string,
  ) => void;
  onSkillInstallComplete: (jobId: string, success: boolean) => void;
}

// --- Helpers ---

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parsePagination(url: URL): { limit: number; offset: number } {
  let limit = parseInt(url.searchParams.get('limit') || '50', 10);
  let offset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (isNaN(limit) || limit < 1) limit = 1;
  if (limit > 200) limit = 200;
  if (isNaN(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

function requireGroup(url: URL, res: ServerResponse): string | null {
  const group = url.searchParams.get('group');
  if (!group) {
    json(res, 400, { error: 'Missing required parameter: group' });
    return null;
  }
  return group;
}

/** Handle body parse errors. Legacy endpoints include `ok` in the response. */
function handleBodyError(res: ServerResponse, err: unknown, includeOk?: boolean): void {
  if (err instanceof BodyParseError) {
    json(res, err.status, includeOk ? { ok: false, error: err.message } : { error: err.message });
  } else {
    json(res, 400, includeOk ? { ok: false, error: 'Invalid JSON' } : { error: 'Invalid JSON' });
  }
}

// Valid values for task fields — keep in sync with ScheduledTask type in types.ts
const VALID_STATUSES = ['active', 'paused', 'completed'];
const VALID_SCHEDULE_TYPES = ['cron', 'interval', 'once'];

// --- Route handler ---

/**
 * Handle an API route request. Returns true if the route was handled,
 * false if no matching route was found (404 fallthrough).
 */
export async function handleRoute(
  pathname: string,
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
): Promise<boolean> {
  // --- Existing endpoints (migrated from web-ui.ts) ---

  if (pathname === '/events' && method === 'GET') {
    deps.addSseClient(res, req);
    return true;
  }

  if (pathname === '/api/groups' && method === 'GET') {
    json(res, 200, { groups: deps.getRegisteredGroups() });
    return true;
  }

  if (pathname === '/api/sessions' && method === 'GET') {
    json(res, 200, {
      sessions: Object.fromEntries(deps.activeSessions()),
    });
    return true;
  }

  if (pathname === '/api/intervene' && method === 'POST') {
    try {
      const body = await parseJsonBody<{
        groupJid?: string;
        threadId?: string;
        text?: string;
      }>(req);
      if (!body.groupJid || !body.text) {
        json(res, 400, { ok: false, error: 'Missing groupJid or text' });
        return true;
      }
      const ok = deps.sendMessage(body.groupJid, body.threadId, body.text);
      json(res, ok ? 200 : 404, { ok });
    } catch (err) {
      handleBodyError(res, err, true);
    }
    return true;
  }

  if (pathname === '/api/send' && method === 'POST') {
    try {
      const body = await parseJsonBody<{
        groupJid?: string;
        text?: string;
      }>(req);
      if (!body.groupJid || !body.text) {
        json(res, 400, { ok: false, error: 'Missing groupJid or text' });
        return true;
      }
      const ok = deps.startSession(body.groupJid, body.text);
      json(res, ok ? 200 : 404, { ok });
    } catch (err) {
      handleBodyError(res, err, true);
    }
    return true;
  }

  // --- New endpoints ---

  // GET /api/capabilities
  if (pathname === '/api/capabilities' && method === 'GET') {
    json(res, 200, deps.getCapabilities());
    return true;
  }

  // GET /api/sessions/history?group=
  if (pathname === '/api/sessions/history' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const { limit, offset } = parsePagination(url);
    const result = getSessionsV2Full(group, limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // GET /api/sessions/:key/messages
  const sessKeyMsgMatch = pathname.match(
    /^\/api\/sessions\/(.+)\/messages$/,
  );
  if (sessKeyMsgMatch && method === 'GET') {
    const sessionKey = decodeURIComponent(sessKeyMsgMatch[1]);
    const { limit } = parsePagination(url);

    // Check active sessions first
    const active = deps.activeSessions();
    const session = active.get(sessionKey);
    if (session) {
      const messages = getRecentMessages(session.groupJid, limit);
      json(res, 200, { data: messages, sessionKey });
      return true;
    }

    // Fall back to DB lookup by session_key
    const dbSession = getSessionV2ByKey(sessionKey);
    if (dbSession?.chat_jid) {
      const messages = getRecentMessages(dbSession.chat_jid, limit);
      json(res, 200, { data: messages, sessionKey });
      return true;
    }

    json(res, 404, { error: 'Session not found' });
    return true;
  }

  // GET /api/tasks
  if (pathname === '/api/tasks' && method === 'GET') {
    const { limit, offset } = parsePagination(url);
    const group = url.searchParams.get('group');
    const result = group
      ? getTasksForGroupPaginated(group, limit, offset)
      : getAllTasksPaginated(limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // Match /api/tasks/:id patterns (but not /api/tasks/:id/logs, /pause, /resume)
  let taskIdMatch: RegExpMatchArray | null = null;
  let taskLogsMatch: RegExpMatchArray | null = null;
  let taskPauseMatch: RegExpMatchArray | null = null;
  let taskResumeMatch: RegExpMatchArray | null = null;
  if (pathname.startsWith('/api/tasks/')) {
    taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    taskLogsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/logs$/);
    taskPauseMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/pause$/);
    taskResumeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
  }

  // GET /api/tasks/:id/logs
  if (taskLogsMatch && method === 'GET') {
    const taskId = decodeURIComponent(taskLogsMatch[1]);
    const { limit, offset } = parsePagination(url);
    const result = getTaskRunLogs(taskId, limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // POST /api/tasks/:id/pause
  if (taskPauseMatch && method === 'POST') {
    const taskId = decodeURIComponent(taskPauseMatch[1]);
    const task = getTaskById(taskId);
    if (!task) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    updateTask(taskId, { status: 'paused' });
    json(res, 200, { ok: true, task: getTaskById(taskId) });
    return true;
  }

  // POST /api/tasks/:id/resume
  if (taskResumeMatch && method === 'POST') {
    const taskId = decodeURIComponent(taskResumeMatch[1]);
    const task = getTaskById(taskId);
    if (!task) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    // Recalculate next_run based on current time
    const nextRun = new Date().toISOString();
    updateTask(taskId, { status: 'active', next_run: nextRun });
    json(res, 200, { ok: true, task: getTaskById(taskId) });
    return true;
  }

  // GET /api/tasks/:id
  if (taskIdMatch && method === 'GET') {
    const taskId = decodeURIComponent(taskIdMatch[1]);
    const task = getTaskById(taskId);
    if (!task) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    json(res, 200, { data: task });
    return true;
  }

  // PATCH /api/tasks/:id
  if (taskIdMatch && method === 'PATCH') {
    const taskId = decodeURIComponent(taskIdMatch[1]);
    const task = getTaskById(taskId);
    if (!task) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      // Only allow specific fields
      const allowedFields = [
        'prompt',
        'schedule_type',
        'schedule_value',
        'schedule_tz',
        'status',
      ];
      const updates: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (field in body) {
          updates[field] = body[field];
        }
      }
      if (Object.keys(updates).length === 0) {
        json(res, 400, { error: 'No valid fields to update' });
        return true;
      }

      // Validate field values
      if (
        updates.status !== undefined &&
        (typeof updates.status !== 'string' ||
          !VALID_STATUSES.includes(updates.status))
      ) {
        json(res, 400, {
          error: `Invalid status: must be one of ${VALID_STATUSES.join(', ')}`,
        });
        return true;
      }
      if (
        updates.schedule_type !== undefined &&
        (typeof updates.schedule_type !== 'string' ||
          !VALID_SCHEDULE_TYPES.includes(updates.schedule_type))
      ) {
        json(res, 400, {
          error: `Invalid schedule_type: must be one of ${VALID_SCHEDULE_TYPES.join(', ')}`,
        });
        return true;
      }
      // Determine the effective schedule_type for cron validation
      const effectiveScheduleType =
        (updates.schedule_type as string) || task.schedule_type;
      if (
        updates.schedule_value !== undefined &&
        effectiveScheduleType === 'cron'
      ) {
        if (
          typeof updates.schedule_value !== 'string' ||
          updates.schedule_value.trim() === ''
        ) {
          json(res, 400, {
            error: 'Invalid schedule_value: cron expression must be a non-empty string',
          });
          return true;
        }
      }
      if (updates.schedule_tz !== undefined && updates.schedule_tz !== null) {
        if (
          typeof updates.schedule_tz !== 'string' ||
          updates.schedule_tz.trim() === ''
        ) {
          json(res, 400, {
            error: 'Invalid schedule_tz: must be a non-empty string',
          });
          return true;
        }
      }

      updateTask(
        taskId,
        updates as Parameters<typeof updateTask>[1],
      );
      json(res, 200, { ok: true, task: getTaskById(taskId) });
    } catch (err) {
      handleBodyError(res, err);
    }
    return true;
  }

  // GET /api/memories
  if (pathname === '/api/memories' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const { limit, offset } = parsePagination(url);
    const result = listMemoriesPaginated(group, limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // GET /api/memories/search
  if (pathname === '/api/memories/search' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const q = url.searchParams.get('q') || '';
    if (!q) {
      json(res, 400, { error: 'Missing required parameter: q' });
      return true;
    }
    const { limit, offset } = parsePagination(url);
    const total = countMemoriesKeyword(group, q);
    const data = searchMemoriesKeyword(group, q, limit, offset);
    json(res, 200, { data, total, limit, offset });
    return true;
  }

  // GET /api/backlog
  if (pathname === '/api/backlog' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const { limit, offset } = parsePagination(url);
    const status = url.searchParams.get('status') || undefined;
    const result = getBacklogPaginated(group, status, limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // GET /api/ship-log
  if (pathname === '/api/ship-log' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const { limit, offset } = parsePagination(url);
    const result = getShipLogPaginated(group, limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // GET /api/threads/search
  if (pathname === '/api/threads/search' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const q = url.searchParams.get('q') || '';
    if (!q) {
      json(res, 400, { error: 'Missing required parameter: q' });
      return true;
    }
    const { limit, offset } = parsePagination(url);
    try {
      // 10-second timeout with cleanup on success
      let timer: NodeJS.Timeout;
      const data = await Promise.race([
        searchThreads(group, q).finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Thread search timeout')), 10_000);
        }),
      ]);
      json(res, 200, { data, total: data.length, limit, offset });
    } catch (err) {
      logger.warn({ err, group, query: q }, 'Thread search failed/timed out');
      json(res, 200, { data: [], total: 0, limit, offset, error: 'search_timeout' });
    }
    return true;
  }

  // GET /api/skills/installed
  if (pathname === '/api/skills/installed' && method === 'GET') {
    const { limit, offset } = parsePagination(url);
    const all = getInstalledSkills();
    const data = all.slice(offset, offset + limit);
    json(res, 200, { data, total: all.length, limit, offset });
    return true;
  }

  // GET /api/skills/marketplace
  if (pathname === '/api/skills/marketplace' && method === 'GET') {
    const q = url.searchParams.get('q') || '';
    if (!q) {
      json(res, 400, { error: 'Missing required parameter: q' });
      return true;
    }
    const result = await searchMarketplace(q);
    json(res, 200, result);
    return true;
  }

  // POST /api/skills/install
  if (pathname === '/api/skills/install' && method === 'POST') {
    try {
      const body = await parseJsonBody<{ repo?: string }>(req);
      if (!body.repo) {
        json(res, 400, { error: 'Missing required field: repo' });
        return true;
      }
      const result = startSkillInstall(
        body.repo,
        (jobId, output) => deps.onSkillInstallProgress(jobId, output),
        (jobId, success) => deps.onSkillInstallComplete(jobId, success),
      );
      if ('error' in result) {
        json(res, result.status, { error: result.error });
      } else {
        json(res, 202, {
          status: 'installing',
          jobId: result.jobId,
          requires_restart: result.requires_restart,
        });
      }
    } catch (err) {
      handleBodyError(res, err);
    }
    return true;
  }

  // GET /api/skills/install/:jobId
  const installJobMatch = pathname.match(
    /^\/api\/skills\/install\/([^/]+)$/,
  );
  if (installJobMatch && method === 'GET') {
    const jobId = decodeURIComponent(installJobMatch[1]);
    const job = getInstallJob(jobId);
    if (!job) {
      json(res, 404, { error: 'Install job not found' });
      return true;
    }
    json(res, 200, job);
    return true;
  }

  // No match
  return false;
}
