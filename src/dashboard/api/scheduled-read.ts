/**
 * Scheduled Tasks Board read endpoints (Tasks B3 + B4):
 *   GET /dashboard/api/scheduled        — list (scope-filtered, health-derived)
 *   GET /dashboard/api/scheduled/:key   — detail (full prompt/script, history,
 *                                          audit tail at mutation tier only)
 *
 * Both apply the standard per-group scope filter with disclose-as-not-found
 * (C7). The list reads from the in-process snapshot cache (full-fleet, 5s TTL)
 * and filters per caller, so differently-scoped callers share one assembly.
 * The detail reads the series' session DB on demand for the full bodies +
 * last-5 fire history the snapshot doesn't carry.
 *
 * See docs/specs/scheduled-tasks-board/design.md §3a, §4.1, §4.2, §4.4, §4.5.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';
import {
  assembleSnapshot,
  buildDetailRow,
  type FireOutcome,
  type FireOutcomeLabel,
  type ScheduledRow,
  type ScheduledSnapshot,
} from './scheduled-assembly.js';
import {
  SWEEP_INTERVAL_MS,
  canManageScheduled,
  decodeKey,
  encodeKey,
  getScheduledCache,
  sessionInboundPathFor,
} from './scheduled-shared.js';

// ── Test seam ─────────────────────────────────────────────────────────────────
// Production reads from DATA_DIR with a live clock. Tests inject a fixture dir +
// fixed now without threading options through the AuthHandler signature.

interface ReadOptions {
  dataDir: string;
  nowMs: number;
}
let testOptions: ReadOptions | null = null;
export function _setReadTestOptions(opts: ReadOptions | null): void {
  testOptions = opts;
}
function readOpts(): ReadOptions {
  return testOptions ?? { dataDir: DATA_DIR, nowMs: Date.now() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Scope filter (C7) ─────────────────────────────────────────────────────────

function rowInScope(scopes: AuthedRequestContext['scopes'], agentGroupId: string): boolean {
  return scopes.no_filter || scopes.allowed_group_ids.includes(agentGroupId);
}

const COUNT_KEYS = ['healthy', 'late', 'stalled', 'paused', 'processing', 'unknown', 'strand', 'one_off', 'unreadable'];

function countRows(rows: ScheduledRow[], unreadable: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const k of COUNT_KEYS) counts[k] = 0;
  for (const r of rows) {
    counts[r.health] = (counts[r.health] ?? 0) + 1;
    if (r.kind === 'one_off') counts.one_off += 1;
  }
  counts.unreadable = unreadable;
  return counts;
}

// ── Audit-only repair rows (§4.2 step 5 / §4.4) ────────────────────────────────
// A double-failure move is durably recorded in scheduled_audit yet can have NO
// live row anywhere — invisible to the recurrence-filtered read shape. Surface
// unresolved move_restore_failed rows AND stale-unresolved move_intent rows
// (older than one sweep, no live row fleet-wide) as synthetic stalled entries
// so the board's whole reason for existing (catch the silently-dead series)
// holds even on the compensation path.

interface RepairAuditRow {
  action: string;
  agent_group_id: string;
  session_id: string;
  series_id: string;
  ts: string;
}

function repairRows(nowMs: number, liveSeriesIds: Set<string>): ScheduledRow[] {
  const db = getDb();
  let auditRows: RepairAuditRow[];
  try {
    auditRows = db
      .prepare(
        `SELECT action, agent_group_id, session_id, series_id, ts
           FROM scheduled_audit
          WHERE action IN ('move_restore_failed', 'move_intent')
            AND resolved_at IS NULL`,
      )
      .all() as RepairAuditRow[];
  } catch {
    // Table absent (uninstalled / pre-migration) — no repair rows to surface.
    return [];
  }

  const seen = new Set<string>();
  const out: ScheduledRow[] = [];
  for (const a of auditRows) {
    // A live row already covers this series → the move resolved fine; skip.
    if (liveSeriesIds.has(a.series_id)) continue;
    // move_intent only counts as a repair candidate once it has been unresolved
    // longer than one sweep (the normal in-flight window is seconds).
    if (a.action === 'move_intent') {
      const tsMs = Date.parse(/[zZ]/.test(a.ts) ? a.ts : a.ts.replace(' ', 'T') + 'Z');
      if (Number.isNaN(tsMs) || nowMs - tsMs <= SWEEP_INTERVAL_MS) continue;
    }
    if (seen.has(a.series_id)) continue;
    seen.add(a.series_id);
    out.push({
      key: encodeKey(a.agent_group_id, a.session_id, a.series_id),
      series_id: a.series_id,
      agent_group_id: a.agent_group_id,
      agent_group_name: a.agent_group_id,
      provider: null,
      channel_name: null,
      channel_type: null,
      thread_id: null,
      kind: 'recurring',
      cron: null,
      next_fire_utc: null,
      next_fire_local: null,
      health: 'stalled',
      module_owner: null,
      quiet_status: false,
      flag_intent: null,
      script_host: false,
      last_fires: [],
      available_verbs: ['cancel'],
    });
  }
  return out;
}

// ── B3: list handler ────────────────────────────────────────────────────────────

/**
 * Return the full-fleet snapshot (cached, 5s TTL) filtered to the caller's
 * scope, with audit-only repair rows folded in. The cache always holds the
 * full-fleet snapshot (assembled under no_filter) so a scoped read never
 * poisons an owner's view; the per-caller scope filter happens here.
 */
