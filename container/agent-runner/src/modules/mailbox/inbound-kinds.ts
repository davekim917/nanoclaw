/**
 * The closed set of `messages_in.kind` values. Upstream's parseInboundRecord rejects any other kind and
 * selection SKIPS unparseable rows, so a row written with a kind outside this set silently vanishes.
 * Recall and status notices are 'system' rows told apart by id prefix or content, not a separate kind.
 */
export const INBOUND_KINDS = ['chat', 'chat-sdk', 'system', 'task', 'webhook'] as const;
