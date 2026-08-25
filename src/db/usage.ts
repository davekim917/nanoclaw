/**
 * Central usage_daily rollup — turn_usage rows written by containers into
 * each session's outbound.db (fleet-hardening Phase 0.1, per-turn usage
 * accounting) get aggregated here so `ncl usage`
 * can answer "what is a group spending" without any caller reading another
 * session's outbound.db directly.
 *
 * Additive UPSERT keyed on (date, agent_group_id, provider, model); the
 * watermark in usage_rollup_state (one row per `<agent-group>/<session>`)
 * guarantees a turn_usage row is folded in exactly once no matter how many
 * times the host sweep revisits a session.
 *
 * Fleet-hardening Phase 0.1 follow-up (per-turn cost attribution): the same
 * rows are ALSO mirrored 1:1 into a central `turn_usage` ledger (migration
 * 059) in the same transaction — usage_daily's shape, keys, and watermark
 * above are unchanged by this. See rollupSessionUsage.
 *
 * NOTE ON HISTORICAL DATA (2026-08-24): rows written by a container before
 * the cumulative-usage fix (container/agent-runner/src/db/turn-usage.ts)
 * landed have INFLATED Claude token/cost totals — the SDK's running-total-
 * for-the-whole-stream value was recorded on every turn instead of that
 * turn's own delta, measured at 1.3-5.2x inflation. Nothing here corrects
 * that retroactively; treat usage_daily/turn_usage rows from before that fix
 * as directional only, not exact.
 *
 * NOTE ON usage_daily.turns (turn-correlation fix, migration 061): a turn
 * spanning multiple models writes one turn_usage row per model, so
 * usage_daily's row-counting `turns = turns + 1` (below) over-counts by
 * exactly that factor — measured ~1.35x fleet-wide, up to 1.62x for the
 * heaviest group. `turn_id` (mirrored into the central turn_usage row below)
 * is shared by every row one turn writes, so the true count is
 * `COUNT(DISTINCT turn_id)` against the central table.
 *
 * This stays a READ-side fix (summarizeTurnUsage below, exposed as `ncl usage
 * summary`) and the write path is deliberately unchanged: per (date, group,
 * provider, model) bucket, "one turn touched opus" and "one turn touched
 * sonnet" are both true statements about the same turn, so `turns = turns + 1`
 * is correct for the row it increments. Only the SUM ACROSS buckets lies, and
 * no honest per-model number can be recovered from a de-duplicated write.
 * Making the writer de-duplicate would also need cross-sweep state
 * (usage_daily is an additive upsert over a watermark, so it never sees a
 * turn's rows together) and would silently redefine an existing column.
 */
import type Database from 'better-sqlite3';

import { getDb, hasTable } from './connection.js';
import { log } from '../log.js';

interface TurnUsageRow {
  id: number;
  ts: string;
  provider: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  // Added after the columns above (Phase 0.1 follow-up) — a row rolled up
  // from a container that predates them arrives with these keys absent
  // entirely (not present on the object at all, since `SELECT *` only
  // returns columns that exist), so every read below goes through `??`.
  steps?: number | null;
  duration_ms?: number | null;
  trigger?: string | null;
  rate_limit_type?: string | null;
  rate_limit_utilization?: number | null;
  rate_limit_resets_at?: string | null;
  turn_id?: string | null;
}

export interface UsageDailyRow {
  date: string;
  agent_group_id: string;
  provider: string;
  model: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  /**
   * Whether cost_usd for this row is a real dollar figure vs a coerced-null
   * zero. `usage_daily.cost_usd` is `REAL NOT NULL DEFAULT 0` (an additive
   * rollup needs an identity element), so a provider whose protocol never
   * reports cost (see PROVIDERS_WITHOUT_COST below) sums to 0 identically to
   * a metered provider that genuinely spent nothing — those are NOT the same
   * thing, and $0 must not be read as "free" for the former. Computed at
   * read time from `provider`, never stored, so it applies uniformly to
   * historical rows with no backfill and no risk of touching real data.
   */
  cost_applicable: boolean;
}

