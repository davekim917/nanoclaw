/**
 * Scheduled Tasks Board simple mutations (Tasks C1-C5):
 *   PUT  /scheduled/:key            edit (prompt/script/cron)
 *   POST /scheduled/:key/pause      pause
 *   POST /scheduled/:key/resume     resume (slot recompute)
 *   POST /scheduled/:key/run-now    early fire
 *   POST /scheduled/:key/cancel     end series
 *
 * Every handler shares one contract (plan §Group-C): canManageScheduled gate
 * (404 disclose-as-not-found for non-manage/out-of-scope — never 403), decode
 * `:key` (malformed → 400), unreadable session inbound.db → 503
 * `session_unreadable`, verbVerdict as the ONLY guard source, writeAudit, a
 * `session_event` SSE frame with the row's owning agent_group_id (never null),
 * then invalidateScheduledCache. See design §4.0, §4.5, §4.6, §4.7.
 */
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, TIMEZONE } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { openInboundDb } from '../../db/session-db.js';
import { cancelSeriesWithStrandClear, pauseTask, resumeTask, updateTask } from '../../modules/scheduling/db.js';
import { wakeContainer } from '../../container-runner.js';
import { admitDueTaskContexts } from '../../session-manager.js';
import { log } from '../../log.js';
import { parseUtcTimestampMs } from '../../thread-context.js';
import { emitDashboardEvent } from './events.js';
import { verbVerdict, type HealthState, type SeriesKind } from './scheduled-board-matrix.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';
import {
  canManageScheduled,
  decodeKey,
  invalidateScheduledCache,
  rateLimit,
  sessionInboundPathFor,
  writeAudit,
} from './scheduled-shared.js';

// `moduleOwner` (the single canonical module-owned registry) lives in
// scheduled-shared.ts; the read assembly + tests import it directly from there.

// ── Test seam ─────────────────────────────────────────────────────────────────

interface MutationOptions {
  dataDir: string;
  nowMs: number;
}
let testOptions: MutationOptions | null = null;
export function _setMutationsTestOptions(opts: MutationOptions | null): void {
  testOptions = opts;
}
function mutationOpts(): MutationOptions {
  return testOptions ?? { dataDir: DATA_DIR, nowMs: Date.now() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Shared resolve + gate + live-row read ────────────────────────────────────────

interface LiveRow {
  id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
  thread_id: string | null;
}

interface ResolvedTarget {
  agentGroupId: string;
  sessionId: string;
  seriesId: string;
  inboundPath: string;
  outboundPath: string;
  live: LiveRow;
  health: HealthState;
  kind: SeriesKind;
  claimed: boolean;
  processAfterMs: number | null;
}

/**
 * Resolve a mutation's target: decode + gate + open the session DBs + read the
 * live row + derive the move-relevant health state (paused / processing /
 * unknown / late / healthy) the way the matrix needs. Returns a Response on any
 * reject (404/400/503/409), or the resolved target.
 */
function resolveTarget(
  key: string,
  ctx: AuthedRequestContext,
  nowMs: number,
  dataDir: string,
): { error: Response } | { ok: ResolvedTarget } {
  const decoded = decodeKey(key);
  if (!decoded) return { error: json({ error: 'bad_key' }, 400) };

  // Mutation gate — owner/global-admin only; non-manage → 404 disclose-as-not-found.
  if (!canManageScheduled(ctx.user.id)) return { error: json({ error: 'not_found' }, 404) };
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(decoded.agentGroupId)) {
    return { error: json({ error: 'not_found' }, 404) };
  }

  // M4: build the inbound path through the containment-checked helper. A null
  // (containment violation — decodeKey already rejects traversal, this is
  // defense in depth) collapses to 404 disclose-as-not-found, never an open
  // outside data/v2-sessions.
  const inboundPath = sessionInboundPathFor(dataDir, decoded.agentGroupId, decoded.sessionId);
  if (!inboundPath) return { error: json({ error: 'not_found' }, 404) };
  const outboundPath = path.join(path.dirname(inboundPath), 'outbound.db');
  // Unreadable / missing session inbound → 503 fail-closed (§3a).
  if (!fs.existsSync(inboundPath))
    return { error: json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503) };

  let live: LiveRow | undefined;
  try {
    const db = openInboundDb(inboundPath);
    try {
      live =
        (db
          .prepare(
            `SELECT id, status, process_after, recurrence, content, thread_id
               FROM messages_in
              WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused')
              ORDER BY seq DESC LIMIT 1`,
          )
          .get(decoded.seriesId) as LiveRow | undefined) ?? undefined;
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn('scheduled-mutations: inbound read failed', { err: err instanceof Error ? err.message : String(err) });
    return { error: json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503) };
  }

  // No live row → stale key (the series ended/moved since the list).
  if (!live) return { error: json({ error: 'stale_key', reason: 'stale_key' }, 409) };

  // Claim state from outbound.db. Absent/unreadable outbound + overdue → unknown
  // (never silently not-claimed — F6).
  const processAfterMs = parseUtcTimestampMs(live.process_after);
  const overdue = processAfterMs !== null && processAfterMs <= nowMs;
  let claimed = false;
  let outboundReadable = false;
  if (fs.existsSync(outboundPath)) {
    try {
      const odb = new Database(outboundPath, { readonly: true });
      odb.pragma('busy_timeout = 1000');
      try {
        const row = odb
          .prepare("SELECT 1 AS ok FROM processing_ack WHERE message_id = ? AND status = 'processing' LIMIT 1")
          .get(live.id) as { ok: number } | undefined;
        claimed = !!row;
        outboundReadable = true;
      } finally {
        odb.close();
      }
    } catch {
      outboundReadable = false;
    }
  }

  let health: HealthState;
  if (live.status === 'paused') health = 'paused';
  else if (claimed) health = 'processing';
  else if (!outboundReadable && overdue) health = 'unknown';
  else if (overdue) health = 'late';
  else health = 'healthy';

  const kind: SeriesKind = live.recurrence ? (live.thread_id ? 'thread_loop' : 'recurring') : 'one_off';

  return {
    ok: {
      agentGroupId: decoded.agentGroupId,
      sessionId: decoded.sessionId,
      seriesId: decoded.seriesId,
      inboundPath,
      outboundPath,
      live,
      health,
      kind,
      claimed,
      processAfterMs,
    },
  };
}

