/**
 * Seam 3 PR 5d: every export runs on the async driver. Each statement is
 * self-guarding — the claim is `INSERT ... ON CONFLICT DO NOTHING`, every
 * transition carries the status it is transitioning FROM in its `WHERE` — so
 * two callers racing settle in SQLite, not in a lease, and none of these needs
 * `centralTransaction` (plan §4.1, §4.4).
 */
import { getDb } from './connection.js';

export interface ChannelIngressReceiptKey {
  channelType: string;
  instance: string;
  platformId: string;
  messageId: string;
}

function params(key: ChannelIngressReceiptKey): Record<string, string> {
  return {
    channel_type: key.channelType,
    instance: key.instance,
    platform_id: key.platformId,
    message_id: key.messageId,
  };
}

/** The claim INSERT, shared by the direct and the deferred-replay claim. */
async function claimIngressRow(key: ChannelIngressReceiptKey): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO channel_ingress_receipts
         (channel_type, instance, platform_id, message_id, status, claimed_at, completed_at)
       VALUES (@channel_type, @instance, @platform_id, @message_id, 'processing', @claimed_at, NULL)
       ON CONFLICT(channel_type, instance, platform_id, message_id) DO NOTHING`,
    { ...params(key), claimed_at: new Date().toISOString() },
  );
  return result.changes > 0;
}

/** Atomically reserve all router side effects for one platform event. */
export function claimChannelIngress(key: ChannelIngressReceiptKey): Promise<boolean> {
  return claimIngressRow(key);
}

export async function completeChannelIngress(key: ChannelIngressReceiptKey): Promise<void> {
  await getDb().run(
    `UPDATE channel_ingress_receipts
          SET status = 'completed', completed_at = @completed_at
        WHERE channel_type = @channel_type
          AND instance = @instance
          AND platform_id = @platform_id
          AND message_id = @message_id`,
    { ...params(key), completed_at: new Date().toISOString() },
  );
}

/**
 * Keep an approval-gated event reserved without treating it as delivered.
 * Platform recovery retries remain blocked until the human flow explicitly
 * claims the deferred receipt for replay.
 */
export async function deferChannelIngress(key: ChannelIngressReceiptKey): Promise<void> {
  await getDb().run(
    `UPDATE channel_ingress_receipts
          SET status = 'deferred'
        WHERE channel_type = @channel_type
          AND instance = @instance
          AND platform_id = @platform_id
          AND message_id = @message_id
          AND status = 'processing'`,
    params(key),
  );
}

/**
 * Atomically reclaim an approval-deferred event. The INSERT fallback supports
 * approvals created before this migration without allowing a completed event
 * to replay.
 *
 * Two awaited statements, not a transaction: the UPDATE's `status = 'deferred'`
 * IS the compare-and-set, and the fallback INSERT's `ON CONFLICT DO NOTHING` is
 * the claim. A concurrent caller landing between them can only make the INSERT
 * lose its conflict race and return false — the same answer the loser of the
 * original single-block race got.
 */
export async function claimDeferredChannelIngress(key: ChannelIngressReceiptKey): Promise<boolean> {
  const updated = await getDb().run(
    `UPDATE channel_ingress_receipts
          SET status = 'processing', claimed_at = @claimed_at, completed_at = NULL
        WHERE channel_type = @channel_type
          AND instance = @instance
          AND platform_id = @platform_id
          AND message_id = @message_id
          AND status = 'deferred'`,
    { ...params(key), claimed_at: new Date().toISOString() },
  );
  if (updated.changes > 0) return true;
  return claimIngressRow(key);
}

/** Resolve a denied/abandoned deferred event without routing it. */
export async function completeDeferredChannelIngress(key: ChannelIngressReceiptKey): Promise<void> {
  await getDb().run(
    `UPDATE channel_ingress_receipts
          SET status = 'completed', completed_at = @completed_at
        WHERE channel_type = @channel_type
          AND instance = @instance
          AND platform_id = @platform_id
          AND message_id = @message_id
          AND status = 'deferred'`,
    { ...params(key), completed_at: new Date().toISOString() },
  );
}

/** Release a failed route so recovery can retry the event. */
export async function releaseChannelIngress(key: ChannelIngressReceiptKey): Promise<void> {
  await getDb().run(
    `DELETE FROM channel_ingress_receipts
        WHERE channel_type = @channel_type
          AND instance = @instance
          AND platform_id = @platform_id
          AND message_id = @message_id
          AND status = 'processing'`,
    params(key),
  );
}

/** Processing claims cannot survive the host process that owned their side effects. */
export async function resetProcessingChannelIngress(): Promise<number> {
  const result = await getDb().run("DELETE FROM channel_ingress_receipts WHERE status = 'processing'");
  return result.changes;
}

export async function pruneChannelIngressReceipts(
  nowMs = Date.now(),
  retentionMs = 7 * 24 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(nowMs - retentionMs).toISOString();
  const result = await getDb().run(
    `DELETE FROM channel_ingress_receipts
        WHERE (status = 'completed' AND datetime(completed_at) < datetime(@cutoff))
           OR (status = 'deferred' AND datetime(claimed_at) < datetime(@cutoff))`,
    { cutoff },
  );
  return result.changes;
}
