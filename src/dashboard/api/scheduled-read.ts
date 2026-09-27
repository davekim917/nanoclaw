/**
 * Scheduled Tasks Board read endpoints: list and detail. Both apply the per-group scope filter with
 * disclose-as-not-found. The list filters the shared full-fleet snapshot cache per caller; the detail reads the
 * session DB on demand for full bodies and fire history.
 */
import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import {
  readSessionInbound,
  readSessionOutbound,
  type ScheduledTaskRow,
  type SessionReadLocation,
  type TaskFireRow,
} from '../../modules/mailbox/index.js';
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

// Tests inject a fixture dir and a fixed clock without threading options through the AuthHandler signature.

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

// A double-failure move can leave no live row anywhere, only a scheduled_audit record. Unresolved move_restore_failed
// rows, and move_intent rows unresolved for longer than a sweep with no live row, surface as synthetic stalled
// entries so a silently dead series still shows.

interface RepairAuditRow {
  action: string;
  agent_group_id: string;
  session_id: string;
  series_id: string;
  ts: string;
}

async function repairRows(nowMs: number, liveSeriesIds: Set<string>): Promise<ScheduledRow[]> {
  let auditRows: RepairAuditRow[];
  try {
    auditRows = await getDb().all<RepairAuditRow>(
      `SELECT action, agent_group_id, session_id, series_id, ts
         FROM scheduled_audit
        WHERE action IN ('move_restore_failed', 'move_intent')
          AND resolved_at IS NULL`,
    );
  } catch {
    // Table absent (pre-migration): nothing to surface.
    return [];
  }

  const seen = new Set<string>();
  const out: ScheduledRow[] = [];
  for (const a of auditRows) {
    if (liveSeriesIds.has(a.series_id)) continue;
    // The normal in-flight window is seconds; only an intent older than one sweep is a repair candidate.
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

/**
 * The cache always holds the full-fleet snapshot (assembled unfiltered) so a scoped read never poisons an owner's
 * view; scope filtering happens per caller here.
 */
export const scheduledListHandler: AuthHandler = async (req, _params, ctx) => {
  const { dataDir, nowMs } = readOpts();

  // An out-of-scope or nonexistent group_id yields an empty list, not an error.
  const groupIdFilter = new URL(req.url).searchParams.get('group_id');

  const cache = getScheduledCache();
  let snapshot: ScheduledSnapshot;
  if (cache.data && cache.expiresMs > nowMs) {
    snapshot = cache.data as unknown as ScheduledSnapshot;
  } else {
    snapshot = await assembleSnapshot({ role: 'owner', allowed_group_ids: [], no_filter: true }, { dataDir, nowMs });
  }

  const liveSeriesIds = new Set(snapshot.rows.map((r) => r.series_id));
  const repair = await repairRows(nowMs, liveSeriesIds);
  const allRows = [...snapshot.rows, ...repair];

  // Out-of-scope rows are simply absent, never a 403.
  const inScopeAndGroup = (agentGroupId: string): boolean =>
    rowInScope(ctx.scopes, agentGroupId) && (!groupIdFilter || agentGroupId === groupIdFilter);
  const visible = allRows.filter((r) => inScopeAndGroup(r.agent_group_id));

  // The unreadable count must cover ONLY the caller's visible groups, never the fleet-wide total.
  const unreadableByGroup = (snapshot.unreadable_by_group ?? {}) as Record<string, number>;
  let scopedUnreadable = 0;
  for (const [agId, n] of Object.entries(unreadableByGroup)) {
    if (inScopeAndGroup(agId)) scopedUnreadable += n;
  }

  return json({
    rows: visible,
    counts: countRows(visible, scopedUnreadable),
    // `degraded` is fleet assembly health; only the unreadable count is scoped.
    degraded: snapshot.degraded,
    assembled_at: snapshot.assembled_at,
  });
};

/**
 * `GET /dashboard/api/scheduled/search?q=&group_id=` → `{ keys }`: scope-filtered row keys whose server-side blob
 * (including prompt and script) matches. Only KEYS are returned; prompt/script text is NEVER serialized. Empty `q`
 * matches nothing.
 */
export const scheduledSearchHandler: AuthHandler = async (req, _params, ctx) => {
  const { dataDir, nowMs } = readOpts();
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const groupIdFilter = url.searchParams.get('group_id');
  if (q === '') return json({ keys: [] });

  const cache = getScheduledCache();
  let snapshot: ScheduledSnapshot;
  if (cache.data && cache.expiresMs > nowMs) {
    snapshot = cache.data as unknown as ScheduledSnapshot;
  } else {
    snapshot = await assembleSnapshot({ role: 'owner', allowed_group_ids: [], no_filter: true }, { dataDir, nowMs });
  }

  const index = (snapshot.search_index ?? {}) as Record<string, string>;
  const inScopeAndGroup = (agentGroupId: string): boolean =>
    rowInScope(ctx.scopes, agentGroupId) && (!groupIdFilter || agentGroupId === groupIdFilter);

  const keys = snapshot.rows
    .filter((r) => inScopeAndGroup(r.agent_group_id))
    .filter((r) => (index[r.key] ?? '').includes(q))
    .map((r) => r.key);

  return json({ keys });
};

type DetailLiveRow = ScheduledTaskRow;
type HistoryRow = TaskFireRow;

function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : (s.includes('T') ? s : s.replace(' ', 'T')) + 'Z';
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * completed + a reply (in_reply_to = row id, ts ≥ due) → ran; completed with no reply → completed (no chat output);
 * failed → failed; expired → missed; board-cancelled → cancelled.
 */
function outcomeFor(row: HistoryRow, replyTs: string | undefined, cancelTsMs: number | null): FireOutcomeLabel {
  // Current cancels mark the row 'cancelled' directly; the audit-ts check below covers legacy rows cancelled as
  // 'completed'.
  if (row.status === 'cancelled') return 'cancelled';
  // Only the occurrence the cancel ended (due at or after the cancel audit ts) is 'cancelled'; earlier completed
  // fires genuinely ran.
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

const HISTORY_TAIL = 5;

function readHistory(location: SessionReadLocation, seriesId: string, cancelTsMs: number | null): FireOutcome[] {
  try {
    const rows = readSessionInbound(location, (mailbox) => mailbox.listRecentTaskFires(seriesId, HISTORY_TAIL)) ?? [];

    let replies = new Map<string, string>();
    try {
      replies = readSessionOutbound(location, (mailbox) => mailbox.latestReplyTimestampByTrigger()) ?? replies;
    } catch {
      /* outbound unreadable — replies stay empty (→ no-chat-output labels) */
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

async function readAuditTail(seriesId: string): Promise<AuditTailRow[]> {
  try {
    return await getDb().all<AuditTailRow>(
      `SELECT ts, actor, action, before_preview, after_preview, correlation_id
         FROM scheduled_audit WHERE series_id = ? ORDER BY id DESC LIMIT 20`,
      seriesId,
    );
  } catch {
    return [];
  }
}

async function cancelAuditTsMs(seriesId: string): Promise<number | null> {
  try {
    const row = await getDb().get<{ ts: string }>(
      "SELECT ts FROM scheduled_audit WHERE series_id = ? AND action = 'cancel' ORDER BY id ASC LIMIT 1",
      seriesId,
    );
    return row ? parseUtcMs(row.ts) : null;
  } catch {
    return null;
  }
}

/** Null when the series has no row (the handler maps that to 404). */
function readLiveRow(location: SessionReadLocation, seriesId: string): DetailLiveRow | null {
  try {
    // Prefer the latest live row (current bodies and schedule); fall back to the latest of any status so an ended
    // series still renders.
    return (
      readSessionInbound(
        location,
        (mailbox) => mailbox.getLiveTaskRow(seriesId) ?? mailbox.getLatestTaskRow(seriesId),
      ) ?? null
    );
  } catch (err) {
    log.warn('scheduled-detail: live row read failed', {
      seriesId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const scheduledDetailHandler: AuthHandler = async (_req, params, ctx) => {
  const { dataDir, nowMs } = readOpts();
  const key = params['key'] ?? '';
  const decoded = decodeKey(key);
  // A malformed key is a bad request (400), not a hidden resource: it reveals nothing to disambiguate.
  if (!decoded) return json({ error: 'bad_key' }, 400);

  // The key is never authorization; out-of-scope → 404, never 403.
  if (!rowInScope(ctx.scopes, decoded.agentGroupId)) {
    return json({ error: 'not_found' }, 404);
  }

  // Containment-checked locator; null is the disclose-as-not-found 404.
  if (!sessionInboundPathFor(dataDir, decoded.agentGroupId, decoded.sessionId)) {
    return json({ error: 'not_found' }, 404);
  }
  const location: SessionReadLocation = {
    dataDir,
    agentGroupId: decoded.agentGroupId,
    sessionId: decoded.sessionId,
  };

  // The snapshot carries neither body; a series that ended since the list → 404.
  const live = readLiveRow(location, decoded.seriesId);
  if (!live) return json({ error: 'not_found' }, 404);

  // Must be a complete ScheduledRow built by the assembly machinery, never a thin projection: the drawer's verb
  // buttons read `available_verbs` and other fields off it.
  const row = (await buildDetailRow(decoded.agentGroupId, decoded.sessionId, decoded.seriesId, dataDir, nowMs)) ?? null;
  if (!row) return json({ error: 'not_found' }, 404);

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(live.content) as Record<string, unknown>;
  } catch {
    /* malformed — fall back to raw */
  }
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : live.content;
  const script = typeof parsed.script === 'string' ? (parsed.script as string) : null;

  const cancelTsMs = await cancelAuditTsMs(decoded.seriesId);
  const history = readHistory(location, decoded.seriesId, cancelTsMs);

  const body: Record<string, unknown> = { row, prompt, script, history };

  // Mutation tier only: hashes, previews and move provenance stay above the read tier.
  if (await canManageScheduled(ctx.user.id)) {
    body.audit_tail = await readAuditTail(decoded.seriesId);
  }

  return json(body);
};
