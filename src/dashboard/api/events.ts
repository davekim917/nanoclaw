/**
 * SSE feed for the dashboard.
 *
 * Single global keepalive timer (M22). Per-user cap 20, aggregate cap 200.
 * chokidar v5 watches data/v2-sessions/ directory; emitDashboardEvent is
 * also called directly by dispatch.ts (cycle-3 M2-c3 — central DB is WAL
 * so chokidar misses writes between checkpoints).
 */
import path from 'path';
import http from 'http';
import { createHash } from 'crypto';
import type { Stats } from 'node:fs';

import { readSessionInbound } from '../../modules/mailbox/index.js';
import type { AuthedRequestContext, AuthHandler } from '../router.js';
import { log } from '../../log.js';

export type DashboardEventKind = 'inbound_message' | 'task_event' | 'session_event';

export interface InboundMessagePayload {
  task_id: string;
  child_session_id: string;
  parent_agent_group_id: string;
  message_id: string;
}

export interface TaskEventPayload {
  // null for whole-group events (e.g., bulk_archived) where there's no
  // single task id worth singling out — SWR consumers should treat null as
  // "invalidate the whole list, this group changed."
  task_id: string | null;
  kind:
    | 'admit'
    | 'status_change'
    | 'progress'
    | 'complete'
    | 'failed'
    | 'cancel'
    | 'needs_input'
    | 'archived'
    | 'unarchived'
    | 'bulk_archived';
  agent_group_id: string;
  [key: string]: unknown;
}

/**
 * Push-channel signal that something on the inbox-board surface changed for
 * one session. Consumers treat it as "invalidate this session's row" — they
 * re-fetch /dashboard/api/sessions to get the new attention_state. The
 * granular `kind` tag is here so a future client can refresh a single card
 * instead of the whole list, but the v1 inbox just invalidates SWR.
 *
 *   - inbound          — router wrote a new row into the session's
 *                        inbound.db. The session's last_inbound_at moved.
 *   - outbound         — host successfully delivered an outbound row;
 *                        last_outbound_at + kind moved. `outbound_kind`
 *                        carries the granular tag from delivery.ts so a
 *                        chat-sdk:ask_question fan-out can be detected
 *                        without re-fetching.
 *   - container_state  — heartbeat-derived state transition (running→idle,
 *                        idle→stopped, etc.). `container_status` carries
 *                        the new state.
 */
export interface SessionEventPayload {
  // null for whole-group bulk events; the inbox treats null as "invalidate
  // the visible list for this group". Matches the TaskEventPayload contract.
  session_id: string | null;
  agent_group_id: string;
  kind: 'inbound' | 'outbound' | 'container_state' | 'archived' | 'unarchived';
  outbound_kind?: string;
  container_status?: 'running' | 'idle' | 'stopped';
}

export function emitDashboardEvent(kind: 'inbound_message', payload: InboundMessagePayload): void;
export function emitDashboardEvent(kind: 'task_event', payload: TaskEventPayload): void;
export function emitDashboardEvent(kind: 'session_event', payload: SessionEventPayload): void;
export function emitDashboardEvent(
  kind: DashboardEventKind,
  payload: InboundMessagePayload | TaskEventPayload | SessionEventPayload,
): void {
  const frame = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const conns of connectionsByUser.values()) {
    for (const conn of conns) {
      let groupId: string;
      if (kind === 'inbound_message') {
        groupId = (payload as InboundMessagePayload).parent_agent_group_id;
      } else if (kind === 'task_event') {
        groupId = (payload as TaskEventPayload).agent_group_id;
      } else {
        groupId = (payload as SessionEventPayload).agent_group_id;
      }
      if (!_scopeAllows(conn.scopes, groupId)) continue;
      try {
        conn.res.write(frame);
      } catch {
        // ignore write errors — close handler cleans up
      }
    }
  }
}

/**
 * Convenience wrapper for the three session-event emit sites (inbound write,
 * outbound delivery, container-state change). Wraps the emit in a try/catch
 * because the dashboard module isn't always initialized in unit tests, and a
 * thrown SSE error from a hot delivery loop is far worse than a missed
 * push (clients poll every 30s as a backstop).
 */
