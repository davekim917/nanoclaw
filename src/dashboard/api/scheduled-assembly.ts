/**
 * Scheduled Tasks Board read assembly + health derivation (Tasks B1 + B2).
 *
 * Assembles the fleet snapshot ON DEMAND from the session DBs — no materialized
 * table (D10 rejected; both prior scheduling incidents were derived-state-
 * diverged-from-truth). One session per event-loop tick via setImmediate
 * (§4.9 — never one contiguous synchronous block in the shared host process).
 * Single-flight + a 5s TTL cache guarded by a generation counter so a mutation
 * that lands mid-assembly forces a re-run (read-your-own-write, §3a).
 *
 * All board DB opens are { readonly: true } + busy_timeout 1000 (the
 * hasPendingRecurrence precedent, sessions.ts:121-122) — never the write
 * path's 5000ms. A per-session read failure never fails the fleet snapshot:
 * the session contributes an `unreadable` count and the rest still return
 * (§3a degraded contract, S12).
 *
 * See docs/specs/scheduled-tasks-board/design.md §3a, §4.1, §4.8, §4.9.
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

// ── Public contract (FROZEN — must match the dashboard client types) ───────────

/** Per-fire history outcome labels (design §4.1; the D16 F-amendment merge). */
export type FireOutcomeLabel = 'ran' | 'completed (no chat output)' | 'failed' | 'missed' | 'cancelled';

export interface FireOutcome {
  /** Live row id / fire id for this entry. */
  id?: string;
  /** ISO timestamp of the fire (process_after for the entry). */
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
  /** Host-side pre-task script execution flag (content.scriptHost) — surfaced for the
   *  workgroup dashboard's "host-gated" badge (fleet-hardening Phase 3). */
  script_host: boolean;
  last_fires: FireOutcome[];
  available_verbs: Verb[];
}

export interface ScheduledSnapshot {
  rows: ScheduledRow[];
  degraded: boolean;
  counts: Record<string, number>;
  /**
   * Per-agent_group unreadable session count (E-3). The fleet-wide
   * `counts.unreadable` is a fleet assembly-health signal; a SCOPED caller must
   * see only its own groups' unreadable count, so the read handler sums this map
   * over the caller's in-scope groups rather than reusing the fleet total.
   */
  unreadable_by_group: Record<string, number>;
  /**
   * Server-side ONLY search blob per row key (lowercased name/group/channel/cron
   * PLUS parsed prompt + script). Powers the `?q=` search endpoint's prompt/script
   * matching. NEVER serialized to the wire — the list/search handlers pick fields
   * explicitly and never emit this map, so prompt/script stay detail-tier.
   */
  search_index: Record<string, string>;
  assembled_at: string;
}

export type AuthScopes = { role: string; allowed_group_ids: string[]; no_filter: boolean };

export interface ScheduledAssemblyOptions {
  /** Override the session data dir (tests). Defaults to DATA_DIR. */
  dataDir?: string;
  /** Override "now" (tests / determinism). Defaults to Date.now(). */
  nowMs?: number;
}

// Module-owned series detection now lives in scheduled-shared.ts (the single
// registry shared with the mutation handlers) — imported as `moduleOwner`.

// ── Time helpers ────────────────────────────────────────────────────────────────

/**
 * Parse a SQLite timestamp/ISO string to epoch ms. SQLite TIMESTAMP columns
 * store UTC without a zone marker; Date.parse treats those as local time, so
 * append Z when no zone marker is present (parseSqliteUtc precedent,
 * host-sweep.ts:86).
 */
function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : (s.includes('T') ? s : s.replace(' ', 'T')) + 'Z';
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/** Render an epoch-ms instant in the service timezone (with a TZ label), or null. */
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

// ── Health derivation (B2) ──────────────────────────────────────────────────────

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
   * The owning group's effective timezone, from `resolveGroupTimezone`. The
   * cadence interval is derived from the cron grid, and around a DST
   * transition that interval is 23 or 25 hours — so a group whose override
   * transitions on a different date than the install would be measured
   * against the wrong cadence and flip between `late` and `stalled` at the
   * wrong moment. Absent = the install timezone.
   */
  timezone?: string;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'expired']);

const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;