/**
 * Providers whose usage protocol has no per-token cost field at all — Codex's
 * app-server reports token counts only (ChatGPT-plan/subscription billing,
 * not per-token API pricing; see the source comment at
 * container/agent-runner/src/providers/codex.ts's tokenUsageState — "No cost
 * field exists on this protocol ... cost_usd stays NULL for codex"). Claude
 * (SDK-reported costUSD) and OpenCode (assistantUsage.cost from a metered
 * Zen/Go provider) both report a real per-turn dollar figure, so they are
 * cost-applicable. If a future provider is added with subscription-style
 * billing, add it here rather than inventing a notional price for it.
 */
const PROVIDERS_WITHOUT_COST = new Set(['codex']);

/** Exported so callers doing their own raw usage_daily queries (e.g. the dashboard's multi-group IN-list, which listUsageDaily's single-agentGroupId filter doesn't support) can attach the same computed flag rather than re-deriving it. */
export function isCostApplicable(provider: string): boolean {
  return !PROVIDERS_WITHOUT_COST.has(provider);
}

function getWatermark(sessionDirKey: string): number {
  const row = getDb()
    .prepare('SELECT last_turn_usage_id FROM usage_rollup_state WHERE session_dir = ?')
    .get(sessionDirKey) as { last_turn_usage_id: number } | undefined;
  return row?.last_turn_usage_id ?? 0;
}

/**
 * Roll a session's new turn_usage rows (id > watermark) into usage_daily and
 * advance the watermark, in one central-DB transaction. `outDb` is a
 * read-only handle the caller opens/closes — never written here, respecting
 * the outbound.db single-writer split (host reads outbound.db, never writes
 * it). Missing table, empty result, or an already-caught-up watermark are all
 * the normal "nothing to do" case, not an error. Returns the row count rolled
 * up.
 */