export const scheduledListHandler: AuthHandler = async (req, _params, ctx) => {
  const { dataDir, nowMs } = readOpts();

  // M5/M6: optional `?group_id=` server-side filter (mirrors sessions.ts). An
  // out-of-scope/nonexistent group_id yields an empty list, NOT an error
  // (out-of-scope-as-nonexistent) — the scope filter below already restricts the
  // row set, and ANDing the group_id naturally yields zero rows.
  const groupIdFilter = new URL(req.url).searchParams.get('group_id');

  // Serve a warm cache (full-fleet); else assemble it.
  const cache = getScheduledCache();
  let snapshot: ScheduledSnapshot;
  if (cache.data && cache.expiresMs > nowMs) {
    snapshot = cache.data as unknown as ScheduledSnapshot;
  } else {
    snapshot = await assembleSnapshot({ role: 'owner', allowed_group_ids: [], no_filter: true }, { dataDir, nowMs });
  }

  const liveSeriesIds = new Set(snapshot.rows.map((r) => r.series_id));
  const repair = repairRows(nowMs, liveSeriesIds);
  const allRows = [...snapshot.rows, ...repair];

  // Per-caller scope filter (C7 — disclose-as-not-found: out-of-scope rows are
  // simply absent, never a 403), ANDed with the optional group_id filter.
  const inScopeAndGroup = (agentGroupId: string): boolean =>
    rowInScope(ctx.scopes, agentGroupId) && (!groupIdFilter || agentGroupId === groupIdFilter);
  const visible = allRows.filter((r) => inScopeAndGroup(r.agent_group_id));

  // E-3: the unreadable count must reflect ONLY the caller's in-scope (and
  // group-filtered) groups — never the fleet-wide total. Sum the per-group
  // unreadable buckets over the groups this caller can actually see.
  const unreadableByGroup = (snapshot.unreadable_by_group ?? {}) as Record<string, number>;
  let scopedUnreadable = 0;
  for (const [agId, n] of Object.entries(unreadableByGroup)) {
    if (inScopeAndGroup(agId)) scopedUnreadable += n;
  }

  return json({
    rows: visible,
    counts: countRows(visible, scopedUnreadable),
    // `degraded` is a fleet assembly-health signal (the assembly either finished
    // in budget or it didn't); the per-caller UNREADABLE count above is scoped.
    degraded: snapshot.degraded,
    assembled_at: snapshot.assembled_at,
  });
};

// ── Prompt/title search (fast-follow) ───────────────────────────────────────────

/**
 * `GET /dashboard/api/scheduled/search?q=&group_id=` → `{ keys: string[] }`.
 *
 * Returns the scope-filtered row keys whose server-side search blob matches `q`.
 * The blob (assembled in scheduled-assembly) covers name/group/channel/cron PLUS
 * the task prompt + script — so this is the prompt/title search the lean list
 * snapshot can't do client-side. Only KEYS are returned: prompt/script text is
 * NEVER serialized (it stays detail-tier; the audit layer hashes it). The client
 * unions these keys with its instant on-row haystack, so list rows/counts/
 * stalled-inline are untouched — this endpoint only narrows the displayed set.
 *
 * Reuses the warm 5s snapshot cache (no extra DB reads on a cache hit). Empty `q`
 * short-circuits to no matches.
 */
export const scheduledSearchHandler: AuthHandler = async (req, _params, ctx) => {
  const { dataDir, nowMs } = readOpts();
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const groupIdFilter = url.searchParams.get('group_id');
  if (q === '') return json({ keys: [] });

  // Serve the warm full-fleet cache; else assemble it (same source as the list).
  const cache = getScheduledCache();
  let snapshot: ScheduledSnapshot;
  if (cache.data && cache.expiresMs > nowMs) {
    snapshot = cache.data as unknown as ScheduledSnapshot;
  } else {
    snapshot = await assembleSnapshot({ role: 'owner', allowed_group_ids: [], no_filter: true }, { dataDir, nowMs });
  }

  const index = (snapshot.search_index ?? {}) as Record<string, string>;
  // Same scope+group predicate as the list handler (disclose-as-not-found): a
  // caller only ever sees keys for groups it's authorized for, group-filtered.
  const inScopeAndGroup = (agentGroupId: string): boolean =>
    rowInScope(ctx.scopes, agentGroupId) && (!groupIdFilter || agentGroupId === groupIdFilter);

  const keys = snapshot.rows
    .filter((r) => inScopeAndGroup(r.agent_group_id))
    .filter((r) => (index[r.key] ?? '').includes(q))
    .map((r) => r.key);

  return json({ keys });
};

