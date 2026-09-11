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
