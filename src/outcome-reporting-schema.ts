/** Pure wire contract. Mirrored into the separately packaged agent runner. */
import { createHash } from 'node:crypto';

export const OUTCOME_PURPOSES = ['progress', 'outcome', 'reply', 'urgent', 'decision', 'handoff'] as const;

export interface TrustedRequestIdentity {
  sessionId: string;
  messageId: string;
  sequence: number;
  origin?: { channelType: string; platformId: string; platformMessageId: string };
}

/** True only for a task occurrence or an external human-authored request. */
export function isAdmissibleOutcomeRequestSource(kind: string, content: unknown): boolean {
  if (kind === 'task') return true;
  if ((kind !== 'chat' && kind !== 'chat-sdk') || !content || typeof content !== 'object' || Array.isArray(content))
    return false;
  const source = content as {
    sender?: unknown;
    senderId?: unknown;
    origin?: unknown;
    author?: { isBot?: unknown };
  };
  return (
    source.sender !== 'system' &&
    source.senderId !== 'system' &&
    source.origin !== 'host' &&
    source.author?.isBot !== true
  );
}

/** Opaque receipt key derived from host-owned session + inbound-row identity. */
export function requestWorkItem(identity: TrustedRequestIdentity): string {
  if (!identity.sessionId || !identity.messageId || !Number.isSafeInteger(identity.sequence) || identity.sequence < 1)
    throw new Error('Invalid trusted request identity');
  const hash = createHash('sha256');
  if (identity.origin) {
    hash
      .update('origin\0')
      .update(identity.origin.channelType)
      .update('\0')
      .update(identity.origin.platformId)
      .update('\0')
      .update(identity.origin.platformMessageId);
  } else {
    hash.update('session\0').update(identity.sessionId).update('\0').update(identity.messageId);
  }
  return `request:v1:${hash.digest('hex')}`;
}

/** Durable originating identity, never an agent-invented milestone or label. */
export function canonicalWorkItem(value: unknown): string {
  if (typeof value !== 'string') throw new Error('workItem must be a GitHub PR/issue or original Slack request URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('workItem must be a durable URL', { cause: error });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Invalid workItem URL');
  if (url.hostname === 'github.com') {
    const match = /^\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (match) return `github:${match[1].toLowerCase()}/${match[2].toLowerCase()}:${match[3]}:${match[4]}`;
  }
  if (/^[a-z0-9-]+\.slack\.com$/.test(url.hostname)) {
    const match = /^\/archives\/([A-Za-z0-9]+)\/p(\d{16})\/?$/.exec(url.pathname);
    if (match) return `slack:${url.hostname}:${match[1].toUpperCase()}:${match[2]}`;
  }
  throw new Error('workItem must identify the original GitHub PR/issue or Slack request, not a phase or free-text key');
}

function field(value: unknown, name: string, max: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/.test(value))
    throw new Error(`${name} must be one short line (${max} characters maximum); put detail in the evidence record`);
  return value.trim();
}

export function renderWorkOutcome(
  text: unknown,
  raw: unknown,
  trustedRequest?: TrustedRequestIdentity,
): { key: string; text: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('outcome requires a work-item and evidence record');
  const outcome = raw as Record<string, unknown>;
  const hasLegacyWorkItem = outcome.workItem !== undefined;
  const hasRequestId = outcome.requestId !== undefined;
  if (hasLegacyWorkItem === hasRequestId)
    throw new Error('outcome requires exactly one original workItem URL or harness requestId');
  const key = hasLegacyWorkItem
    ? canonicalWorkItem(outcome.workItem)
    : trustedRequest && outcome.requestId === trustedRequest.sequence
      ? requestWorkItem(trustedRequest)
      : (() => {
          throw new Error('requestId is not an admissible original request for this session');
        })();
  const summary = field(text, 'Outcome', 320);
  const verified = field(outcome.verified, 'Verified', 180);
  const remaining = field(outcome.remaining, 'Remaining', 180, true);
  const needsYou = field(outcome.needsYou, 'Needs you', 160, true);
  const evidence = field(outcome.evidence, 'Evidence', 500, true);
  if (evidence) {
    let url: URL;
    try {
      url = new URL(evidence);
    } catch (error) {
      throw new Error('Evidence must be an accessible HTTPS link', { cause: error });
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Evidence must be an accessible HTTPS link');
  }
  const body = [
    summary,
    `Verified: ${verified}`,
    remaining && `Remaining: ${remaining}`,
    needsYou ? `Needs you: ${needsYou}` : 'No action needed.',
    evidence && `Details: ${evidence}`,
  ]
    .filter(Boolean)
    .join('\n');
  if (body.length > 1100) throw new Error('Outcome exceeds 1100 characters; shorten it without dropping material risk');
  return { key, text: body };
}
