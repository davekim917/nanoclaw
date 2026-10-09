/**
 * A route-checked (`thread-route-split.ts`) handoff post waits for the host's verdict, so the agent learns before its
 * next step whether the host moved the request to a new thread, and under which key.
 */
import { awaitDeliveryAck } from '../db/delivery-acks.js';
import { readDeliveryNotice } from '../modules/mailbox/index.js';
import { ROUTE_CHECK_ACK_WAIT_MS, splitThreadKey } from '../thread-route-split.js';
import { err, ok } from './tool-helpers.js';

export async function routeCheckedSendResult(
  id: string,
  seq: number,
  destination: string,
  threadKey: string,
  waitMs = ROUTE_CHECK_ACK_WAIT_MS,
) {
  const ack = await awaitDeliveryAck(id, waitMs);
  if (!ack) {
    const split = splitThreadKey(threadKey, id);
    return ok(
      `Message queued to ${destination} (id: ${seq}). ROUTING CHECK UNCONFIRMED: the host did not answer within ` +
        `${waitMs / 1000}s, and a check it could not finish in time counts as a veto. If thread_key ` +
        `"${threadKey}" already had a thread before this post, this post opened a NEW thread and this request's ` +
        `thread_key is now "${split}": use "${split}" for its topic file, its dispatch and every later post about it. ` +
        `Otherwise keep using "${threadKey}".`,
    );
  }
  if (ack.status === 'failed') return err(`Message not delivered: ${ack.error ?? 'host rejected delivery'}`);
  const notice = readDeliveryNotice(id);
  return ok(`Message sent to ${destination} (id: ${seq}).${notice ? ` ${notice}` : ''}`);
}
