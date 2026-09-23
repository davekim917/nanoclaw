/**
 * `ncl usage summary` — the read surface over the accurate per-turn ledger.
 *
 * The query itself is covered in src/db/usage.test.ts; this file covers the
 * CLI seam: the verb is registered, a bad `--by` is rejected loudly instead of
 * silently answering a different question, and the resource stays operator-only
 * for a container agent under `cli_scope=group`.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getRawDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
// Side-effect import: registers the `usage-list` / `usage-summary` commands.
import './usage.js';

const GID = 'ag-usage-cli';
const HOST: CallerContext = { caller: 'host', sessionId: '', agentGroupId: '' } as CallerContext;

// Dated after the #1061 cutoff (src/db/usage-trust.ts): a Claude row inside
// the untrusted window is counted but never summed, and this file tests the
// CLI seam, not that rule (src/db/usage.test.ts covers it).
function insertCentralTurn(turnId: string, model: string, cacheRead: number): void {
  getRawDb()
    .prepare(
      `INSERT INTO turn_usage (ts, session_id, agent_group_id, provider, model, turn_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES ('2026-10-01T12:00:00.000Z', 'sess-1', ?, 'claude', ?, ?, 10, 5, ?, 1, 0.25)`,
    )
    .run(GID, model, turnId, cacheRead);
}

describe('ncl usage summary', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    await createAgentGroup({
      id: GID,
      name: 'usage-cli',
      folder: 'usage-cli',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(() => closeDb());

  it('is registered and returns the accurate turn count for a host caller', async () => {
    insertCentralTurn('t-1', 'claude-opus-5', 1000);
    insertCentralTurn('t-1', 'claude-sonnet-5', 2000); // same turn, second model
    insertCentralTurn('t-2', 'claude-opus-5', 3000);

    const res = await dispatch({ id: '1', command: 'usage-summary', args: {} }, HOST);
    expect(res.ok).toBe(true);
    const rows = (res as { data: Array<Record<string, unknown>> }).data;
    const total = rows.at(-1)!;
    expect(total.group).toBe('TOTAL');
    // 3 rows, 2 turns. A row count here would read 3.
    expect(total.turns).toBe(2);
    expect(total.cache_read_tokens).toBe(6000);
    expect(total.cache_read_per_turn).toBe(3000);
  });

  it('rejects an unknown --by dimension instead of silently falling back to group', async () => {
    const res = await dispatch({ id: '2', command: 'usage-summary', args: { by: 'provider,wat' } }, HOST);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('wat');
  });

  it('is operator-only — a container agent under cli_scope=group is rejected', async () => {
    const agent: CallerContext = {
      caller: 'agent',
      sessionId: 'sess-1',
      agentGroupId: GID,
    } as CallerContext;
    const res = await dispatch({ id: '3', command: 'usage-summary', args: {} }, agent);
    expect(res.ok).toBe(false);
  });
});
