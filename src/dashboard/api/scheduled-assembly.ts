/**
 * Scheduled Tasks Board read assembly and health derivation.
 * Assembled on demand from the session DBs, never a materialized table (derived state that diverged from truth caused
 * past incidents). One session per event-loop tick, never one long synchronous block in the shared host process.
 * Single-flight plus a 5s TTL cache guarded by a generation counter, so a mutation landing mid-assembly forces a
 * re-run.
 * Board DB opens are read-only with busy_timeout 1000, never the write path's 5000. A per-session read failure never
 * fails the snapshot: the session adds to `unreadable` and the rest still return.
 */
import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, TIMEZONE } from '../../config.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import {
  readSessionInbound,
  readSessionOutbound,
  type ScheduledTaskRow,
  type SessionReadLocation,
} from '../../modules/mailbox/index.js';
import { availableVerbs, type HealthState, type SeriesKind, type Verb } from './scheduled-board-matrix.js';
import {
  SWEEP_INTERVAL_MS,
  encodeKey,
  getScheduledCache,
  moduleOwner,
  type ScheduledSnapshot as CacheSnapshot,
} from './scheduled-shared.js';

export type { HealthState, SeriesKind, Verb };

// Public contract: must match the dashboard client types.

export type FireOutcomeLabel = 'ran' | 'completed (no chat output)' | 'failed' | 'missed' | 'cancelled';

export interface FireOutcome {
  id?: string;
  ts?: string | null;
  outcome: FireOutcomeLabel;
}

export interface ScheduledRow {
  key: string;
  series_id: string;
  agent_group_id: string;
  agent_group_name: string;
  provider: string | null;
  channel_name: string | null;
  channel_type: string | null;
  thread_id: string | null;
  kind: SeriesKind;
  cron: string | null;
  next_fire_utc: string | null;
  next_fire_local: string | null;
  health: HealthState;
  module_owner: string | null;
  quiet_status: boolean;
  flag_intent: Record<string, unknown> | null;
  /** Host-side pre-task script flag (content.scriptHost), for the "host-gated" badge. */
  script_host: boolean;
  last_fires: FireOutcome[];
  available_verbs: Verb[];
}

export interface ScheduledSnapshot {
  rows: ScheduledRow[];
  degraded: boolean;
  counts: Record<string, number>;
  /**
   * Per-agent_group unreadable counts: a SCOPED caller must see only its own groups' count, never the fleet-wide
   * `counts.unreadable`.
   */
  unreadable_by_group: Record<string, number>;
  /**
   * Server-side ONLY search blob per row key, including prompt and script. NEVER serialized to the wire:
   * prompt/script stay detail-tier.
   */
  search_index: Record<string, string>;
  assembled_at: string;
}

export type AuthScopes = { role: string; allowed_group_ids: string[]; no_filter: boolean };

export interface ScheduledAssemblyOptions {
  dataDir?: string;
  nowMs?: number;
}

/**
 * SQLite TIMESTAMP values carry no zone and `Date.parse` treats them as local time, so `Z` is appended when no zone
 * marker is present.
 */
function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : (s.includes('T') ? s : s.replace(' ', 'T')) + 'Z';
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function localString(ms: number | null): string | null {
  if (ms === null) return null;
  try {
    return `${new Date(ms).toLocaleString('en-US', {
      timeZone: TIMEZONE,
      dateStyle: 'short',
      timeStyle: 'short',
    })} ${TIMEZONE}`;
  } catch {
    return null;
  }
}

export interface HealthCtx {
  status: string;
  recurrence: string | null;
  processAfterMs: number | null;
  timestampMs: number | null;
  ackPresent: boolean;
  outboundReadable: boolean;
  nowMs: number;
  isOneOff: boolean;
  /**
   * The owning group's timezone: a DST transition makes a daily cadence 23 or 25 hours, so the install zone would
   * flip `late`/`stalled` at the wrong moment.
   */
  timezone?: string;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'expired']);

const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;

/**
 * The cron interval (ms) for the occurrence the row is ARMED on, parsed as recurrence.ts does; null on parse failure
 * or for one-offs.
 * Anchored at the armed occurrence, not now: across DST the interval changes, and measuring from now would move the
 * stall grace the instant the due time passes. The anchor is one millisecond before the armed instant because
 * `next()` excludes `currentDate`.
 */
