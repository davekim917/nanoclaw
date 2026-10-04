/**
 * Persistent key/value state owned by the registered mailbox.
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getAgentMailbox } from '../mailbox/index.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  return getAgentMailbox().operations.getState(key)?.value;
}

function setValue(key: string, value: string): void {
  getAgentMailbox().operations.setState(key, value);
}

function deleteValue(key: string): void {
  getAgentMailbox().operations.deleteState(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

/**
 * The reply stamp: the message being answered (its id, for the host's a2a return-path routing) and the chat and
 * thread it came from, so a send to that chat lands in the same thread. The poll loop publishes it at batch start
 * and again for each follow-up it pushes into a running query; MCP tools read it.
 *
 * This lives in mailbox state because the MCP server runs as a separate stdio
 * subprocess; module state set by the poll loop is invisible to it.
 */
export interface ReplyRoute {
  inReplyTo: string | null;
  platformId: string | null;
  threadId: string | null;
}

const REPLY_ROUTE_KEY = 'current_reply_route';

/**
 * Ignore a stamp older than this. The poll loop clears the stamp in a
 * finally, but a container killed mid-batch (SIGKILL) can leave one behind;
 * the guard stops a later out-of-batch read from picking up a dead stamp.
 * Generous so a long-running batch's late sends still stamp correctly.
 */
const REPLY_ROUTE_MAX_AGE_MS = 30 * 60 * 1000;

export function setCurrentReplyRoute(route: ReplyRoute | null): void {
  if (route === null) {
    clearCurrentReplyRoute();
    return;
  }
  const { inReplyTo, platformId, threadId } = route;
  setValue(REPLY_ROUTE_KEY, JSON.stringify({ inReplyTo, platformId, threadId }));
}

export function clearCurrentReplyRoute(): void {
  deleteValue(REPLY_ROUTE_KEY);
}

export function getCurrentReplyRoute(): ReplyRoute | null {
  const row = getAgentMailbox().operations.getState(REPLY_ROUTE_KEY);
  if (!row) return null;
  const age = Date.now() - new Date(row.updatedAt).getTime();
  if (!Number.isFinite(age) || age > REPLY_ROUTE_MAX_AGE_MS) return null;
  try {
    const route = JSON.parse(row.value) as Partial<ReplyRoute>;
    return { inReplyTo: route.inReplyTo ?? null, platformId: route.platformId ?? null, threadId: route.threadId ?? null };
  } catch {
    return null;
  }
}

export function getCurrentInReplyTo(): string | null {
  return getCurrentReplyRoute()?.inReplyTo ?? null;
}
