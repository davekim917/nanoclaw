/**
 * The host-only content fields on inbound session messages: `origin` and
 * `event`.
 *
 * The runner renders origin="host" and event="..." from these fields alone,
 * and only on chat rows (container/agent-runner/src/formatter.ts).
 * writeSessionMessage strips them from every inbound chat write except a host
 * note (WriteSessionMessageOptions.hostOrigin, session-manager.ts), so a person
 * or a peer agent — who controls `sender` and `senderId` in content they
 * author — can never make them survive.
 */

/** Content fields only a host note may carry: the origin marker and its purpose tag. */
export const HOST_ONLY_FIELDS = ['origin', 'event'] as const;

/**
 * Content field carrying the platform-native id of the specific inbound
 * message a row represents (e.g. a Slack `ts`) — what the runner renders as
 * `platform_msg_id` (formatter.ts formatSingleChat), so an agent can cite the
 * exact platform message it was answering and an external verifier can check
 * that citation against the platform's own API.
 *
 * Unlike `origin`/`event`, this is not gated by `hostOrigin` (a host NOTE
 * never has a genuine platform message behind it, so it never carries this
 * field either way). It has its own trust rule instead: `stripPlatformMessageId`
 * removes it from ANY content a write arrives with, unconditionally, and
 * `withPlatformMessageId` is the only way it re-enters — called from
 * `writeSessionMessage*` only when the caller passes `platformMessageId`
 * (`WriteSessionMessageOptions`), which in practice is the router's own
 * routed-message write (src/router.ts), the one place that knows the real
 * id. No chat write — an agent's own tool call, an agent-to-agent delivery —
 * can set this field on itself and have it survive.
 */
export const PLATFORM_MSG_ID_FIELD = 'platformMsgId';

/**
 * The message kinds the runner marks. formatSingleChat renders the fields above,
 * and it formats only the chat and chat-sdk batch (formatter.ts:322, passed to
 * formatChatMessages). Other kinds keep same-named fields that mean something
 * else, e.g. a webhook row's `event`, which formatWebhookMessage renders
 * (formatter.ts:534-537).
 */
export const HOST_MARKED_KINDS: readonly string[] = ['chat', 'chat-sdk'];

/**
 * Drop the host-only fields (HOST_ONLY_FIELDS) from JSON-object content of a
 * kind the runner marks (HOST_MARKED_KINDS). Anything else — another kind, no
 * field present, non-JSON, a non-object — passes through byte-identical.
 */
export function withoutHostFields(content: string, kind: string): string {
  if (!HOST_MARKED_KINDS.includes(kind)) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
    // eslint-disable-next-line no-catch-all/no-catch-all -- non-JSON content has no field to strip
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return content;
  if (!HOST_ONLY_FIELDS.some((field) => Object.hasOwn(parsed, field))) return content;
  const copy = { ...(parsed as Record<string, unknown>) };
  for (const field of HOST_ONLY_FIELDS) delete copy[field];
  return JSON.stringify(copy);
}

/**
 * Drop PLATFORM_MSG_ID_FIELD from JSON-object content of a kind the runner
 * marks, unconditionally — called on every write, `hostOrigin` or not, before
 * `withPlatformMessageId` (if any) re-adds the trusted value. This is what
 * keeps a chat write from forging or echoing its own `platformMsgId`: whatever
 * the caller-supplied content claims is removed first, every time.
 */
export function stripPlatformMessageId(content: string, kind: string): string {
  if (!HOST_MARKED_KINDS.includes(kind)) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
    // eslint-disable-next-line no-catch-all/no-catch-all -- non-JSON content has no field to strip
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return content;
  if (!Object.hasOwn(parsed, PLATFORM_MSG_ID_FIELD)) return content;
  const copy = { ...(parsed as Record<string, unknown>) };
  delete copy[PLATFORM_MSG_ID_FIELD];
  return JSON.stringify(copy);
}

/**
 * Stamp PLATFORM_MSG_ID_FIELD onto JSON-object content of a kind the runner
 * marks. The one caller is the write path, and only when the write's caller
 * explicitly supplied `platformMessageId` — see `stripPlatformMessageId`'s
 * doc for why nothing else can reach this. Non-JSON or non-object content is
 * returned unchanged: there is no object to annotate, and manufacturing one
 * would change the row's shape for a kind that never expected it.
 */
export function withPlatformMessageId(content: string, kind: string, platformMessageId: string): string {
  if (!HOST_MARKED_KINDS.includes(kind)) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
    // eslint-disable-next-line no-catch-all/no-catch-all -- non-JSON content has no object to annotate
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return content;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), [PLATFORM_MSG_ID_FIELD]: platformMessageId });
}
