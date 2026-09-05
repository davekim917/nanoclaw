/**
 * Steer write path for `POST /dashboard/api/sessions/:id/message`.
 *
 * Flow: input validation, §2a scope filter, role gate, per-(user, child)
 * rate-limit, reserve-before-write idempotency, partial-write recovery,
 * SSE emit, wakeContainer, fire-and-forget echo to the originating
 * Slack/Discord thread via setImmediate. `_writeAndEchoSteer` is the core;
 * `applySessionSteer` is a thin loader that resolves the session and its
 * echo destination.
 */
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

import { getSession } from '../db/sessions.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { log } from '../log.js';
import { writeSessionMessage } from '../session-manager.js';
import { readSessionInbound } from '../modules/mailbox/index.js';
import { wakeContainer } from '../container-runner.js';
import { getChannelAdapter } from '../channels/channel-registry.js';
import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from '../modules/permissions/db/user-roles.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import {
  reserveIdempotency,
  applyIdempotency,
  claimEchoAttempted,
  IdempotencyConflict,
  type SteerResponse,
  type SteerTarget,
} from './db/steer-idempotency.js';
import { emitDashboardEvent } from './api/events.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

// ── In-memory rate-limit: keyed by `${user_id}:${child_session_id}` ──────────

interface RateWindow {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateWindow>();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Opportunistic eviction threshold for rate-limit Map. The map is in-memory and
// per-(user, child_session) — entries accumulate over time as new sessions are
// created. Without eviction the map grows unbounded over the host's lifetime
// (post-build QA fix SF-7). When size crosses this threshold we sweep stale
// entries (those whose windows have fully expired).
const RATE_LIMIT_MAP_SOFT_CAP = 1024;

function _sweepExpiredRateWindows(now: number): void {
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(key);
    }
  }
}

function checkRateLimit(key: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  if (rateLimitMap.size > RATE_LIMIT_MAP_SOFT_CAP) {
    _sweepExpiredRateWindows(now);
  }
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }
  entry.count++;
  return { allowed: true };
}

function refundRateLimit(key: string): void {
  const entry = rateLimitMap.get(key);
  if (entry && entry.count > 0) entry.count--;
}

export function _resetRateLimitForTesting(): void {
  rateLimitMap.clear();
}

// ── Role check ────────────────────────────────────────────────────────────────

/**
 * Exported for `thread-message.ts`, which must run this BEFORE it resolves a
 * session: assigning to an agent that has never spoken on the thread CREATES a
 * session row, and creating one is a side effect a caller who cannot steer must
 * never be able to cause. It is the same gate, run earlier — not a second one.
 */
export function canSteer(userId: string, agentGroupId: string): { ok: boolean; reason?: string } {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return { ok: true };
  }
  if (isMember(userId, agentGroupId)) {
    return { ok: false, reason: 'member_role_cannot_steer' };
  }
  return { ok: false, reason: 'not_found' };
}

// ── Shared executor ───────────────────────────────────────────────────────────

type SteerStatus = 202 | 400 | 403 | 404 | 409 | 422 | 429 | 503;
type SteerResult = { status: SteerStatus; body: Record<string, unknown> };

interface EchoConfig {
  kind: 'thread' | 'headless';
  messagingGroupId?: string;
  platformThreadId?: string;
}

interface SteerExecution {
  target: SteerTarget;
  // Agent group the target lives under — used for both the scope check and
  // SSE routing. For tasks: parent_agent_group_id. For sessions: agent_group_id.
  agentGroupId: string;
  // Where the inbound write lands. For tasks: task.child_session_id. For
  // sessions: the session itself.
  childAgentGroupId: string;
  childSessionId: string;
  // Where the echo posts. For tasks: child_messaging_group_id +
  // child_platform_thread_id + surface_mode. For sessions: the session's own
  // messaging_group_id + thread_id (or headless when MG is null).
  echo: EchoConfig;
  // Optional task-only side effect after the inbound write commits.
  onWrite?: () => void;
  // What goes into the inbound message envelope's `_steer` block. Lets
  // session-targeted writes carry a different attribution payload.
  envelope: Record<string, unknown>;
}

