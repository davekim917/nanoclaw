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
 */
import type Database from 'better-sqlite3';

import { getDb, hasTable } from './connection.js';

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
  return getDb()
    .prepare(`SELECT * FROM usage_daily${clause} ORDER BY date DESC, agent_group_id, provider, model LIMIT 1000`)
    .all(...params) as UsageDailyRow[];
}
