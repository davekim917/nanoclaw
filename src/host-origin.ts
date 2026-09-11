/**
 * The reserved `origin` content field on inbound session messages.
 *
 * The runner renders origin="host" from this field alone
 * (container/agent-runner/src/formatter.ts). writeSessionMessage strips it
 * from every inbound write except a host note (WriteSessionMessageOptions.hostOrigin,
 * session-manager.ts), so a person or a peer agent — who controls `sender`
 * and `senderId` in content they author — can never make it survive.
 */

/**
 * Drop a top-level `origin` from JSON-object content. Anything else — no such
 * field, non-JSON, a non-object — passes through byte-identical.
 */
export function withoutReservedOrigin(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
    // eslint-disable-next-line no-catch-all/no-catch-all -- non-JSON content has no field to strip
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'origin')) {
    return content;
  }
  const copy = { ...(parsed as Record<string, unknown>) };
  delete copy.origin;
  return JSON.stringify(copy);
}
