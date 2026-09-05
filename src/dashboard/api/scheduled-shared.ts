/**
 * Shared host-side helpers for the Scheduled Tasks Board mutation/read APIs
 * (Task A6). Imported by the read layer (Group B), the simple mutations
 * (Group C), and the move flow (Group D) so the gate, audit writer, rate
 * limiter, `:key` codec, and read-cache singleton have exactly one home.
 *
 * See docs/specs/scheduled-tasks-board/design.md §3a, §4.4, §4.5.
 */
import { createHash } from 'crypto';
import path from 'path';

import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { isOwner, isGlobalAdmin } from '../../modules/permissions/db/user-roles.js';
import type { ScheduledTaskRow } from '../../modules/mailbox/index.js';

/**
 * Host sweep cadence. MIRRORS the private `SWEEP_INTERVAL_MS = 60_000` at
 * src/host-sweep.ts:90 — defined here as the board feature's single host-side
 * home for the constant so the verb×state matrix's `guard_grace` derivation
 * (scheduled-board-matrix.ts) and the health-grace math (scheduled-assembly.ts)
 * can import it without reaching across group ownership into host-sweep.ts.
 *
 * The board's health-grace and guard-grace math MUST use the same interval the
 * sweep actually runs at, so the two values are coupled: if anyone ever changes
 * the sweep cadence, BOTH src/host-sweep.ts:90 and this const must move together.
 */
export const SWEEP_INTERVAL_MS = 60_000;

// ── Mutation gate ─────────────────────────────────────────────────────────────

/**
 * The mutation tier gate (D7): owner OR global-admin only. Scoped admins and
 * members are excluded in v1 — `move/preview` reads vault secret NAMES and is
 * gated here, so a scoped-admin enumeration path never opens (§4.5). Mirrors
 * the `isOwner`/`isGlobalAdmin` precedent in dashboard/steer.ts.
 */
export function canManageScheduled(userId: string): boolean {
  return isOwner(userId) || isGlobalAdmin(userId);
}

// ── Audit writer ──────────────────────────────────────────────────────────────

export interface AuditEntry {
  actor: string;
  action: string;
  agentGroupId: string;
  sessionId: string;
  seriesId: string;
  /** Prompt body before the change — previewed (512 chars) + hashed. */
  before?: string;
  /** Prompt body after the change — previewed (512 chars) + hashed. */
  after?: string;
  /**
   * Pre-task script before/after an edit. Hash-only — never previewed or
   * stored verbatim (the standing privacy guarantee, §4.4). The hashes land in
   * detail_json as `scriptBeforeHash`/`scriptAfterHash`.
   */
  scriptBefore?: string;
  scriptAfter?: string;
  /**
   * Non-body structured detail (cron change, move source→target, secret-delta
   * COUNTS, etc.). For a `move` audit, pass `secretGains`/`secretLosses` as
   * arrays of NAMES — writeAudit converts them to counts and DROPS the names
   * (persisting names would re-open the §4.5 enumeration hole). For
   * `move_intent`, pass `snapshot` — the ONE row type allowed to persist a
   * verbatim body, purged on resolve (§4.2 2b / §4.4 F5).
   */
  detail?: Record<string, unknown>;
  correlationId?: string;
}

const PREVIEW_CAP = 512;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Build the detail_json payload: scrub secret NAMES into counts (for non-intent
 * rows), fold in script hashes, and preserve every other structured field.
 * `move_intent` rows keep their `snapshot` verbatim (the F5 exception).
 */
function buildDetailJson(e: AuditEntry): string | null {
  const detail: Record<string, unknown> = { ...(e.detail ?? {}) };

  // Secret-name scrubbing — counts + hashes only, NEVER names (§4.5). Applies
  // to every action EXCEPT nothing; even move_intent must not persist names.
  if (Array.isArray(detail.secretGains)) {
    detail.secretGainsCount = (detail.secretGains as unknown[]).length;
    delete detail.secretGains;
  }
  if (Array.isArray(detail.secretLosses)) {
    detail.secretLossesCount = (detail.secretLosses as unknown[]).length;
    delete detail.secretLosses;
  }

  // Scripts are hash-only.
  if (e.scriptBefore !== undefined) detail.scriptBeforeHash = sha256(e.scriptBefore);
  if (e.scriptAfter !== undefined) detail.scriptAfterHash = sha256(e.scriptAfter);

  if (Object.keys(detail).length === 0) return null;
  return JSON.stringify(detail);
}

/**
 * Write one audit row. Prompt bodies are hashed + previewed (≤512 chars);
 * scripts are hash-only; secret names never persist; `move_intent` rows carry
 * the verbatim snapshot in detail_json until purged on resolve. Central DB.
 */
