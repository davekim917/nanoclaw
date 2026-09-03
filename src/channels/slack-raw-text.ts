/**
 * Recover pasted-table content from a raw Slack event.
 *
 * Slack sends pasted tables as attachment blocks instead of message text or
 * files. The Chat SDK adapter currently leaves those blocks only in
 * `message.raw`, which the host deliberately drops before persistence.
 *
 * THE INVARIANT, and the reason this comment exists: the projection below is
 * part of the message body. Every consumer that reads a Slack message's text
 * has to consult it, not just the one that persists the body — a table can be
 * the ONLY content of a message, including the only place the bot is
 * @-mentioned. Three consumers do today:
 *
 *  - `messageToInbound` appends it to the persisted body (chat-sdk-bridge.ts);
 *  - `fetchThreadHistory` appends it to replayed thread context (same file);
 *  - `detectRecoveredMention` searches it for the bot's id (slack.ts).
 *
 * A fourth consumer that reads `.text` and skips this is a message the agent
 * silently never sees. Add it here when you add it there.
 */

const MAX_TABLE_CHARS = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Render one rich_text element node to readable text.
 *
 * Only plain runs carry their content in `text`. A mention, emoji, channel
 * reference, unlabeled link or broadcast keeps it in `user_id` / `name` /
 * `channel_id` / `url` / `range`, so a cell built from those alone would
 * project as empty — and a table of only such cells would look like nothing
 * was pasted at all.
 *
 * Mentions and channel refs are emitted in Slack's own wire form on purpose:
 * the bridge runs `transformInboundText` over the rescued text after
 * appending it, so `<@U…>` resolves to `@name` exactly like a mention typed
 * in the message body. Returns null when the node carries no readable value.
 */
function elementText(node: Record<string, unknown>): string | null {
  if (typeof node.text === 'string') return node.text;
  const str = (key: string): string | null => (typeof node[key] === 'string' ? (node[key] as string) : null);
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
    default:
      return null;
  }
}

/**
 * Structural containers inside a rich_text tree. Slack's TEXT runs already
 * carry their own spacing — `**AC**ME` is two adjacent runs "AC" and "ME" —
 * so leaves are concatenated with nothing between them, and a separator is
 * inserted only when a new section, list item or quote begins.
 */
const RICH_TEXT_SECTIONS = new Set([
  'rich_text_section',
  'rich_text_list',
  'rich_text_quote',
  'rich_text_preformatted',
]);

/** Collect the readable leaves in a Slack cell's raw_text/rich_text subtree. */
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
      // A rendered node is a leaf in Slack's schema (`text` and the id-bearing
      // fields only ever appear on leaves), so its own values carry nothing
      // further to collect.
      out += rendered;
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  // One line per cell: a cell built from a list or a preformatted block can
  // carry newlines, which would break the `a | b` row projection.
  return out.replace(/\s+/g, ' ').trim();
}

/** Slice without splitting a surrogate pair — an emoji rendered from its
 *  codepoints sits right on the truncation boundary often enough to matter,
 *  and half a pair is an invalid character in the persisted body. */
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
  // A table whose every cell is empty carries nothing to recover — say so with
  // null rather than handing the bridge a body of separators and blank lines.
  if (text.trim() === '') return null;
  if (text.length <= MAX_TABLE_CHARS) return text;
  return `${sliceWholeCharacters(text, MAX_TABLE_CHARS - 20)}\n[table truncated]`;
}
