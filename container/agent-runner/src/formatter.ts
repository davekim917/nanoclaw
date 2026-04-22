import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

/**
 * Command categories for messages starting with '/'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

const ADMIN_COMMANDS = new Set(['/remote-control', '/clear', '/compact', '/context', '/cost', '/files', '/kill']);
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/start']);

const VALID_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh']);

// Short-alias map for common model pins. Lets the user type `-m opus46`
// or `-m opus4-6` instead of `-m claude-opus-4-6[1m]` for the models they
// reach for most often. Resolution runs BEFORE the allowlist check, so the
// expanded canonical form is what gets stored.
//
// Opus short aliases default to the [1m] 1M-context variant because that's
// the common intent when pinning to a specific Opus version. Sonnet/Haiku
// variants don't have [1m] today; add when/if they do.
const MODEL_ALIAS_MAP: Record<string, string> = {
  'opus46': 'claude-opus-4-6[1m]',
  'opus4-6': 'claude-opus-4-6[1m]',
  'opus47': 'claude-opus-4-7',
  'opus4-7': 'claude-opus-4-7',
  'sonnet46': 'claude-sonnet-4-6',
  'sonnet4-6': 'claude-sonnet-4-6',
  'sonnet47': 'claude-sonnet-4-7',
  'sonnet4-7': 'claude-sonnet-4-7',
  'haiku45': 'claude-haiku-4-5',
  'haiku4-5': 'claude-haiku-4-5',
};

function resolveModelAlias(value: string): string {
  return MODEL_ALIAS_MAP[value.toLowerCase()] ?? value;
}

// Model values accepted by `-m`/`-m1` after alias resolution. Strict
// allowlist to prevent a DoS via `-m <nonsense>` that wedges future turns
// until an admin clears sticky state. Bare `opus`/`sonnet`/`haiku`/`default`
// are SDK-native aliases (current-default for that family).
const VALID_MODEL_RE = /^(?:opus|sonnet|haiku|default|claude-(?:opus|sonnet|haiku)-\d+-\d+(?:\[\dm\])?)$/;

/**
 * Model/effort flags parsed from the start of an inbound text message.
 *
 *   -m <model>    session-sticky model (persists across turns)
 *   -m1 <model>   one-shot per-turn model override
 *   -e <level>    session-sticky effort (low|medium|high|xhigh)
 *   -e1 <level>   one-shot per-turn effort
 *
 * Mnemonic: the `1` suffix means "apply to 1 message". No suffix = default
 * (all messages in this session).
 *
 * Flags must appear as a contiguous prefix of the text, separated by
 * whitespace. Anything after the flag block is the actual prompt. Empty
 * value on a sticky flag (`-m ''` or `-e ''`) clears the sticky state.
 *
 * Short aliases for model values: opus46 / opus4-6 / opus47 / opus4-7 /
 * sonnet46 / sonnet4-6 / sonnet47 / sonnet4-7 / haiku45 / haiku4-5. See
 * MODEL_ALIAS_MAP.
 *
 * Returns undefined for each field if no corresponding flag was found.
 * `cleanedText` is the prompt with the flag prefix stripped.
 */
export interface ParsedFlags {
  turnModel?: string;
  stickyModel?: string;
  /** True when `-m ''` was seen (clear the sticky). */
  clearStickyModel?: boolean;
  turnEffort?: string;
  stickyEffort?: string;
  clearStickyEffort?: boolean;
  cleanedText: string;
}

