/** Claude's Markdown to channel-native formatting; code (fenced and inline) is never marker-substituted. */

export type ChannelType = 'signal' | 'telegram' | 'slack' | 'discord';

export function parseTextStyles(text: string, channel: ChannelType): string {
  if (!text) return text;

  if (channel === 'discord' || channel === 'signal') return text;

  const segments = splitProtectedRegions(text);
  return segments
    .map(({ content, protected: isProtected }) => (isProtected ? content : transformSegment(content, channel)))
    .join('');
}

export interface SignalTextStyle {
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
  /** Start position in the final message string, in UTF-16 code units. */
  start: number;
  /** Length of the styled range, in UTF-16 code units. */
  length: number;
}

/**
 * Markdown to plain text plus Signal textStyle ranges, in UTF-16 code units as signal-cli's `send.textStyle`
 * expects. Links become "text (url)", headings BOLD, horizontal rules are dropped.
 */
export function parseSignalStyles(rawText: string): {
  text: string;
  textStyle: SignalTextStyle[];
} {
  const textStyle: SignalTextStyle[] = [];
  let out = '';
  let i = 0;
  const s = rawText;
  const n = s.length;

  function addStyle(style: SignalTextStyle['style'], startOut: number, endOut: number): void {
    const length = endOut - startOut;
    if (length > 0) textStyle.push({ style, start: startOut, length });
  }

  while (i < n) {
    if (s[i] === '`' && s[i + 1] === '`' && s[i + 2] === '`') {
      const langNl = s.indexOf('\n', i + 3);
      if (langNl !== -1) {
        const closeAt = s.indexOf('\n```', langNl);
        if (closeAt !== -1) {
          const content = s.slice(langNl + 1, closeAt);
          const startOut = out.length;
          out += content;
          addStyle('MONOSPACE', startOut, out.length);
          const afterClose = s.indexOf('\n', closeAt + 4);
          i = afterClose !== -1 ? afterClose + 1 : n;
          continue;
        }
      }
      out += s[i];
      i++;
      continue;
    }

    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      const nl = s.indexOf('\n', i + 1);
      if (end !== -1 && (nl === -1 || end < nl)) {
        const content = s.slice(i + 1, end);
        const startOut = out.length;
        out += content;
        addStyle('MONOSPACE', startOut, out.length);
        i = end + 1;
        continue;
      }
    }

    if (s[i] === '*' && s[i + 1] === '*' && s[i + 2] && s[i + 2] !== ' ') {
      const end = s.indexOf('**', i + 2);
      if (end !== -1 && s[end - 1] !== ' ') {
        const content = s.slice(i + 2, end);
        const startOut = out.length;
        out += content;
        addStyle('BOLD', startOut, out.length);
        i = end + 2;
        continue;
      }
    }

    if (s[i] === '~' && s[i + 1] === '~' && s[i + 2] && s[i + 2] !== ' ') {
      const end = s.indexOf('~~', i + 2);
      if (end !== -1) {
        const content = s.slice(i + 2, end);
        const startOut = out.length;
        out += content;
        addStyle('STRIKETHROUGH', startOut, out.length);
        i = end + 2;
        continue;
      }
    }

    if (s[i] === '*' && s[i + 1] !== '*' && s[i + 1] !== ' ' && s[i + 1] !== undefined) {
      const end = findClosingStar(s, i + 1);
      if (end !== -1) {
        const content = s.slice(i + 1, end);
        const startOut = out.length;
        out += content;
        addStyle('ITALIC', startOut, out.length);
        i = end + 1;
        continue;
      }
    }

    if (s[i] === '_' && s[i + 1] !== '_' && s[i + 1] !== ' ' && s[i + 1]) {
      // Not after a word character: snake_case is not italic.
      const prevChar = i > 0 ? s[i - 1] : '';
      if (!/\w/.test(prevChar)) {
        const end = findClosingUnderscore(s, i + 1);
        if (end !== -1) {
          const content = s.slice(i + 1, end);
          const startOut = out.length;
          out += content;
          addStyle('ITALIC', startOut, out.length);
          i = end + 1;
          continue;
        }
      }
    }

    if ((i === 0 || s[i - 1] === '\n') && s[i] === '#') {
      let j = i;
      while (j < n && s[j] === '#') j++;
      if (j < n && s[j] === ' ') {
        const lineEnd = s.indexOf('\n', j + 1);
        const headingText = lineEnd !== -1 ? s.slice(j + 1, lineEnd) : s.slice(j + 1);
        const startOut = out.length;
        out += headingText;
        addStyle('BOLD', startOut, out.length);
        if (lineEnd !== -1) {
          out += '\n';
          i = lineEnd + 1;
        } else i = n;
        continue;
      }
    }

    if (s[i] === '[') {
      const closeBracket = s.indexOf(']', i + 1);
      if (closeBracket !== -1 && s[closeBracket + 1] === '(') {
        const closeParen = s.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = s.slice(i + 1, closeBracket);
          const url = s.slice(closeBracket + 2, closeParen);
          out += `${linkText} (${url})`;
          i = closeParen + 1;
          continue;
        }
      }
    }

    if (i === 0 || s[i - 1] === '\n') {
      const hrMatch = /^(-{3,}|\*{3,}|_{3,}) *(\n|$)/.exec(s.slice(i));
      if (hrMatch) {
        i += hrMatch[0].length;
        continue;
      }
    }

    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      out += s[i] + s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }

  return { text: out, textStyle };
}

