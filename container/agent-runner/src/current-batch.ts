/**
 * Per-batch, per-destination reply anchors, used ONLY inside the poll-loop
 * process (module state is fine there — the poll loop is single-process and
 * handles one batch at a time, and every reader runs on its call stack).
 *
 * The batch-level a2a reply stamp that used to live here moved to
 * outbound.db session_state (`setCurrentInReplyTo` / `getCurrentInReplyTo`
 * in db/session-state.ts): the nanoclaw MCP server can run as a separate
 * stdio subprocess from the poll loop, so module state set here was
 * invisible to it.
 *
 * Keyed by `<channelType>\0<platformId>`. In agent-shared sessions one batch
 * can carry messages from several channels; a reply sent to channel X must
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

export function clearBatchAnchors(): void {
  batchAnchors.clear();
}
