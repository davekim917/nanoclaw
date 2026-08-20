import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true, // single newline → <br>; matches Slack/Discord visual rhythm
});

/**
 * Escaping raw HTML in the SOURCE is what makes `dangerouslySetInnerHTML`
 * acceptable at every call site of `renderMarkdown` — the text is agent- and
 * user-authored and effectively untrusted.
 *
 * **`marked` does not do this on its own, and the comment here used to say it
 * did.** Verified against marked 18.0.10: with only `{gfm, breaks}` set,
 * `marked.parse('<img src=x onerror=alert(1)>')` returns that tag verbatim.
 * `sanitize` was removed from marked in v5 and nothing replaced it, so every
 * caller feeding this into `dangerouslySetInnerHTML` was a stored-XSS sink.
 * The two overrides below are what actually deliver the promise:
 *
 *  - `html` — block and inline raw-HTML tokens render as escaped text, so a
 *    `<script>` in a message reads as `<script>` instead of running.
 *  - `link` — hrefs are restricted to a scheme allow-list, because
 *    `[x](javascript:…)` is a link token, not an HTML token, and the `html`
 *    hook never sees it.
 *
 * DO NOT remove either, and do not add a `sanitize: false`, a `mangle`, or a
 * renderer that permits inline HTML. Fenced code, tables, autolinks and every
 * other GFM construct are unaffected — they never went through these paths.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Schemes a rendered link may carry. Anything else renders as inert text. */
const SAFE_LINK_SCHEME = /^(?:https?:|mailto:|#|\/|\.{1,2}\/)/i;

marked.use({
  renderer: {
    html(token: { raw?: string; text?: string }): string {
      return escapeHtml(token.raw ?? token.text ?? '');
    },
    link(token: { href?: string; title?: string | null; tokens?: unknown[]; text?: string }): string {
      // `this.parser.parseInline` keeps the link's own emphasis/code formatting
      // rather than flattening it to text.
      const self = this as unknown as { parser: { parseInline: (t: unknown[]) => string } };
      const label = token.tokens ? self.parser.parseInline(token.tokens) : escapeHtml(token.text ?? '');
      const href = (token.href ?? '').trim();
      if (!SAFE_LINK_SCHEME.test(href)) return label;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title}>${label}</a>`;
    },
  },
});

export function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string;
}

/**
 * Markdown flattened to one line of plain text, for SINGLE-LINE PREVIEWS ONLY.
 *
 * A row's excerpt lives in a one-line flex cell with an ellipsis. Rendering
 * markdown into it would inject `<p>`, `<ul>` and `<pre>` — block elements in a
 * one-line container — and break the row. Leaving the source raw is the other
 * failure: the operator reads `**ship it**` instead of `ship it`.
 *
 * **This is NOT a sanitiser and must never be mistaken for one.** It returns a
 * plain string that callers render as a text node, so there is nothing to
 * sanitise; safety on the rendered path comes from `renderMarkdown` above,
 * where `marked` escapes raw HTML in the source to entities. If you ever find
 * yourself passing this output to `dangerouslySetInnerHTML`, stop — that is the
 * bug this paragraph exists to prevent.
 *
 * Deliberately a handful of regexes rather than a second parse: an excerpt is
 * ~140 characters of a message and it runs per row, per refresh. Nested or
 * exotic constructs degrade to slightly-imperfect prose, which is the right
 * failure for a preview.
 */
export function stripMarkdown(src: string): string {
  return (
    src
      // Fenced code → its contents, so a preview shows the code rather than ```.
      .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
      .replace(/```/g, '')
      // Inline code → its contents.
      .replace(/`([^`]+)`/g, '$1')
      // Images before links: ![alt](url) keeps the alt text, not the URL.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Autolinks and reference-style brackets.
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      // Leading block markers, line by line: headings, quotes, list bullets.
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
      // Horizontal rules become nothing rather than a row of dashes.
      .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, ' ')
      // Emphasis markers. Paired only, so `a * b` and snake_case survive.
      .replace(/(\*\*\*|___)(\S(?:[\s\S]*?\S)?)\1/g, '$2')
      .replace(/(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/g, '$2')
      .replace(/(?<![\w*])\*(\S(?:[^*]*?\S)?)\*(?![\w*])/g, '$1')
      .replace(/(?<![\w_])_(\S(?:[^_]*?\S)?)_(?![\w_])/g, '$1')
      .replace(/~~([\s\S]*?)~~/g, '$1')
      // One line, single spaces — the whole point.
      .replace(/\s+/g, ' ')
      .trim()
  );
}
