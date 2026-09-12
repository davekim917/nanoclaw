import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 077 — choice_receipts
 *
 * A durable, host-written record of every RESOLVED choice card
 * (`request_choice`, src/modules/interactive/choice.ts), independent of the
 * `pending_approvals` row backing it — that row is deleted the moment the
 * click's answer has been delivered (`resolveChoice`,
 * src/modules/approvals/choices.ts), which is also the moment the choice id,
 * the picked value and the clicking user stop being queryable anywhere else.
 *
 * This table exists so a release policy OUTSIDE this host — one that never
 * trusts the agent's own narration of what a human approved — has a fact it
 * can check independently: which value a given card resolved to, who clicked
 * it, and (when known) which platform message carried the card, so the
 * policy can confirm that message against the platform's own API.
 *
 * One row per resolved card, written once, host-only, after delivery
 * succeeds and before the `pending_approvals` row is deleted
 * (src/modules/approvals/choices.ts:resolveChoice). `request_id` is the PK:
 * it is the card's own `choice-…` id (the container's `choiceId`,
 * threaded through as `pending_approvals.request_id` — see
 * src/modules/interactive/choice.ts:174 and
 * src/modules/approvals/primitive.ts:416), globally unique per card and
 * stable whether or not the underlying approval row is retried.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` at the write site, not a schema
 * constraint alone: the first click to win the pending→approved
 * compare-and-swap is the only one that ever reaches the write, so a
 * conflict here would mean two winners for the same card, which cannot
 * happen — the guard is defense in depth, not a case this table expects to
 * hit.
 *
 * No FK to `pending_approvals` (deleted immediately after) or `sessions`
 * (may end long before this row is read): the receipt's job is to outlive
 * both. Nothing else deletes from this table — no session archival, no
 * approval cleanup, no retention sweep. See CONTRIBUTING PR notes for the
 * cited call sites verifying that.
 */
export const migration077: Migration = {
  version: 77,
  name: 'choice-receipts',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS choice_receipts (
        request_id          TEXT PRIMARY KEY,
        approval_id         TEXT NOT NULL,
        action              TEXT NOT NULL,
        agent_group_id      TEXT,
        session_id          TEXT NOT NULL,
        platform_id         TEXT,
        thread_id           TEXT,
        platform_message_id TEXT,
        value               TEXT NOT NULL,
        label               TEXT NOT NULL,
        clicker_user_id     TEXT NOT NULL,
        resolved_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_choice_receipts_agent_group
        ON choice_receipts(agent_group_id, resolved_at);
    `);
  },
};
