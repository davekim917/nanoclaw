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

/** Atomically reserve all router side effects for one platform event. */
export function claimChannelIngress(key: ChannelIngressReceiptKey): boolean {
  const result = getDb()
    .prepare(
      `INSERT INTO channel_ingress_receipts
         (channel_type, instance, platform_id, message_id, status, claimed_at, completed_at)
       VALUES (@channel_type, @instance, @platform_id, @message_id, 'processing', @claimed_at, NULL)
       ON CONFLICT(channel_type, instance, platform_id, message_id) DO NOTHING`,
    )
    .run({ ...params(key), claimed_at: new Date().toISOString() });
  return result.changes > 0;
}

export function completeChannelIngress(key: ChannelIngressReceiptKey): void {
  getDb()
    .prepare(
      `UPDATE channel_ingress_receipts
          SET status = 'completed', completed_at = @completed_at
        WHERE channel_type = @channel_type
          AND instance = @instance
          AND platform_id = @platform_id
          AND message_id = @message_id`,
    )
    .run({ ...params(key), completed_at: new Date().toISOString() });
}

/**
 * Keep an approval-gated event reserved without treating it as delivered.
 * Platform recovery retries remain blocked until the human flow explicitly
 * claims the deferred receipt for replay.
 */
export function deferChannelIngress(key: ChannelIngressReceiptKey): void {
  getDb()
    .prepare(
      `UPDATE channel_ingress_receipts
          SET status = 'deferred'
        WHERE channel_type = @channel_type
          AND instance = @instance
          AND platform_id = @platform_id
          AND message_id = @message_id
          AND status = 'processing'`,
    )
    .run(params(key));
}

/**
 * Atomically reclaim an approval-deferred event. The INSERT fallback supports
 * approvals created before this migration without allowing a completed event
 * to replay.
 */
export function claimDeferredChannelIngress(key: ChannelIngressReceiptKey): boolean {
  const db = getDb();
  const updated = db
    .prepare(
      `UPDATE channel_ingress_receipts
          SET status = 'processing', claimed_at = @claimed_at, completed_at = NULL
        WHERE channel_type = @channel_type
          AND instance = @instance
          AND platform_id = @platform_id
          AND message_id = @message_id
          AND status = 'deferred'`,
    )
    .run({ ...params(key), claimed_at: new Date().toISOString() });
  if (updated.changes > 0) return true;
  return claimChannelIngress(key);
}

/** Resolve a denied/abandoned deferred event without routing it. */
export function completeDeferredChannelIngress(key: ChannelIngressReceiptKey): void {
  getDb()
    .prepare(
      `UPDATE channel_ingress_receipts
          SET status = 'completed', completed_at = @completed_at
        WHERE channel_type = @channel_type
          AND instance = @instance
          AND platform_id = @platform_id
          AND message_id = @message_id
          AND status = 'deferred'`,
    )
    .run({ ...params(key), completed_at: new Date().toISOString() });
}

/** Release a failed route so recovery can retry the event. */
export function releaseChannelIngress(key: ChannelIngressReceiptKey): void {
  getDb()
    .prepare(
      `DELETE FROM channel_ingress_receipts
        WHERE channel_type = @channel_type
          AND instance = @instance
          AND platform_id = @platform_id
          AND message_id = @message_id
          AND status = 'processing'`,
    )
    .run(params(key));
}

/** Processing claims cannot survive the host process that owned their side effects. */
export function resetProcessingChannelIngress(): number {
  return getDb().prepare("DELETE FROM channel_ingress_receipts WHERE status = 'processing'").run().changes;
}

export function pruneChannelIngressReceipts(nowMs = Date.now(), retentionMs = 7 * 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(nowMs - retentionMs).toISOString();
  return getDb()
    .prepare(
      `DELETE FROM channel_ingress_receipts
        WHERE (status = 'completed' AND datetime(completed_at) < datetime(@cutoff))
           OR (status = 'deferred' AND datetime(claimed_at) < datetime(@cutoff))`,
    )
    .run({ cutoff }).changes;
}