function findClosingStar(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\n') return -1; // italics don't span lines
    if (s[i] === '*' && s[i + 1] !== '*' && s[i - 1] !== ' ') return i;
  }
  return -1;
}

function findClosingUnderscore(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\n') return -1;
    if (s[i] === '_' && s[i + 1] !== '_' && !/\w/.test(s[i + 1] ?? '')) {
      return i;
    }
  }
  return -1;
}

interface Segment {
  content: string;
  protected: boolean;
}

/**
 * Split text into alternating unprotected/protected segments.
 * Protected = fenced code blocks (```...```) and inline code (`...`).
 */
function splitProtectedRegions(text: string): Segment[] {
  const segments: Segment[] = [];
  const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]+`/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        content: text.slice(lastIndex, match.index),
        protected: false,
      });
    }
    segments.push({ content: match[0], protected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), protected: false });
  }

  return segments.length > 0 ? segments : [{ content: text, protected: false }];
}

/** Apply `transform` to every region of `text` outside fenced and inline code. */
export function transformOutsideProtectedRegions(text: string, transform: (segment: string) => string): string {
  if (!text) return text;
  return splitProtectedRegions(text)
    .map(({ content, protected: isProtected }) => (isProtected ? content : transform(content)))
    .join('');
}

/** Apply `transform` to the content of inline code spans only; the complement of transformOutsideProtectedRegions. */
export function transformInsideInlineCode(text: string, transform: (inner: string) => string): string {
  if (!text) return text;
  return splitProtectedRegions(text)
    .map(({ content, protected: isProtected }) => {
      if (!isProtected || content.startsWith('```')) return content;
      const m = content.match(/^(`+)([\s\S]*)\1$/);
      if (!m) return content;
      return `${m[1]}${transform(m[2])}${m[1]}`;
    })
    .join('');
}

/**
 * `## Heading` → `**Heading**`, for adapters that render ATX headings as plain text but bold natively; keeps the
 * `markdown` delivery path (where rich blocks like Slack Block Kit tables live).
 */
export function markdownHeadingsToBold(text: string): string {
  return transformOutsideProtectedRegions(text, (s) =>
    s.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '**$1**'),
  );
}

function transformSegment(text: string, channel: ChannelType): string {
  let t = text;

  // Italic before bold: bold first (**b** → *b*) would be re-converted to _b_ by the italic step.
  t = t.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');

  t = t.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');

  t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  if (channel === 'slack') {
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
  } else {
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  }

  // Collapse a rule and its surrounding blank lines into one paragraph break.
  t = t.replace(/\n*^(-{3,}|\*{3,}|_{3,})$\n*/gm, '\n\n');

  return t;
}