export function emitSessionEvent(payload: SessionEventPayload): void {
  try {
    emitDashboardEvent('session_event', payload);
  } catch {
    // never let a push failure bubble up into the core message path
  }
}

function _scopeAllows(scopes: AuthedRequestContext['scopes'], parentGroupId: string): boolean {
  if (scopes.no_filter) return true;
  return scopes.allowed_group_ids.includes(parentGroupId);
}

interface SseConnection {
  id: string;
  userId: string;
  res: http.ServerResponse;
  scopes: AuthedRequestContext['scopes'];
}

const connectionsByUser = new Map<string, Set<SseConnection>>();
let aggregateCount = 0;

const PER_USER_CAP = 20;
const AGGREGATE_CAP = 200;
const KEEPALIVE_INTERVAL_MS = 25_000;
const SESSIONS_ROOT = path.resolve(process.cwd(), 'data/v2-sessions');
const SESSION_DATABASE_FILES = new Set(['inbound.db', 'outbound.db']);
// One definition of the layout, imported rather than restated: the watcher has
// to look exactly where the host writes, and a second copy of '.host' here
// would be free to drift away from the writer.
import { HOST_INBOUND_DIR_NAME } from '../../modules/mailbox/index.js';

type SessionWatchStats = Pick<Stats, 'isDirectory' | 'isSymbolicLink'>;

export function shouldIgnoreSessionWatchPath(filePath: string, stats?: SessionWatchStats): boolean {
  const relative = path.relative(SESSIONS_ROOT, path.resolve(filePath));
  if (relative === '') {
    return stats !== undefined && (stats.isSymbolicLink() || !stats.isDirectory());
  }
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
  const parts = relative.split(path.sep);
  // Traverse only v2-sessions/<agent-group>/<session>. Session worktrees can
  // contain hundreds of thousands of directories and are irrelevant here.
  if (parts.length <= 2) {
    // Chokidar calls a two-argument ignored function once before and once
    // after stat. Admit the path-only pass, then require a real directory.
    return stats !== undefined && (stats.isSymbolicLink() || !stats.isDirectory());
  }
  // The host writes `<session>/.host/inbound.db`, so the watch has
  // to reach one level deeper for that one path — otherwise every host inbound
  // write stops raising an SSE event and the board silently goes stale. The
  // `.host` DIRECTORY is admitted too, or chokidar never descends into it.
  if (parts.length === 3 && parts[2] === HOST_INBOUND_DIR_NAME) {
    return stats !== undefined && (stats.isSymbolicLink() || !stats.isDirectory());
  }
  if (parts.length === 4) {
    if (parts[2] !== HOST_INBOUND_DIR_NAME || parts[3] !== 'inbound.db') return true;
    return stats !== undefined && (stats.isSymbolicLink() || stats.isDirectory());
  }
  if (parts.length !== 3 || !SESSION_DATABASE_FILES.has(parts[2]!)) return true;
  return stats !== undefined && (stats.isSymbolicLink() || stats.isDirectory());
}

function addConnection(conn: SseConnection): void {
  let userSet = connectionsByUser.get(conn.userId);
  if (!userSet) {
    userSet = new Set();
    connectionsByUser.set(conn.userId, userSet);
  }
  userSet.add(conn);
  aggregateCount++;
}

function removeConnection(conn: SseConnection): void {
  const userSet = connectionsByUser.get(conn.userId);
  if (userSet) {
    userSet.delete(conn);
    if (userSet.size === 0) connectionsByUser.delete(conn.userId);
  }
  aggregateCount--;
  if (aggregateCount < 0) aggregateCount = 0;
}

// Single global keepalive timer (M22 — one timer, not per-connection)
let keepaliveTimer: NodeJS.Timeout | null = null;
let watcher: import('chokidar').FSWatcher | null = null;

