import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';

export function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

export function generateId(prefix = 'msg'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const };
}

/** Write a host-facing system action into this session's own conversation. */
export async function emitSystemAction(
  idPrefix: string,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const r = getSessionRouting();
  await writeMessageOut({
    id: generateId(idPrefix),
    kind: 'system',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({ action, ...extra }),
  });
}