/**
 * The cron interval (ms) for the occurrence this row is ARMED on — parsed
 * identically to the firing path (recurrence.ts:31). Returns null on parse
 * failure or for one-offs (no cron).
 *
 * `anchorMs` is the armed occurrence (`process_after`), not the wall clock.
 * A cron interval is not a constant: across a DST transition a daily grid
 * measures 23 or 25 hours. Reading it from "now" means the same overdue row
 * changes cadence the instant its own due time slips into the past — a daily
 * task armed on the occurrence before a spring-forward is measured on the 23h
 * gap that occurrence opens while it is still upcoming, and on the following
 * 24h gap a second later, so its stall grace moves and the row can flip
 * between `late` and `stalled` with nothing about it having changed. Anchoring
 * at the armed occurrence makes the grace a property of the row.
 *
 * Anchoring one millisecond BEFORE the armed instant so the first occurrence
 * the parser yields is the armed one itself (cron-parser's `next()` is
 * exclusive of `currentDate`); the interval is then the gap that occurrence
 * opens. A `process_after` that has drifted off the grid still yields the two
 * surrounding occurrences, so the answer stays deterministic.
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

/**
 * Derive a series' health from its live row + observability facts — NEVER from
 * `status` alone (D6: the May/June die-off left no failed row). Exactly per
 * design §4.1.
 */
export function deriveHealth(ctx: HealthCtx): HealthState {
  if (ctx.status === 'paused') return 'paused';

  // Residual-strand: the latest row of the series is TERMINAL yet still carries
  // a recurrence (no live successor was minted — the swallowed-cron-parse-error
  // signature, recurrence.ts:46-52). A stateless persistence clock excludes the
  // legitimate transient between completion-sync and successor-insert: flag
  // strand only once aged past 2×SWEEP_INTERVAL via now − max(timestamp,
  // process_after) (§4.1).
  if (TERMINAL_STATUSES.has(ctx.status) && ctx.recurrence !== null) {
    const anchor = Math.max(ctx.timestampMs ?? 0, ctx.processAfterMs ?? 0);
    if (anchor > 0 && ctx.nowMs - anchor > 2 * SWEEP_INTERVAL_MS) return 'strand';
    // Within the transient grace — not yet a strand; treat as healthy (a
    // successor is expected imminently).
    return 'healthy';
  }

  const overdueBy = ctx.processAfterMs !== null ? ctx.nowMs - ctx.processAfterMs : 0;
  const overdue = overdueBy > 0;

  // Positive claim wins over lateness — the row is actively running.
  if (ctx.ackPresent) return 'processing';

  // Observability failure is NOT collapsed into "not claimed": an overdue row
  // whose outbound.db is unreadable is `unknown`, never silently healthy (F6).
  if (!ctx.outboundReadable && overdue) return 'unknown';

  if (!overdue) return 'healthy';

  // Overdue: late (immediately visible) until it crosses the stall grace.
  // Grace scales with cadence but is capped at an absolute 24h so a weekly/
  // monthly series can't be silently dead for days (S11).
  const interval = ctx.isOneOff
    ? 2 * SWEEP_INTERVAL_MS
    : cronIntervalMs(ctx.recurrence, ctx.timezone, ctx.processAfterMs);
  const cadenceGrace = interval !== null ? Math.max(interval * 0.5, 2 * SWEEP_INTERVAL_MS) : 2 * SWEEP_INTERVAL_MS;
  const stallGrace = Math.min(cadenceGrace, TWENTY_FOUR_H_MS);

  return overdueBy > stallGrace ? 'stalled' : 'late';
}

// ── Per-session read ──────────────────────────────────────────────────────────

/**
 * The board reads its rows through the mailbox module's named ops, so the row
 * shape is the module's. Aliased rather than re-declared: one definition, and
 * a column added there reaches the board without a second edit here.
 */
type RawRow = ScheduledTaskRow;

interface SessionDescriptor {
  agentGroupId: string;
  agentGroupName: string;
  provider: string | null;
  sessionId: string;
}

interface SessionReadResult {
  rows: ScheduledRow[];
  /** Per-row-key server-side search blob (incl. prompt/script). Wire-excluded. */
  searchByKey: Record<string, string>;
  unreadable: number;
}

/**
 * The board's session locator. `dataDir` rides along because the read layer
 * threads an injected fixture root through its whole path (its `ReadOptions`
 * test seam) and `DATA_DIR` is a module constant with no env override.
 */
function locate(dataDir: string, agentGroupId: string, sessionId: string): SessionReadLocation {
  return { dataDir, agentGroupId, sessionId };
}

