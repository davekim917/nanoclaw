import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * A durable host-written record of every RESOLVED choice card, independent of its `pending_approvals` row (deleted as
 * soon as the answer is delivered). It lets a release policy outside this host check which value a card resolved to,
 * who clicked it, and which platform message carried it, without trusting the agent's narration.
 * `approval_id` (host-minted, unique by construction) is the PK. `request_id` is agent-chosen and can be reused
 * across cards, so it is indexed, NOT unique: keying on it let a reused choiceId collapse two approvals into one
 * receipt. Plain INSERT at the write site: a PK conflict is a real error.
 * No FK to `pending_approvals` or `sessions`: the receipt must outlive both, and nothing on the normal lifecycle
 * deletes it. Only full agent-group teardown (`scripts/delete-cli-agent.ts`, which sweeps every table with an
 * `agent_group_id` column) removes rows, so a consumer that must outlive teardown copies receipts out first.
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