// ── B4: detail handler ───────────────────────────────────────────────────────────

interface DetailLiveRow {
  id: string;
  series_id: string | null;
  recurrence: string | null;
  process_after: string | null;
  status: string;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
}

interface HistoryRow {
  id: string;
  status: string;
  process_after: string | null;
  timestamp: string;
}

function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : (s.includes('T') ? s : s.replace(' ', 'T')) + 'Z';
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Label a completed/failed/expired fire row per §4.1:
 *   completed + a messages_out reply (in_reply_to = row id, ts ≥ due) → ran
 *   completed + no reply → completed (no chat output)   (the D16 merge)
 *   failed → failed · expired → missed · board-cancelled (audit) → cancelled
 */
function outcomeFor(row: HistoryRow, replyTs: string | undefined, cancelTsMs: number | null): FireOutcomeLabel {
  // Post-2.1.46 cancels mark the row 'cancelled' directly — label it as such.
  // The audit-ts heuristic below still covers legacy rows cancelled while
  // cancelTask wrote 'completed'.
  if (row.status === 'cancelled') return 'cancelled';
  // Label 'cancelled' ONLY for the occurrence the board-cancel actually ended — a
  // completed row whose scheduled due (process_after) is at/after the cancel audit
  // ts. Prior completed fires (due < cancelTs) genuinely RAN and keep their ran /
  // no-output label. (Was a series-level boolean that relabeled every prior run as
  // cancelled the moment the series had any cancel audit.)
  if (cancelTsMs !== null && row.status === 'completed') {
    const dueMs = parseUtcMs(row.process_after);
    if (dueMs !== null && dueMs >= cancelTsMs) return 'cancelled';
  }
  if (row.status === 'failed') return 'failed';
  if (row.status === 'expired') return 'missed';
  if (row.status === 'completed') {
    if (replyTs) {
      const dueMs = parseUtcMs(row.process_after);
      const replyMs = parseUtcMs(replyTs);
      if (dueMs === null || (replyMs !== null && replyMs >= dueMs)) return 'ran';
    }
    return 'completed (no chat output)';
  }
  return 'completed (no chat output)';
}

