import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 078 — the choice-card reservation index.
 *
 * `request_choice` promises that one `choiceId` never has two live cards at
 * once (src/modules/interactive/choice.ts handleRequestChoice). That promise
 * was enforced only by a read-then-insert in application code: the pre-check
 * `getPendingApprovalByRequestId` and the insert in
 * src/modules/approvals/primitive.ts (requestApprovalOutcome) are separated
 * by several awaits — approver validation, destination authorization — and
 * delivery exclusion is per session (src/delivery.ts deliverSessionMessages,
 * `inflightDeliveries` is keyed on session.id), so two sessions of one agent
 * group draining at the same time both passed the pre-check and both
 * inserted: two pending approvals, two cards, no refusal (a `choice_receipts`
 * review finding).
 *
 * This index makes the reservation atomic: the insert itself is the claim,
 * and the loser cannot post a card because it never gets a row.
 * `createPendingApproval` inserts with `INSERT OR IGNORE` (src/db/sessions.ts),
 * so the losing insert is skipped and reported as `changes === 0` rather than
 * throwing, and `requestApprovalOutcome` turns that into 'duplicate-request'.
 *
 * SCOPED TO THE ACTION on purpose. `pending_approvals.request_id` is a
 * caller-supplied id shared by every approval kind, and the other kinds reuse
 * one deliberately: the OneCLI gateway re-delivers a held request under the
 * same `request.id` after a host restart and expects to find (and re-arm) the
 * existing row (src/modules/approvals/onecli-approvals.ts handleRequest), and
 * bash-gate keys on its outbound-message id. A table-wide unique index would
 * newly constrain both. The uniqueness claim being enforced here is
 * `request_choice`'s alone, so the index carries its action.
 *
 * Scoped to the LIVE statuses, `pending` AND `approved`, which together are
 * exactly the window in which a card can still take an answer. This is not
 * cosmetic: `resolveChoice` flips the row pending→approved BEFORE it awaits
 * delivery, and puts it back to
 * `pending` when delivery throws or finds no live session —
 * the card stays open and clickable the whole time.
 *
 * Covering only `pending` would drop the reservation for the entire delivery
 * window. A second request could then claim the same choiceId and post its
 * own card, and the restore-to-`pending` would violate this index and throw
 * SQLITE_CONSTRAINT_UNIQUE out of a path with no catch — stranding the first
 * row in `approved` with two live cards, no answer and no receipt, and no
 * further click able to recover it (a `choice_receipts` review finding,
 * reproduced by the reviewer).
 *
 * `expired` is deliberately NOT covered: `retireChoice` moves a row there and
 * deletes it in the same breath, and a resolved row is
 * deleted outright, so a choiceId whose card is gone is free to be
 * used again — the same rule the application-level pre-check applies.
 *
 * FAILS SOFT, NEVER CLOSED, on pre-existing duplicates. `runMigrations` runs
 * at every host start (src/db/migrations/index.ts), so a `CREATE UNIQUE INDEX`
 * that throws on legacy data would crash-loop the host until someone did DB
 * surgery. Any live duplicate is therefore retired first — oldest row kept,
 * newer ones marked 'expired' so they fall out of the partial index — which
 * is the same outcome the application would have produced had the refusal
 * been atomic all along — and it spans both live statuses, so a legacy
 * `approved` row left behind by a crashed delivery is reconciled too, not
 * just a `pending` one. Nothing is deleted. Verified before authoring this:
 * the live central DB holds 13 pending approvals with 13 distinct request_ids
 * and no `request_choice` rows at all, so the cleanup is a no-op there.
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
