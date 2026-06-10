/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * Today the only field is `inReplyTo` — the id of the first inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out).
 */
let currentInReplyTo: string | null = null;

/**
 * Per-destination reply anchors for the batch being processed, keyed by
 * `<channelType>\0<platformId>`. In agent-shared sessions one batch can
 * carry messages from several channels; a reply sent to channel X must
 * anchor to X's inbound message, not the batch's first message.
 *
 * Derived ONLY from the claimed batch — never resolved from the newest
 * inbound DB row. Batch rows are already claimed/processing, so stamping
 * them as replied-to is harmless; a freshly-resolved "latest row" can be a
 * sibling scheduled task's unfired future fire, and marking THAT as
 * replied-to suppressed the series forever (the 2026-05-27..31 die-off).
 */
const batchAnchors = new Map<string, string>();

function anchorKey(channelType: string, platformId: string): string {
  return `${channelType}\0${platformId}`;
}

export function setCurrentBatchAnchors(
  messages: Array<{ id: string; channel_type: string | null; platform_id: string | null }>,
): void {
  batchAnchors.clear();
  // Later rows win: the most recent message from each channel is the anchor.
  for (const m of messages) {
    if (m.channel_type != null && m.platform_id != null) {
      batchAnchors.set(anchorKey(m.channel_type, m.platform_id), m.id);
    }
  }
}

export function getBatchAnchor(channelType: string, platformId: string): string | null {
  return batchAnchors.get(anchorKey(channelType, platformId)) ?? null;
}

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
  batchAnchors.clear();
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo;
}