/** Channel display name for a (channel_type, platform_id) destination, or null. */
function channelNameOf(
  mgByDest: Map<string, string>,
  channelType: string | null,
  platformId: string | null,
): string | null {
  if (!channelType || !platformId) return null;
  // S7: NUL (\0) separator — channel_type + platform_id are operator-controlled
  // and could collide under a printable separator ("a"+"b c" vs "a b"+"c"), but
  // \0 can appear in neither. The build sites (doAssemble + buildDetailRow) must
  // use the byte-identical key or the join silently returns null.
  return mgByDest.get(`${channelType}\0${platformId}`) ?? null;
}

interface OutboundView {
  readable: boolean;
  claimed: Set<string>;
}

/**
 * Read which fire-row ids are currently claimed (processing_ack='processing'),
 * opening outbound.db read-only. Returns `readable=false` if the file is
 * absent/corrupt (→ `unknown` health for overdue rows, never silently
 * not-claimed — F6/S9). Never throws. Fire-history replies are NOT read here —
 * the list path never needs them; the detail handler (B4) reads them on demand
 * for the single series it renders.
 */
function readOutbound(location: SessionReadLocation): OutboundView {
  try {
    const claimed = readSessionOutbound(location, (mailbox) => new Set(mailbox.listProcessingClaimedMessageIds()));
    // `undefined` is "this session has no outbound.db" — absent, not
    // unobservable — which is the same not-readable answer the existsSync
    // guard gave before the seam.
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
    // Mirrors src/cli/resources/tasks.ts's parseContent — content.scriptHost is
    // the only place this flag lives (not a DB column).
    scriptHost: parsed.scriptHost === true,
  };
}

