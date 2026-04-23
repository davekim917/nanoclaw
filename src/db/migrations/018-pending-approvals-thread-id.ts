import type { Migration } from './index.js';

/**
 * Add thread_id to pending_approvals so the host can look the approval
 * card back up on the platform (to edit it when the gate times out or
 * gets auto-cancelled by a follow-up message). channel_type and
 * platform_id were already on the row; thread_id (Slack thread_ts or
 * Discord thread id) is the remaining bit the Chat-SDK bridge needs to
 * resolve the adapter's internal thread key for editMessage calls.
 */
export const pendingApprovalsThreadId: Migration = {
  version: 18,
  name: 'pending-approvals-thread-id',
  up(db) {
    try {
      db.exec(`ALTER TABLE pending_approvals ADD COLUMN thread_id TEXT`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate column') || msg.includes('already exists')) return;
      throw err;
    }
  },
};