function cronIntervalMs(cron: string | null, tz: string = TIMEZONE, anchorMs?: number | null): number | null {
  if (!cron) return null;
  try {
    const it = CronExpressionParser.parse(cron, {
      tz,
      ...(anchorMs != null ? { currentDate: new Date(anchorMs - 1) } : {}),
    });
    const a = it.next().getTime();
    const b = it.next().getTime();
    return b - a;
  } catch {
    return null;
  }
}

/** Health from the live row plus observability facts, NEVER from `status` alone: a die-off can leave no failed row. */
export function deriveHealth(ctx: HealthCtx): HealthState {
  if (ctx.status === 'paused') return 'paused';

  // Residual strand: the latest row is terminal yet still has a recurrence (no successor was minted). Flagged only
  // after 2×SWEEP_INTERVAL, to exclude the legitimate gap between completion sync and successor insert.
  if (TERMINAL_STATUSES.has(ctx.status) && ctx.recurrence !== null) {
    const anchor = Math.max(ctx.timestampMs ?? 0, ctx.processAfterMs ?? 0);
    if (anchor > 0 && ctx.nowMs - anchor > 2 * SWEEP_INTERVAL_MS) return 'strand';
    // Within the transient grace: a successor is expected.
    return 'healthy';
  }

  const overdueBy = ctx.processAfterMs !== null ? ctx.nowMs - ctx.processAfterMs : 0;
  const overdue = overdueBy > 0;

  // A positive claim wins over lateness.
  if (ctx.ackPresent) return 'processing';

  // An overdue row whose outbound.db is unreadable is `unknown`, never silently healthy.
  if (!ctx.outboundReadable && overdue) return 'unknown';

  if (!overdue) return 'healthy';

  // Grace scales with cadence but is capped at 24h so a weekly or monthly series cannot be silently dead for days.
  const interval = ctx.isOneOff
    ? 2 * SWEEP_INTERVAL_MS
    : cronIntervalMs(ctx.recurrence, ctx.timezone, ctx.processAfterMs);
  const cadenceGrace = interval !== null ? Math.max(interval * 0.5, 2 * SWEEP_INTERVAL_MS) : 2 * SWEEP_INTERVAL_MS;
  const stallGrace = Math.min(cadenceGrace, TWENTY_FOUR_H_MS);

  return overdueBy > stallGrace ? 'stalled' : 'late';
}

/** Aliased, not re-declared, so a mailbox column reaches the board without a second edit. */
type RawRow = ScheduledTaskRow;

interface SessionDescriptor {
  agentGroupId: string;
  agentGroupName: string;
  provider: string | null;
  sessionId: string;
}

interface SessionReadResult {
  rows: ScheduledRow[];
  /** Includes prompt/script. Wire-excluded. */
  searchByKey: Record<string, string>;
  unreadable: number;
}

/** `dataDir` rides along because tests inject a fixture root and `DATA_DIR` has no env override. */
function locate(dataDir: string, agentGroupId: string, sessionId: string): SessionReadLocation {
  return { dataDir, agentGroupId, sessionId };
}

function channelNameOf(
  mgByDest: Map<string, string>,
  channelType: string | null,
  platformId: string | null,
): string | null {
  if (!channelType || !platformId) return null;
  // NUL separator: channel_type and platform_id are operator-controlled and could collide under a printable
  // separator. Every site building this map must use the identical key or the join silently returns null.
  return mgByDest.get(`${channelType}\0${platformId}`) ?? null;
}

interface OutboundView {
  readable: boolean;
  claimed: Set<string>;
}

/**
 * Which fire-row ids are claimed (processing_ack='processing'). `readable=false` when outbound.db is absent or
 * corrupt, so an overdue row reads `unknown`, never silently unclaimed. Never throws.
 */
