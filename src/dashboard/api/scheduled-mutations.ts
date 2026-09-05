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
// 5c deferral (seam 3, deployer call 2026-09-05): every getRawDb() call in
// this file feeds writeAudit (scheduled-shared.ts), which is also called
// from src/modules/sweep-scheduled-move/index.ts (PR 5b's file) — §4.2
// cannot be honored split across two parallel PRs. A follow-up "5c" PR
// converts writeAudit/purgeIntentBody together with every caller (this
// file, scheduled-move.ts, cli/resources/tasks.ts, and the
// sweep-scheduled-move helpers) once 5a and 5b are both merged. Nothing in
// this file was changed by seam 3 PR 5a for that reason.
import { getRawDb } from '../../db/connection.js';
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
 * The gate's derived state for one live row — the inputs `verbVerdict` reads.
 *
 * One function, two callers: the preflight in `resolveTarget` and the
 * re-proof inside `withMutationSession`. They MUST agree, because the second
 * exists to re-run the first's decision against fresher facts; two copies of
 * these five lines would drift and the re-proof would start refusing (or
 * allowing) things the preflight did not.
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

/** What a mutation produced: a touched-count, or the refusal to return verbatim. */
type MutationOutcome = { touched: number } | { refused: Response };

/**
 * Run one mutation against the target's inbound mailbox, re-proving the
 * verdict against the row the write will actually land on.
 *
 * Existing-only by construction: `resolveTarget` has already proved the file
 * is there and 503'd if not, so `undefined` here means the session vanished
 * between the gate and the write. That collapses to 0 touched, which every
 * caller already answers with the same 409 stale_key the pre-seam open's
 * throw produced.
 *
 * THE RE-PROOF. `resolveTarget` reads the live row, the claim and the health
 * state, and `verbVerdict` approves the verb from them — all before this
 * function's `await`. Before the seam that was safe: the gate and the write
 * were one synchronous run, so nothing could move between them. Acquiring a
 * mailbox is asynchronous now, and in that window another request can resume
 * the paused row this one approved, a container can claim it, or the
 * occurrence can complete and recurrence can arm a successor. The task ops
 * key on the SERIES and its live status, not on the row that was approved, so
 * every one of those writes lands and reports success against something the
 * operator never saw.
 *
 * So the same verdict runs again here, inside the session, from a fresh read
 * of the same three facts, with nothing awaited between the read and the
 * write. A row that changed identity refuses as `stale_key` — the answer a
 * genuinely stale key already gets. A row whose STATE moved (resumed,
 * claimed, now overdue) refuses with that verb's own verdict, the same shape
 * the preflight would have returned had it seen this state first.
 *
 * The claim read is fail-closed on purpose: `getProcessingClaimRows` degrades
 * to empty only when `outbound.db` is genuinely absent, and throws when it is
 * present but unopenable. That throw becomes `outboundReadable: false`, which
 * is exactly what the preflight does with the same condition (F6 — never
 * silently not-claimed), and the verdict decides from there rather than this
 * function inventing a policy of its own.
 */
async function withMutationSession(
  t: ResolvedTarget,
  verb: Verb,
  nowMs: number,
  action: (mailbox: NanoclawMailboxSession) => number,
  verdictCtx?: { forced?: boolean },
): Promise<MutationOutcome> {
  // The re-proof and the write are ONE synchronous block under the central
  // lease (`withCentralSync`): the quiet-mark invalidation inside it is a raw
  // central write (seam 3 §4.5 I-1), and nothing yields between the verdict
  // and the statement it protects.
  const outcome = await withExistingMailboxSession(t.agentGroupId, t.sessionId, (mailbox) =>
    withCentralSync(() => {
      const live = mailbox.getLiveTaskRow(t.seriesId);
      // No live row, a DIFFERENT one, or the SAME one rewritten underneath us.
      // The id alone would miss the third: admission mutates a row in place, so
      // a concurrent run-now flips `trigger` and moves `process_after` while the
      // id and the status stay put. `approvedRowChanged` is shared with the
      // board move, which needs the same proof for the same reason.
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

      // Fail-closed exactly as the preflight does: `getProcessingClaimRows`
      // degrades to empty only when outbound.db is genuinely absent, and throws
      // when it is present but unopenable. That throw is "unreadable", not
      // "unclaimed" (F6), and the verdict decides what to do about it.
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

      // The quiet-mark invalidation sits HERE: inside the session, after the
      // re-proof above, in the same synchronous turn as the statement it
      // protects. Outside the callback, `withExistingMailboxSession`'s await
      // would sit between the invalidation and the row (Codex round 3, H1), and
      // ahead of the re-proof it would charge a session whose verdict then
      // refuses. It throws `QuietInvalidationError`, which
      // `mutateWithInvalidation` maps to the 503 this surface owes.
      return { touched: withQuietInvalidationSync(t.sessionId, () => action(mailbox)) };
    }, `scheduled ${verb}`),
  );
  return outcome ?? { touched: 0 };
}

/**
 * Emit the post-mutation SSE frame (non-null agent_group_id) + invalidate cache.
 *
 * The quiet-mark invalidation this used to also do here now sits immediately
 * before the write itself, inside `withMutationSession`'s mailbox callback:
 * the session DB and the central DB are two separate files with no shared
 * transaction, so the mark has to die first (Codex pre-pass,
 * review/b3/review.json Part C) and in the same synchronous turn as the
 * statement (round 3, H1). This function still runs after the write and only on
 * the success paths — the SSE frame and the cache both describe what already
 * happened, so there is nothing to gain by moving them earlier.
 */