async function _writeAndEchoSteer(
  exec: SteerExecution,
  body: { idempotency_key: string; text: string },
  ctx: AuthedRequestContext,
): Promise<SteerResult> {
  const userId = ctx.user.id;
  const text = body.text;
  const idempotencyKey = body.idempotency_key;

  if (!text || !text.trim()) return { status: 400, body: { error: 'empty_message' } };
  if (text.length > 4000) return { status: 400, body: { error: 'message_too_long' } };

  // §2a scope filter — disclose-as-not-found.
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(exec.agentGroupId)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  // Role gate — same disclose-as-not-found pattern.
  const roleCheck = canSteer(userId, exec.agentGroupId);
  if (!roleCheck.ok) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const rateLimitKey = `${userId}:${exec.childSessionId}`;
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    return { status: 429, body: { error: 'rate_limit_exceeded', retry_after: rateCheck.retryAfter } };
  }

  const trimmedText = text.trim();
  const requestHash = createHash('sha256').update(trimmedText).digest('hex');
  const messageId = randomUUID();

  let reserved: Awaited<ReturnType<typeof reserveIdempotency>>;
  try {
    reserved = await reserveIdempotency(userId, idempotencyKey, exec.target, messageId, trimmedText, requestHash);
  } catch (err) {
    if (err instanceof IdempotencyConflict) {
      refundRateLimit(rateLimitKey);
      return {
        status: 422,
        body: { error: 'mismatched_idempotency_payload', conflict_kind: err.conflictKind },
      };
    }
    throw err;
  }

  if (reserved.status === 'applied' && reserved.cached) {
    // Echo-recovery on idempotent replay. If the original run crashed
    // between `applyIdempotency` and the setImmediate echo schedule,
    // `echo_attempted` stays 0 and the operator's Slack/Discord thread
    // never sees the message. claim+fire here closes that window —
    // single CAS guarantees we don't double-echo if the original
    // setImmediate already ran.
    if (!reserved.echoAttempted && (await claimEchoAttempted(reserved.id))) {
      setImmediate(() => {
        void (async () => {
          try {
            await _fireEchoAsync(exec, trimmedText, ctx);
          } catch {
            // outer catch covers sync throws — claim already committed
          }
        })();
      });
    }
    return { status: 202, body: _responseShapeForTarget(reserved.cached) };
  }

  const resolvedMessageId = reserved.messageId;
  // Read-only seam: this is the partial-write recovery probe (D5), so it must
  // answer without provisioning or migrating the child's mailbox. `undefined`
  // (no mailbox yet) is "the message is not there", which is what the write
  // below then fixes. `recoverJournal` keeps the pre-seam behavior: rolling a
  // hot journal back is the only reason a read-only handle can answer a
  // session whose host write was interrupted, and this caller owns that
  // session's write anyway. 5s busy_timeout, the write path's, not the
  // console fan-out's 1s — one named session, and a false "not there" here
  // costs a duplicate insert.
  const inboundExists =
    readSessionInbound(
      { agentGroupId: exec.childAgentGroupId, sessionId: exec.childSessionId },
      (mailbox) => mailbox.inboundHasMessage(resolvedMessageId),
      { busyTimeoutMs: 5000, recoverJournal: true },
    ) ?? false;

  if (!inboundExists) {
    const now = new Date().toISOString();
    try {
      await writeSessionMessage(exec.childAgentGroupId, exec.childSessionId, {
        id: resolvedMessageId,
        kind: 'chat',
        timestamp: now,
        content: JSON.stringify({
          text: trimmedText,
          _via: 'dashboard',
          _steer: exec.envelope,
        }),
        trigger: 1,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
        // Concurrent-retry race (PK on id, UNIQUE on seq) — treat as success.
      } else if (code === 'SQLITE_BUSY') {
        refundRateLimit(rateLimitKey);
        return { status: 503, body: { error: 'db_busy', retry_after: 2 } };
      } else {
        refundRateLimit(rateLimitKey);
        throw err;
      }
    }
  }

  if (exec.onWrite) {
    try {
      exec.onWrite();
    } catch (err) {
      log.warn('steer: onWrite hook failed — non-fatal', {
        target: exec.target,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    emitDashboardEvent('inbound_message', {
      task_id: exec.target.type === 'task' ? exec.target.id : '',
      child_session_id: exec.childSessionId,
      parent_agent_group_id: exec.agentGroupId,
      message_id: resolvedMessageId,
    });
  } catch {
    // non-fatal
  }

  const childSession = await getSession(exec.childSessionId);
  if (childSession) {
    void wakeContainer(childSession).catch((err) =>
      log.warn('steer: wakeContainer failed', { target: exec.target, err }),
    );
  }

  const steerResponse: SteerResponse = {
    target_type: exec.target.type,
    target_id: exec.target.id,
    message_id: resolvedMessageId,
    echo_status: 'pending',
  };
  await applyIdempotency(userId, idempotencyKey, steerResponse);

  if (await claimEchoAttempted(reserved.id)) {
    setImmediate(() => {
      void (async () => {
        try {
          await _fireEchoAsync(exec, trimmedText, ctx);
        } catch {
          // outer catch covers sync throws — claim already committed; nothing to roll back
        }
      })();
    });
  }

  return { status: 202, body: _responseShapeForTarget(steerResponse) };
}

/**
 * Re-shape the generic `SteerResponse` for HTTP. The task endpoint has
 * carried `task_id` in the body since v1; the session endpoint exposes
 * `session_id`. `target_type`/`target_id` are also included so future
 * clients can stay generic.
 */
function _responseShapeForTarget(r: SteerResponse): Record<string, unknown> {
  const base: Record<string, unknown> = {
    target_type: r.target_type,
    target_id: r.target_id,
    message_id: r.message_id,
    echo_status: r.echo_status,
  };
  if (r.target_type === 'task') base['task_id'] = r.target_id;
  else base['session_id'] = r.target_id;
  return base;
}

async function _fireEchoAsync(exec: SteerExecution, text: string, ctx: AuthedRequestContext): Promise<void> {
  if (exec.echo.kind !== 'thread' || !exec.echo.messagingGroupId || !exec.echo.platformThreadId) {
    await _emitEchoStatus('skipped_headless', exec);
    return;
  }

  const mg = getMessagingGroup(exec.echo.messagingGroupId);
  if (!mg) {
    await _emitEchoStatus('adapter_unavailable', exec);
    return;
  }

  const adapter = getChannelAdapter(mg.channel_type);
  if (!adapter || typeof adapter.deliver !== 'function') {
    await _emitEchoStatus('adapter_unavailable', exec);
    return;
  }

  const displayName = ctx.user.display_name ?? ctx.user.id;
  try {
    await adapter.deliver(mg.platform_id, exec.echo.platformThreadId, {
      kind: 'chat',
      content: { text: `[via dashboard] ${text} — ${displayName}` },
    });
    await _emitEchoStatus('echoed', exec);
  } catch {
    await _emitEchoStatus('echo_failed', exec);
  }
}

async function _emitEchoStatus(
  echoStatus: 'echoed' | 'echo_failed' | 'adapter_unavailable' | 'skipped_headless',
  exec: SteerExecution,
): Promise<void> {
  log.debug('steer: echo_status', { echoStatus, target: exec.target });
  if (exec.target.type === 'task') {
    emitDashboardEvent('task_event', {
      task_id: exec.target.id,
      kind: 'progress',
      agent_group_id: exec.agentGroupId,
      echo_status: echoStatus,
    });
  } else {
    emitDashboardEvent('session_event', {
      session_id: exec.target.id,
      agent_group_id: exec.agentGroupId,
      kind: 'outbound',
      outbound_kind: `dashboard-echo:${echoStatus}`,
    });
  }
}

// ── Session steer ─────────────────────────────────────────────────────────────

export async function applySessionSteer(
  sessionId: string,
  body: { idempotency_key: string; text: string },
  ctx: AuthedRequestContext,
): Promise<SteerResult> {
  const session = await getSession(sessionId);
  if (!session) return { status: 404, body: { error: 'session_not_found' } };

  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(session.agent_group_id)) {
    return { status: 404, body: { error: 'session_not_found' } };
  }

  // Session lives in chat when messaging_group_id is set. Agent-shared
  // sessions (mg=null) have no chat surface to echo into — analogous to a
  // task in `headless` surface mode.
  const echo: EchoConfig = session.messaging_group_id
    ? {
        kind: 'thread',
        messagingGroupId: session.messaging_group_id,
        ...(session.thread_id ? { platformThreadId: session.thread_id } : {}),
      }
    : { kind: 'headless' };

  const result = await _writeAndEchoSteer(
    {
      target: { type: 'session', id: sessionId },
      agentGroupId: session.agent_group_id,
      childAgentGroupId: session.agent_group_id,
      childSessionId: sessionId,
      echo,
      envelope: { session_id: sessionId, user_id: ctx.user.id },
    },
    body,
    ctx,
  );

  if (result.status === 404 && result.body['error'] === 'not_found') {
    return { status: 404, body: { error: 'session_not_found' } };
  }
  return result;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function _readSteerBody(req: Request): Promise<{ idempotency_key: string; text: string } | { error: Response }> {
  let body: { idempotency_key?: string; text?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return {
      error: new Response(JSON.stringify({ error: 'invalid_request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }
  if (!body.idempotency_key) {
    return {
      error: new Response(JSON.stringify({ error: 'invalid_request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }
  return { idempotency_key: body.idempotency_key, text: body.text ?? '' };
}

function _httpStatusOf(status: SteerStatus): number {
  const statusMap: Record<number, number> = {
    202: 202,
    400: 400,
    403: 403,
    404: 404,
    409: 409,
    422: 422,
    429: 429,
    503: 503,
  };
  return statusMap[status] ?? 500;
}

export const sessionMessageHandler: AuthHandler = async (req, params, ctx) => {
  const body = await _readSteerBody(req);
  if ('error' in body) return body.error;

  const sessionId = params['id'] ?? '';
  const result = await applySessionSteer(sessionId, body, ctx);
  return new Response(JSON.stringify(result.body), {
    status: _httpStatusOf(result.status),
    headers: { 'Content-Type': 'application/json' },
  });
};
