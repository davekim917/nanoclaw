/**
 * Shared helpers for the Scheduled Tasks Board read and mutation APIs: the gate, audit writer, rate limiter, `:key`
 * codec and read-cache singleton each have exactly one home here.
 */
import { createHash } from 'crypto';
import path from 'path';

import { withCentralSync } from '../../db/central-lease.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { isOwner, isGlobalAdmin } from '../../modules/permissions/db/user-roles.js';
import type { ScheduledTaskRow } from '../../modules/mailbox/index.js';

/**
 * MIRRORS the private `SWEEP_INTERVAL_MS` in src/host-sweep.ts: the board's health and guard grace must use the
 * interval the sweep actually runs at, so both must change together.
 */
export const SWEEP_INTERVAL_MS = 60_000;

/** Owner or global admin only: `move/preview` reads vault secret NAMES, so scoped admins must not pass. */
export function canManageScheduled(userId: string): Promise<boolean> {
  return withCentralSync(() => isOwner(userId) || isGlobalAdmin(userId), 'canManageScheduled');
}

export interface AuditEntry {
  actor: string;
  action: string;
  agentGroupId: string;
  sessionId: string;
  seriesId: string;
  /** Previewed (512 chars) and hashed. */
  before?: string;
  /** Previewed (512 chars) and hashed. */
  after?: string;
  /** Hash-only: never previewed or stored verbatim. */
  scriptBefore?: string;
  scriptAfter?: string;
  /**
   * For a `move` audit, `secretGains`/`secretLosses` are NAMES that writeAudit converts to counts and DROPS
   * (persisting names would reopen the enumeration hole). `move_intent` alone may persist a verbatim `snapshot`,
   * purged on resolve.
   */
  detail?: Record<string, unknown>;
  correlationId?: string;
}

const PREVIEW_CAP = 512;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function buildDetailJson(e: AuditEntry): string | null {
  const detail: Record<string, unknown> = { ...(e.detail ?? {}) };

  // Counts only, NEVER names, for every action including move_intent.
  if (Array.isArray(detail.secretGains)) {
    detail.secretGainsCount = (detail.secretGains as unknown[]).length;
    delete detail.secretGains;
  }
  if (Array.isArray(detail.secretLosses)) {
    detail.secretLossesCount = (detail.secretLosses as unknown[]).length;
    delete detail.secretLosses;
  }

  if (e.scriptBefore !== undefined) detail.scriptBeforeHash = sha256(e.scriptBefore);
  if (e.scriptAfter !== undefined) detail.scriptAfterHash = sha256(e.scriptAfter);

  if (Object.keys(detail).length === 0) return null;
  return JSON.stringify(detail);
}

export async function writeAudit(e: AuditEntry): Promise<void> {
  const beforeHash = e.before !== undefined ? sha256(e.before) : null;
  const afterHash = e.after !== undefined ? sha256(e.after) : null;
  // A script-only edit must still leave a provable after_hash.
  const afterHashOrScript = afterHash ?? (e.scriptAfter !== undefined ? sha256(e.scriptAfter) : null);
  const beforeHashOrScript = beforeHash ?? (e.scriptBefore !== undefined ? sha256(e.scriptBefore) : null);

  const beforePreview = e.before !== undefined ? e.before.slice(0, PREVIEW_CAP) : null;
  const afterPreview = e.after !== undefined ? e.after.slice(0, PREVIEW_CAP) : null;
  const beforeLen = e.before !== undefined ? e.before.length : null;
  const afterLen = e.after !== undefined ? e.after.length : null;

  await getDb().run(
    `INSERT INTO scheduled_audit
       (ts, actor, action, agent_group_id, session_id, series_id,
        before_hash, after_hash, before_preview, after_preview, before_len, after_len,
        detail_json, correlation_id)
     VALUES (@ts, @actor, @action, @agentGroupId, @sessionId, @seriesId,
        @beforeHash, @afterHash, @beforePreview, @afterPreview, @beforeLen, @afterLen,
        @detailJson, @correlationId)`,
    {
      // Explicit ISO, not the column's naive `datetime('now')` default.
      ts: new Date().toISOString(),
      actor: e.actor,
      action: e.action,
      agentGroupId: e.agentGroupId,
      sessionId: e.sessionId,
      seriesId: e.seriesId,
      beforeHash: beforeHashOrScript,
      afterHash: afterHashOrScript,
      beforePreview,
      afterPreview,
      beforeLen,
      afterLen,
      detailJson: buildDetailJson(e),
      correlationId: e.correlationId ?? null,
    },
  );
}

