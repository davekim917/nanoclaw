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
 * (src/modules/approvals/choices.ts:resolveChoice). `approval_id` is the PK:
 * it is host-minted per approval (`appr-<ms>-<6 base36>`,
 * src/modules/approvals/primitive.ts:~410) and unique by construction.
 * `request_id` — the card's own `choice-…` id, the container's `choiceId`
 * threaded through as `pending_approvals.request_id` (see
 * src/modules/interactive/choice.ts:174) — is kept as an indexed, NOT unique
 * column: it is agent-chosen, so a compromised agent can reuse one across
 * two different cards. Keying the receipt on `request_id` let a reused
 * choiceId silently collapse two resolved approvals into one receipt (a
 * `choice_receipts` review finding); keying on the host-minted `approval_id`
 * means every resolved approval gets its own row regardless. The host itself
 * additionally refuses a `request_choice` whose choiceId already has a
 * PENDING approval (src/modules/interactive/choice.ts handleRequestChoice),
 * so two live cards never legitimately share one choiceId — this schema is
 * the second, structural line of defense.
 *
 * Plain `INSERT` at the write site, no `ON CONFLICT` — a conflict on the
 * host-minted PK must never happen (the pending→approved compare-and-swap
 * lets exactly one click win per approval, and approval ids don't repeat),
 * so a collision throws into the existing logged catch
 * (choices.ts writeChoiceReceipt) rather than silently discarding evidence.
 *
 * No FK to `pending_approvals` (deleted immediately after) or `sessions`
 * (may end long before this row is read): the receipt's job is to outlive
 * both. Nothing on the normal lifecycle deletes from this table — no session
 * archival, no approval cleanup, no retention sweep.
 *
 * ONE path does delete rows, and it is not on that lifecycle: full
 * agent-group teardown. `scripts/delete-cli-agent.ts` sweeps every table
 * carrying an `agent_group_id` column, discovered generically from
 * `pragma_table_info` rather than named one by one
 * (scripts/delete-cli-agent.ts:50-59), so this table's rows for that group go
 * with the group — by design: once the agent group is gone the receipts
 * attest to cards nobody can resolve back to an agent. A consumer that must
 * outlive teardown has to copy the receipt out before then.
 */
export const migration077: Migration = {
  version: 77,
  name: 'choice-receipts',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS choice_receipts (
        approval_id         TEXT PRIMARY KEY,
        request_id          TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_choice_receipts_request_id
        ON choice_receipts(request_id);
      CREATE INDEX IF NOT EXISTS idx_choice_receipts_agent_group
        ON choice_receipts(agent_group_id, resolved_at);
    `);
  },
};