export function parseModelEffortFlags(text: string): ParsedFlags {
  const out: ParsedFlags = { cleanedText: text };
  let rest = text;
  // Walk flags greedily; stop at the first non-flag token.
  for (;;) {
    const m = rest.match(/^\s*(-[me]1?)\s+(\S*)\s*/);
    if (!m) break;
    const flag = m[1];
    const rawValue = m[2];
    const unquoted = rawValue.replace(/^['"]|['"]$/g, ''); // strip surrounding quotes
    rest = rest.slice(m[0].length);
    switch (flag) {
      case '-m': {
        const value = unquoted ? resolveModelAlias(unquoted) : unquoted;
        if (value && VALID_MODEL_RE.test(value)) out.stickyModel = value;
        else if (!unquoted) out.clearStickyModel = true;
        break;
      }
      case '-m1': {
        const value = unquoted ? resolveModelAlias(unquoted) : unquoted;
        if (value && VALID_MODEL_RE.test(value)) out.turnModel = value;
        break;
      }
      case '-e':
        if (unquoted && VALID_EFFORT_LEVELS.has(unquoted)) out.stickyEffort = unquoted;
        else if (!unquoted) out.clearStickyEffort = true;
        break;
      case '-e1':
        if (unquoted && VALID_EFFORT_LEVELS.has(unquoted)) out.turnEffort = unquoted;
        break;
    }
  }
  out.cleanedText = rest;
  return out;
}

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear')
  text: string; // full original text
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages.
 *
 * The extracted `senderId` is compared against `NANOCLAW_ADMIN_USER_IDS`
 * which stores ids in the namespaced form `<channel_type>:<raw>` (see
 * src/db/users.ts). chat-sdk-bridge serializes `author.userId` as a raw
 * platform id with no prefix, so we prefix it here. If the id already
 * contains a `:` we assume it's pre-namespaced (non-chat-sdk adapters
 * that populate `senderId` directly) and leave it alone.
 */
export function categorizeMessage(msg: MessageInRow): CommandInfo {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  const senderId = extractSenderId(msg, content);

  if (!text.startsWith('/')) {
    return { category: 'none', command: '', text, senderId };
  }

  // Extract the command name (e.g., '/clear' from '/clear some args')
  const command = text.split(/\s/)[0].toLowerCase();

  if (ADMIN_COMMANDS.has(command)) {
    return { category: 'admin', command, text, senderId };
  }

  if (FILTERED_COMMANDS.has(command)) {
    return { category: 'filtered', command, text, senderId };
  }

  return { category: 'passthrough', command, text, senderId };
}

/**
 * Narrow check for /clear — the only command the runner handles directly.
 * All other command gating (filtered, admin) is done by the host router
 * before messages reach the container.
 */
export function isClearCommand(msg: MessageInRow): boolean {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  return text.toLowerCase().startsWith('/clear');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSenderId(msg: MessageInRow, content: any): string | null {
  const raw: string | null = content?.senderId || content?.author?.userId || null;
  if (!raw) return null;
  // Already namespaced (e.g. "telegram:123") — use as-is.
  if (raw.includes(':')) return raw;
  // Raw platform id from chat-sdk serialization — prefix with channel type.
  if (!msg.channel_type) return raw;
  return `${msg.channel_type}:${raw}`;
}

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

/**
 * Extract routing context from a batch of messages.
 * Uses the first message's routing fields.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const first = messages[0];
  return {
    platformId: first?.platform_id ?? null,
    channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null,
    inReplyTo: first?.id ?? null,
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 *
 * Prepends a `<context timezone="<IANA>" />` header so the agent always knows
 * what timezone it's in — every timestamp it sees in message bodies is the
 * user's local time, and every time it produces (schedules, suggests) should
 * be interpreted as local time in that same zone. This header is v1 behavior
 * (src/v1/router.ts:20-22); dropping it led to misinterpretations where the
 * agent scheduled tasks for the wrong hour.
 *
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  if (messages.length === 0) return header;

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return header + parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  if (messages.length === 1) {
    return formatSingleChat(messages[0]);
  }

  const lines = ['<messages>'];
  for (const msg of messages) {
    lines.push(formatSingleChat(msg));
  }
  lines.push('</messages>');
  return lines.join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyAttr = content.replyTo?.id ? ` reply_to="${escapeXml(String(content.replyTo.id))}"` : '';
  const replyPrefix = formatReplyContext(content.replyTo);
  const attachmentsSuffix = formatAttachments(content.attachments);

  // Look up the destination name for the origin (reverse map lookup).
  // If not found, fall back to a raw channel:platform_id marker so nothing
  // gets silently dropped — this should only happen if the destination was
  // removed between when the message was received and when it's being processed.
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  const fromAttr = fromDest
    ? ` from="${escapeXml(fromDest.name)}"`
    : msg.channel_type || msg.platform_id
      ? ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`
      : '';

  return `<message${idAttr}${fromAttr} sender="${escapeXml(sender)}" time="${escapeXml(time)}"${replyAttr}>${replyPrefix}${escapeXml(text)}${attachmentsSuffix}</message>`;
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const parts = ['[SCHEDULED TASK]'];
  if (content.scriptOutput) {
    parts.push('', 'Script output:', JSON.stringify(content.scriptOutput, null, 2));
  }
  parts.push('', 'Instructions:', content.prompt || '');
  return parts.join('\n');
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  return `[WEBHOOK: ${source}/${event}]\n\n${JSON.stringify(content.payload || content, null, 2)}`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  return `[SYSTEM RESPONSE]\n\nAction: ${content.action || 'unknown'}\nStatus: ${content.status || 'unknown'}\nResult: ${JSON.stringify(content.result || null)}`;
}

/**
 * Render the quoted original inside the <message> body.
 *
 * Matches v1 format (src/v1/router.ts:10-18): `<quoted_message from="X">Y</quoted_message>`.
 * Requires BOTH sender and text — if only id is present the reply_to attribute
 * on the parent <message> carries the link without an inline preview.
 *
 * No truncation here (v1 didn't truncate).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender;
  const text = replyTo.text;
  if (!sender || !text) return '';
  return `\n  <quoted_message from="${escapeXml(sender)}">${escapeXml(text)}</quoted_message>\n`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAttachments(attachments: any[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((a) => {
    const name = a.name || a.filename || 'attachment';
    const type = a.type || 'file';
    const localPath = a.localPath ? `/workspace/${a.localPath}` : '';
    const url = a.url || '';
    if (localPath) {
      return `[${type}: ${escapeXml(name)} — saved to ${escapeXml(localPath)}]`;
    }
    return url ? `[${type}: ${escapeXml(name)} (${escapeXml(url)})]` : `[${type}: ${escapeXml(name)}]`;
  });
  return '\n' + parts.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Strip `<internal>...</internal>` blocks from agent output, then trim.
 * Ported from v1 (src/v1/router.ts:25-27). Used to remove the agent's
 * own scratchpad/reasoning before a reply goes out over a channel.
 */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}
