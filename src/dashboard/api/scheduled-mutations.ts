/**
 * Scheduled Tasks Board simple mutations: edit, pause, resume, run-now, cancel.
 * Shared contract: canManageScheduled gate (non-manage or out-of-scope → 404, never 403), malformed key → 400,
 * unreadable session inbound.db → 503 `session_unreadable`, verbVerdict as the ONLY guard source, writeAudit, a
 * `session_event` SSE frame with a non-null agent_group_id, then invalidateScheduledCache.
 */
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { DATA_DIR, TIMEZONE } from '../../config.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { withCentralSync } from '../../db/central-lease.js';
import { getSession, QuietInvalidationError, withQuietInvalidationSync } from '../../db/sessions.js';
import {
  readSessionInbound,
  readSessionOutbound,
  type NanoclawMailboxSession,
  type ScheduledTaskRow,
  type SessionReadLocation,
} from '../../modules/mailbox/index.js';
import { requestWake } from '../../request-wake.js';
import { admitDueTaskContextsFor, resolveRecallCentral, withExistingMailboxSession } from '../../session-manager.js';
import { log } from '../../log.js';
import { parseUtcTimestampMs } from '../../thread-context.js';
import { emitDashboardEvent } from './events.js';
import { verbVerdict, type HealthState, type SeriesKind, type Verb } from './scheduled-board-matrix.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';
import {
  canManageScheduled,
  decodeKey,
  invalidateScheduledCache,
  rateLimit,
  sessionInboundPathFor,
  writeAudit,
  approvedRowChanged,
} from './scheduled-shared.js';

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
 * Decode, gate, read the live row and derive the health state verbVerdict needs. Returns a Response on any reject
 * (404/400/503/409).
 */
async function resolveTarget(
  key: string,
  ctx: AuthedRequestContext,
  nowMs: number,
  dataDir: string,
): Promise<{ error: Response } | { ok: ResolvedTarget }> {
  const decoded = decodeKey(key);
  if (!decoded) return { error: json({ error: 'bad_key' }, 400) };

  if (!(await canManageScheduled(ctx.user.id))) return { error: json({ error: 'not_found' }, 404) };
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(decoded.agentGroupId)) {
    return { error: json({ error: 'not_found' }, 404) };
  }

  // Containment-checked path (defense in depth; decodeKey already rejects traversal); null → 404, never an open
  // outside data/v2-sessions.
  const inboundPath = sessionInboundPathFor(dataDir, decoded.agentGroupId, decoded.sessionId);
  if (!inboundPath) return { error: json({ error: 'not_found' }, 404) };
  if (!fs.existsSync(inboundPath))
    return { error: json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503) };

  const location: SessionReadLocation = { dataDir, agentGroupId: decoded.agentGroupId, sessionId: decoded.sessionId };
  let live: LiveRow | undefined;
  try {
    // Read-only seam: the gate must not provision or migrate the session. The 5s busy_timeout lets a contended
    // session wait instead of 503-ing an edit, and the hot-journal rollback keeps a SIGKILLed container's session
    // from answering every gate with 503.
    live =
      readSessionInbound(location, (mailbox) => mailbox.getLiveTaskRow(decoded.seriesId), {
        busyTimeoutMs: 5000,
        recoverJournal: true,
      }) ?? undefined;
  } catch (err) {
    log.warn('scheduled-mutations: inbound read failed', { err: err instanceof Error ? err.message : String(err) });
    return { error: json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503) };
  }

  // The series ended or moved since the list.
  if (!live) return { error: json({ error: 'stale_key', reason: 'stale_key' }, 409) };

  // Absent/unreadable outbound + overdue → unknown, never silently not-claimed.
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

  const { health, kind, processAfterMs } = gateStateFor(live, claimed, outboundReadable, nowMs);

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
 * The inputs `verbVerdict` reads. Shared by the preflight in `resolveTarget` and the re-proof in
 * `withMutationSession`, which MUST agree.
 */
function gateStateFor(
  live: LiveRow,
  claimed: boolean,
  outboundReadable: boolean,
  nowMs: number,
): { health: HealthState; kind: SeriesKind; processAfterMs: number | null } {
  const processAfterMs = parseUtcTimestampMs(live.process_after);
  const overdue = processAfterMs !== null && processAfterMs <= nowMs;
  let health: HealthState;
  if (live.status === 'paused') health = 'paused';
  else if (claimed) health = 'processing';
  else if (!outboundReadable && overdue) health = 'unknown';
  else if (overdue) health = 'late';
  else health = 'healthy';
  const kind: SeriesKind = live.recurrence ? (live.thread_id ? 'thread_loop' : 'recurring') : 'one_off';
  return { health, kind, processAfterMs };
}