/**
 * Resolves a move_intent (or move_restore_failed) row: nulls the plaintext snapshot and stamps resolved_at in one
 * statement. Idempotent.
 */
/**
 * Does an unresolved move intent still name this session?
 * Between a move's source cancel and target insert, the source session has zero live task rows, which is what
 * spent-task-session GC collects. If GC closes it first, the repair can never restore into it and the series stays
 * cancelled forever, so the GC asks first.
 * FAIL-CLOSED, unlike `recoverMoveIntents`' read of the same table: here the consequence of a wrong "no" is
 * destroying the session, so an unknown answer blocks the close.
 */
export async function hasUnresolvedMoveIntent(sessionId: string): Promise<boolean> {
  try {
    const row = await getDb().get(
      `SELECT 1 AS present FROM scheduled_audit
          WHERE action = 'move_intent' AND resolved_at IS NULL AND session_id = ?
          LIMIT 1`,
      sessionId,
    );
    return row !== undefined;
  } catch (err) {
    log.warn('Could not read move intents before closing a spent task session — keeping it open', {
      sessionId,
      err,
    });
    return true;
  }
}

export async function purgeIntentBody(correlationId: string): Promise<void> {
  await getDb().run(
    'UPDATE scheduled_audit SET detail_json = NULL, resolved_at = ? WHERE correlation_id = ?',
    new Date().toISOString(),
    correlationId,
  );
}

// Per-(user, verb) sliding window for the two verbs that turn a keypress into container compute.

interface RateWindow {
  count: number;
  windowStart: number;
}

const scheduledRateLimitMap = new Map<string, RateWindow>();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAP_SOFT_CAP = 1024;

function sweepExpiredRateWindows(now: number): void {
  for (const [key, entry] of scheduledRateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      scheduledRateLimitMap.delete(key);
    }
  }
}

export function rateLimit(userId: string, verb: 'run_now' | 'move'): { ok: boolean; retryAfter?: number } {
  const now = Date.now();
  if (scheduledRateLimitMap.size > RATE_LIMIT_MAP_SOFT_CAP) {
    sweepExpiredRateWindows(now);
  }
  const key = `${userId}:${verb}`;
  const entry = scheduledRateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    scheduledRateLimitMap.set(key, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { ok: false, retryAfter: Math.max(1, retryAfter) };
  }
  entry.count++;
  return { ok: true };
}

export function _resetScheduledRateLimitForTesting(): void {
  scheduledRateLimitMap.clear();
}

// base64url of `agentGroupId/sessionId/seriesId`. A LOCATOR, never authorization: handlers re-resolve and re-check
// scope server-side. decodeKey returns null (never throws) on malformed input.

export function encodeKey(agentGroupId: string, sessionId: string, seriesId: string): string {
  return Buffer.from(`${agentGroupId}/${sessionId}/${seriesId}`, 'utf8').toString('base64url');
}

export function decodeKey(key: string): { agentGroupId: string; sessionId: string; seriesId: string } | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(key, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // agentGroupId and sessionId never contain '/', so splitting on the first two delimiters round-trips a seriesId
  // that does.
  const first = decoded.indexOf('/');
  if (first <= 0) return null;
  const second = decoded.indexOf('/', first + 1);
  if (second < 0) return null;
  const agentGroupId = decoded.slice(0, first);
  const sessionId = decoded.slice(first + 1, second);
  const seriesId = decoded.slice(second + 1);
  if (!agentGroupId || !sessionId || !seriesId) return null;
  // agentGroupId and sessionId build a filesystem path, so '.', '..', '\' and NUL must be rejected or a crafted key
  // escapes the session tree.
  for (const seg of [agentGroupId, sessionId]) {
    if (seg === '.' || seg === '..') return null;
    if (seg.includes('\\') || seg.includes('\0')) return null;
  }
  // seriesId is only ever a bound SQL parameter, so an internal '/' is harmless.
  if (seriesId === '.' || seriesId === '..' || seriesId.includes('\0')) return null;
  return { agentGroupId, sessionId, seriesId };
}

