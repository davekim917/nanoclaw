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

// A word is split into wrapping punctuation and a core; only a core that is
// EXACTLY a token is rewritten, so URLs, paths, queries and identifiers that
// merely contain one (`task-NO_GO-x`, `a/`NO_GO`/b`, `?NO_GO=1`) never match.
const WORD = /^([(["'*`]*)(.*?)([.,;:!?)\]"'*`]*)$/s;
// Any fence-like run means the message may carry code. Modelling Markdown to
// find its edges drew new holes each round (lists, blockquotes, nesting), so
// such a message is left alone entirely — verdict posts don't carry code.
const CODE = /```|~~~/;

/** Rewrite gate tokens in text that carries no code block. Pure and idempotent. */
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
