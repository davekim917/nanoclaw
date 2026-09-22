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
 * The a2a reply stamp: the id of the first inbound message in the batch the
 * agent is currently processing. The poll loop publishes it at batch start;
 * MCP tools (`send_message`, `send_file`) read it and stamp it onto outbound
 * rows so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This lives in mailbox state because the MCP server runs as a separate stdio
 * subprocess; module state set by the poll loop is invisible to it.
 */
const IN_REPLY_TO_KEY = 'current_in_reply_to';

/**
 * Ignore a stamp older than this. The poll loop clears the stamp in a
 * finally, but a container killed mid-batch (SIGKILL) can leave one behind;
 * the guard stops a later out-of-batch read from picking up a dead stamp.
 * Generous so a long-running batch's late sends still stamp correctly.
 */
const IN_REPLY_TO_MAX_AGE_MS = 30 * 60 * 1000;

export function setCurrentInReplyTo(id: string | null): void {
  if (id === null) {
    clearCurrentInReplyTo();
    return;
  }
  setValue(IN_REPLY_TO_KEY, id);
}

export function clearCurrentInReplyTo(): void {
  deleteValue(IN_REPLY_TO_KEY);
}

export function getCurrentInReplyTo(): string | null {
  const row = getAgentMailbox().operations.getState(IN_REPLY_TO_KEY);
  if (!row) return null;
  const age = Date.now() - new Date(row.updatedAt).getTime();
  if (!Number.isFinite(age) || age > IN_REPLY_TO_MAX_AGE_MS) return null;
  return row.value;
}

export interface RequestCandidate {
  sequence: number;
  messageId: string;
}

const REQUEST_CANDIDATES_KEY = 'request_candidates';
const MAX_REQUEST_CANDIDATES = 32;

/** Retain trusted original inbound identities across retries and clarification turns. */
export function rememberRequestCandidates(
  messages: Array<{
    id: string;
    seq: number | null;
    kind: string;
    trigger: number;
    channel_type: string | null;
    content: string;
  }>,
): void {
  const previous = getRequestCandidates();
  const bySequence = new Map(previous.map((candidate) => [candidate.sequence, candidate]));
  for (const message of messages) {
    let eligible = message.kind === 'task';
    if ((message.kind === 'chat' || message.kind === 'chat-sdk') && message.channel_type !== 'agent') {
      try {
        const content = JSON.parse(message.content) as { sender?: unknown; senderId?: unknown; origin?: unknown };
        eligible = content.sender !== 'system' && content.senderId !== 'system' && content.origin !== 'host';
      } catch {
        eligible = false;
      }
    }
    if (message.trigger === 1 && Number.isSafeInteger(message.seq) && (message.seq as number) > 0 && eligible) {
      bySequence.set(message.seq as number, { sequence: message.seq as number, messageId: message.id });
    }
  }
  const candidates = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-MAX_REQUEST_CANDIDATES);
  if (candidates.length > 0) setValue(REQUEST_CANDIDATES_KEY, JSON.stringify(candidates));
}

export function getRequestCandidates(): RequestCandidate[] {
  const raw = getValue(REQUEST_CANDIDATES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is RequestCandidate =>
        !!value &&
        typeof value === 'object' &&
        Number.isSafeInteger((value as RequestCandidate).sequence) &&
        (value as RequestCandidate).sequence > 0 &&
        typeof (value as RequestCandidate).messageId === 'string' &&
        (value as RequestCandidate).messageId.length > 0,
    );
  } catch {
    return [];
  }
}

export function resolveRequestCandidate(sequence: unknown): RequestCandidate {
  const candidates = getRequestCandidates();
  if (sequence === undefined && candidates.length === 1) return candidates[0];
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1)
    throw new Error(
      candidates.length > 1
        ? 'requestId is required when several original requests are available'
        : 'No admissible original request is available',
    );
  const candidate = candidates.find((value) => value.sequence === sequence);
  if (!candidate) throw new Error('requestId is not an admissible original request for this session');
  return candidate;
}

const LIFECYCLE_STATUS_KEY = 'current_lifecycle_status';

export function setCurrentLifecycleStatus(id: string): void {
  setValue(LIFECYCLE_STATUS_KEY, id);
}

export function getCurrentLifecycleStatus(): string | null {
  return getValue(LIFECYCLE_STATUS_KEY) ?? null;
}

export function clearCurrentLifecycleStatus(): void {
  deleteValue(LIFECYCLE_STATUS_KEY);
}