export function rollupSessionUsage(outDb: Database.Database, agentGroupId: string, sessionDirKey: string): number {
  if (!hasTable(outDb, 'turn_usage')) return 0;

  const watermark = getWatermark(sessionDirKey);
  const rows = outDb.prepare('SELECT * FROM turn_usage WHERE id > ? ORDER BY id ASC').all(watermark) as TurnUsageRow[];
  if (rows.length === 0) return 0;

  // sessionDirKey is the fixed `<agent-group>/<session>` contract (see the
  // watermark table's own comment) — derive session_id from it rather than
  // adding a parameter, since every caller already builds sessionDirKey from
  // exactly these two pieces.
  const sessionId = sessionDirKey.startsWith(`${agentGroupId}/`)
    ? sessionDirKey.slice(agentGroupId.length + 1)
    : sessionDirKey;

  const db = getDb();
  let maxId = watermark;
  db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO usage_daily
        (date, agent_group_id, provider, model, turns, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
      VALUES (@date, @agent_group_id, @provider, @model, 1, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd)
      ON CONFLICT(date, agent_group_id, provider, model) DO UPDATE SET
        turns = turns + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        cost_usd = cost_usd + excluded.cost_usd
    `);
    // Fleet-hardening Phase 0.1 follow-up: a faithful 1:1 per-turn mirror,
    // written alongside the usage_daily upsert above rather than replacing
    // it — `ncl usage` and the dashboard read usage_daily and must not see
    // any behavior change. Unlike usage_daily, NULLs stay NULL here (this is
    // a detail ledger, not an additive aggregate with an identity element).
    const insertCentral = db.prepare(`
      INSERT INTO turn_usage
        (ts, session_id, agent_group_id, provider, model, turn_id, steps, duration_ms, trigger, rate_limit_type, rate_limit_utilization, rate_limit_resets_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
      VALUES (@ts, @session_id, @agent_group_id, @provider, @model, @turn_id, @steps, @duration_ms, @trigger, @rate_limit_type, @rate_limit_utilization, @rate_limit_resets_at, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd)
    `);
    for (const row of rows) {
      maxId = Math.max(maxId, row.id);
      // NULL numeric columns (provider didn't report that field) aggregate as
      // 0; NULL model aggregates as '' — both match the usage_daily schema
      // defaults so a partial turn_usage row never breaks the rollup.
      upsert.run({
        date: row.ts.slice(0, 10), // ts is ISO-8601 UTC; the date prefix IS the UTC day.
        agent_group_id: agentGroupId,
        provider: row.provider,
        model: row.model ?? '',
        input_tokens: row.input_tokens ?? 0,
        output_tokens: row.output_tokens ?? 0,
        cache_read_tokens: row.cache_read_tokens ?? 0,
        cache_write_tokens: row.cache_write_tokens ?? 0,
        cost_usd: row.cost_usd ?? 0,
      });
      insertCentral.run({
        ts: row.ts,
        session_id: sessionId,
        agent_group_id: agentGroupId,
        provider: row.provider,
        model: row.model ?? null,
        turn_id: row.turn_id ?? null,
        // `??` (not `||`) so a real 0 steps/duration_ms survives — only an
        // absent/null value (old container, or a provider with no signal)
        // becomes NULL.
        steps: row.steps ?? null,
        duration_ms: row.duration_ms ?? null,
        trigger: row.trigger ?? null,
        rate_limit_type: row.rate_limit_type ?? null,
        rate_limit_utilization: row.rate_limit_utilization ?? null,
        rate_limit_resets_at: row.rate_limit_resets_at ?? null,
        input_tokens: row.input_tokens ?? null,
        output_tokens: row.output_tokens ?? null,
        cache_read_tokens: row.cache_read_tokens ?? null,
        cache_write_tokens: row.cache_write_tokens ?? null,
        cost_usd: row.cost_usd ?? null,
      });
    }
    db.prepare(
      `INSERT INTO usage_rollup_state (session_dir, last_turn_usage_id) VALUES (?, ?)
       ON CONFLICT(session_dir) DO UPDATE SET last_turn_usage_id = excluded.last_turn_usage_id`,
    ).run(sessionDirKey, maxId);
  })();
  return rows.length;
}

/** Read-side query backing `ncl usage list`. Filters are optional and AND'd. */
export function listUsageDaily(
  filters: { agentGroupId?: string; sinceDate?: string; days?: number } = {},
): UsageDailyRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.agentGroupId) {
    where.push('agent_group_id = ?');
    params.push(filters.agentGroupId);
  }
  if (filters.sinceDate) {
    where.push('date >= ?');
    params.push(filters.sinceDate);
  }
  if (filters.days !== undefined) {
    where.push('date >= ?');
    params.push(new Date(Date.now() - filters.days * 86_400_000).toISOString().slice(0, 10));
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`SELECT * FROM usage_daily${clause} ORDER BY date DESC, agent_group_id, provider, model LIMIT 1000`)
    .all(...params) as Omit<UsageDailyRow, 'cost_applicable'>[];
  return rows.map((row) => ({ ...row, cost_applicable: isCostApplicable(row.provider) }));
}

// ---------------------------------------------------------------------------
// Accurate read surface over the central turn_usage ledger
// ---------------------------------------------------------------------------

/** Dimension name -> the SQL expression that buckets by it. */
const USAGE_DIMENSIONS = {
  group: 'agent_group_id',
  provider: 'provider',
  model: "COALESCE(model, '')",
  day: 'substr(ts, 1, 10)',
  session: 'session_id',
} as const;

export type UsageDimension = keyof typeof USAGE_DIMENSIONS;

export const USAGE_DIMENSION_NAMES = Object.keys(USAGE_DIMENSIONS) as UsageDimension[];

/** One bucket of the summary, plus the synthetic `TOTAL` row appended last. */
export type TurnUsageSummaryRow = Record<string, string | number>;

/**
 * Summarize the central turn_usage ledger — the accurate per-turn data that
 * until now had zero consumers in src/.
 *
 * Two things here are deliberate and are the whole point of the verb:
 *
 * 1. `turns` is `COUNT(DISTINCT turn_id)`, not a row count. A turn spanning N
 *    models writes N rows (measured 1.40x fleet-wide), so a row count is not
 *    a turn count. Rows written by a container older than migration 061 carry
 *    no turn_id; each of those counts as one turn (`SUM(turn_id IS NULL)`) —
 *    the pre-turn_id best guess — rather than being dropped by COUNT DISTINCT.
 *
 * 2. The `TOTAL` row is its own un-grouped query, NOT the sum of the buckets.
 *    Grouping by `model` (or any dimension one turn can straddle) puts that
 *    turn in several buckets, so a bucket's `turns` reads as "turns that
 *    touched this model" — true per bucket, but summing them double-counts.
 *    Re-querying without the GROUP BY is the only way the total stays an
 *    honest fleet turn count.
 *
 * Tokens are reported split (input / cache_read / cache_write / output)
 * rather than as one number because measured fleet volume is ~96% cache_read
 * — a collapsed "tokens" column hides the entire cost story.
 */
export function summarizeTurnUsage(
  filters: { dimensions?: UsageDimension[]; agentGroupId?: string; sinceDate?: string; days?: number } = {},
): TurnUsageSummaryRow[] {
  const dims: UsageDimension[] = filters.dimensions?.length ? filters.dimensions : ['group'];

  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.agentGroupId) {
    where.push('agent_group_id = ?');
    params.push(filters.agentGroupId);
  }
  // ts is ISO-8601 UTC, so a lexical `>=` against a YYYY-MM-DD prefix is a
  // correct day-boundary filter and stays usable by idx_turn_usage_ts.
  if (filters.sinceDate) {
    where.push('ts >= ?');
    params.push(filters.sinceDate);
  }
  if (filters.days !== undefined) {
    where.push('ts >= ?');
    params.push(new Date(Date.now() - filters.days * 86_400_000).toISOString().slice(0, 10));
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

  // Every SUM is wrapped: over zero rows SQLite's SUM returns NULL, not 0, and
  // the un-grouped TOTAL query always produces a row — so an empty window
  // would otherwise report `null` tokens rather than `0`.
  const metrics = `
    COUNT(DISTINCT turn_id) + COALESCE(SUM(turn_id IS NULL), 0) AS turns,
    COALESCE(SUM(input_tokens), 0) AS input_tokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
    COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(cost_usd), 0) AS cost_usd`;

  const db = getDb();
  const selectDims = dims.map((d) => `${USAGE_DIMENSIONS[d]} AS "${d}"`).join(', ');
  const order = dims.includes('day') ? '"day" DESC' : 'cache_read_tokens DESC';
  const buckets = db
    .prepare(
      `SELECT ${selectDims}, ${metrics} FROM turn_usage${clause}
       GROUP BY ${dims.map((d) => USAGE_DIMENSIONS[d]).join(', ')}
       ORDER BY ${order} LIMIT 1000`,
    )
    .all(...params) as Record<string, string | number>[];
  const total = db.prepare(`SELECT ${metrics} FROM turn_usage${clause}`).get(...params) as Record<
    string,
    string | number
  > | null;

  const decorate = (
    row: Record<string, string | number> | null,
    label: Record<string, string>,
  ): TurnUsageSummaryRow => {
    const turns = Number(row?.turns ?? 0);
    const per = (n: unknown): number => (turns > 0 ? Math.round(Number(n ?? 0) / turns) : 0);
    return {
      ...label,
      ...row,
      turns,
      cost_usd: Math.round(Number(row?.cost_usd ?? 0) * 10_000) / 10_000,
      input_per_turn: per(row?.input_tokens),
      cache_read_per_turn: per(row?.cache_read_tokens),
      output_per_turn: per(row?.output_tokens),
    };
  };

  const rows = buckets.map((b) => decorate(b, {}));
  // The TOTAL row is emitted even for an empty ledger (all zeros) — "no usage
  // in this window" and "the query returned nothing because it is broken"
  // must not look identical to an operator.
  const totalLabel = Object.fromEntries(dims.map((d, i) => [d, i === 0 ? 'TOTAL' : '']));
  rows.push(decorate(total, totalLabel));
  return rows;
}

const TURN_USAGE_RETENTION_DAYS = 30;

/**
 * Delete central turn_usage rows older than the retention window. Called
 * from the host sweep (60s tick) — fleet volume is ~300-600 turns/day, so
 * this is a trivial per-tick cost and doesn't need its own timer. Self-
 * contained try/catch so a prune failure never blocks the rest of the sweep.
 */
export function pruneOldTurnUsage(): number {
  try {
    return getDb()
      .prepare(`DELETE FROM turn_usage WHERE datetime(ts) < datetime('now', '-${TURN_USAGE_RETENTION_DAYS} days')`)
      .run().changes;
  } catch (err) {
    log.warn('pruneOldTurnUsage: failed', { err });
    return 0;
  }
}
