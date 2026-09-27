import type { Migration } from './index.js';

/** thread_id lets the host find the approval card on the platform again to edit it on timeout or auto-cancel. */
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
