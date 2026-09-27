/**
 * Central usage rollup: turn_usage rows that containers write to each session's outbound.db are folded into
 * `usage_daily` (additive UPSERT keyed on date, agent_group_id, provider, model) and mirrored 1:1 into the central
 * `turn_usage` ledger, in one transaction. The watermark in usage_rollup_state (one row per
 * `<agent-group>/<session>`) makes each row fold exactly once however often the sweep revisits a session.
 * Claude rows before ./usage-trust.ts's cutoff are untrusted (inflated token/cost totals); readers return the
 * untrusted note instead of a figure, and stored values are never rewritten.
 * `usage_daily.turns` counts rows, and a multi-model turn writes one row per model, so a SUM across buckets
 * over-counts turns. The honest count is `COUNT(DISTINCT turn_id)` over the central table (`summarizeTurnUsage`). The
 * writer is deliberately unchanged: per bucket the count is true, and de-duplicating would need cross-sweep state and
 * redefine an existing column.
 */
import { centralTransaction } from './central-lease.js';
import { getDb } from './connection.js';
import { isUntrustedUsageDay, UNTRUSTED_USAGE_NOTE, untrustedTurnUsageSql } from './usage-trust.js';
import { log } from '../log.js';
import type { NanoclawMailboxSession } from '../modules/mailbox/index.js';

// The row shape is the mailbox module's. Optional fields postdate the original table, so rows from older containers
// lack them and every read goes through `??`.

export interface StoredUsageDailyRow {
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
}

/**
 * Token and cost columns are NULL, with `untrusted` carrying the note, for a bucket inside the untrusted Claude
 * window. `turns` stays: it counts rows, which the defect never touched.
 */
export interface UsageDailyRow {
  date: string;
  agent_group_id: string;
  provider: string;
  model: string;
  turns: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  untrusted: string | null;
  /**
   * Whether cost_usd is a real figure. The column is `NOT NULL DEFAULT 0` (the additive rollup needs an identity), so
   * a provider that never reports cost sums to 0 just like one that spent nothing; $0 must not read as "free".
   * Computed at read time from `provider`, so it covers historical rows without a backfill.
   */
  cost_applicable: boolean;
}

/**
 * Providers whose usage protocol has no per-token cost field (Codex reports token counts only). Add
 * subscription-billed providers here rather than inventing a price.
 */
const PROVIDERS_WITHOUT_COST = new Set(['codex']);

function isCostApplicable(provider: string): boolean {
  return !PROVIDERS_WITHOUT_COST.has(provider);
}

/** The one way a stored usage_daily row reaches a reader. */
export function presentUsageDailyRow(row: StoredUsageDailyRow): UsageDailyRow {
  const base = { ...row, cost_applicable: isCostApplicable(row.provider) };
  if (!isUntrustedUsageDay(row.provider, row.date)) return { ...base, untrusted: null };
  return {
    ...base,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
    untrusted: UNTRUSTED_USAGE_NOTE,
  };
}

export type TurnUsageBatch = ReturnType<NanoclawMailboxSession['listTurnUsageSince']>;

/**
 * The highest turn_usage id already folded for one session (0 if never). Read BEFORE opening outbound.db so the
 * caller asks only for newer rows, and again inside `rollupSessionUsage`'s transaction, which keeps the fold
 * exactly-once when two sweeps race.
 */
export async function getUsageWatermark(sessionDirKey: string): Promise<number> {
  const row = await getDb().get<{ last_turn_usage_id: number }>(
    'SELECT last_turn_usage_id FROM usage_rollup_state WHERE session_dir = ?',
    sessionDirKey,
  );
  return row?.last_turn_usage_id ?? 0;
}

/**
 * Takes the ROWS, not the mailbox: the outbound read funnel closes the file when its synchronous action returns, and
 * this transaction is async, so they cannot nest. Nothing writes outbound.db (the container is its single writer).
 * The closure is DB-only. The watermark is re-read inside the transaction and rows at or below it skipped. Returns
 * the number of rows actually rolled up.
 */
