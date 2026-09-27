/**
 * Rewrites machine gate-verdict tokens into plain English at delivery, unconditionally: a token is never meaningful
 * to a human. `GO` and `BLOCKED` are left alone: they already read as English.
 */

const HUMAN: Record<string, string> = {
  NO_GO: 'No-go',
  HUMAN_DECISION: 'Needs a human decision',
  BLOCKED_BUILD_IDENTITY: 'Blocked (build identity)',
};

// Only a core that is EXACTLY a token is rewritten, so URLs, paths and identifiers that merely contain one
// (`task-NO_GO-x`, `?NO_GO=1`) never match.
const WORD = /^([(["'*`]*)(.*?)([.,;:!?)\]"'*`]*)$/s;
// Any fence-like run may mean code; such a message is left alone entirely (verdict posts don't carry code).
const CODE = /```|~~~/;

export function humanizeVerdictTokens(text: string): string {
  if (CODE.test(text)) return text;
  return text.replace(/\S+/g, (word) => {
    const [, pre, core, post] = WORD.exec(word)!;
    const ticks = (s: string) => s.split('`').length - 1;
    // An unbalanced backtick means the word sits inside a longer code span.
    if (!Object.hasOwn(HUMAN, core) || ticks(pre) !== ticks(post)) return word;
    return pre.replaceAll('`', '') + HUMAN[core] + post.replaceAll('`', '');
  });
}

/** Unparseable content, or content without string `text`, passes through byte-for-byte. */
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
