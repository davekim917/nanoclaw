/**
 * Which thread keys the host's routing check covers, the key a vetoed post moves to, and how long the runner waits
 * for the host's answer. The host decides and re-keys; the runner names the same key to the agent when the host's
 * answer is late. No shared modules cross the container boundary, so this file exists in both trees and a host test
 * keeps the two byte-identical.
 */

/** littlebird-watch topic keys. Every other key, and an unkeyed post, routes exactly as before. */
const ROUTE_CHECK_KEY_PREFIX = 'lb-';

const MAX_THREAD_KEY_LENGTH = 128;

/**
 * Longer than the host's routing deadline (20 s from queueing) plus its post and ack, so a verdict the host reached
 * in time is read here; past it the host has already counted the check as a veto.
 */
export const ROUTE_CHECK_ACK_WAIT_MS = 45_000;

export function isRouteCheckedKey(threadKey: string): boolean {
  return threadKey.startsWith(ROUTE_CHECK_KEY_PREFIX);
}

/**
 * The key for a new ask whose post the check refused to put in the thread its key already had: derived from the
 * outbound row id, so a retried row lands on the same key and the earlier key keeps its own thread.
 */
export function splitThreadKey(threadKey: string, messageOutId: string): string {
  const suffix = `.split-${messageOutId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
  const keep = Math.max(ROUTE_CHECK_KEY_PREFIX.length, MAX_THREAD_KEY_LENGTH - suffix.length);
  return threadKey.slice(0, keep) + suffix;
}
