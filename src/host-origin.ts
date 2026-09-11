/**
 * The host-only content fields on inbound session messages: `origin` and
 * `event`.
 *
 * The runner renders origin="host" and event="..." from these fields alone
 * (container/agent-runner/src/formatter.ts). writeSessionMessage strips it
 * from every inbound write except a host note (WriteSessionMessageOptions.hostOrigin,
 * session-manager.ts), so a person or a peer agent — who controls `sender`
 * and `senderId` in content they author — can never make it survive.
 */

/** Content fields only a host note may carry: the origin marker and its purpose tag. */
export const HOST_ONLY_FIELDS = ['origin', 'event'] as const;

/**
 * Drop the host-only fields (HOST_ONLY_FIELDS) from JSON-object content.
 * Anything else — none present, non-JSON, a non-object — passes through
 * byte-identical.
 */
export function withoutHostFields(content: string): string {
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
