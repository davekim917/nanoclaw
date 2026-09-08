import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 076 — turn_usage effort columns
 *
 * Added after migration 061 (additive ALTER, same pattern as the
 * container-side turn_usage columns in
 * container/agent-runner/src/modules/mailbox/schema.ts). Every existing
 * migration stays immutable — this is its own step rather than an edit to
 * 059/060/061.
 *
 * WHY. Every other column in this table is a MEASUREMENT: `model` comes from
 * the provider's own usage report, keyed on what the API billed. Effort is a
 * REQUEST parameter that no provider bills back, so nothing in the ledger
 * could confirm it — and a class of silent config no-ops, where
 * `ncl groups config update --model/--effort` never reached a Claude
 * container, survived unnoticed across nine agent groups for months
 * (2026-09-07, PRs #532/#540/#535). The model half of each of those findings
 * was measurable from this table; the effort half rested entirely on code
 * reading. These columns close that gap.
 *
 * `effort` is EFFECTIVE — post-clamp, the value actually handed to the
 * provider. `effort_requested` is what the resolution chain produced BEFORE
 * the clamp. They diverge exactly where the clamp does something: a Haiku turn
 * resolves `high` from group config and sends nothing (Haiku has no effort
 * control), and a `-e` outside a provider's vocabulary is dropped for the
 * sticky default. With only the effective value, both read identically to
 * "effort was never configured" — the failure mode these columns exist to
 * catch.
 *
 * CUTOFF — 2026-09-07, NO BACKFILL. The value never existed for earlier
 * turns, so nothing can reconstruct it. Every row written before a container
 * carrying these columns is NULL, and NULL here means "not recorded", NEVER
 * "ran at no effort". Two live NULLs are also expected forever after the
 * cutoff, and are equally not measurements of zero effort:
 *   - Haiku (and any future model with no effort control), where `effort` is
 *     NULL by design and `effort_requested` carries what was asked for;
 *   - subagent-model rows on a multi-model Claude turn, which the attribution
 *     rule leaves NULL because we never set a subagent's effort and will not
 *     guess (container/agent-runner/src/providers/turn-effort.ts).
 * The central table's 30-day retention (TURN_USAGE_RETENTION_DAYS in
 * src/db/usage.ts) ages the pre-cutoff rows out on its own; the per-session
 * outbound.db copies keep them for as long as the session directory lives.
 */
export const migration076: Migration = {
  version: 76,
  name: 'turn-usage-effort',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('turn_usage')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const [name, type] of [
      ['effort', 'TEXT'],
      ['effort_requested', 'TEXT'],
    ] as const) {
      if (!cols.has(name)) db.exec(`ALTER TABLE turn_usage ADD COLUMN ${name} ${type}`);
    }
  },
};
