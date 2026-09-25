/**
 * Progress labels derived from assistant messages. Only thinking
 * blocks are forwarded — tool_use labels were dropped because the post-then-
 * edit chat UX shows one progress message at a time, so a tool_use label
 * emitted immediately after thinking would overwrite the reasoning text
 * within a second. Users wanted to read the thinking; the tool action is
 * implied by the context.
 *
 * Secret scrubbing happens host-side in delivery.ts (scrubSecrets catches
 * Bearer tokens, vendor-prefix keys, registered .env values) — the
 * container emits raw text and trusts the outbound filter.
 *
 * NANOCLAW_HIDE_THINKING=1 suppresses all progress forwarding.
 */

/** Max chars per thinking label. Thinking prose is usually multi-paragraph. */
const LABEL_MAX = 2000;

/** Env gate: set NANOCLAW_HIDE_THINKING=1 to suppress thinking-block forwarding. */
export function thinkingForwardingEnabled(): boolean {
  const v = process.env.NANOCLAW_HIDE_THINKING;
  return !v || v === '0' || v.toLowerCase() === 'false';
}

export function truncate(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= LABEL_MAX) return trimmed;
  return trimmed.slice(0, LABEL_MAX - 1).replace(/\s+\S*$/, '') + '…';
}

/**
 * Format a status label as a blockquote with a leading emoji. Prefixes
 * every line with `> ` so it renders as a blockquote — indented with a
 * vertical accent bar on Slack and Discord, visually distinct from a
 * real agent response. The orphan is deleted on final-chat delivery, so
 * it only ever lives mid-turn; blockquote reads more naturally than
 * monospace for live prose.
 */
export function formatBlockquoteLabel(emoji: string, prose: string): string {
  const lines = prose.split('\n');
  lines[0] = `${emoji} ${lines[0]}`;
  return lines.map((line) => `> ${line}`).join('\n');
}