function afterMutation(agentGroupId: string, sessionId: string): void {
  try {
    emitDashboardEvent('session_event', { session_id: sessionId, agent_group_id: agentGroupId, kind: 'inbound' });
  } catch {
    /* non-fatal */
  }
  invalidateScheduledCache();
}

/**
 * Run one mutation with its quiet-mark invalidation immediately before it.
 *
 * The single due-ness-write entry for this module. `withQuietInvalidationSync`
 * runs INSIDE `withMutationSession`'s mailbox callback, after that function's
 * in-session re-proof and in the same synchronous turn as the statement it
 * protects — outside the callback, the funnel's await would sit between the
 * invalidation and the row (Codex round 3, H1). This wrapper adds only the
 * refusal mapping: the 503 this surface owes, rather than a throw at the router.
 *
 * A cron edit or a resume recomputes `process_after` straight in the session
 * DB, which the host sweep's quiet cache cannot see; without the invalidation a
 * quiet session sleeps past its new due time, and since S2-PR15 persists that
 * mark, across a restart too.
 *
 * FAIL-CLOSED (Codex round 2, H1): a central DB that refuses the invalidation —
 * including because no ACTIVE session row is there any more — gets a 503 and NO
 * write, not a silent success whose due-time change stays hidden behind a mark
 * nothing will clear. A 503 is retryable and visible; missed work is neither.
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

/** The 503 a refused quiet-mark invalidation owes, or null if `err` is something else. */
function quietRefusal(sessionId: string, err: unknown): Response | null {
  if (!(err instanceof QuietInvalidationError)) return null;
  log.warn('scheduled-mutations: quiet-mark invalidation failed — mutation refused', {
    sessionId,
    err: err.message,
  });
  return json({ error: 'invalidation_failed', reason: 'invalidation_failed' }, 503);
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
    update.processAfter = nextSlot(body.cron, nowMs, await resolveGroupTimezone(t.agentGroupId));
  }

  // Existing-only: a mutation must never provision the session it edits
  // (invariant I-10). `undefined` reads as "nothing was touched", which the
  // stale-key branch below already answers — the same 409 the pre-seam open
  // produced for a session that vanished under the gate.
  const outcome = await mutateWithInvalidation(t, 'edit', nowMs, (mailbox) => mailbox.updateTask(t.seriesId, update));
  if ('refused' in outcome) return outcome.refused;
  if (outcome.touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  writeAudit(getRawDb(), {
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

  const outcome = await mutateWithInvalidation(t, 'pause', nowMs, (mailbox) => mailbox.pauseTask(t.seriesId));
  if ('refused' in outcome) return outcome.refused;
  if (outcome.touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  writeAudit(getRawDb(), {
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

  // Resolved before the session so the mutation action stays one synchronous
  // block from its verdict to its writes.
  const timezone = t.live.recurrence ? await resolveGroupTimezone(t.agentGroupId) : null;
  const outcome = await mutateWithInvalidation(t, 'resume', nowMs, (mailbox) => {
    // §4.7: recompute process_after to the next FUTURE slot BEFORE flipping to
    // pending (skip-don't-replay, D3) — a paused-past-its-slot series must not
    // fire immediately on resume.
    if (t.live.recurrence && timezone !== null) {
      mailbox.updateTask(t.seriesId, {
        processAfter: nextSlot(t.live.recurrence, nowMs, timezone),
      });
    }
    return mailbox.resumeTask(t.seriesId);
  });
  if ('refused' in outcome) return outcome.refused;
  if (outcome.touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  writeAudit(getRawDb(), {
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
  // The recall's one central read, before the session: the mutation action
  // proves its verdict and mutates in one synchronous block.
  const recallCentral = await resolveRecallCentral(t.agentGroupId, t.sessionId);
  const outcome = await mutateWithInvalidation(
    t,
    'run_now',
    nowMs,
    (mailbox) => {
      // keepScheduledFor: an early fire does not shift the schedule (§4.6), so the
      // occurrence is still FOR its original slot and must keep announcing that
      // slot to the agent. Only `process_after` moves to now.
      const n = mailbox.updateTask(t.seriesId, {
        processAfter: new Date(nowMs).toISOString(),
        keepScheduledFor: true,
      });
      if (n > 0) {
        admitDueTaskContextsFor(mailbox, t.agentGroupId, t.sessionId, recallCentral);
        admittedTarget = mailbox.taskPairIsAdmitted(t.live.id);
        if (!admittedTarget) {
          // Do not silently turn a failed run-now request into a later run-now.
          // Keep the row inert (updateTask already invalidated stale recall) but
          // restore its prior schedule so only the pre-existing fire remains.
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

  writeAudit(getRawDb(), {
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

  // Cancel has no ResolvedTarget, so it opens the mailbox itself and calls the
  // same helper from inside the callback, mapping the same refusal.
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
  // touched 0 → nothing live AND no terminal recurrence to clear → stale key.
  if (touched === 0) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  writeAudit(getRawDb(), {
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