/**
 * The inbound.db path for a locator, only if it resolves to exactly `<dataDir>/v2-sessions/<ag>/<sess>/inbound.db`
 * inside the base; otherwise null. Every board handler opens through here, so a caller that skips the codec guard
 * still cannot escape.
 */
export function sessionInboundPathFor(dataDir: string, agentGroupId: string, sessionId: string): string | null {
  const base = path.resolve(dataDir, 'v2-sessions');
  const p = path.resolve(base, agentGroupId, sessionId, 'inbound.db');
  const expected = path.join(base, agentGroupId, sessionId, 'inbound.db');
  return p === expected && p.startsWith(base + path.sep) ? p : null;
}

// 5s TTL plus a generation counter: a mutation bumps `gen` and clears `data`; an assembly refuses to populate the
// cache if `gen` advanced since it started. Lives here so any mutation can invalidate without importing the read
// layer.

/** Opaque here so the cache needs no import of the read assembly. */
export type ScheduledSnapshot = Record<string, unknown>;

interface ScheduledCache {
  gen: number;
  data: ScheduledSnapshot | null;
  expiresMs: number;
}

const scheduledCache: ScheduledCache = { gen: 0, data: null, expiresMs: 0 };

export function getScheduledCache(): ScheduledCache {
  return scheduledCache;
}

export function invalidateScheduledCache(): void {
  scheduledCache.gen += 1;
  scheduledCache.data = null;
  scheduledCache.expiresMs = 0;
}

// The single module-owned series registry, shared by the read badge and the mutation reseed warning.

const MODULE_PREFIXES: Array<{ prefix: string; owner: string }> = [
  { prefix: 'memory-synth-', owner: 'memory' },
  { prefix: 'memory-lint-', owner: 'memory' },
];

const MODULE_STATIC: Record<string, string> = {
  // Static map for any non-prefixed module series. Empty against the current
  // fleet; extend here if a future module series doesn't carry a known prefix.
};

export function moduleOwner(seriesId: string): { moduleOwned: boolean; owner?: string } {
  for (const { prefix, owner } of MODULE_PREFIXES) {
    if (seriesId.startsWith(prefix)) return { moduleOwned: true, owner };
  }
  const staticOwner = MODULE_STATIC[seriesId];
  if (staticOwner) return { moduleOwned: true, owner: staticOwner };
  return { moduleOwned: false };
}

/** Named, not aliased, so adding a column to the read does not silently widen what counts as "changed". */
export type ApprovedTaskRow = Pick<
  ScheduledTaskRow,
  | 'id'
  | 'seq'
  | 'status'
  | 'trigger'
  | 'process_after'
  | 'scheduled_for'
  | 'recurrence'
  | 'series_id'
  | 'platform_id'
  | 'channel_type'
  | 'thread_id'
>;

const APPROVAL_FIELDS = [
  'id',
  'seq',
  'status',
  'trigger',
  'process_after',
  'scheduled_for',
  'recurrence',
  'series_id',
  'platform_id',
  'channel_type',
  'thread_id',
] as const satisfies ReadonlyArray<keyof ApprovedTaskRow>;

/**
 * The first field that differs from the approved row, or null. An id check is not enough: admission mutates a row in
 * place (a concurrent run-now flips `trigger` and moves `process_after` with id and status unchanged), and every
 * board writer acquires its mailbox asynchronously. `content` is deliberately not compared: some verbs exist to edit
 * it.
 */
export function approvedRowChanged(approved: ApprovedTaskRow, current: ApprovedTaskRow): string | null {
  for (const field of APPROVAL_FIELDS) {
    if (approved[field] !== current[field]) return field;
  }
  return null;
}
