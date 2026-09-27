/**
 * Per-destination reply anchors for the current batch. Module state is safe only
 * because the poll loop handles one batch at a time and every reader runs on its
 * call stack; the MCP server may be a separate subprocess and cannot see it.
 *
 * Keyed per channel: in agent-shared sessions a batch spans channels, and a reply
 * must anchor to its own channel's message. Derived ONLY from the claimed batch,
 * never the newest inbound row: that row can be a sibling task's unfired future
 * fire, and marking it replied-to suppresses the series for good.
 */
const batchAnchors = new Map<string, string>();

function anchorKey(channelType: string, platformId: string): string {
  return `${channelType}\0${platformId}`;
}

export function setCurrentBatchAnchors(
  messages: Array<{ id: string; channel_type: string | null; platform_id: string | null }>,
): void {
  batchAnchors.clear();
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
