/**
 * Host-only content fields on inbound chat rows, which the runner renders as origin="host"/event="...".
 * writeSessionMessage strips them from every write except a host note, so a person or peer agent, who controls the
 * content they author, can never make them survive.
 */

const HOST_ONLY_FIELDS = ['origin', 'event'] as const;

/**
 * The platform-native id of the inbound message a row represents (e.g. a Slack `ts`), rendered as
 * `platform_msg_id` so an agent's citation can be verified against the platform. Stripped from EVERY write; only
 * `withPlatformMessageId` re-adds it, when the caller passes `platformMessageId`, which only the router's write of
 * genuine non-CLI adapter ingress does. No agent or agent-to-agent write can set it on itself.
 */
const PLATFORM_MSG_ID_FIELD = 'platformMsgId';

/** Only chat and chat-sdk rows get these fields rendered; other kinds' same-named fields (a webhook `event`) differ. */
const HOST_MARKED_KINDS: readonly string[] = ['chat', 'chat-sdk'];

/** Anything other than a marked kind's JSON object carrying a host-only field passes through byte-identical. */
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

/** Runs on every write, before `withPlatformMessageId` re-adds the trusted value, so content cannot forge it. */
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

/** Non-object content is returned unchanged rather than manufacturing an object the kind never expected. */
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
