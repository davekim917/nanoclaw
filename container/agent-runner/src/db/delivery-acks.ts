/**
 * Wait for the host's delivery verdict in inbound.db's `delivered` table, so send_file can surface upload
 * failures instead of fire-and-forget.
 */
import { readDeliveredRow, type DeliveredRow } from '../modules/mailbox/index.js';

export interface DeliveryAck {
  status: 'delivered' | 'failed';
  platformMessageId?: string;
  error?: string;
}

const POLL_INTERVAL_MS = 300;

function readRow(messageId: string): DeliveredRow | undefined {
  const row = readDeliveredRow(messageId);
  // 'pending' is the host holding a gate: keep polling, or toAck() would treat it as failed before the human saw the card.
  if (row && row.status === 'pending') return undefined;
  return row;
}

function toAck(row: DeliveredRow): DeliveryAck {
  if (row.status === 'delivered') {
    return {
      status: 'delivered',
      platformMessageId: row.platform_message_id ?? undefined,
    };
  }
  return {
    status: 'failed',
    error: row.error ?? undefined,
  };
}

/** null on timeout: the host may still deliver, so callers report "sent; delivery unconfirmed", not failure. */
export async function awaitDeliveryAck(
  messageId: string,
  timeoutMs: number,
): Promise<DeliveryAck | null> {
  const deadline = Date.now() + timeoutMs;
  const first = readRow(messageId);
  if (first) return toAck(first);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const row = readRow(messageId);
    if (row) return toAck(row);
  }
  return null;
}