/** Emit the post-mutation SSE frame (non-null agent_group_id) + invalidate cache. */
function afterMutation(agentGroupId: string, sessionId: string): void {
  try {
    emitDashboardEvent('session_event', { session_id: sessionId, agent_group_id: agentGroupId, kind: 'inbound' });
  } catch {
    /* non-fatal */
  }
  invalidateScheduledCache();
}

/** Next future cron occurrence (canonical parse — byte-identical to recurrence.ts:31). */
function nextSlot(cron: string, afterMs: number): string {
  const it = CronExpressionParser.parse(cron, { tz: TIMEZONE, currentDate: new Date(afterMs) });
  return it.next().toDate().toISOString();
}

/** Validate a cron via the firing-path parser + confirm a finite interval (§4.5). */
function cronIsValid(cron: unknown): boolean {
  // cron-parser ACCEPTS null/undefined/'' (and treats them as "* * * * *" — a
  // per-minute fire). A falsy cron reaching the firing path turns a series into
  // a runaway minute loop, so reject non-strings AND empty/whitespace-only here
  // (the M3 corruption class, extended to the third editable field). The typeof
  // guard in editHandler already 400s a non-string before this, but keeping the
  // check here makes the helper safe for any future caller.
  if (typeof cron !== 'string' || cron.trim() === '') return false;
  try {
    const it = CronExpressionParser.parse(cron, { tz: TIMEZONE });
    it.next();
    it.next();
    return true;
  } catch {
    return false;
  }
}

const verdictResponse = (v: ReturnType<typeof verbVerdict>): Response =>
  json({ error: v.reason ?? 'forbidden', reason: v.reason, needsForce: v.needsForce }, v.status ?? 409);

// ── C1: edit ────────────────────────────────────────────────────────────────────

const PROMPT_MAX = 8000;
const SCRIPT_MAX = 4000;