export function writeAudit(db: Database.Database, e: AuditEntry): void {
  const beforeHash = e.before !== undefined ? sha256(e.before) : null;
  const afterHash = e.after !== undefined ? sha256(e.after) : null;
  // A script-only edit must still leave a provable after_hash even when the
  // prompt body is unchanged — fall back to the script hash for that column.
  const afterHashOrScript = afterHash ?? (e.scriptAfter !== undefined ? sha256(e.scriptAfter) : null);
  const beforeHashOrScript = beforeHash ?? (e.scriptBefore !== undefined ? sha256(e.scriptBefore) : null);

  const beforePreview = e.before !== undefined ? e.before.slice(0, PREVIEW_CAP) : null;
  const afterPreview = e.after !== undefined ? e.after.slice(0, PREVIEW_CAP) : null;
  const beforeLen = e.before !== undefined ? e.before.length : null;
  const afterLen = e.after !== undefined ? e.after.length : null;

  db.prepare(
    `INSERT INTO scheduled_audit
       (ts, actor, action, agent_group_id, session_id, series_id,
        before_hash, after_hash, before_preview, after_preview, before_len, after_len,
        detail_json, correlation_id)
     VALUES (@ts, @actor, @action, @agentGroupId, @sessionId, @seriesId,
        @beforeHash, @afterHash, @beforePreview, @afterPreview, @beforeLen, @afterLen,
        @detailJson, @correlationId)`,
  ).run({
    // Explicit ISO ts, not the column's `datetime('now')` default (CLAUDE.md
    // Timestamps rule — datetime('now') is naive UTC and gets misparsed as
    // local by `new Date()`; every downstream reader already tolerates the
    // 'Z'-suffixed form, e.g. scheduled-move.ts's tsMs parse).
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
  });
}

/**
 * Resolve a move_intent (or move_restore_failed) row: null the detail_json body
 * AND stamp resolved_at in one statement (§4.2 2b). The plaintext snapshot
 * lives only while the move is unresolved. Idempotent — re-running on an
 * already-resolved row is a harmless no-op.
 */
/**
 * Does an unresolved move intent still name this session?
 *
 * A move cancels the SOURCE series before it inserts into the target, so
 * between those two steps the source session holds zero live task rows — which
 * is exactly the state S19 (spent-task-session GC) collects. The recovery duty
 * that repairs a crashed move only acts on intents older than one sweep
 * interval, so on a stopped session S19 runs first and closes the row the
 * restore needs. Every later `withQuietInvalidationSync` then refuses (no
 * ACTIVE session row), the recovery's catch leaves the intent unresolved, and
 * the series stays cancelled forever — the one outcome no later pass repairs.
 *
 * So the GC asks first. One central-DB read per spent task session per tick,
 * against the table the intent already lives in.
 *
 * FAIL-CLOSED, unlike `recoverMoveIntents`' own read of the same table. That
 * one treats an unreadable `scheduled_audit` as "no intents" and returns,
 * which is right when the consequence is "repair nothing this tick". Here the
 * consequence is DESTROYING the session a repair would restore into, so an
 * unknown answer must block the close. The cost of being wrong that way is a
 * spent task session staying open and quiet for another tick; the cost of the
 * other way is unrecoverable.
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

export function purgeIntentBody(db: Database.Database, correlationId: string): void {
  // Explicit ISO, for the same reason the insert above already documents at the
  // `ts` field — this statement was writing the naive `datetime('now')` shape
  // into the very same table, contradicting that comment three lines up.
  db.prepare('UPDATE scheduled_audit SET detail_json = NULL, resolved_at = ? WHERE correlation_id = ?').run(
    new Date().toISOString(),
    correlationId,
  );
}

// ── Rate limit (run_now + move) ──────────────────────────────────────────────
// Reuses the steer.ts rateLimitMap shape: per-(user, verb) sliding window. The
// two verbs that convert a keypress into container compute (§4.5).

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

// ── `:key` locator codec ──────────────────────────────────────────────────────
// base64url of `agentGroupId / sessionId / seriesId`. A LOCATOR, never an authz
// input — every handler re-resolves the agent group from the decoded key and
// re-checks scope/role server-side (§4.5). decodeKey returns null (never
// throws) on malformed input so handlers map it to a clean 400.

export function encodeKey(agentGroupId: string, sessionId: string, seriesId: string): string {
  return Buffer.from(`${agentGroupId}/${sessionId}/${seriesId}`, 'utf8').toString('base64url');
}

export function decodeKey(key: string): { agentGroupId: string; sessionId: string; seriesId: string } | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  // base64url alphabet only — reject anything else up front.
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(key, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // Split into exactly three segments. agentGroupId and sessionId are slugs/
  // sess-ids that never contain '/', so splitting on the first two delimiters
  // round-trips even a seriesId that happens to contain one.
  const first = decoded.indexOf('/');
  if (first <= 0) return null;
  const second = decoded.indexOf('/', first + 1);
  if (second < 0) return null;
  const agentGroupId = decoded.slice(0, first);
  const sessionId = decoded.slice(first + 1, second);
  const seriesId = decoded.slice(second + 1);
  if (!agentGroupId || !sessionId || !seriesId) return null;
  // M4: reject path-traversal segments. agentGroupId and sessionId are the two
  // segments used to BUILD a filesystem path (v2-sessions/<ag>/<sess>/inbound.db);
  // a '.', '..', separator, or NUL char in either would let a crafted :key
  // escape the session tree. They can never contain a raw '/' (the codec split
  // on '/'), but a '\' or NUL still must be rejected.
  for (const seg of [agentGroupId, sessionId]) {
    if (seg === '.' || seg === '..') return null;
    if (seg.includes('\\') || seg.includes('\0')) return null;
  }
  // seriesId is ALWAYS used as a bound SQL parameter (series_id = ?), never as a
  // path component, so an internal '/' is a supported, harmless case (the codec
  // round-trips it). Still reject the structurally-invalid '.'/'..' whole-segment
  // and a NUL char.
  if (seriesId === '.' || seriesId === '..' || seriesId.includes('\0')) return null;
  return { agentGroupId, sessionId, seriesId };
}

/**
 * Build the canonical inbound.db path for a session locator, with a
 * canonicalize + containment check (M4). Returns the absolute path ONLY if it
 * resolves to exactly `<dataDir>/v2-sessions/<agentGroupId>/<sessionId>/inbound.db`
 * AND stays strictly inside the v2-sessions base — otherwise null. This is the
 * single hardened open-site for every scheduled-board handler that opens a
 * session inbound.db from a decoded :key (defense in depth: decodeKey already
 * rejects traversal segments, but routing every open through here means a future
 * caller that forgets the codec guard still cannot escape the base).
 */
