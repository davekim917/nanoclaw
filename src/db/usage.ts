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
 * turn's own delta, measured at 1.3-5.2x inflation. That fix left a second
 * defect in place until 2026-09-22, so EVERY Claude row before
 * ./usage-trust.ts's cutoff is untrusted: the readers below return the
 * untrusted note instead of a figure for it. The stored values are never
 * rewritten.
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
import { centralTransaction } from './central-lease.js';
import { getDb } from './connection.js';
import { isUntrustedUsageDay, UNTRUSTED_USAGE_NOTE, untrustedTurnUsageSql } from './usage-trust.js';
import { log } from '../log.js';
import type { NanoclawMailboxSession } from '../modules/mailbox/index.js';

// The per-turn row shape is the mailbox module's — it owns the session-DB
// shape, and `listTurnUsageSince` is what this file reads it through. Its
// optional fields postdate the original table, so a row from an older
// container arrives without those keys and every read below goes through `??`.

/** A usage_daily row as stored. */
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
 * A usage_daily row as readers present it. The token and cost columns are
 * NULL, and `untrusted` carries the untrusted note, for a bucket inside the
 * untrusted Claude window (./usage-trust.ts) — a stored sum there is not a
 * figure anyone may quote. `turns` stays: it counts rows, which the defect
 * never touched.
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
function isCostApplicable(provider: string): boolean {
  return !PROVIDERS_WITHOUT_COST.has(provider);
}

/** The one way a stored usage_daily row reaches a reader — every read surface goes through it. */
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

/** The turn_usage rows one session read hands over, in the mailbox's own shape. */
export type TurnUsageBatch = ReturnType<NanoclawMailboxSession['listTurnUsageSince']>;

/**
 * The rollup watermark for one `<agent-group>/<session>`: the highest
 * outbound turn_usage id already folded into the central tables (0 when the
 * session has never been rolled up).
 *
 * Read BEFORE the session's outbound.db is opened, so the caller asks the
 * mailbox for exactly the rows above it (`listTurnUsageSince`), and read
 * AGAIN inside `rollupSessionUsage`'s transaction, which is what keeps the
 * fold exactly-once when two sweeps race on one session.
 */
export async function getUsageWatermark(sessionDirKey: string): Promise<number> {
  const row = await getDb().get<{ last_turn_usage_id: number }>(
    'SELECT last_turn_usage_id FROM usage_rollup_state WHERE session_dir = ?',
    sessionDirKey,
  );
  return row?.last_turn_usage_id ?? 0;
}

/**
 * Roll a batch of a session's turn_usage rows into usage_daily and the central
 * turn_usage mirror and advance the watermark, in one central-DB transaction.
 *
 * Takes the ROWS, not the mailbox. The outbound read funnel
 * (`readSessionOutbound`) closes the session file the moment its synchronous
 * action returns, and the central transaction is asynchronous, so the two
 * cannot nest: the caller reads `getUsageWatermark` → opens the outbound
 * mailbox → `listTurnUsageSince(watermark)` → hands the rows here. Nothing is
 * written to outbound.db by any of that, which is the single-writer split (the
 * container writes it, the host reads it).
 *
 * The closure is DB-only (plan §4.4): driver statements, awaited in sequence.
 * The watermark is re-read INSIDE the transaction and rows at or below it are
 * skipped, so a second sweep that read the same batch before this one
 * committed folds nothing twice — the pre-seam guarantee, now held by the
 * transaction rather than by a synchronous closure. Returns the row count
 * actually rolled up; an empty batch or a fully-superseded one is 0.
 */
export async function rollupSessionUsage(
  rows: TurnUsageBatch,
  agentGroupId: string,
  sessionDirKey: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  // sessionDirKey is the fixed `<agent-group>/<session>` contract (see the
  // watermark table's own comment) — derive session_id from it rather than
  // adding a parameter, since every caller already builds sessionDirKey from
  // exactly these two pieces.
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
      // NULL numeric columns (provider didn't report that field) aggregate as
      // 0; NULL model aggregates as '' — both match the usage_daily schema
      // defaults so a partial turn_usage row never breaks the rollup.
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
          date: row.ts.slice(0, 10), // ts is ISO-8601 UTC; the date prefix IS the UTC day.
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
      // Fleet-hardening Phase 0.1 follow-up: a faithful 1:1 per-turn mirror,
      // written alongside the usage_daily upsert above rather than replacing
      // it — `ncl usage` and the dashboard read usage_daily and must not see
      // any behavior change. Unlike usage_daily, NULLs stay NULL here (this is
      // a detail ledger, not an additive aggregate with an identity element).
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
          // The whole point of the column is that it survives THIS hop: a
          // value that lands in the session DB and is dropped at the mirror
          // is worse than no column, because it reads as measured.
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

/** Read-side query backing `ncl usage list`. Filters are optional and AND'd. */
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
  // `ncl usage summary --by group,model,effort` is the query that proves a
  // group's configured effort reached its container. NULL buckets as '' the
  // same way model does — and here '' has two meanings that must not be
  // confused: a row predating migration 075 (no data ever existed) and a row
  // the attribution rule left unattributable (a subagent model on a
  // multi-model turn). Neither is "ran at no effort".
  effort: "COALESCE(effort, '')",
} as const;

export type UsageDimension = keyof typeof USAGE_DIMENSIONS;

export const USAGE_DIMENSION_NAMES = Object.keys(USAGE_DIMENSIONS) as UsageDimension[];

/**
 * One bucket of the summary, plus the synthetic `TOTAL` row appended last.
 * NULL is the untrusted-only bucket's "no figure" and `untrusted`'s "clean".
 */
export type TurnUsageSummaryRow = Record<string, string | number | null>;

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
  //
  // Token and cost sums cover TRUSTED rows only (./usage-trust.ts);
  // untrusted rows are counted, not summed, and `decorate` names them. `turns`
  // still counts every turn — the defect never touched turn identity — while
  // the per-turn averages divide by the trusted turns the sums came from.
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
  // `get` resolves to `undefined` where `.get()` returned `undefined` too; the
  // un-grouped TOTAL query always produces a row, so this is defensive only and
  // `decorate` already renders a null/absent row as all zeros.
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
    // A bucket made only of untrusted rows has no figure at all. Its zero sums
    // would read as "spent nothing", so they become NULL beside the note.
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
