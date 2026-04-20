/**
 * Wait for host delivery result (container side).
 *
 * The host's delivery.ts writes to inbound.db's `delivered` table after
 * each outbound message send attempt. Rows appear as:
 *   status='delivered' → adapter.deliver returned; row has platform_message_id
 *   status='failed'    → adapter.deliver threw MAX_DELIVERY_ATTEMPTS times;
 *                        row has `error` with the last adapter error string
 *
 * send_file uses this to turn v2's default fire-and-forget writeMessageOut
 * into a synchronous-looking call: write the row, poll `delivered` until
 * a matching row appears or a timeout expires, surface the outcome to the
 * agent. Without this, upload errors (missing OAuth scope, file too large
 * for the channel, transient adapter failures past retry count) are
 * invisible to the agent.
 *
 * Read-only against inbound.db — no schema changes on the container side.
 */
import { getInboundDb } from './connection.js';

export interface DeliveryAck {
  status: 'delivered' | 'failed';
  platformMessageId?: string;
  error?: string;
}

interface DeliveredRow {
  status: string;
  platform_message_id: string | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 300;

function readRow(messageId: string): DeliveredRow | undefined {
  return getInboundDb()
    .prepare('SELECT status, platform_message_id, error FROM delivered WHERE message_out_id = ?')
    .get(messageId) as DeliveredRow | undefined;
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

/**
 * Poll the delivered table for a row matching `messageId`. Resolves with
 * the ack shape once the host records delivery, or `null` on timeout. On
 * timeout the file has been staged and the host may still deliver it —
 * callers should report "sent; delivery unconfirmed" rather than failure.
 */
export async function awaitDeliveryAck(
  messageId: string,
  timeoutMs: number,
): Promise<DeliveryAck | null> {
  const deadline = Date.now() + timeoutMs;
  // Fast path: maybe the host delivered between writeMessageOut and the
  // first poll (unlikely, but cheap to check).
  const first = readRow(messageId);
  if (first) return toAck(first);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const row = readRow(messageId);
    if (row) return toAck(row);
  }
  return null;
}