type MutationOutcome = { touched: number } | { refused: Response };

/**
 * Runs one mutation, re-proving the verdict against the row the write will land on.
 * The gate's reads happen before an async mailbox acquisition, and in that window another request can resume the row,
 * a container can claim it, or recurrence can arm a successor; the task ops key on the series, so the write would
 * succeed against something the operator never saw. So the verdict runs again inside the session from fresh reads,
 * with nothing awaited between read and write. A changed identity refuses as `stale_key`; a changed state refuses
 * with that verb's own verdict.
 * `undefined` (the session vanished) collapses to 0 touched → 409. The claim read is fail-closed: a
 * present-but-unopenable outbound.db is `outboundReadable: false`, never "unclaimed".
 */
async function withMutationSession(
  t: ResolvedTarget,
  verb: Verb,
  nowMs: number,
  action: (mailbox: NanoclawMailboxSession) => number,
  verdictCtx?: { forced?: boolean },
): Promise<MutationOutcome> {
  // The re-proof and the write are ONE synchronous block under the central lease; the quiet-mark invalidation inside
  // it is a raw central write.
  const outcome = await withExistingMailboxSession(t.agentGroupId, t.sessionId, (mailbox) =>
    withCentralSync(() => {
      const live = mailbox.getLiveTaskRow(t.seriesId);
      // No live row, a different one, or the same one rewritten underneath: admission mutates a row in place (a
      // run-now flips `trigger` and moves `process_after`), so the id alone would miss the third.
      const changed = live ? approvedRowChanged(t.live, live) : 'row';
      if (!live || changed) {
        log.warn('scheduled-mutations: the approved row is no longer the one to act on — refusing', {
          verb,
          seriesId: t.seriesId,
          approvedRowId: t.live.id,
          liveRowId: live?.id ?? null,
          field: changed,
        });
        return { refused: json({ error: 'stale_key', reason: 'stale_key' }, 409) };
      }

      // Fail-closed like the preflight: a present-but-unopenable outbound.db throws, which is "unreadable", not
      // "unclaimed".
      let claim: { claimed: boolean; outboundReadable: boolean };
      try {
        claim = {
          claimed: mailbox.getProcessingClaimRows().some((c) => c.message_id === live.id),
          outboundReadable: true,
        };
      } catch {
        claim = { claimed: false, outboundReadable: false };
      }
      const { claimed } = claim;

      const fresh = gateStateFor(live, claimed, claim.outboundReadable, nowMs);
      const verdict = verbVerdict(verb, {
        state: fresh.health,
        kind: fresh.kind,
        claimed,
        processAfterMs: fresh.processAfterMs,
        nowMs,
        ...(verdictCtx?.forced === undefined ? {} : { forced: verdictCtx.forced }),
      });
      if (!verdict.allowed) {
        log.warn('scheduled-mutations: the approved verdict no longer holds — refusing', {
          verb,
          seriesId: t.seriesId,
          rowId: live.id,
          was: t.health,
          now: fresh.health,
          reason: verdict.reason,
        });
        return { refused: verdictResponse(verdict) };
      }

      // The quiet-mark invalidation sits here, after the re-proof and in the same synchronous turn as the write it
      // protects. It throws `QuietInvalidationError`, which `mutateWithInvalidation` maps to 503.
      return { touched: withQuietInvalidationSync(t.sessionId, () => action(mailbox)) };
    }, `scheduled ${verb}`),
  );
  return outcome ?? { touched: 0 };
}

/** Post-mutation SSE frame (non-null agent_group_id) and cache invalidation; success paths only. */
function afterMutation(agentGroupId: string, sessionId: string): void {
  try {
    emitDashboardEvent('session_event', { session_id: sessionId, agent_group_id: agentGroupId, kind: 'inbound' });
  } catch {
    /* non-fatal */
  }
  invalidateScheduledCache();
}

/**
 * Runs one mutation with its quiet-mark invalidation (see `withMutationSession`) and maps a refused invalidation to
 * 503.
 * A cron edit or resume recomputes `process_after` in the session DB, which the sweep's persisted quiet cache cannot
 * see; without the invalidation a quiet session sleeps past its new due time. FAIL-CLOSED: a refused invalidation
 * (including no ACTIVE session row) gets a 503 and NO write.
 */
