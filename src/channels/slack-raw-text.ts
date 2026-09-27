/**
 * Recovers pasted-table content, which Slack sends as attachment blocks and the Chat SDK leaves only in `message.raw`
 * (dropped before persistence).
 * INVARIANT: this projection is part of the message body. A table can be a message's only content, including the only
 * place the bot is @-mentioned, so every consumer of Slack message text must consult it: `messageToInbound` and
 * `fetchThreadHistory` (chat-sdk-bridge.ts) and `detectRecoveredMention` (slack.ts). A consumer that skips it
 * silently loses messages.
 */

import { TIMEZONE } from '../config.js';
import { formatLocalTime } from '../timezone.js';

const MAX_TABLE_CHARS = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fences code with one backtick more than the longest run inside, so `slackMentionOutsideCode` strips it whole; a
 * too-short fence closes early and PROMOTES a mention inside it to prose, waking a mention-scoped agent. Content
 * starting or ending with a backtick is padded.
 */
function fenceCode(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Renders one rich_text leaf. Only plain runs carry `text`; mentions, emoji, channels, links and broadcasts keep
 * their value elsewhere, and missing them makes a table project as empty. Mentions and channel refs are emitted in
 * Slack's wire form so `transformInboundText` resolves them like body text. Returns null when nothing is readable.
 * The single owner of leaf rendering: all nine documented leaf types are handled here, and new ones belong here.
 */
function elementText(node: Record<string, unknown>): string | null {
  const str = (key: string): string | null => (typeof node[key] === 'string' ? (node[key] as string) : null);
  if (typeof node.text === 'string') {
    // An inline code run keeps its backticks: a mention only inside code is demoted, and dropping the delimiters
    // would wake an agent off pasted gate syntax.
    const style = isRecord(node.style) ? node.style : undefined;
    return style?.code === true ? fenceCode(node.text) : node.text;
  }
  switch (node.type) {
    case 'user': {
      const id = str('user_id');
      return id ? `<@${id}>` : null;
    }
    case 'channel': {
      const id = str('channel_id');
      return id ? `<#${id}>` : null;
    }
    case 'usergroup': {
      const id = str('usergroup_id');
      return id ? `<!subteam^${id}>` : null;
    }
    case 'broadcast': {
      const range = str('range');
      return range ? `@${range}` : null;
    }
    case 'emoji': {
      const unicode = str('unicode');
      if (unicode) {
        const points = unicode.split('-').map((hex) => Number.parseInt(hex, 16));
        if (points.every((cp) => Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff)) {
          return String.fromCodePoint(...points);
        }
      }
      const name = str('name');
      return name ? `:${name}:` : null;
    }
    case 'link':
      return str('url');
    case 'date': {
      // Prefer Slack's pre-rendered `fallback`; otherwise render in the install timezone.
      const fallback = str('fallback');
      if (fallback) return fallback;
      const timestamp = typeof node.timestamp === 'number' ? node.timestamp : Number(str('timestamp'));
      return Number.isFinite(timestamp) && timestamp > 0
        ? formatLocalTime(new Date(timestamp * 1000).toISOString(), TIMEZONE)
        : null;
    }
    case 'color':
      return str('value');
    default:
      return null;
  }
}

/**
 * Text runs carry their own spacing (`**AC**ME` is runs "AC" and "ME"), so leaves concatenate directly and a
 * separator is added only at a new section, list item or quote.
 */
const RICH_TEXT_SECTIONS = new Set([
  'rich_text_section',
  'rich_text_list',
  'rich_text_quote',
  'rich_text_preformatted',
]);

function cellText(value: unknown): string {
  let out = '';
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.type === 'string' && RICH_TEXT_SECTIONS.has(node.type) && out !== '' && !/\s$/.test(out)) {
      out += ' ';
    }
    const rendered = elementText(node);
    if (rendered !== null) {
      // A rendered node is always a leaf in Slack's schema.
      out += rendered;
      return;
    }
    if (node.type === 'rich_text_preformatted') {
      // Fenced for the same reason as inline code; see elementText.
      const start = out.length;
      Object.values(node).forEach(visit);
      const body = out.slice(start).trim();
      out = body ? `${out.slice(0, start)}${fenceCode(body)}` : out.slice(0, start);
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  // One line per cell, or newlines break the `a | b` row projection.
  return out.replace(/\s+/g, ' ').trim();
}

/** Never splits a surrogate pair: half a pair is an invalid character in the persisted body. */
function sliceWholeCharacters(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function extractSlackRawText(raw: Record<string, unknown>): string | null {
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const lines: string[] = [];

  for (const attachment of attachments) {
    if (!isRecord(attachment)) continue;
    const blocks = Array.isArray(attachment.blocks) ? attachment.blocks : [];
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== 'table' || !Array.isArray(block.rows)) continue;
      for (const row of block.rows) {
        if (!Array.isArray(row)) continue;
        lines.push(row.map(cellText).join(' | '));
      }
    }
  }

  const text = lines.join('\n');
  // An all-empty table carries nothing to recover.
  if (text.trim() === '') return null;
  if (text.length <= MAX_TABLE_CHARS) return text;
  return `${sliceWholeCharacters(text, MAX_TABLE_CHARS - 20)}\n[table truncated]`;
}