export function sessionInboundPathFor(dataDir: string, agentGroupId: string, sessionId: string): string | null {
  const base = path.resolve(dataDir, 'v2-sessions');
  const p = path.resolve(base, agentGroupId, sessionId, 'inbound.db');
  const expected = path.join(base, agentGroupId, sessionId, 'inbound.db');
  return p === expected && p.startsWith(base + path.sep) ? p : null;
}

// ── Read-cache singleton ──────────────────────────────────────────────────────
// 5s TTL + generation counter (§3a). A mutation bumps `gen` and clears `data`
// (invalidateScheduledCache); an assembly stamps the gen it started under and
// refuses to populate the cache if `gen` has advanced since — the
// read-your-own-write guard. Group B's read assembly owns populate/read-TTL
// logic; this module owns the singleton + the generation counter so a mutation
// in any group can invalidate without importing B.

/**
 * Opaque snapshot shape — Group B's read assembly produces the concrete value.
 * Kept permissive here so the cache can hold it without a cross-group import.
 */
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

// ── Module-owned series registry (the SINGLE source of truth) ────────────────────
// One definition consumed by BOTH the read assembly (the user-visible badge,
// scheduled-assembly.ts) and the mutation handlers (the reseed-warning confirm,
// scheduled-mutations.ts). Lives here in the shared module so neither layer
// imports the other. Series-id prefix matching + a static map for any
// non-prefixed module series. Owner is 'memory' — the module lives at
// src/modules/memory/ (plan C5 ASSERT). Cross-checked against the live fleet
// (33 series: 10 memory-synth-*, 10 memory-lint-*, 12 task-* operator, 1
// operator-owned task-…-support-poller; ZERO mnemon-*/support- series — those
// prefixes are dead and intentionally absent here).

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

/* ─── Writer-side approval re-proof ───────────────────────────────────────── */

/**
 * The row fields every board verdict is computed from.
 *
 * A subset of `ScheduledTaskRow`, named rather than aliased so adding a column
 * to the read does not silently widen what counts as "changed".
 */
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
 * Has the row a board write was approved against changed underneath it?
 *
 * Returns the FIRST differing field, or `null` when the row is byte-equal on
 * every field a verdict reads. The field name is returned rather than a
 * boolean so the refusal log says which fact moved.
 *
 * Why an id check is not enough: admission MUTATES a task row in place rather
 * than replacing it. A concurrent run-now can flip `trigger` 0 → 1 and move
 * `process_after` while the id and the `pending` status both stay exactly as
 * the approving read saw them. Every board writer acquires its mailbox
 * asynchronously, so that window is real for all of them — which is why this
 * lives here and not in either caller.
 *
 * `content` is deliberately NOT compared: an edit to the prompt is the thing
 * some of these verbs exist to do, and the move carries the snapshot's copy
 * forward by design.
 */
export function approvedRowChanged(approved: ApprovedTaskRow, current: ApprovedTaskRow): string | null {
  for (const field of APPROVAL_FIELDS) {
    if (approved[field] !== current[field]) return field;
  }
  return null;
}
