import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Makes `request_choice`'s one-live-card-per-choiceId promise atomic. The pre-check and insert are separated by
 * awaits and delivery exclusion is per session, so two sessions of one group could both post a card. Now the insert
 * is the claim: `createPendingApproval`'s `INSERT OR IGNORE` reports the loser as `changes === 0`, which becomes
 * 'duplicate-request'.
 * Scoped to the `request_choice` ACTION: other kinds reuse `request_id` deliberately (the OneCLI gateway re-delivers
 * a held request under the same id after a restart; bash-gate keys on its outbound id).
 * Covers `pending` AND `approved`: `resolveChoice` flips a row to approved before awaiting delivery and restores
 * `pending` on failure, and with `pending` alone a second card could claim the id mid-delivery and the restore would
 * throw SQLITE_CONSTRAINT_UNIQUE from an uncaught path, stranding the first card. `expired` is not covered: on the
 * normal path `retireChoice` deletes an expired row at once, and the legacy duplicates expired below must fall out.
 * FAILS SOFT on pre-existing duplicates, because this runs at every host start and a throwing CREATE UNIQUE INDEX
 * would crash-loop the host: newer live duplicates are marked 'expired' (oldest kept). Nothing is deleted.
 */
export const migration078: Migration = {
  version: 78,
  name: 'choice-request-reservation',
  up(db: Database.Database) {
    db.exec(`
      UPDATE pending_approvals
         SET status = 'expired'
       WHERE action = 'request_choice'
         AND status IN ('pending', 'approved')
         AND approval_id NOT IN (
           SELECT approval_id FROM (
             SELECT approval_id,
                    ROW_NUMBER() OVER (
                      PARTITION BY request_id ORDER BY created_at, approval_id
                    ) AS rn
               FROM pending_approvals
              WHERE action = 'request_choice' AND status IN ('pending', 'approved')
           ) WHERE rn = 1
         );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_approvals_choice_request_live
        ON pending_approvals(request_id)
        WHERE action = 'request_choice' AND status IN ('pending', 'approved');
    `);
  },
};