export async function rollupSessionUsage(
  rows: TurnUsageBatch,
  agentGroupId: string,
  sessionDirKey: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  // sessionDirKey is always `<agent-group>/<session>`.
  const sessionId = sessionDirKey.startsWith(`${agentGroupId}/`)
    ? sessionDirKey.slice(agentGroupId.length + 1)
    : sessionDirKey;

  return centralTransaction(async () => {
    const db = getDb();
    const watermark = await getUsageWatermark(sessionDirKey);
    const fresh = rows.filter((row) => row.id > watermark);
    if (fresh.length === 0) return 0;
    let maxId = watermark;
    for (const row of fresh) {
      maxId = Math.max(maxId, row.id);
      // NULL numerics aggregate as 0 and NULL model as '', matching the usage_daily defaults.
      await db.run(
        `INSERT INTO usage_daily
           (date, agent_group_id, provider, model, turns, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES (@date, @agent_group_id, @provider, @model, 1, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd)
         ON CONFLICT(date, agent_group_id, provider, model) DO UPDATE SET
           turns = turns + 1,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           cost_usd = cost_usd + excluded.cost_usd`,
        {
          date: row.ts.slice(0, 10), // ts is ISO-8601 UTC, so its date prefix is the UTC day.
          agent_group_id: agentGroupId,
          provider: row.provider,
          model: row.model ?? '',
          input_tokens: row.input_tokens ?? 0,
          output_tokens: row.output_tokens ?? 0,
          cache_read_tokens: row.cache_read_tokens ?? 0,
          cache_write_tokens: row.cache_write_tokens ?? 0,
          cost_usd: row.cost_usd ?? 0,
        },
      );
      // A faithful per-turn mirror beside the usage_daily upsert; NULLs stay NULL here (a detail ledger, not an
      // additive aggregate).
      await db.run(
        `INSERT INTO turn_usage
           (ts, session_id, agent_group_id, provider, model, turn_id, steps, duration_ms, trigger, rate_limit_type, rate_limit_utilization, rate_limit_resets_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, effort, effort_requested)
         VALUES (@ts, @session_id, @agent_group_id, @provider, @model, @turn_id, @steps, @duration_ms, @trigger, @rate_limit_type, @rate_limit_utilization, @rate_limit_resets_at, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd, @effort, @effort_requested)`,
        {
          ts: row.ts,
          session_id: sessionId,
          agent_group_id: agentGroupId,
          provider: row.provider,
          model: row.model ?? null,
          turn_id: row.turn_id ?? null,
          // `??`, not `||`: a real 0 must survive.
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
          // A value dropped at this hop would read as measured-but-empty, which is worse than no column.
          effort: row.effort ?? null,
          effort_requested: row.effort_requested ?? null,
        },
      );
    }
    await db.run(
      `INSERT INTO usage_rollup_state (session_dir, last_turn_usage_id) VALUES (?, ?)
       ON CONFLICT(session_dir) DO UPDATE SET last_turn_usage_id = excluded.last_turn_usage_id`,
      sessionDirKey,
      maxId,
    );
    return fresh.length;
  }, 'rollupSessionUsage');
}

/** Backs `ncl usage list`; filters are optional and AND'd. */
export async function listUsageDaily(
  filters: { agentGroupId?: string; sinceDate?: string; days?: number } = {},
): Promise<UsageDailyRow[]> {
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
  const rows = await getDb().all<StoredUsageDailyRow>(
    `SELECT * FROM usage_daily${clause} ORDER BY date DESC, agent_group_id, provider, model LIMIT 1000`,
    ...params,
  );
  return rows.map(presentUsageDailyRow);
}

const USAGE_DIMENSIONS = {
  group: 'agent_group_id',
  provider: 'provider',
  model: "COALESCE(model, '')",
  day: 'substr(ts, 1, 10)',
  session: 'session_id',
  // NULL buckets as '' like model, where '' means either a row predating migration 075 or an unattributable subagent
  // model on a multi-model turn. Neither means "ran at no effort".
  effort: "COALESCE(effort, '')",
} as const;

export type UsageDimension = keyof typeof USAGE_DIMENSIONS;

export const USAGE_DIMENSION_NAMES = Object.keys(USAGE_DIMENSIONS) as UsageDimension[];

/** NULL is an untrusted-only bucket's "no figure" and `untrusted`'s "clean". */
export type TurnUsageSummaryRow = Record<string, string | number | null>;

/**
 * Summarizes the central turn_usage ledger.
 * `turns` is `COUNT(DISTINCT turn_id)`, not a row count (a turn spanning N models writes N rows); rows without a
 * turn_id (pre-migration 061) count as one turn each.
 * The `TOTAL` row is its own un-grouped query, NOT the sum of buckets: a turn straddling several buckets would be
 * double-counted.
 * Tokens stay split because nearly all volume is cache_read.
 */
