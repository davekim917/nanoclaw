import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `pending_channel_approvals` is the only `messaging_groups` child nothing cleans up by messaging group, and 012
 * declared the FK NO ACTION: orphans re-log FK violations on every boot, and deleting a messaging group holding a
 * pending card fails. Deletes the orphans, then rebuilds with ON DELETE CASCADE on `messaging_group_id` (SQLite
 * cannot alter an FK action). `agent_group_id` keeps NO ACTION: the agent-group delete path clears those rows
 * explicitly and reports the count.
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