export const editHandler: AuthHandler = async (req, params, ctx) => {
  const { dataDir, nowMs } = mutationOpts();
  // prompt/script/cron are `unknown` at the boundary so the M3 type guards below
  // are meaningful (a non-string from a malformed client body must be rejected,
  // not narrowed away by the type system and then merged into live content or
  // the recurrence column).
  let body: { prompt?: unknown; script?: unknown; cron?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  const r = resolveTarget(params['key'] ?? '', ctx, nowMs, dataDir);
  if ('error' in r) return r.error;
  const t = r.ok;

  // M3: reject non-string prompt/script BEFORE any length check or write — a
  // non-string would be merged verbatim into the live row's JSON content and
  // corrupt it (the firing path expects content.prompt/script to be strings).
  // The same class applies to `cron` (the third editable field): a non-string
  // cron (null/number/object) slips past cronIsValid because cron-parser accepts
  // null/'' as "* * * * *" → a runaway per-minute fire loop. Reject it here with
  // the same 400 before any write; cronIsValid below rejects an empty string.
  if (body.prompt !== undefined && typeof body.prompt !== 'string') return json({ error: 'invalid_request' }, 400);
  if (body.script !== undefined && typeof body.script !== 'string') return json({ error: 'invalid_request' }, 400);
  if (body.cron !== undefined && typeof body.cron !== 'string') return json({ error: 'invalid_request' }, 400);

  // Bounds (C8).
  if (body.prompt !== undefined && body.prompt.length > PROMPT_MAX) return json({ error: 'too_long' }, 400);
  if (body.script !== undefined && body.script.length > SCRIPT_MAX) return json({ error: 'too_long' }, 400);
  // Cron validity (never silently accept — would create a strand).
  if (body.cron !== undefined && !cronIsValid(body.cron)) return json({ error: 'bad_cron' }, 400);

  const verdict = verbVerdict('edit', {
    state: t.health,
    kind: t.kind,
    claimed: t.claimed,
    processAfterMs: t.processAfterMs,
    nowMs,
  });
  if (!verdict.allowed) return verdictResponse(verdict);

  const before = (() => {
    try {
      return (JSON.parse(t.live.content) as { prompt?: string }).prompt ?? '';
    } catch {
      return t.live.content;
    }
  })();

  // Cron edit recomputes process_after to the next occurrence (M6).
  const update: { prompt?: string; script?: string; recurrence?: string; processAfter?: string } = {};
  if (body.prompt !== undefined) update.prompt = body.prompt;
  if (body.script !== undefined) update.script = body.script;
  if (body.cron !== undefined) {
    update.recurrence = body.cron;
    update.processAfter = nextSlot(body.cron, nowMs);
  }

  const db = openInboundDb(t.inboundPath);
  let touched: number;
  try {
    touched = updateTask(db, t.seriesId, update);
  } finally {
    db.close();
  }
  if (touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  writeAudit(getDb(), {
    actor: ctx.user.id,
    action: 'edit',
    agentGroupId: t.agentGroupId,
    sessionId: t.sessionId,
    seriesId: t.seriesId,
    before,
    ...(body.prompt !== undefined ? { after: body.prompt } : {}),
    ...(body.script !== undefined ? { scriptAfter: body.script } : {}),
    detail: body.cron !== undefined ? { cron: body.cron } : undefined,
  });
  afterMutation(t.agentGroupId, t.sessionId);
  return json({ updated: true });
};

// ── C2: pause / resume ────────────────────────────────────────────────────────────

export const pauseHandler: AuthHandler = async (_req, params, ctx) => {
  const { dataDir, nowMs } = mutationOpts();
  const r = resolveTarget(params['key'] ?? '', ctx, nowMs, dataDir);
  if ('error' in r) return r.error;
  const t = r.ok;

  const verdict = verbVerdict('pause', {
    state: t.health,
    kind: t.kind,
    claimed: t.claimed,
    processAfterMs: t.processAfterMs,
    nowMs,
  });
  if (!verdict.allowed) return verdictResponse(verdict);

  const db = openInboundDb(t.inboundPath);
  let touched: number;
  try {
    touched = pauseTask(db, t.seriesId);
  } finally {
    db.close();
  }
  if (touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  writeAudit(getDb(), {
    actor: ctx.user.id,
    action: 'pause',
    agentGroupId: t.agentGroupId,
    sessionId: t.sessionId,
    seriesId: t.seriesId,
  });
  afterMutation(t.agentGroupId, t.sessionId);
  return json({ paused: true });
};

export const resumeHandler: AuthHandler = async (_req, params, ctx) => {
  const { dataDir, nowMs } = mutationOpts();
  const r = resolveTarget(params['key'] ?? '', ctx, nowMs, dataDir);
  if ('error' in r) return r.error;
  const t = r.ok;

  const verdict = verbVerdict('resume', {
    state: t.health,
    kind: t.kind,
    claimed: t.claimed,
    processAfterMs: t.processAfterMs,
    nowMs,
  });
  if (!verdict.allowed) return verdictResponse(verdict);

  const db = openInboundDb(t.inboundPath);
  let touched: number;
  try {
    // §4.7: recompute process_after to the next FUTURE slot BEFORE flipping to
    // pending (skip-don't-replay, D3) — a paused-past-its-slot series must not
    // fire immediately on resume.
    if (t.live.recurrence) {
      updateTask(db, t.seriesId, { processAfter: nextSlot(t.live.recurrence, nowMs) });
    }
    touched = resumeTask(db, t.seriesId);
  } finally {
    db.close();
  }
  if (touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  writeAudit(getDb(), {
    actor: ctx.user.id,
    action: 'resume',
    agentGroupId: t.agentGroupId,
    sessionId: t.sessionId,
    seriesId: t.seriesId,
  });
  afterMutation(t.agentGroupId, t.sessionId);
  return json({ resumed: true });
};

// ── C3: run-now ────────────────────────────────────────────────────────────────

export const runNowHandler: AuthHandler = async (req, params, ctx) => {
  const { dataDir, nowMs } = mutationOpts();
  let body: { force?: boolean } = {};
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    /* no body — force defaults false */
  }

  const r = resolveTarget(params['key'] ?? '', ctx, nowMs, dataDir);
  if ('error' in r) return r.error;
  const t = r.ok;

  // Rate limit (run-now converts a keypress into container compute — S10).
  const rl = rateLimit(ctx.user.id, 'run_now');
  if (!rl.ok) return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429);

  const verdict = verbVerdict('run_now', {
    state: t.health,
    kind: t.kind,
    claimed: t.claimed,
    processAfterMs: t.processAfterMs,
    nowMs,
    forced: body.force === true,
  });
  if (!verdict.allowed) return verdictResponse(verdict);

  // Fire: process_after = now, then wake the container. Recurrence advances
  // normally on completion (an early fire does not shift the schedule — §4.6).
  const db = openInboundDb(t.inboundPath);
  let touched: number;
  let admittedTarget = false;
  try {
    touched = updateTask(db, t.seriesId, { processAfter: new Date(nowMs).toISOString() });
    if (touched > 0) {
      admitDueTaskContexts(db, t.agentGroupId, t.sessionId);
      admittedTarget =
        db
          .prepare(
            `SELECT 1
               FROM messages_in AS task
               JOIN messages_in AS recall
                 ON recall.id = 'recall-' || task.id
                AND recall.seq = task.seq - 2
                AND recall.kind = 'system'
                AND recall.trigger = 0
              WHERE task.id = ?
                AND task.kind = 'task'
                AND task.status = 'pending'
                AND task.trigger = 1`,
          )
          .get(t.live.id) !== undefined;
      if (!admittedTarget) {
        // Do not silently turn a failed run-now request into a later run-now.
        // Keep the row inert (updateTask already invalidated stale recall) but
        // restore its prior schedule so only the pre-existing fire remains.
        db.prepare(
          `UPDATE messages_in
              SET process_after = ?
            WHERE id = ? AND kind = 'task' AND status = 'pending' AND trigger = 0`,
        ).run(t.live.process_after, t.live.id);
      }
    }
  } finally {
    db.close();
  }
  if (touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);
  if (!admittedTarget) {
    return json(
      {
        error: 'context_admission_failed',
        reason: 'Fresh context could not be admitted; the task remains inert and was not fired.',
      },
      503,
    );
  }

  const session = getSession(t.sessionId);
  if (session) {
    void wakeContainer(session).catch((err) => log.warn('scheduled-mutations: run-now wake failed', { err }));
  }

  writeAudit(getDb(), {
    actor: ctx.user.id,
    action: 'run_now',
    agentGroupId: t.agentGroupId,
    sessionId: t.sessionId,
    seriesId: t.seriesId,
    ...(body.force === true ? { detail: { forced: true } } : {}),
  });
  afterMutation(t.agentGroupId, t.sessionId);
  return json({ fired: true });
};

// ── C4: cancel ──────────────────────────────────────────────────────────────────

export const cancelHandler: AuthHandler = async (_req, params, ctx) => {
  const { dataDir, nowMs } = mutationOpts();

  // Cancel is reachable on a pure strand (terminal recurrence-set row, no live
  // row), so it does NOT go through resolveTarget's live-row requirement — that
  // would 409 stale_key on a strand. Decode + gate inline, then
  // cancelSeriesWithStrandClear, whose touched-count includes terminal clears.
  const decoded = decodeKey(params['key'] ?? '');
  if (!decoded) return json({ error: 'bad_key' }, 400);
  if (!canManageScheduled(ctx.user.id)) return json({ error: 'not_found' }, 404);
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(decoded.agentGroupId)) {
    return json({ error: 'not_found' }, 404);
  }

  // M4: containment-checked open (null → 404 disclose-as-not-found).
  const inboundPath = sessionInboundPathFor(dataDir, decoded.agentGroupId, decoded.sessionId);
  if (!inboundPath) return json({ error: 'not_found' }, 404);
  if (!fs.existsSync(inboundPath)) return json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503);

  let touched: number;
  try {
    const db = openInboundDb(inboundPath);
    try {
      touched = cancelSeriesWithStrandClear(db, decoded.seriesId);
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn('scheduled-mutations: cancel failed', { err: err instanceof Error ? err.message : String(err) });
    return json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503);
  }
  // touched 0 → nothing live AND no terminal recurrence to clear → stale key.
  if (touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  writeAudit(getDb(), {
    actor: ctx.user.id,
    action: 'cancel',
    agentGroupId: decoded.agentGroupId,
    sessionId: decoded.sessionId,
    seriesId: decoded.seriesId,
  });
  afterMutation(decoded.agentGroupId, decoded.sessionId);
  void nowMs; // (kept for signature parity with the other handlers)
  return json({ cancelled: true });
};
