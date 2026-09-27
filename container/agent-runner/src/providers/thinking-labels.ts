/**
 * Only thinking blocks become progress labels: the chat shows one progress message at a time, so a tool_use
 * label would overwrite the reasoning within a second. Secrets are scrubbed host-side (delivery.ts
 * scrubSecrets); the container emits raw text.
 */

const LABEL_MAX = 2000;

export function thinkingForwardingEnabled(): boolean {
  const v = process.env.NANOCLAW_HIDE_THINKING;
  return !v || v === '0' || v.toLowerCase() === 'false';
}

export function truncate(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= LABEL_MAX) return trimmed;
  return trimmed.slice(0, LABEL_MAX - 1).replace(/\s+\S*$/, '') + '…';
}

export function formatBlockquoteLabel(emoji: string, prose: string): string {
  const lines = prose.split('\n');
  lines[0] = `${emoji} ${lines[0]}`;
  return lines.map((line) => `> ${line}`).join('\n');
}