export async function summarizeTurnUsage(
  filters: { dimensions?: UsageDimension[]; agentGroupId?: string; sinceDate?: string; days?: number } = {},
): Promise<TurnUsageSummaryRow[]> {
  const dims: UsageDimension[] = filters.dimensions?.length ? filters.dimensions : ['group'];

  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.agentGroupId) {
    where.push('agent_group_id = ?');
    params.push(filters.agentGroupId);
  }
  // ts is ISO-8601 UTC, so a lexical `>=` on a date prefix is a correct day boundary and uses idx_turn_usage_ts.
  if (filters.sinceDate) {
    where.push('ts >= ?');
    params.push(filters.sinceDate);
  }
  if (filters.days !== undefined) {
    where.push('ts >= ?');
    params.push(new Date(Date.now() - filters.days * 86_400_000).toISOString().slice(0, 10));
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

  // Every SUM is wrapped: SUM over zero rows is NULL, and the TOTAL query always returns a row. Token and cost sums
  // cover TRUSTED rows only; untrusted rows are counted and named, and per-turn averages divide by trusted turns.
  const untrusted = untrustedTurnUsageSql();
  const trusted = `NOT ${untrusted}`;
  const trustedSum = (col: string): string => `COALESCE(SUM(CASE WHEN ${trusted} THEN ${col} END), 0) AS ${col}`;
  const metrics = `
    COUNT(DISTINCT turn_id) + COALESCE(SUM(turn_id IS NULL), 0) AS turns,
    COUNT(DISTINCT CASE WHEN ${trusted} THEN turn_id END)
      + COALESCE(SUM(turn_id IS NULL AND ${trusted}), 0) AS trusted_turns,
    COALESCE(SUM(${untrusted}), 0) AS untrusted_rows,
    ${trustedSum('input_tokens')},
    ${trustedSum('cache_read_tokens')},
    ${trustedSum('cache_write_tokens')},
    ${trustedSum('output_tokens')},
    ${trustedSum('cost_usd')}`;

  const db = getDb();
  const selectDims = dims.map((d) => `${USAGE_DIMENSIONS[d]} AS "${d}"`).join(', ');
  const order = dims.includes('day') ? '"day" DESC' : 'cache_read_tokens DESC';
  const buckets = await db.all<Record<string, string | number>>(
    `SELECT ${selectDims}, ${metrics} FROM turn_usage${clause}
       GROUP BY ${dims.map((d) => USAGE_DIMENSIONS[d]).join(', ')}
       ORDER BY ${order} LIMIT 1000`,
    ...params,
  );
  // Defensive only: the un-grouped TOTAL query always returns a row.
  const total =
    (await db.get<Record<string, string | number>>(`SELECT ${metrics} FROM turn_usage${clause}`, ...params)) ?? null;

  const decorate = (
    row: Record<string, string | number> | null,
    label: Record<string, string>,
  ): TurnUsageSummaryRow => {
    const turns = Number(row?.turns ?? 0);
    const trustedTurns = Number(row?.trusted_turns ?? 0);
    const untrustedRows = Number(row?.untrusted_rows ?? 0);
    const per = (n: unknown): number => (trustedTurns > 0 ? Math.round(Number(n ?? 0) / trustedTurns) : 0);
    const decorated: TurnUsageSummaryRow = {
      ...label,
      ...row,
      turns,
      trusted_turns: trustedTurns,
      untrusted_rows: untrustedRows,
      cost_usd: Math.round(Number(row?.cost_usd ?? 0) * 10_000) / 10_000,
      input_per_turn: per(row?.input_tokens),
      cache_read_per_turn: per(row?.cache_read_tokens),
      output_per_turn: per(row?.output_tokens),
      untrusted: untrustedRows > 0 ? `${untrustedRows} row(s) not summed — ${UNTRUSTED_USAGE_NOTE}` : null,
    };
    // An untrusted-only bucket's zero sums would read as "spent nothing", so they become NULL beside the note.
    if (untrustedRows > 0 && trustedTurns === 0) {
      for (const key of [
        'input_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'output_tokens',
        'cost_usd',
        'input_per_turn',
        'cache_read_per_turn',
        'output_per_turn',
      ]) {
        decorated[key] = null;
      }
    }
    return decorated;
  };

  const rows = buckets.map((b) => decorate(b, {}));
  // TOTAL is emitted even for an empty ledger, so "no usage" never looks like a broken query.
  const totalLabel = Object.fromEntries(dims.map((d, i) => [d, i === 0 ? 'TOTAL' : '']));
  rows.push(decorate(total, totalLabel));
  return rows;
}

const TURN_USAGE_RETENTION_DAYS = 30;

/** Called from the host sweep; the per-tick cost is trivial. A prune failure never blocks the rest of the sweep. */
export async function pruneOldTurnUsage(): Promise<number> {
  try {
    const result = await getDb().run(
      `DELETE FROM turn_usage WHERE datetime(ts) < datetime('now', '-${TURN_USAGE_RETENTION_DAYS} days')`,
    );
    return result.changes;
  } catch (err) {
    log.warn('pruneOldTurnUsage: failed', { err });
    return 0;
  }
}