async function mutateWithInvalidation(
  t: ResolvedTarget,
  verb: Verb,
  nowMs: number,
  action: (mailbox: NanoclawMailboxSession) => number,
  verdictCtx?: { forced?: boolean },
): Promise<MutationOutcome> {
  try {
    return await withMutationSession(t, verb, nowMs, action, verdictCtx);
  } catch (err) {
    const refused = quietRefusal(t.sessionId, err);
    if (refused) return { refused };
    throw err;
  }
}

function quietRefusal(sessionId: string, err: unknown): Response | null {
  if (!(err instanceof QuietInvalidationError)) return null;
  log.warn('scheduled-mutations: quiet-mark invalidation failed — mutation refused', {
    sessionId,
    err: err.message,
  });
  return json({ error: 'invalidation_failed', reason: 'invalidation_failed' }, 503);
}

/**
 * Next future cron occurrence, parsed exactly as recurrence.ts does. `tz` must be the OWNING group's timezone: the
 * firing path re-arms in it, so arming on the install grid lands the series one slot off.
 */
function nextSlot(cron: string, afterMs: number, tz: string = TIMEZONE): string {
  const it = CronExpressionParser.parse(cron, { tz, currentDate: new Date(afterMs) });
  return it.next().toDate().toISOString();
}

/** Firing-path parser plus a finite-interval check. */
function cronIsValid(cron: unknown): boolean {
  // cron-parser ACCEPTS null/undefined/'' as "* * * * *", which would turn a series into a runaway per-minute loop,
  // so non-strings and blank strings are rejected here.
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

const PROMPT_MAX = 8000;
const SCRIPT_MAX = 4000;

export const editHandler: AuthHandler = async (req, params, ctx) => {
  const { dataDir, nowMs } = mutationOpts();
  // `unknown` at the boundary so the type guards below are real: a non-string must be rejected, not narrowed away and
  // merged into live content.
  let body: { prompt?: unknown; script?: unknown; cron?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  const r = await resolveTarget(params['key'] ?? '', ctx, nowMs, dataDir);
  if ('error' in r) return r.error;
  const t = r.ok;

  // Reject non-string prompt/script/cron BEFORE any length check or write: a non-string corrupts the row's JSON
  // content, and a null cron would pass cron-parser as "* * * * *".
  if (body.prompt !== undefined && typeof body.prompt !== 'string') return json({ error: 'invalid_request' }, 400);
  if (body.script !== undefined && typeof body.script !== 'string') return json({ error: 'invalid_request' }, 400);
  if (body.cron !== undefined && typeof body.cron !== 'string') return json({ error: 'invalid_request' }, 400);

  if (body.prompt !== undefined && body.prompt.length > PROMPT_MAX) return json({ error: 'too_long' }, 400);
  if (body.script !== undefined && body.script.length > SCRIPT_MAX) return json({ error: 'too_long' }, 400);
  // Never silently accept an invalid cron: it would create a strand.
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

  // A cron edit recomputes process_after to the next occurrence.
  const update: { prompt?: string; script?: string; recurrence?: string; processAfter?: string } = {};
  if (body.prompt !== undefined) update.prompt = body.prompt;
  if (body.script !== undefined) update.script = body.script;
  if (body.cron !== undefined) {
    update.recurrence = body.cron;
    update.processAfter = nextSlot(body.cron, nowMs, await resolveGroupTimezone(t.agentGroupId));
  }

  // Existing-only: a mutation must never provision the session it edits; `undefined` reads as nothing touched → 409.
  const outcome = await mutateWithInvalidation(t, 'edit', nowMs, (mailbox) => mailbox.updateTask(t.seriesId, update));
  if ('refused' in outcome) return outcome.refused;
  if (outcome.touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  await writeAudit({
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

export const pauseHandler: AuthHandler = async (_req, params, ctx) => {
  const { dataDir, nowMs } = mutationOpts();
  const r = await resolveTarget(params['key'] ?? '', ctx, nowMs, dataDir);
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

  const outcome = await mutateWithInvalidation(t, 'pause', nowMs, (mailbox) => mailbox.pauseTask(t.seriesId));
  if ('refused' in outcome) return outcome.refused;
  if (outcome.touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  await writeAudit({
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
  const r = await resolveTarget(params['key'] ?? '', ctx, nowMs, dataDir);
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

  // Resolved before the session so the mutation action stays one synchronous block from verdict to writes.
  const timezone = t.live.recurrence ? await resolveGroupTimezone(t.agentGroupId) : null;
  const outcome = await mutateWithInvalidation(t, 'resume', nowMs, (mailbox) => {
    // Recompute process_after to the next FUTURE slot BEFORE flipping to pending (skip, don't replay): a series
    // paused past its slot must not fire immediately on resume.
    if (t.live.recurrence && timezone !== null) {
      mailbox.updateTask(t.seriesId, {
        processAfter: nextSlot(t.live.recurrence, nowMs, timezone),
      });
    }
    return mailbox.resumeTask(t.seriesId);
  });
  if ('refused' in outcome) return outcome.refused;
  if (outcome.touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  await writeAudit({
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

  const r = await resolveTarget(params['key'] ?? '', ctx, nowMs, dataDir);
  if ('error' in r) return r.error;
  const t = r.ok;

  // Run-now turns a keypress into container compute.
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

  // An early fire does not shift the schedule; recurrence advances normally on completion.
  let admittedTarget = false;
  // Read before the session so the action proves its verdict and mutates in one synchronous block.
  const recallCentral = await resolveRecallCentral(t.agentGroupId, t.sessionId);
  const outcome = await mutateWithInvalidation(
    t,
    'run_now',
    nowMs,
    (mailbox) => {
      // The occurrence is still FOR its original slot and must keep announcing it; only `process_after` moves.
      const n = mailbox.updateTask(t.seriesId, {
        processAfter: new Date(nowMs).toISOString(),
        keepScheduledFor: true,
      });
      if (n > 0) {
        admitDueTaskContextsFor(mailbox, t.agentGroupId, t.sessionId, recallCentral);
        admittedTarget = mailbox.taskPairIsAdmitted(t.live.id);
        if (!admittedTarget) {
          // Do not turn a failed run-now into a later run-now: keep the row inert and restore its prior schedule.
          mailbox.restoreInertTaskSchedule(t.live.id, t.live.process_after);
        }
      }
      return n;
    },
    { forced: body.force === true },
  );
  if ('refused' in outcome) return outcome.refused;
  if (outcome.touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);
  if (!admittedTarget) {
    return json(
      {
        error: 'context_admission_failed',
        reason: 'Fresh context could not be admitted; the task remains inert and was not fired.',
      },
      503,
    );
  }

  const session = await getSession(t.sessionId);
  if (session) {
    void requestWake(session, 'due-message').catch((err) =>
      log.warn('scheduled-mutations: run-now wake failed', { err }),
    );
  }

  await writeAudit({
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

export const cancelHandler: AuthHandler = async (_req, params, ctx) => {
  const { dataDir, nowMs } = mutationOpts();

  // Cancel is reachable on a pure strand (a terminal recurrence-set row with no live row), so it skips
  // resolveTarget's live-row requirement; the touched count includes terminal clears.
  const decoded = decodeKey(params['key'] ?? '');
  if (!decoded) return json({ error: 'bad_key' }, 400);
  if (!(await canManageScheduled(ctx.user.id))) return json({ error: 'not_found' }, 404);
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(decoded.agentGroupId)) {
    return json({ error: 'not_found' }, 404);
  }

  const inboundPath = sessionInboundPathFor(dataDir, decoded.agentGroupId, decoded.sessionId);
  if (!inboundPath) return json({ error: 'not_found' }, 404);
  if (!fs.existsSync(inboundPath)) return json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503);

  // Cancel has no ResolvedTarget, so it opens the mailbox itself and maps the same refusal.
  let touched: number;
  try {
    touched =
      (await withExistingMailboxSession(decoded.agentGroupId, decoded.sessionId, (mailbox) =>
        withCentralSync(
          () =>
            withQuietInvalidationSync(decoded.sessionId, () => mailbox.cancelSeriesWithStrandClear(decoded.seriesId)),
          'scheduled cancel',
        ),
      )) ?? 0;
  } catch (err) {
    const refused = quietRefusal(decoded.sessionId, err);
    if (refused) return refused;
    log.warn('scheduled-mutations: cancel failed', { err: err instanceof Error ? err.message : String(err) });
    return json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503);
  }
  // Nothing live and no terminal recurrence to clear.
  if (touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  await writeAudit({
    actor: ctx.user.id,
    action: 'cancel',
    agentGroupId: decoded.agentGroupId,
    sessionId: decoded.sessionId,
    seriesId: decoded.seriesId,
  });
  afterMutation(decoded.agentGroupId, decoded.sessionId);
  void nowMs;
  return json({ cancelled: true });
};