function readHistory(
  inboundPath: string,
  outboundPath: string,
  seriesId: string,
  cancelTsMs: number | null,
): FireOutcome[] {
  let inDb: Database.Database | null = null;
  let outDb: Database.Database | null = null;
  try {
    inDb = new Database(inboundPath, { readonly: true });
    inDb.pragma('busy_timeout = 1000');
    const rows = inDb
      .prepare(
        `SELECT id, status, process_after, timestamp
           FROM messages_in
          WHERE series_id = ? AND kind = 'task'
            AND status IN ('completed', 'failed', 'expired', 'cancelled')
          ORDER BY seq DESC LIMIT 5`,
      )
      .all(seriesId) as HistoryRow[];

    const replies = new Map<string, string>();
    if (fs.existsSync(outboundPath)) {
      try {
        outDb = new Database(outboundPath, { readonly: true });
        outDb.pragma('busy_timeout = 1000');
        for (const r of outDb
          .prepare(
            'SELECT in_reply_to, MAX(timestamp) AS ts FROM messages_out WHERE in_reply_to IS NOT NULL GROUP BY in_reply_to',
          )
          .all() as Array<{ in_reply_to: string; ts: string }>) {
          replies.set(r.in_reply_to, r.ts);
        }
      } catch {
        /* outbound unreadable — replies stay empty (→ no-chat-output labels) */
      }
    }

    return rows.map((r) => ({
      id: r.id,
      ts: r.process_after,
      outcome: outcomeFor(r, replies.get(r.id), cancelTsMs),
    }));
  } catch (err) {
    log.warn('scheduled-detail: history read failed', {
      seriesId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    inDb?.close();
    outDb?.close();
  }
}

interface AuditTailRow {
  ts: string;
  actor: string;
  action: string;
  before_preview: string | null;
  after_preview: string | null;
  correlation_id: string | null;
}

function readAuditTail(seriesId: string): AuditTailRow[] {
  try {
    return getDb()
      .prepare(
        `SELECT ts, actor, action, before_preview, after_preview, correlation_id
           FROM scheduled_audit WHERE series_id = ? ORDER BY id DESC LIMIT 20`,
      )
      .all(seriesId) as AuditTailRow[];
  } catch {
    return [];
  }
}

function cancelAuditTsMs(seriesId: string): number | null {
  try {
    const row = getDb()
      .prepare("SELECT ts FROM scheduled_audit WHERE series_id = ? AND action = 'cancel' ORDER BY id ASC LIMIT 1")
      .get(seriesId) as { ts: string } | undefined;
    return row ? parseUtcMs(row.ts) : null;
  } catch {
    return null;
  }
}

/**
 * Read the series' live row (prompt/script + current state). Returns null when
 * no live row exists (the series ended/moved since the list — the handler maps
 * that to 404 / stale).
 */
function readLiveRow(inboundPath: string, seriesId: string): DetailLiveRow | null {
  if (!fs.existsSync(inboundPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(inboundPath, { readonly: true });
    db.pragma('busy_timeout = 1000');
    const cols = `id, series_id, recurrence, process_after, status, content, platform_id, channel_type, thread_id`;
    // Prefer the latest LIVE (pending|paused) row — that carries the current
    // prompt/script/schedule. Fall back to the latest row of any status so an
    // ended series still renders its bodies (detail is read-only).
    const liveRow = db
      .prepare(
        `SELECT ${cols} FROM messages_in
          WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused')
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(seriesId) as DetailLiveRow | undefined;
    if (liveRow) return liveRow;
    return (
      (db
        .prepare(`SELECT ${cols} FROM messages_in WHERE series_id = ? AND kind = 'task' ORDER BY seq DESC LIMIT 1`)
        .get(seriesId) as DetailLiveRow | undefined) ?? null
    );
  } catch (err) {
    log.warn('scheduled-detail: live row read failed', {
      seriesId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    db?.close();
  }
}

export const scheduledDetailHandler: AuthHandler = async (_req, params, ctx) => {
  const { dataDir, nowMs } = readOpts();
  const key = params['key'] ?? '';
  const decoded = decodeKey(key);
  // Malformed key → 400. The :key is a structural locator (base64url codec,
  // scheduled-shared.ts) — a string that cannot decode is a bad request, not a
  // hidden resource. Out-of-scope and nonexistent are the disclose-as-not-found
  // cases (404 below); a malformed key reveals nothing to disambiguate, so the
  // distinct status is safe and matches the codec's documented contract.
  if (!decoded) return json({ error: 'bad_key' }, 400);

  // Scope re-check from the decoded key — never trust the key as authz (§4.5).
  // Out-of-scope → 404 disclose-as-not-found (C7), never 403.
  if (!rowInScope(ctx.scopes, decoded.agentGroupId)) {
    return json({ error: 'not_found' }, 404);
  }

  // M4: containment-checked open. A null path (containment violation — decodeKey
  // already rejects traversal segments, this is defense in depth) → 404
  // disclose-as-not-found, never an open outside data/v2-sessions.
  const inboundPath = sessionInboundPathFor(dataDir, decoded.agentGroupId, decoded.sessionId);
  if (!inboundPath) return json({ error: 'not_found' }, 404);
  const outboundPath = path.join(path.dirname(inboundPath), 'outbound.db');

  // Read the series' live/latest row for the full prompt + script bodies (the
  // snapshot carries neither). null → the series ended/moved since the list →
  // 404 (detail is read-only; a stale key just doesn't resolve).
  const live = readLiveRow(inboundPath, decoded.seriesId);
  if (!live) return json({ error: 'not_found' }, 404);

  // The `row` MUST be a complete ScheduledRow — the drawer reads
  // `available_verbs`, `health`, `agent_group_name`, `channel_name`,
  // `module_owner`, `kind`, `next_fire_local`, `quiet_status`, `flag_intent`
  // off it. Build it with the same assembly machinery (health + verbs + joins),
  // never a thin projection (that would make the drawer's verb buttons throw on
  // `row.available_verbs`).
  const row = buildDetailRow(decoded.agentGroupId, decoded.sessionId, decoded.seriesId, dataDir, nowMs) ?? null;
  if (!row) return json({ error: 'not_found' }, 404);

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(live.content) as Record<string, unknown>;
  } catch {
    /* malformed — fall back to raw */
  }
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : live.content;
  const script = typeof parsed.script === 'string' ? (parsed.script as string) : null;

  const cancelTsMs = cancelAuditTsMs(decoded.seriesId);
  const history = readHistory(inboundPath, outboundPath, decoded.seriesId, cancelTsMs);

  const body: Record<string, unknown> = { row, prompt, script, history };

  // Audit tail is served ONLY at the mutation tier (owner/global-admin). A
  // read-only in-scope caller never sees the tail (M5 — delta hashes/previews
  // and move provenance stay above the read tier).
  if (canManageScheduled(ctx.user.id)) {
    body.audit_tail = readAuditTail(decoded.seriesId);
  }

  return json(body);
};
