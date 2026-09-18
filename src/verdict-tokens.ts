/**
 * Rewrite machine gate-verdict tokens into plain English before agent text
 * reaches a human.
 *
 * The operator asked repeatedly that agents stop showing these tokens, and a
 * group's standing prose rule against it did not hold: on 2026-09-18 an agent
 * still posted "**Verdict: do not ship — `NO_GO` on develop lineage …**" to a
 * human. A token is never meaningful to a human, so this runs unconditionally
 * at delivery — no flag.
 *
 * `GO` and `BLOCKED` are left alone: they already read as English.
 */

const HUMAN: Record<string, string> = {
  NO_GO: 'No-go',
  HUMAN_DECISION: 'Needs a human decision',
  BLOCKED_BUILD_IDENTITY: 'Blocked (build identity)',
};

const NAMES = Object.keys(HUMAN).join('|');
// Either the whole inline-code span `TOKEN`, or a bare whole-word TOKEN not
// embedded in an identifier, path, URL or query (`task-NO_GO-x`,
// `NO_GO_REASON`, `/NO_GO`, `?v=NO_GO`). A trailing sentence period is fine.
const TOKEN = new RegExp(`\`(${NAMES})\`|(?<![\\w\\-/.=\`])(${NAMES})(?![\\w\\-/\`]|\\.\\w)`, 'g');
const FENCE = /^\s*(```|~~~)/;

/** Rewrite gate tokens outside fenced code blocks. Pure and idempotent. */
export function humanizeVerdictTokens(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      const fence = FENCE.exec(line);
      if (fence) {
        // A one-line ```…``` span opens and closes on the same line.
        if (!line.slice(fence[0].length).includes(fence[1])) inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(TOKEN, (_m, code?: string, bare?: string) => HUMAN[(code ?? bare)!]);
    })
    .join('\n');
}

/**
 * Apply `humanizeVerdictTokens` to the `text` field of a serialized outbound
 * content payload. Anything unparseable or without string text passes through
 * byte-for-byte.
 */
export function humanizeOutboundContent(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { text?: unknown }).text !== 'string') return content;
  const text = (parsed as { text: string }).text;
  const humanized = humanizeVerdictTokens(text);
  return humanized === text ? content : JSON.stringify({ ...parsed, text: humanized });
}