function readOutbound(location: SessionReadLocation): OutboundView {
  try {
    const claimed = readSessionOutbound(location, (mailbox) => new Set(mailbox.listProcessingClaimedMessageIds()));
    // `undefined` means no outbound.db: absent, reported as not readable.
    if (!claimed) return { readable: false, claimed: new Set() };
    return { readable: true, claimed };
  } catch (err) {
    log.warn('scheduled-assembly: outbound read failed', {
      sessionId: location.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { readable: false, claimed: new Set() };
  }
}

function parseContent(content: string): {
  prompt: string;
  script: string | null;
  quietStatus: boolean;
  flagIntent: Record<string, unknown> | null;
  scriptHost: boolean;
} {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    /* malformed — fall back to raw prompt */
  }
  return {
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : content,
    script: typeof parsed.script === 'string' ? (parsed.script as string) : null,
    quietStatus: parsed.quietStatus === true,
    flagIntent:
      parsed.flagIntent && typeof parsed.flagIntent === 'object'
        ? (parsed.flagIntent as Record<string, unknown>)
        : null,
    // content.scriptHost is the only place this flag lives, as in src/cli/resources/tasks.ts's parseContent.
    scriptHost: parsed.scriptHost === true,
  };
}

/**
 * Server-side search blob including the parsed prompt and script; NEVER serialized to the wire. Malformed content
 * stays searchable as raw text.
 */
function searchTextFor(raw: RawRow, row: ScheduledRow): string {
  const { prompt, script } = parseContent(raw.content);
  return [row.series_id, row.agent_group_name, row.channel_name ?? '', row.cron ?? '', prompt, script ?? '']
    .join(' ')
    .toLowerCase();
}

function kindOf(raw: RawRow): SeriesKind {
  if (raw.recurrence === null) return 'one_off';
  if (raw.thread_id) return 'thread_loop';
  return 'recurring';
}

function rawToRow(
  raw: RawRow,
  desc: SessionDescriptor,
  mgByDest: Map<string, string>,
  outbound: OutboundView,
  nowMs: number,
  forceUnhealthy: boolean,
  timezone: string,
): ScheduledRow {
  const seriesId = raw.series_id ?? raw.id;
  const parsed = parseContent(raw.content);
  const isOneOff = raw.recurrence === null;
  const processAfterMs = parseUtcMs(raw.process_after);
  const timestampMs = parseUtcMs(raw.timestamp);
  const ackPresent = outbound.claimed.has(raw.id);

  let health = deriveHealth({
    status: raw.status,
    recurrence: raw.recurrence,
    processAfterMs,
    timestampMs,
    ackPresent,
    outboundReadable: outbound.readable,
    nowMs,
    isOneOff,
    timezone,
  });
  // Duplicate successor rows are always flagged: the MAX(seq) read would hide the second fireable row.
  if (forceUnhealthy && health !== 'paused' && health !== 'processing') health = 'stalled';

  const kind = kindOf(raw);
  const claimed = ackPresent;

  return {
    key: encodeKey(desc.agentGroupId, desc.sessionId, seriesId),
    series_id: seriesId,
    agent_group_id: desc.agentGroupId,
    agent_group_name: desc.agentGroupName,
    provider: desc.provider,
    channel_name: channelNameOf(mgByDest, raw.channel_type, raw.platform_id),
    channel_type: raw.channel_type,
    thread_id: raw.thread_id,
    kind,
    cron: raw.recurrence,
    next_fire_utc: processAfterMs !== null ? new Date(processAfterMs).toISOString() : null,
    next_fire_local: localString(processAfterMs),
    health,
    module_owner: moduleOwner(seriesId).owner ?? null,
    quiet_status: parsed.quietStatus,
    flag_intent: parsed.flagIntent,
    script_host: parsed.scriptHost,
    last_fires: [],
    available_verbs: availableVerbs({
      state: health,
      kind,
      claimed,
      processAfterMs,
      nowMs,
    }),
  };
}

async function readSession(
  desc: SessionDescriptor,
  dataDir: string,
  mgByDest: Map<string, string>,
  nowMs: number,
): Promise<SessionReadResult> {
  const location = locate(dataDir, desc.agentGroupId, desc.sessionId);
  // Resolved before the read-only funnel so the session read stays synchronous.
  const timezone = await resolveGroupTimezone(desc.agentGroupId);
  try {
    // Read-only seam, deliberately not `withExistingMailboxSession`: this runs across every session on each poll and
    // must never provision, schema-ensure or migrate a session it only lists.
    const read = readSessionInbound(location, (mailbox) => {
      const dupSeries = new Set(mailbox.listDuplicateLiveTaskSeriesIds());
      return {
        dupSeries,
        latest: mailbox.listLatestRecurringSeriesRows(),
        oneOffs: mailbox.listLiveOneOffTaskRows(),
      };
    });
    // No mailbox on disk is a complete answer, not an unreadable session.
    if (!read) return { rows: [], searchByKey: {}, unreadable: 0 };
    const { dupSeries, latest, oneOffs } = read;

    const outbound = readOutbound(location);

    const rows: ScheduledRow[] = [];
    const searchByKey: Record<string, string> = {};
    const emit = (raw: RawRow, forceUnhealthy: boolean): void => {
      const row = rawToRow(raw, desc, mgByDest, outbound, nowMs, forceUnhealthy, timezone);
      rows.push(row);
      searchByKey[row.key] = searchTextFor(raw, row);
    };

    // One row per series; extra recurring successors mark the series unhealthy but cannot produce duplicate keys or
    // controls.
    for (const raw of latest) {
      const seriesId = raw.series_id ?? raw.id;
      emit(raw, dupSeries.has(seriesId));
    }
    for (const raw of oneOffs) {
      const seriesId = raw.series_id ?? raw.id;
      if (dupSeries.has(seriesId)) continue;
      emit(raw, false);
    }

    return { rows, searchByKey, unreadable: 0 };
  } catch (err) {
    log.warn('scheduled-assembly: session read failed — partial snapshot', {
      sessionId: desc.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { rows: [], searchByKey: {}, unreadable: 1 };
  }
}

/**
 * The FULL board row for one series, built with the same machinery as the list (the drawer reads most of its fields).
 * Falls back to the latest row of any status so an ended or stranded series renders read-only; null when the series
 * has no row.
 */
export async function buildDetailRow(
  agentGroupId: string,
  sessionId: string,
  seriesId: string,
  dataDir: string,
  nowMs: number,
): Promise<ScheduledRow | null> {
  const location = locate(dataDir, agentGroupId, sessionId);
  const timezone = await resolveGroupTimezone(agentGroupId);
  const ag = await getDb().get<{ name: string; agent_provider: string | null }>(
    'SELECT name, agent_provider FROM agent_groups WHERE id = ?',
    agentGroupId,
  );
  // Must use channelNameOf's NUL-separated key; see there.
  const mgByDest = new Map<string, string>();
  const mgRows = await getDb().all<{
    channel_type: string;
    platform_id: string;
    name: string | null;
  }>('SELECT channel_type, platform_id, name FROM messaging_groups');
  for (const m of mgRows) {
    if (m.name) mgByDest.set(`${m.channel_type}\0${m.platform_id}`, m.name);
  }

  const desc: SessionDescriptor = {
    agentGroupId,
    agentGroupName: ag?.name ?? agentGroupId,
    provider: ag?.agent_provider ?? null,
    sessionId,
  };

  try {
    // Same read-only seam as the list path.
    const raw = readSessionInbound(
      location,
      (mailbox) => mailbox.getLiveSeriesRow(seriesId) ?? mailbox.getLatestSeriesRow(seriesId),
    );
    if (!raw) return null;
    // Cancelled series are excluded from the list, so the detail 404s too rather than rendering a phantom strand.
    if (raw.status === 'cancelled') return null;

    const isLive = raw.status === 'pending' || raw.status === 'paused';
    const isStrand = !isLive && raw.recurrence !== null;
    const outbound = readOutbound(location);
    const row = rawToRow(raw, desc, mgByDest, outbound, nowMs, false, timezone);
    // rawToRow's health ladder sees only live rows, so a terminal-with-recurrence strand is forced here.
    if (isStrand) {
      row.health = 'strand';
      row.available_verbs = availableVerbs({
        state: 'strand',
        kind: row.kind,
        claimed: outbound.claimed.has(raw.id),
        processAfterMs: parseUtcMs(raw.process_after),
        nowMs,
      });
    }
    return row;
  } catch (err) {
    log.warn('scheduled-assembly: detail row read failed', {
      seriesId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const EMPTY_COUNTS: Record<string, number> = {
  healthy: 0,
  late: 0,
  stalled: 0,
  paused: 0,
  processing: 0,
  unknown: 0,
  strand: 0,
  one_off: 0,
  unreadable: 0,
};

const WARN_MS = 1000;
const DEGRADE_MS = 3000;
const CACHE_TTL_MS = 5000;

let inFlight: Promise<ScheduledSnapshot> | null = null;

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function countRow(counts: Record<string, number>, row: ScheduledRow): void {
  counts[row.health] = (counts[row.health] ?? 0) + 1;
  if (row.kind === 'one_off') counts.one_off = (counts.one_off ?? 0) + 1;
}

/**
 * Single-flight: concurrent callers share the in-flight promise. The cache is written only if the generation the
 * assembly started under is still current.
 */
export async function assembleSnapshot(
  scopes: AuthScopes,
  options: ScheduledAssemblyOptions = {},
): Promise<ScheduledSnapshot> {
  if (inFlight) return inFlight;
  inFlight = doAssemble(scopes, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doAssemble(scopes: AuthScopes, options: ScheduledAssemblyOptions): Promise<ScheduledSnapshot> {
  const dataDir = options.dataDir ?? DATA_DIR;
  const nowMs = options.nowMs ?? Date.now();
  const startGen = getScheduledCache().gen;
  const startedAt = Date.now();

  const agentGroupRows = await getDb().all<{
    id: string;
    name: string;
    agent_provider: string | null;
  }>('SELECT id, name, agent_provider FROM agent_groups');
  const agentGroups = new Map(agentGroupRows.map((g) => [g.id, g]));
  const mgRows = await getDb().all<{
    channel_type: string;
    platform_id: string;
    name: string | null;
  }>('SELECT channel_type, platform_id, name FROM messaging_groups');
  const mgByDest = new Map(
    // Same NUL key as channelNameOf.
    mgRows.map((m) => [`${m.channel_type}\0${m.platform_id}`, m.name ?? '']),
  );

  let sessionSql = "SELECT id, agent_group_id FROM sessions WHERE status = 'active'";
  const sessionParams: unknown[] = [];
  if (!scopes.no_filter) {
    if (scopes.allowed_group_ids.length === 0) {
      return {
        rows: [],
        degraded: false,
        counts: { ...EMPTY_COUNTS },
        unreadable_by_group: {},
        search_index: {},
        assembled_at: new Date(nowMs).toISOString(),
      };
    }
    sessionSql += ` AND agent_group_id IN (${scopes.allowed_group_ids.map(() => '?').join(', ')})`;
    sessionParams.push(...scopes.allowed_group_ids);
  }
  const sessionRows = await getDb().all<{
    id: string;
    agent_group_id: string;
  }>(sessionSql, ...sessionParams);

  const rows: ScheduledRow[] = [];
  const counts: Record<string, number> = { ...EMPTY_COUNTS };
  const unreadableByGroup: Record<string, number> = {};
  const searchIndex: Record<string, string> = {};

  for (const s of sessionRows) {
    await yieldTick(); // One session per event-loop tick.
    const ag = agentGroups.get(s.agent_group_id);
    const desc: SessionDescriptor = {
      agentGroupId: s.agent_group_id,
      agentGroupName: ag?.name ?? s.agent_group_id,
      provider: ag?.agent_provider ?? null,
      sessionId: s.id,
    };
    const res = await readSession(desc, dataDir, mgByDest, nowMs);
    for (const r of res.rows) {
      rows.push(r);
      countRow(counts, r);
    }
    Object.assign(searchIndex, res.searchByKey);
    counts.unreadable += res.unreadable;
    if (res.unreadable > 0) {
      unreadableByGroup[s.agent_group_id] = (unreadableByGroup[s.agent_group_id] ?? 0) + res.unreadable;
    }
  }

  const elapsed = Date.now() - startedAt;
  let degraded = false;
  if (elapsed > DEGRADE_MS) {
    degraded = true;
    log.warn('scheduled-assembly: degraded (>3s) — serving with degraded flag', { elapsedMs: elapsed });
    const cached = getScheduledCache();
    if (cached.data) {
      return { ...(cached.data as unknown as ScheduledSnapshot), degraded: true };
    }
  } else if (elapsed > WARN_MS) {
    log.warn('scheduled-assembly: warm assembly slow (>1s)', { elapsedMs: elapsed });
  } else {
    log.debug('scheduled-assembly: assembled', { elapsedMs: elapsed, rows: rows.length });
  }

  const snapshot: ScheduledSnapshot = {
    rows,
    degraded,
    counts,
    unreadable_by_group: unreadableByGroup,
    search_index: searchIndex,
    assembled_at: new Date(nowMs).toISOString(),
  };

  // A stale assembly is returned to its caller but never cached.
  const cache = getScheduledCache();
  if (cache.gen === startGen) {
    cache.data = snapshot as unknown as CacheSnapshot;
    cache.expiresMs = nowMs + CACHE_TTL_MS;
  }

  return snapshot;
}

export function _resetAssemblyInFlightForTesting(): void {
  inFlight = null;
}
