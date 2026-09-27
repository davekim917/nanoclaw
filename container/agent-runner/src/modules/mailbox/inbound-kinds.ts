/**
 * The closed set of `messages_in.kind` values this install writes. Upstream's parseInboundRecord rejects any
 * other kind and selection SKIPS unparseable rows, so a kind written outside this set silently vanishes.
 * Verified against every live inbound.db and every host write site; recall and status notices are 'system'
 * rows distinguished by id prefix or content, not a separate kind.
 */
export const INBOUND_KINDS = ['chat', 'chat-sdk', 'system', 'task', 'webhook'] as const;
