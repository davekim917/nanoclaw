/**
 * Recover pasted-table content from a raw Slack event.
 *
 * Slack sends pasted tables as attachment blocks instead of message text or
 * files. The Chat SDK adapter currently leaves those blocks only in
 * `message.raw`, which the host deliberately drops before persistence.
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

/** Collect the readable leaves in a Slack cell's raw_text/rich_text subtree. */
function cellText(value: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    const rendered = elementText(node);
    if (rendered) parts.push(rendered);
    Object.values(node).forEach(visit);
  };
  visit(value);
  return parts.join(' ').trim();
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
  return `${text.slice(0, MAX_TABLE_CHARS - 20)}\n[table truncated]`;
}
