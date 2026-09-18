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
// Allowlist, not exclusions: a token is rewritten only as a whole
// whitespace-delimited word, optionally wrapped in markdown/prose punctuation.
// Anything else in the word — `/`, `\`, `#`, `?`, `=`, `-`, letters — means it
// is part of a URL, path, query or identifier, and the word is left alone.
const WORD = new RegExp(`(?<=^|\\s)([(\\["'*]*)(${NAMES})([.,;:!?)\\]"'*]*)(?=\\s|$)`, 'g');
// An inline code span: a backtick run closed by a run of the same length.
const CODE_SPAN = /(`+)[\s\S]*?(?<!`)\1(?!`)/g;
// CommonMark fences: an opening run of 3+ backticks (no backtick in the info
// string) or tildes; closed only by a bare run of the same char, at least as long.
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

function humanizeLine(line: string): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(CODE_SPAN)) {
    out += line.slice(last, m.index).replace(WORD, (_w, pre: string, t: string, post: string) => pre + HUMAN[t] + post);
    // Only a span holding exactly one token, in single backticks, is rewritten.
    out += m[0].slice(1, -1) in HUMAN && m[1] === '`' ? HUMAN[m[0].slice(1, -1)] : m[0];
    last = m.index + m[0].length;
  }
  return out + line.slice(last).replace(WORD, (_w, pre: string, t: string, post: string) => pre + HUMAN[t] + post);
}

/** Rewrite gate tokens outside fenced code blocks. Pure and idempotent. */
export function humanizeVerdictTokens(text: string): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      if (fence !== null) {
        const close = /^ {0,3}(`+|~+)\s*$/.exec(line);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
        return line;
      }
      const open = FENCE_OPEN.exec(line);
      if (open) {
        fence = open[1];
        return line;
      }
      return humanizeLine(line);
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
