import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `pending_channel_approvals` is the only child of `messaging_groups` that
 * nothing ever cleans up: the agent-group delete path
 * (`src/cli/resources/groups.ts`) removes its rows by `agent_group_id`, but no
 * path removes them by `messaging_group_id`, and migration 012 declared the FK
 * with the default NO ACTION. Two consequences, one visible and one latent:
 *
 *   1. A live install carries an orphan row whose parent messaging group is
 *      gone, so every `disableForeignKeys` migration re-logs
 *      "Pre-existing FK violations carried through migration" at boot.
 *   2. With `foreign_keys = ON` (`src/db/compose.ts`), deleting a messaging
 *      group that still holds a pending registration card fails outright.
 *
 * Delete the orphans, then rebuild the table with ON DELETE CASCADE on
 * `messaging_group_id` — the same recreate migration 073 used for the
 * workgroup-owned tables, because SQLite cannot alter a foreign-key action in
 * place. Columns, keys and defaults are copied from the tip schema (012's
 * table plus 013's title/options_json and 045's question); `agent_group_id`
 * keeps NO ACTION, since the agent-group delete path already clears those rows
 * explicitly and surfaces the count.
 */
export const migration074: Migration = {
  version: 74,
  name: 'pending-channel-approvals-cascade',
  sqliteOnly: true,
  disableForeignKeys: true,
  up(db: Database.Database) {
    db.exec(`
      DELETE FROM pending_channel_approvals
        WHERE messaging_group_id NOT IN (SELECT id FROM messaging_groups);

      CREATE TABLE pending_channel_approvals_074 (
        messaging_group_id   TEXT PRIMARY KEY REFERENCES messaging_groups(id) ON DELETE CASCADE,
        agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
        original_message     TEXT NOT NULL,
        approver_user_id     TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        title                TEXT NOT NULL DEFAULT '',
        options_json         TEXT NOT NULL DEFAULT '[]',
        question             TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO pending_channel_approvals_074
        (rowid, messaging_group_id, agent_group_id, original_message, approver_user_id, created_at,
         title, options_json, question)
        SELECT rowid, messaging_group_id, agent_group_id, original_message, approver_user_id, created_at,
               title, options_json, question
        FROM pending_channel_approvals;
      DROP TABLE pending_channel_approvals;
      ALTER TABLE pending_channel_approvals_074 RENAME TO pending_channel_approvals;
    `);
  },
};
