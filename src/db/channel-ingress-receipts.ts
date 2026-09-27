/**
 * Every statement is self-guarding (the claim is `ON CONFLICT DO NOTHING`, each transition names its FROM status in
 * `WHERE`), so races settle in SQLite and none needs `centralTransaction`.
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
 * Keeps an approval-gated event reserved but not delivered: platform recovery retries stay blocked until the human
 * flow claims it for replay.
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
 * The INSERT fallback covers approvals that predate the migration without letting a completed event replay. Two
 * statements, not a transaction: the UPDATE's `status = 'deferred'` is the compare-and-set and the INSERT's `ON
 * CONFLICT DO NOTHING` the claim, so an interleaved caller can only make this return false.
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

/** Processing claims cannot outlive the host process that owned their side effects. */
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