export function startSSEFeed(): void {
  if (keepaliveTimer !== null) return;

  keepaliveTimer = setInterval(() => {
    const frame = ':keepalive\n\n';
    for (const conns of connectionsByUser.values()) {
      for (const conn of conns) {
        try {
          conn.res.write(frame);
        } catch {
          // ignore
        }
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
  keepaliveTimer.unref();

  void import('chokidar')
    .then(({ watch }) => {
      // ignored function accepts both inbound.db and outbound.db (M4-c2)
      // returning false = DO watch the file; returning true = ignore
      watcher = watch(SESSIONS_ROOT, {
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
        // Accept only the two session DBs and their two directory ancestors.
        // A filename heuristic would recurse into session worktrees and exhaust
        // the process-wide inotify budget on large repositories.
        ignored: shouldIgnoreSessionWatchPath,
      });

      // Post-build QA fix SF-9: chokidar emits `error` events; without a handler
      // they propagate as unhandled `EventEmitter` errors and crash the process on
      // newer Node.js versions. Common trigger: SESSIONS_ROOT doesn't exist on first
      // run before any sessions have been created. Log and continue — the SSE feed
      // remains functional via programmatic emitDashboardEvent calls.
      watcher.on('error', (err) => {
        log.warn('chokidar SSE watcher error', { err });
      });

      watcher.on('change', (filePath: string) => {
        const rel = path.relative(SESSIONS_ROOT, filePath);
        const parts = rel.split(path.sep);
        if (parts.length < 3) return;
        const [agentGroupId, sessionId] = parts;
        if (!agentGroupId || !sessionId) return;
        // `<ag>/<sess>/{inbound,outbound}.db`, or the host-owned
        // `<ag>/<sess>/.host/inbound.db` the host writes.
        const filename = parts[parts.length - 1];
        const hostOwned = parts.length === 4 && parts[2] === HOST_INBOUND_DIR_NAME && filename === 'inbound.db';
        if (!hostOwned && (parts.length !== 3 || !filename || !SESSION_DATABASE_FILES.has(filename))) return;

        _emitInboundChangeEvent(agentGroupId, sessionId, filename === 'inbound.db');
      });
    })
    .catch(() => {
      // chokidar unavailable — SSE feed works without filesystem watch
    });
}

function _emitInboundChangeEvent(agentGroupId: string, sessionId: string, isInbound: boolean): void {
  let messageId = `fs:${agentGroupId}:${sessionId}:${Date.now()}`;
  // Only an inbound.db change can name the row that changed. An outbound.db
  // touch keeps the synthetic id, exactly as before the seam — the pre-seam
  // code opened whichever file moved and asked it for `messages_in`, which on
  // outbound.db threw and fell through to this same fallback.
  if (isInbound) {
    try {
      const latest = readSessionInbound({ agentGroupId, sessionId }, (mailbox) => mailbox.latestInboundMessageId(), {
        busyTimeoutMs: 500,
      });
      if (latest) messageId = latest;
    } catch {
      // ignore — use timestamp-based id
    }
  }

  emitDashboardEvent('inbound_message', {
    task_id: '',
    child_session_id: sessionId,
    parent_agent_group_id: agentGroupId,
    message_id: messageId,
  });
}

export function stopSSEFeed(): void {
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (watcher !== null) {
    watcher.close().catch(() => {});
    watcher = null;
  }
  for (const conns of connectionsByUser.values()) {
    for (const conn of conns) {
      try {
        conn.res.end();
      } catch {
        // ignore
      }
    }
  }
  connectionsByUser.clear();
  aggregateCount = 0;
}

export const eventsHandler: AuthHandler = async (_req, _params, ctx) => {
  const userId = ctx.user.id;

  const userConns = connectionsByUser.get(userId);
  if (userConns && userConns.size >= PER_USER_CAP) {
    return new Response(JSON.stringify({ error: 'too_many_connections' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
    });
  }

  if (aggregateCount >= AGGREGATE_CAP) {
    return new Response(JSON.stringify({ error: 'too_many_connections' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
    });
  }

  const nodeReq: http.IncomingMessage = ctx.rawNodeReq;
  // rawNodeRes is set by dispatch in router.ts
  const nodeRes: http.ServerResponse = (ctx as unknown as { rawNodeRes: http.ServerResponse }).rawNodeRes;

  nodeRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const connId = createHash('sha256').update(`${userId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);

  const conn: SseConnection = {
    id: connId,
    userId,
    res: nodeRes,
    scopes: ctx.scopes,
  };

  addConnection(conn);

  nodeReq.on('close', () => {
    removeConnection(conn);
    try {
      nodeRes.end();
    } catch {
      // ignore
    }
  });

  return null;
};