/**
 * Server-side search blob for a row: lowercased name/group/channel/cron PLUS the
 * parsed prompt + script. Used only by the `?q=` search endpoint — NEVER
 * serialized to the wire (prompt/script stay detail-tier). Re-parses content
 * (cheap: one JSON.parse/row) to keep rawToRow's return type unchanged; the
 * malformed-JSON fallback in parseContent means the raw content is still
 * searchable even when it isn't valid prompt/script JSON.
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
  // Duplicate-successor rows are always flagged (the MAX(seq) read would hide
  // the second fireable row — §4.1). Surface them as stalled.
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
  // The one central read a row needs, resolved once per session and before the
  // read-only funnel opens, so the session read itself stays synchronous.
  const timezone = await resolveGroupTimezone(desc.agentGroupId);
  try {
    // Read-only seam, deliberately not `withExistingMailboxSession`: this runs
    // across EVERY session in the fleet on a console poll, and a board read
    // must never provision, schema-ensure or migrate a session it is only
    // listing (docs/specs/upstream-mailbox-seam/plan.md I-4, and the read-only
    // rationale in src/modules/mailbox/read-only.ts).
    const read = readSessionInbound(location, (mailbox) => {
      const dupSeries = new Set(mailbox.listDuplicateLiveTaskSeriesIds());
      // For duplicate series, return ALL live rows (not just MAX(seq)) so the
      // hidden second fireable row is visible.
      const dupRows: RawRow[] = [];
      for (const seriesId of dupSeries) dupRows.push(...mailbox.listLiveTaskRowsForSeries(seriesId));
      return {
        dupSeries,
        dupRows,
        latest: mailbox.listLatestRecurringSeriesRows(),
        oneOffs: mailbox.listLiveOneOffTaskRows(),
      };
    });
    // No mailbox on disk — nothing to contribute, and NOT an unreadable
    // session: absence is a complete answer, a failed read is not.
    if (!read) return { rows: [], searchByKey: {}, unreadable: 0 };
    const { dupSeries, dupRows, latest, oneOffs } = read;

    const outbound = readOutbound(location);

    const rows: ScheduledRow[] = [];
    const searchByKey: Record<string, string> = {};
    const emit = (raw: RawRow, forceUnhealthy: boolean): void => {
      const row = rawToRow(raw, desc, mgByDest, outbound, nowMs, forceUnhealthy, timezone);
      rows.push(row);
      searchByKey[row.key] = searchTextFor(raw, row);
    };

    // Duplicate series: every live row, all flagged.
    for (const raw of dupRows) {
      emit(raw, true);
    }
    // Latest-per-series recurring rows, skipping any series already emitted as
    // duplicates (the MAX(seq) row of a dup series is one of the dupRows).
    for (const raw of latest) {
      const seriesId = raw.series_id ?? raw.id;
      if (dupSeries.has(seriesId)) continue;
      emit(raw, false);
    }
    // One-off live rows (recurrence NULL), skipping dup series.
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

// ── Single-series detail row (B4 helper) ────────────────────────────────────────

/**
 * Build the FULL board row for ONE series — the detail endpoint's `row` (B4).
 * The drawer consumes a complete `ScheduledRow` (it reads `available_verbs`,
 * `health`, `agent_group_name`, `channel_name`, `module_owner`, `kind`,
 * `next_fire_local`, `quiet_status`, `flag_intent`), so the detail row must be
 * assembled with the same machinery as the list — not a thin projection.
 *
 * Resolves the live row (latest pending/paused) when present; otherwise the
 * latest row of any status so an ended/strand series still renders read-only.
 * Returns null when no row exists for the series (→ the handler maps to 404).
 * Health honors the strand verdict for a terminal-with-recurrence latest row.
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
  // Key MUST match channelNameOf's lookup format (S7). channelNameOf is the
  // shared getter for BOTH the list and detail paths, and it (plus doAssemble's
  // list-path map) keys on a NUL (\0) separator — channel_type and platform_id
  // are operator-controlled and could collide under a printable separator, but
  // \0 cannot appear in either. All three sites must agree or the join silently
  // returns null.
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
    // Same read-only seam as the list path: a detail render must not provision
    // or migrate the session it is rendering.
    const raw = readSessionInbound(
      location,
      (mailbox) => mailbox.getLiveSeriesRow(seriesId) ?? mailbox.getLatestSeriesRow(seriesId),
    );
    if (!raw) return null;
    // A cancelled series is intentionally ended and is excluded from the board
    // list (LATEST_PER_SERIES_SQL). The detail tier 404s to match — never
    // resolves a phantom 'strand'/'stalled' row for a task that's off the board.
    if (raw.status === 'cancelled') return null;

    const isLive = raw.status === 'pending' || raw.status === 'paused';
    const isStrand = !isLive && raw.recurrence !== null;
    const outbound = readOutbound(location);
    const row = rawToRow(raw, desc, mgByDest, outbound, nowMs, false, timezone);
    // A terminal-with-recurrence latest row is a residual strand; the §4.1
    // ladder in rawToRow only sees live rows, so force the verdict here.
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

// ── Snapshot assembly (B1) ──────────────────────────────────────────────────────

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

/** Yield to the event loop — one session per tick (§4.9). */
function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function countRow(counts: Record<string, number>, row: ScheduledRow): void {
  counts[row.health] = (counts[row.health] ?? 0) + 1;
  if (row.kind === 'one_off') counts.one_off = (counts.one_off ?? 0) + 1;
}

/**
 * Assemble the fleet snapshot. Single-flight: concurrent callers await the same
 * in-flight promise. The cache is populated only if the generation the assembly
 * started under is still current (a mid-assembly mutation forces a re-run).
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
    // S7: NUL (\0) key — byte-identical to channelNameOf's lookup + buildDetailRow's
    // build map (collision-safe; channel_type/platform_id can't contain \0).
    mgRows.map((m) => [`${m.channel_type}\0${m.platform_id}`, m.name ?? '']),
  );

  // Enumerate authorized sessions (scope filter — C7).
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
  // E-3: per-group unreadable buckets so a scoped caller can sum only its own.
  const unreadableByGroup: Record<string, number> = {};
  // Server-side search blobs (incl. prompt/script) keyed by row key. Cached on
  // the snapshot, never serialized to the wire (see ScheduledSnapshot.search_index).
  const searchIndex: Record<string, string> = {};

  for (const s of sessionRows) {
    await yieldTick(); // one session per event-loop tick — never one block (§4.9)
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

  // Read-your-own-write: only populate the cache if no mutation bumped the
  // generation while we assembled (§3a / S2). A stale assembly is returned to
  // its caller but never cached.
  const cache = getScheduledCache();
  if (cache.gen === startGen) {
    cache.data = snapshot as unknown as CacheSnapshot;
    cache.expiresMs = nowMs + CACHE_TTL_MS;
  }

  return snapshot;
}

/** Test seam: drop any in-flight assembly so suites don't bleed state. */
export function _resetAssemblyInFlightForTesting(): void {
  inFlight = null;
}
