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

import { DATA_DIR, TIMEZONE } from '../../config.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import {
  readSessionInbound,
  readSessionOutbound,
  type NanoclawMailboxSession,
  type ScheduledTaskRow,
  type SessionReadLocation,
} from '../../modules/mailbox/index.js';
import { wakeContainer } from '../../container-runner.js';
import { admitDueTaskContexts, withExistingMailboxSession } from '../../session-manager.js';
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

// Read through the mailbox module's named ops, so the row shape is the
// module's. (The WRITE half of these handlers still opens a raw inbound handle
// for modules/scheduling/db.ts's task mutators — see the file header note.)
type LiveRow = ScheduledTaskRow;

interface ResolvedTarget {
  agentGroupId: string;
  sessionId: string;
  seriesId: string;
  inboundPath: string;
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
  // Unreadable / missing session inbound → 503 fail-closed (§3a).
  if (!fs.existsSync(inboundPath))
    return { error: json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503) };

  const location: SessionReadLocation = { dataDir, agentGroupId: decoded.agentGroupId, sessionId: decoded.sessionId };
  let live: LiveRow | undefined;
  try {
    // Read-only seam: resolving the gate must not provision or migrate the
    // session (invariant I-4). `undefined` is "no mailbox", which the
    // existsSync guard above has already turned into a 503.
    //
    // The options restate what `openInboundDb` gave this read before the seam,
    // because both matter on a MUTATION gate: the write path's 5s
    // busy_timeout, so a contended session waits rather than 503-ing an
    // operator's edit, and the hot-journal rollback, without which a session
    // whose container was SIGKILLed answers every gate with 503 until some
    // other subsystem recovers it. This is one named session the handler is
    // about to write to anyway — not the console's fleet fan-out, which is
    // what the 1s no-recovery default exists for.
    live =
      readSessionInbound(location, (mailbox) => mailbox.getLiveTaskRow(decoded.seriesId), {
        busyTimeoutMs: 5000,
        recoverJournal: true,
      }) ?? undefined;
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
  try {
    const claimedIds = readSessionOutbound(location, (mailbox) => mailbox.listProcessingClaimedMessageIds());
    if (claimedIds) {
      claimed = claimedIds.includes(live.id);
      outboundReadable = true;
    }
  } catch {
    outboundReadable = false;
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
      live,
      health,
      kind,
      claimed,
      processAfterMs,
    },
  };
}

/**
 * Run one mutation against the target's inbound mailbox.
 *
 * Existing-only by construction: `resolveTarget` has already proved the file
 * is there and 503'd if not, so `undefined` here means the session vanished
 * between the gate and the write. That collapses to 0 touched, which every
 * caller already answers with the same 409 stale_key the pre-seam open's
 * throw produced.
 */
function withMutationSession(t: ResolvedTarget, action: (mailbox: NanoclawMailboxSession) => number): Promise<number> {
  return withExistingMailboxSession(t.agentGroupId, t.sessionId, action).then((touched) => touched ?? 0);
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

/**
 * Next future cron occurrence (canonical parse — byte-identical to
 * recurrence.ts:31). `tz` is the OWNING group's effective timezone: the
 * firing path re-arms in it, so a dashboard edit that armed the first fire on
 * the install grid would land the series one slot off until the next re-arm.
 */
function nextSlot(cron: string, afterMs: number, tz: string = TIMEZONE): string {
  const it = CronExpressionParser.parse(cron, { tz, currentDate: new Date(afterMs) });
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
    update.processAfter = nextSlot(body.cron, nowMs, resolveGroupTimezone(t.agentGroupId));
  }

  // Existing-only: a mutation must never provision the session it edits
  // (invariant I-10). `undefined` reads as "nothing was touched", which the
  // stale-key branch below already answers — the same 409 the pre-seam open
  // produced for a session that vanished under the gate.
  const touched = await withMutationSession(t, (mailbox) => mailbox.updateTask(t.seriesId, update));
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

  const touched = await withMutationSession(t, (mailbox) => mailbox.pauseTask(t.seriesId));
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

  const touched = await withMutationSession(t, (mailbox) => {
    // §4.7: recompute process_after to the next FUTURE slot BEFORE flipping to
    // pending (skip-don't-replay, D3) — a paused-past-its-slot series must not
    // fire immediately on resume.
    if (t.live.recurrence) {
      mailbox.updateTask(t.seriesId, {
        processAfter: nextSlot(t.live.recurrence, nowMs, resolveGroupTimezone(t.agentGroupId)),
      });
    }
    return mailbox.resumeTask(t.seriesId);
  });
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
  let admittedTarget = false;
  const touched = await withMutationSession(t, (mailbox) => {
    // keepScheduledFor: an early fire does not shift the schedule (§4.6), so the
    // occurrence is still FOR its original slot and must keep announcing that
    // slot to the agent. Only `process_after` moves to now.
    const n = mailbox.updateTask(t.seriesId, {
      processAfter: new Date(nowMs).toISOString(),
      keepScheduledFor: true,
    });
    if (n > 0) {
      admitDueTaskContexts(mailbox, t.agentGroupId, t.sessionId);
      admittedTarget = mailbox.taskPairIsAdmitted(t.live.id);
      if (!admittedTarget) {
        // Do not silently turn a failed run-now request into a later run-now.
        // Keep the row inert (updateTask already invalidated stale recall) but
        // restore its prior schedule so only the pre-existing fire remains.
        mailbox.restoreInertTaskSchedule(t.live.id, t.live.process_after);
      }
    }
    return n;
  });
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
    touched =
      (await withExistingMailboxSession(decoded.agentGroupId, decoded.sessionId, (mailbox) =>
        mailbox.cancelSeriesWithStrandClear(decoded.seriesId),
      )) ?? 0;
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
