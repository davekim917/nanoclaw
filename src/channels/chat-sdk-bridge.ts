/**
 * Chat SDK bridge — wraps a Chat SDK adapter + Chat instance
 * to conform to the NanoClaw ChannelAdapter interface.
 *
 * Used by Discord, Slack, and other Chat SDK-supported platforms.
 */
import http from 'http';

import {
  Chat,
  Card,
  CardText,
  Actions,
  Button,
  LinkButton,
  type CardChild,
  type Adapter,
  type ConcurrencyStrategy,
  type Message as ChatMessage,
  type SlashCommandEvent,
  toPlainText,
  getNodeChildren,
  isListNode,
} from 'chat';
import { log } from '../log.js';
import { SqliteStateAdapter } from '../state-sqlite.js';
import { registerWebhookAdapter } from '../webhook-server.js';
import { getAskQuestionRender } from '../db/sessions.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelRecoveryRequest,
  ChannelRecoveryResult,
  ChannelRecoveryTarget,
  ChannelSetup,
  InboundMessage,
} from './adapter.js';

/** Adapter with optional gateway support (e.g., Discord). */
interface GatewayAdapter extends Adapter {
  startGatewayListener?(
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
}

/** Reply context extracted from a platform's raw message. */
export interface ReplyContext {
  text: string;
  sender: string;
  senderId?: string;
}

/**
 * Registry for native platform slash-command handlers (e.g. Slack's
 * registered `/dashboard-token`) — the same decoupling shape as
 * `command-gate.ts`'s INTERCEPT_COMMANDS registry, so this generic bridge
 * never has to import a specific feature's handler directly. Every Chat SDK
 * adapter dispatches through the one shared map below; a command with no
 * registered handler is silently ignored (harmless for adapters — e.g.
 * Discord — that never emit `SlashCommandEvent` at all).
 */
export type SlashCommandHandler = (event: SlashCommandEvent) => Promise<void>;

const slashCommandHandlers = new Map<string, SlashCommandHandler>();

export function registerSlashCommandHandler(command: string, handler: SlashCommandHandler): void {
  slashCommandHandlers.set(command, handler);
}

interface InboundFilterContext {
  /** True on the recovery scan, false on live dispatch. */
  recovered: boolean;
}

/** Extract reply context from a platform-specific raw message. Return null if no reply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReplyContextExtractor = (raw: Record<string, any>) => ReplyContext | null;

/**
 * Recover readable content a platform adapter left only in `message.raw`.
 *
 * The bridge drops `raw` before persisting (it can be very large), so anything
 * the adapter did not project into `Message.toJSON()` is lost at that point.
 * A platform that carries readable content outside the normal text — Slack
 * puts pasted tables in `attachments[].blocks[]` — returns it here as text.
 * Return null when there is nothing to recover.
 */
export type RawTextExtractor = (raw: Record<string, unknown>) => string | null;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      timer.unref();
    }),
  ]);
}

/**
 * Minimal view of the mdast nodes we touch when rebuilding inbound text.
 * The Chat SDK exposes the parsed message as `message.formatted` (an mdast
 * `Root`); we only read structural fields, so a loose shape keeps us off the
 * full `@types/mdast` dependency.
 */
interface MdNode {
  type?: string;
  ordered?: boolean;
  start?: number;
  value?: string;
  lang?: string;
  children?: MdNode[];
}

function renderListNode(list: MdNode, depth: number): string {
  const ordered = list.ordered === true;
  const start = typeof list.start === 'number' ? list.start : 1;
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  const items = getNodeChildren(list as never) as MdNode[];
  items.forEach((item, i) => {
    const marker = ordered ? `${start + i}.` : '-';
    let firstContent = true;
    for (const child of getNodeChildren(item as never) as MdNode[]) {
      if (isListNode(child as never)) {
        lines.push(renderListNode(child, depth + 1));
        continue;
      }
      const txt = (toPlainText(child as never) as string).trim();
      if (!txt) continue;
      if (firstContent) {
        lines.push(`${indent}${marker} ${txt}`);
        firstContent = false;
      } else {
        lines.push(`${indent}  ${txt}`);
      }
    }
    // An empty item is kept so ordered numbering stays aligned.
    if (firstContent) lines.push(`${indent}${marker}`);
  });
  return lines.join('\n');
}

/**
 * Rebuild the inbound message text from the Chat SDK's mdast `formatted` AST,
 * preserving block structure (paragraph breaks, list markers, code fences).
 *
 * Why: the SDK's `message.text` is `mdastToString(formatted)`, which strips ALL
 * structure — it concatenates every text node with no separators. So
 * `-e xhigh\n1. Approved\n2. Approved\n3. Catch up …` arrives as
 * `-e xhighApprovedApprovedCatch up …`, which both breaks `-e`/`-m` flag parsing
 * (the `\S*` value grabs the run-on) AND hands the agent garbled instructions.
 * The SDK itself documents `stringifyMarkdown(message.formatted)` as the way to
 * recover markdown, but that escapes every `_`/`*`/`~` (`SOURCE_DATA` →
 * `SOURCE\_DATA`) — pervasive corruption of snake_case identifiers. So we render
 * structure ourselves and use the SDK's (non-escaping) `toPlainText` for inline
 * content, matching the existing flattening exactly within each block.
 *
 * Returns null when there's no usable AST, so callers fall back to `.text`.
 */
export function reconstructInboundText(formatted: unknown): string | null {
  const root = formatted as MdNode | undefined;
  if (!root || !Array.isArray(root.children) || root.children.length === 0) return null;
  const blocks: string[] = [];
  for (const node of root.children) {
    if (isListNode(node as never)) {
      blocks.push(renderListNode(node, 0));
    } else if (node.type === 'code') {
      blocks.push(`\`\`\`${node.lang ?? ''}\n${node.value ?? ''}\n\`\`\``);
    } else {
      blocks.push(toPlainText(node as never) as string);
    }
  }
  const out = blocks.join('\n\n');
  return out.trim() ? out : null;
}

/**
 * Resolves a quoted or shared MESSAGE link into reply context. Slack delivers it as a LinkPreview whose
 * `fetchMessage()` is stripped by `Message.toJSON()`, and Slack has no `extractReplyContext` hook, so otherwise the
 * quoted text never reaches the agent. Time-bounded; any error returns null. Only the first resolvable link is used.
 */
export async function resolveQuotedReply(
  message: ChatMessage,
  timeoutMs = 8000,
): Promise<(ReplyContext & { id?: string }) | null> {
  try {
    const links = (message as unknown as { links?: Array<{ fetchMessage?: () => Promise<unknown> }> }).links;
    const resolver = links?.find((l) => typeof l?.fetchMessage === 'function')?.fetchMessage;
    if (!resolver) return null;
    const resolved = (await withTimeout(resolver(), timeoutMs)) as {
      id?: string;
      text?: string;
      author?: { userId?: string; fullName?: string; userName?: string };
    } | null;
    const text = resolved?.text;
    if (!resolved || typeof text !== 'string' || !text.trim()) return null;
    const sender = resolved.author?.fullName ?? resolved.author?.userName ?? 'unknown';
    return {
      id: resolved.id,
      sender,
      text,
      ...(resolved.author?.userId ? { senderId: resolved.author.userId } : {}),
    };
  } catch (err) {
    log.warn('Failed to resolve quoted message link', { err: String(err) });
    return null;
  }
}

/**
 * The message body the bridge hands `adapter.postMessage`.
 *
 * `markdown` is the normal path; `raw` is the pre-rendered native-syntax path
 * taken when an adapter declares `transformOutboundText`. `subtext` is an
 * OPTIONAL extension this fork's Slack adapter reads in its postMessage
 * wrapper — the Chat SDK's own postable types have no field for small print,
 * and adapters that do not look for it ignore it harmlessly.
 */
export type OutboundBody = ({ markdown: string } | { raw: string }) & { subtext?: string };

export interface ChatSdkBridgeConfig {
  adapter: Adapter;
  /**
   * Adapter-instance name for running multiple bridges of one platform
   * (e.g. several Slack apps in one workspace). Defaults to the platform
   * name. Drives the registry key, the webhook route (/webhook/<instance>),
   * and the Chat SDK state namespace. channelType is NOT affected — user
   * identity, formatting, and container config stay keyed on the platform.
   * Must be URL-safe: non-empty, only letters, digits, '.', '_' or '-'.
   */
  instance?: string;
  concurrency?: ConcurrencyStrategy;
  /** Bot token for authenticating forwarded Gateway events (required for interaction handling). */
  botToken?: string;
  /** Platform-specific reply context extraction. */
  extractReplyContext?: ReplyContextExtractor;
  /**
   * Whether this platform uses threads as the primary conversation unit.
   * See `ChannelAdapter.supportsThreads`. Declared by the calling channel
   * skill, not inferred, because some platforms (Discord) can be used either
   * way and the default depends on installation style.
   */
  supportsThreads: boolean;
  /**
   * Declared wiring-time defaults for this channel. Copied verbatim onto the
   * returned ChannelAdapter, exactly like supportsThreads. See
   * `ChannelAdapter.defaults`.
   */
  defaults?: ChannelDefaults;
  /**
   * Optional transform applied to outbound text/markdown before it reaches the
   * adapter. Used by channels that pre-render to the platform's native syntax
   * (e.g. Telegram's legacy Markdown parse mode). Setting this forces `raw`
   * delivery, which bypasses the chat-adapter's own markdown→native conversion
   * (and any rich-block features like Slack's Block Kit table rendering).
   * Use `transformOutboundMarkdown` instead when the transform preserves
   * standard Markdown semantics.
   */
  transformOutboundText?: (text: string) => string;
  /**
   * Markdown→Markdown transform: the bridge keeps `markdown` delivery so the adapter's native conversion and rich
   * blocks (e.g. Slack tables) still run. If both this and `transformOutboundText` are set, `transformOutboundText`
   * wins.
   */
  transformOutboundMarkdown?: (markdown: string, destination?: { platformId: string }) => string;
  /**
   * How this platform renders the status subtext (model, effort, context) as small print: Discord appends a `-# `
   * line, Slack gets a Block Kit `context` block. OPT-IN: without it there is no subtext at all, because a full-size
   * footer under every reply is worse than none.
   */
  renderSubtext?: (body: OutboundBody, subtext: string) => OutboundBody;
  /**
   * Re-verifies a platform-claimed mention against the final text; false demotes it. Slack fires app_mention for
   * `@name` inside code spans.
   */
  refineInboundMention?: (text: string) => boolean;
  /**
   * Applied to `serialized.text` and `serialized.replyTo.text` before they land in `messages_in`, for platforms whose
   * wire format leaks opaque user references (Discord `<@snowflake>`). Any other place the raw form leaks needs its
   * own pass.
   */
  transformInboundText?: (text: string) => string;
  /**
   * Content the adapter left only in `message.raw`, appended to the persisted body; see appendRawText for ordering
   * inside messageToInbound.
   */
  extractRawText?: RawTextExtractor;
  /**
   * Live name override for known bot authors, since SDK adapters can keep a stale install-time name after a rename.
   * Null/undefined keeps the SDK name.
   */
  transformInboundSender?: (author: {
    userId?: string;
    fullName?: string;
    userName?: string;
    isMe?: boolean;
  }) => string | null | undefined;
  /**
   * Return false to drop, e.g. platform system messages the SDK does not filter. Runs on BOTH live dispatch and
   * recovery (`ctx.recovered`). A filter carrying conversational state must skip recovery: recovery pages arrive
   * newest-first and were already judged live.
   */
  inboundFilter?: (message: ChatMessage, ctx: InboundFilterContext) => boolean;
  /** REST-fetched history may omit isMention. */
  detectRecoveredMention?: (message: ChatMessage) => boolean;
  /**
   * Threads a recovered channel-root @mention the way live dispatch would (Discord's Gateway opens a thread first);
   * otherwise it is answered at channel root. Null keeps the root address.
   */
  threadRecoveredRootMention?: (platformId: string, message: ChatMessage) => Promise<string | null>;
  /** Default recovery policy drops bot-authored rows. */
  allowRecoveredBotMessage?: (message: ChatMessage) => boolean;
  fetchRecoveryPage?: (
    threadId: string,
    options: { limit: number; direction: 'backward'; cursor?: string; since: string },
  ) => Promise<{ messages: ChatMessage[]; nextCursor?: string }>;
  /** Thread targets that do not have a NanoClaw session yet. */
  discoverRecoveryTargets?: (request: ChannelRecoveryRequest) => Promise<{
    targets: ChannelRecoveryTarget[];
    complete: boolean;
    /** Failed roots with their errors, so the bridge classifies per target instead of failing the whole pass. */
    failed?: Array<{ target: ChannelRecoveryTarget; error: unknown }>;
  }>;
  /**
   * 'permanent' parks the target in the durable dead-target registry (skipped for 24h, then re-probed) so one
   * unreachable channel cannot freeze the recovery cursor or drive a whole-window retry loop. Anything unclassified
   * is 'transient' and fails the pass for retry. Default: transient.
   */
  classifyRecoveryError?: (err: unknown) => 'permanent' | 'transient';
  /**
   * Defaults to `adapter.name`. Multi-instance channels (multi-workspace Slack) set a distinct channelType and
   * `/webhook/<channelType>` path per instance.
   */
  channelType?: string;
  /**
   * Maximum text length the underlying adapter accepts in a single message.
   * When set, the bridge splits outbound text longer than this on paragraph
   * → line → hard-char boundaries and posts multiple messages. Without this,
   * adapters like Discord (2000) and Telegram (4096) silently truncate
   * mid-response. The returned id is the first chunk's id so subsequent edits
   * and reactions still target the head of the reply.
   */
  maxTextLength?: number;
  /**
   * Continuation chunks of an oversize channel-level post reply under the first chunk instead of posting as more
   * channel parents. The adapter must accept `<platformId>:<messageId>` as a thread target (Discord via
   * `installMessageThreadAutoCreate`). A chunk that cannot thread falls back to channel level rather than being
   * truncated.
   */
  threadContinuationChunks?: boolean;
  /**
   * The thread's anchor/starter messages, which live outside `fetchMessages(threadId)`. For a Discord auto-thread on
   * an @mention that replied to M0, returns M0 then M1 (the mention), tagged `isAnchor: true`. `excludeMessageId`
   * drops the anchor when it IS the trigger (first wake). Null on none or error.
   */
  fetchThreadAnchor?: (
    threadId: string,
    opts?: { excludeMessageId?: string },
  ) => Promise<Array<{ sender: string; text: string; timestamp: string; isAnchor: true }> | null>;
}

/**
 * Serializes recovery passes without blocking live ingress. The durable gap floor stops live cursor advancement
 * across an incomplete window; ingress receipts dedupe a live/recovery race.
 */
export class RecoveryIngressGate {
  private recoveryTail: Promise<void> = Promise.resolve();

  async runLive<T>(run: () => Promise<T>): Promise<T> {
    return run();
  }

  runRecovery<T>(run: () => Promise<T>): Promise<T> {
    const result = this.recoveryTail.then(run);
    this.recoveryTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Split `text` into chunks no larger than `limit`, preferring paragraph
 * breaks, then line breaks, then a hard character cut as a last resort.
 * Preserves code fences only structurally — a fenced block that straddles a
 * chunk boundary will render as two independent blocks on the receiving
 * platform, which is the same behavior as manually re-opening a fence.
 */
/**
 * Decode the actual option value from a button callback. Buttons are encoded
 * with an integer index (to keep under Telegram's 64-byte callback_data cap),
 * and the real value is looked up via `getAskQuestionRender(questionId)`.
 * Falls back to treating the tail as a literal value so old in-flight cards
 * (encoded before this shortening landed) still resolve.
 */
function resolveSelectedOption(
  render: { options: NormalizedOption[] } | undefined,
  eventValue: string | undefined,
  tail: string | undefined,
): string | undefined {
  const candidate = eventValue || tail;
  if (!candidate) return undefined;
  if (/^\d+$/.test(candidate)) {
    // Index-encoded (Telegram's callback-data limit). An unresolvable index is NOT a legacy literal: forwarding "0"
    // would fall into approval's reject-by-default branch.
    if (!render) return undefined;
    const idx = Number(candidate);
    if (render.options[idx]) return render.options[idx].value;
    return undefined;
  }
  return candidate;
}

/** @chat-adapter/discord joins action id and value with a newline; forwarded Gateway events bypass its decoder. */
function decodeDiscordCustomId(customId: string): { actionId: string; value: string | undefined } {
  const delimiter = customId.indexOf('\n');
  if (delimiter === -1) return { actionId: customId, value: undefined };
  return {
    actionId: customId.slice(0, delimiter),
    value: customId.slice(delimiter + 1),
  };
}

/**
 * Parse a 429 rate-limit error and return the number of milliseconds the
 * caller should wait before retrying, or null if the error isn't a 429.
 *
 * Discord errors arrive as `NetworkError: Discord API error: 429 {...JSON
 * with "retry_after": <seconds> ...}`. Slack rate-limits surface as
 * `slack_webapi_platform_error` with a `Retry-After` header (often
 * normalized into the message). We recognize both shapes and fall back
 * to a 1s default if the marker is present but the value is missing.
 *
 * Returning null signals "not a recoverable rate limit" — the caller
 * should fall through to its existing failure path (truncate + warn,
 * or re-throw on first chunk).
 */
export function parseRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return null;
  if (!/\b429\b|rate[\s_-]?limit/i.test(message)) return null;
  const m = message.match(/"retry_after"\s*:\s*([\d.]+)/);
  if (m) {
    const seconds = parseFloat(m[1]);
    if (!Number.isNaN(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  }
  const h = message.match(/retry[\s_-]?after[":\s]+([\d.]+)/i);
  if (h) {
    const seconds = parseFloat(h[1]);
    if (!Number.isNaN(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  }
  return 1000;
}

/**
 * Room beside the subtext for the renderer's separator (Discord's newline plus `-# `), with margin so a renderer
 * adding more cannot push a max-length message over the cap.
 */
const SUBTEXT_BUDGET_OVERHEAD = 8;

const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BUFFER_MS = 100;
const CARD_TITLE_MAX_CODE_POINTS = 150;
const DISCORD_MESSAGE_MAX_CODE_UNITS = 2000;
const DISCORD_BUTTON_LABEL_MAX_CODE_POINTS = 80;
const DISCORD_COMPONENTS_PER_ROW = 5;
const DISCORD_COMPONENT_ROW_MAX = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fitCardTitle(title: string): string {
  const codePoints = Array.from(title);
  if (codePoints.length <= CARD_TITLE_MAX_CODE_POINTS) return title;
  return (
    codePoints
      .slice(0, CARD_TITLE_MAX_CODE_POINTS - 1)
      .join('')
      .trimEnd() + '…'
  );
}

function fitDiscordButtonLabel(label: string): string {
  const codePoints = Array.from(label);
  if (codePoints.length <= DISCORD_BUTTON_LABEL_MAX_CODE_POINTS) return label;
  return (
    codePoints
      .slice(0, DISCORD_BUTTON_LABEL_MAX_CODE_POINTS - 1)
      .join('')
      .trimEnd() + '…'
  );
}

function discordDeliveryChannelId(threadId: string): string {
  const parts = threadId.split(':');
  if (parts[0] !== 'discord' || parts.length < 3 || !parts[2]) {
    throw new Error(`Invalid Discord thread ID: ${threadId}`);
  }
  return parts[3] || parts[2];
}

function discordButtonStyle(style: NormalizedOption['style']): number {
  if (style === 'primary') return 1;
  if (style === 'danger') return 4;
  return 2;
}

/**
 * Decision context goes in ordinary message content: Discord clients can suppress embeds, leaving an unexplained row
 * of buttons.
 */
async function postDiscordQuestion(
  threadId: string,
  botToken: string,
  title: string,
  question: string,
  questionId: string,
  options: NormalizedOption[],
  configuredTextLimit?: number,
): Promise<string> {
  if (options.length > DISCORD_COMPONENTS_PER_ROW * DISCORD_COMPONENT_ROW_MAX) {
    throw new Error(`Discord question has ${options.length} options; maximum is 25`);
  }

  const limit = Math.min(configuredTextLimit ?? DISCORD_MESSAGE_MAX_CODE_UNITS, DISCORD_MESSAGE_MAX_CODE_UNITS);
  const fullContent = `**${title}**\n\n${question}`;
  const content =
    fullContent.length > limit ? `${splitForLimit(fullContent, Math.max(1, limit - 1))[0].trimEnd()}…` : fullContent;
  const buttons = options.map((option, index) => {
    const customId = `ncq:${questionId}:${index}\n${index}`;
    if (customId.length > 100) {
      throw new Error(`Discord question ID is too long for a button custom_id: ${questionId}`);
    }
    return {
      type: 2,
      style: discordButtonStyle(option.style),
      label: fitDiscordButtonLabel(option.label),
      custom_id: customId,
    };
  });
  const components: Array<{ type: number; components: typeof buttons }> = [];
  for (let i = 0; i < buttons.length; i += DISCORD_COMPONENTS_PER_ROW) {
    components.push({ type: 1, components: buttons.slice(i, i + DISCORD_COMPONENTS_PER_ROW) });
  }

  const channelId = discordDeliveryChannelId(threadId);
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content,
      components,
      // Moved text must never become an accidental @everyone or user ping.
      allowed_mentions: { parse: [] },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Discord card delivery failed (${response.status}): ${detail}`);
  }
  const posted = (await response.json()) as { id?: unknown };
  if (typeof posted.id !== 'string' || !posted.id) {
    throw new Error('Discord card delivery response did not include a message id');
  }
  return posted.id;
}

export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Append platform-rescued text to the serialized body, before `raw` is dropped.
 * No extractor, or nothing recovered, leaves the body byte-identical.
 */
export function appendRawText(
  serialized: Record<string, unknown>,
  raw: Record<string, unknown>,
  extract?: RawTextExtractor,
): void {
  if (!extract) return;
  const extra = extract(raw);
  if (!extra) return;
  const text = typeof serialized.text === 'string' ? serialized.text : '';
  serialized.text = text ? `${text}\n\n${extra}` : extra;
}

export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {
  const { adapter } = config;
  const bridgeChannelType = config.channelType ?? adapter.name;
  const isDiscordBridge = bridgeChannelType === 'discord' || bridgeChannelType.startsWith('discord-');
  // The instance name becomes a webhook route segment (the route regex is
  // [^/?]+) and ':' is the state-namespace delimiter — reject anything that
  // would break either, at construction time rather than at first webhook.
  // Positive allow-list (not a deny-list): also rejects '' and
  // whitespace-only names, which are config bugs — '' is falsy, so it
  // would skip a truthiness guard, dead-end the webhook route, and
  // collapse the state namespace into the default instance's keyspace.
  if (config.instance !== undefined && !/^[A-Za-z0-9._-]+$/.test(config.instance)) {
    throw new Error(
      `chat-sdk bridge instance ${JSON.stringify(config.instance)} must be URL-safe: ` +
        `non-empty, only letters, digits, '.', '_' or '-'`,
    );
  }
  const transformText = (t: string, platformId?: string): string => {
    if (config.transformOutboundText) return config.transformOutboundText(t);
    if (config.transformOutboundMarkdown)
      return config.transformOutboundMarkdown(t, platformId ? { platformId } : undefined);
    return t;
  };
  // Status text is narration, never an address, but the outbound mention rewriters cannot tell "@Name" in prose about
  // someone from a live address. A zero-width space after `@` (and after `<` for Slack `<!here>`/`<!subteam^…>`,
  // Discord `<@&role>`) breaks every rewriter while rendering identically.
  const neutralizeMentions = (t: string): string =>
    t.replace(/@(?=[\w\p{L}])/gu, '@\u200b').replace(/<(?=[!@])/g, '<\u200b');
  // Status and task-list text is progress, never a ping: an @ would notify on messages whose edits are otherwise
  // silent.
  const transformStatusOrText = (t: string, kind: string, platformId?: string): string =>
    transformText(kind === 'status' || kind === 'task_list' ? neutralizeMentions(t) : t, platformId);
  // Native-syntax transforms go out as `raw` so the adapter does not re-parse them as CommonMark; markdown-preserving
  // ones keep `markdown` so rich blocks still fire.
  const wrapBody = (text: string): OutboundBody => (config.transformOutboundText ? { raw: text } : { markdown: text });
  let chat: Chat;
  let state: SqliteStateAdapter;
  let setupConfig: ChannelSetup;
  let gatewayAbort: AbortController | null = null;
  let recoveryCursorMs = 0;
  let recoveryGapFloorMs: number | null = null;
  const ingressGate = new RecoveryIngressGate();
  const recoveryCursorKey = `nanoclaw:recovery-cursor:${bridgeChannelType}`;
  const recoveryGapKey = `nanoclaw:recovery-gap:${bridgeChannelType}`;
  const recoveryDeadKey = `nanoclaw:recovery-dead:${bridgeChannelType}`;

  // Targets whose recovery failed PERMANENTLY are excluded without counting as failures, so the pass completes and
  // the cursor advances; one dead channel must never freeze the recovery window. Entries expire after 24h so a
  // re-invited bot heals.
  const DEAD_TARGET_TTL_MS = 24 * 60 * 60 * 1000;
  type DeadTargetMap = Record<string, { until: string; error: string }>;

  async function loadDeadTargets(): Promise<DeadTargetMap> {
    const raw = await state.get<string>(recoveryDeadKey);
    if (!raw) return {};
    try {
      const map = JSON.parse(raw) as DeadTargetMap;
      const nowIso = new Date().toISOString();
      let changed = false;
      for (const [key, entry] of Object.entries(map)) {
        if (entry.until <= nowIso) {
          delete map[key];
          changed = true;
        }
      }
      if (changed) await state.set(recoveryDeadKey, JSON.stringify(map));
      return map;
    } catch {
      return {};
    }
  }

  async function advanceRecoveryCursor(timestamp: string): Promise<void> {
    const timestampMs = Date.parse(timestamp);
    if (recoveryGapFloorMs !== null || !Number.isFinite(timestampMs) || timestampMs <= recoveryCursorMs) return;
    await state.set(recoveryCursorKey, new Date(timestampMs).toISOString());
    recoveryCursorMs = timestampMs;
  }

  async function preserveRecoveryGap(sinceMs: number): Promise<number> {
    const floor = Math.min(
      sinceMs,
      recoveryGapFloorMs ?? Number.POSITIVE_INFINITY,
      recoveryCursorMs > 0 ? recoveryCursorMs : Number.POSITIVE_INFINITY,
    );
    recoveryGapFloorMs = floor;
    recoveryCursorMs = floor;
    await state.set(recoveryGapKey, new Date(floor).toISOString());
    await state.set(recoveryCursorKey, new Date(floor).toISOString());
    return floor;
  }

  async function completeRecovery(timestampMs: number): Promise<void> {
    await state.set(recoveryCursorKey, new Date(timestampMs).toISOString());
    await state.delete(recoveryGapKey);
    recoveryCursorMs = timestampMs;
    recoveryGapFloorMs = null;
  }

  async function forwardInbound(
    platformId: string,
    threadId: string | null,
    message: InboundMessage,
    updateCursor = true,
  ): Promise<void> {
    if (!updateCursor) {
      await setupConfig.onInbound(platformId, threadId, message);
      return;
    }
    await ingressGate.runLive(async () => {
      await setupConfig.onInbound(platformId, threadId, message);
      await advanceRecoveryCursor(message.timestamp);
    });
  }

  /**
   * Undefined when the SDK adapter has no isDM, so the router applies its own default (is_group=1 when isGroup is
   * also unset).
   */
  function adapterIsDM(a: typeof adapter, threadId: string): boolean | undefined {
    const fn = (a as unknown as { isDM?: (t: string) => boolean }).isDM;
    return typeof fn === 'function' ? fn.call(a, threadId) : undefined;
  }

  async function messageToInbound(
    message: ChatMessage,
    isMention: boolean,
    isDM?: boolean,
    recovered = false,
  ): Promise<InboundMessage> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = message.toJSON() as Record<string, any>;

    // Download attachment data before serialization loses fetchData()
    if (message.attachments && message.attachments.length > 0) {
      const enriched = [];
      for (const att of message.attachments) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry: Record<string, any> = {
          type: att.type,
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          width: (att as unknown as Record<string, unknown>).width,
          height: (att as unknown as Record<string, unknown>).height,
        };
        const attUrl = (att as unknown as { url?: string }).url;
        if (attUrl) entry.url = attUrl;
        if (att.fetchData) {
          try {
            const buffer = await att.fetchData();
            entry.data = buffer.toString('base64');
          } catch (err) {
            log.warn('Failed to download attachment via fetchData', { type: att.type, err });
          }
        } else if (attUrl) {
          // For adapters without fetchData (e.g. @chat-adapter/discord): Discord CDN URLs are signed and public, but
          // the signature expires, so bytes must be pulled now.
          try {
            const response = await fetch(attUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            entry.data = buffer.toString('base64');
          } catch (err) {
            log.warn('Failed to download attachment via url fallback', { type: att.type, url: attUrl, err });
          }
        }
        enriched.push(entry);
      }
      serialized.attachments = enriched;
    }

    // Extract reply context via platform-specific hook
    if (config.extractReplyContext && message.raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replyTo = config.extractReplyContext(message.raw as Record<string, any>);
      if (replyTo) serialized.replyTo = replyTo;
    }

    // Adapters without an extractReplyContext hook (Slack): resolve a quoted message link into reply context.
    if (!serialized.replyTo) {
      const quoted = await resolveQuotedReply(message);
      if (quoted) serialized.replyTo = quoted;
    }

    // Project chat-sdk's nested author into the flat sender fields the router
    // expects (see src/router.ts extractAndUpsertUser). Native adapters already
    // populate these directly; this brings chat-sdk adapters in line.
    const author = serialized.author as
      | { userId?: string; fullName?: string; userName?: string; isMe?: boolean }
      | undefined;
    if (author) {
      const name = config.transformInboundSender?.(author) ?? author.fullName ?? author.userName;
      serialized.senderId = author.userId;
      serialized.sender = name;
      serialized.senderName = name;
    }

    // Rebuilt from the mdast so newlines, list markers and code fences survive; the SDK's `.text` is a structure-less
    // flatten that breaks flag parsing and multi-line instructions. Runs BEFORE transformInboundText.
    if (serialized.formatted) {
      const rebuilt = reconstructInboundText(serialized.formatted);
      if (rebuilt !== null) serialized.text = rebuilt;
    }

    // AFTER the mdast rebuild, which REPLACES serialized.text (appending earlier would be discarded), and BEFORE
    // transformInboundText so raw `<@U…>` in recovered cells resolves too.
    if (message.raw) {
      appendRawText(serialized, message.raw as Record<string, unknown>, config.extractRawText);
    }

    // Also rewrites `replyTo.text`, which comes from raw wire content and is surfaced verbatim to the agent.
    if (config.transformInboundText) {
      if (typeof serialized.text === 'string') {
        serialized.text = config.transformInboundText(serialized.text);
      }
      const replyTo = serialized.replyTo as { text?: unknown } | undefined;
      if (replyTo && typeof replyTo.text === 'string') {
        replyTo.text = config.transformInboundText(replyTo.text);
      }
    }

    const replyTo = serialized.replyTo as { sender?: string; senderId?: string } | undefined;
    if (replyTo?.senderId && config.transformInboundSender) {
      const sender = config.transformInboundSender({ userId: replyTo.senderId, fullName: replyTo.sender });
      if (sender) replyTo.sender = sender;
    }

    // Raw ids are already resolved to @name here.
    let effectiveMention = isMention;
    if (effectiveMention && config.refineInboundMention && typeof serialized.text === 'string') {
      effectiveMention = config.refineInboundMention(serialized.text);
    }

    // An explicit flat field so the router does not depend on chat-sdk's internal naming.
    serialized.isMention = effectiveMention;

    // Drop raw to save DB space (can be very large)
    serialized.raw = undefined;

    return {
      id: message.id,
      kind: 'chat-sdk',
      content: serialized,
      timestamp: message.metadata.dateSent.toISOString(),
      isMention: effectiveMention,
      isDM,
      isGroup: isDM === undefined ? undefined : !isDM,
      recovered,
    };
  }

  const channelType = config.channelType ?? adapter.name;

  const bridge: ChannelAdapter = {
    // This fork keys multi-instance bridges by a distinct channelType, not upstream's `instance`, which stays unset
    // (the registry falls back to channelType).
    name: channelType,
    channelType,
    supportsThreads: config.supportsThreads,
    defaults: config.defaults,
    recoveryDiscoversThreads: config.discoverRecoveryTargets !== undefined,

    async setup(hostConfig: ChannelSetup) {
      setupConfig = hostConfig;

      // State namespace: ONLY for a named non-default instance. A skill
      // that explicitly names the primary instance after the platform
      // (instance === adapter.name) still lands on the legacy UNPREFIXED
      // keyspace — prefixing the default would orphan every live install's
      // chat_sdk_subscriptions/kv/locks/lists rows.
      state = new SqliteStateAdapter(config.instance && config.instance !== adapter.name ? config.instance : undefined);

      // Establish the durable startup gap before Chat initializes the adapter: an early live event could otherwise
      // advance the cursor past messages missed while the host was down.
      await state.connect();
      recoveryCursorMs = 0;
      recoveryGapFloorMs = null;
      const storedCursor = await state.get<string>(recoveryCursorKey);
      const storedCursorMs = storedCursor ? Date.parse(storedCursor) : Number.NaN;
      if (Number.isFinite(storedCursorMs)) recoveryCursorMs = storedCursorMs;
      const storedGap = await state.get<string>(recoveryGapKey);
      const storedGapMs = storedGap ? Date.parse(storedGap) : Number.NaN;
      if (Number.isFinite(storedGapMs)) recoveryGapFloorMs = storedGapMs;
      await preserveRecoveryGap(Date.now() - 10 * 60 * 1000);

      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        userName: adapter.userName || 'NanoClaw',
        concurrency: config.concurrency ?? 'concurrent',
        state,
        logger: process.env.CHAT_SDK_DEBUG ? 'debug' : 'silent',
      });

      // Four SDK dispatch paths — bridge just forwards. All per-wiring
      // engage / accumulate / drop / subscribe decisions live in the host
      // router (src/router.ts routeInbound / evaluateEngage). The bridge
      // only resolves channel ids and sets the platform-confirmed isMention
      // flag that routeInbound evaluates; the router calls back into
      // bridge.subscribe(...) when a mention-sticky wiring engages.

      // Chat SDK's thread.id equals the channel id for channel-root posts; the router wants a real sub-thread or
      // null, or mention-sticky treats every channel message as an in-thread follow-up.
      const resolveThreadId = (rawThreadId: string, channelId: string): string | null =>
        rawThreadId === channelId ? null : rawThreadId;

      // On the first inbound for a channel, fetch its name and forward it via onMetadata; otherwise auto-created
      // messaging groups stay nameless.
      const reportedChannels = new Set<string>();
      const reportChannelMetadata = (channelId: string): void => {
        if (reportedChannels.has(channelId)) return;
        reportedChannels.add(channelId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fetchInfo = (adapter as any).fetchChannelInfo;
        if (typeof fetchInfo !== 'function') return;
        void fetchInfo
          .call(adapter, channelId)
          .then((info: { name?: string; isDM?: boolean }) => {
            if (!info) return;
            return setupConfig.onMetadata(channelId, info.name, info.isDM === undefined ? undefined : !info.isDM);
          })
          .catch((err: unknown) => {
            reportedChannels.delete(channelId);
            log.debug('fetchChannelInfo failed', {
              channelId,
              err: err instanceof Error ? err.message : String(err),
            });
          });
      };

      const passesFilter = (message: ChatMessage): boolean =>
        config.inboundFilter ? config.inboundFilter(message, { recovered: false }) : true;

      // Subscribed threads — every message in a thread we've previously
      // engaged. Carry the SDK's `message.isMention` through so mention-mode
      // wirings still fire on in-thread mentions.
      chat.onSubscribedMessage(async (thread, message) => {
        if (!passesFilter(message)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        const isDM = adapterIsDM(adapter, thread.id);
        reportChannelMetadata(channelId);
        await forwardInbound(
          channelId,
          resolveThreadId(thread.id, channelId),
          await messageToInbound(message, message.isMention === true, isDM),
        );
      });

      // @mention in an unsubscribed thread — SDK-confirmed bot mention.
      chat.onNewMention(async (thread, message) => {
        if (!passesFilter(message)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        const isDM = adapterIsDM(adapter, thread.id);
        reportChannelMetadata(channelId);
        await forwardInbound(
          channelId,
          resolveThreadId(thread.id, channelId),
          await messageToInbound(message, true, isDM),
        );
      });

      // DMs — by definition addressed to the bot. Thread id flows through
      // unmodified (Slack users can open sub-threads inside a DM); whether it
      // is honored is policy, not transport: the channel's declared
      // dm.threads default (ChannelDefaults) or a per-wiring threads override
      // decides at router fanout whether replies land in-thread or all DM
      // sub-threads collapse into the one DM session.
      chat.onDirectMessage(async (thread, message) => {
        if (!passesFilter(message)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);

        // Slack DMs without the "Agent or Assistant" toggle arrive with no `thread_ts` (thread.id `slack:D…:`), so
        // replies would post at channel root. Treat the originating message as the thread root. Slack DMs only.
        let normalizedThreadId = thread.id;
        // Prefix match: slack.ts renames every adapter to its channelType (`slack-<suffix>`) for dedup isolation.
        if (adapter.name.startsWith('slack') && normalizedThreadId.endsWith(':')) {
          normalizedThreadId = `${normalizedThreadId}${message.id}`;
        }

        log.info('Inbound DM received', {
          adapter: adapter.name,
          channelId,
          sender: (message.author as any)?.fullName ?? (message.author as any)?.userId ?? 'unknown',
          threadId: normalizedThreadId,
        });
        // onDirectMessage only fires for real DMs.
        await forwardInbound(channelId, normalizedThreadId, await messageToInbound(message, true, true));
      });

      // Plain messages in unsubscribed threads.
      //
      // Chat SDK dispatch (handling-events.mdx §"Handler dispatch order") is
      // exclusive: subscribed → onSubscribedMessage; unsubscribed+mention →
      // onNewMention; unsubscribed+pattern-match → onNewMessage. Registering
      // with `/[\s\S]*/` lets the router see every plain message (including
      // media-only messages with empty text) on every unsubscribed thread the
      // getMessagingGroupWithAgentCount (~1 DB read) for unwired channels,
      // so forwarding every one is cheap enough to not need a bridge-side
      // flood gate.
      chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
        if (!passesFilter(message)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        const isDM = adapterIsDM(adapter, thread.id);
        reportChannelMetadata(channelId);
        await forwardInbound(
          channelId,
          resolveThreadId(thread.id, channelId),
          await messageToInbound(message, false, isDM),
        );
      });

      // Handle button clicks (ask_user_question)
      chat.onAction(async (event) => {
        if (!event.actionId.startsWith('ncq:')) return;
        const parts = event.actionId.split(':');
        if (parts.length < 3) return;
        const questionId = parts[1];
        const tail = parts.slice(2).join(':');
        const userId = event.user?.userId || '';
        // The button names only a questionId, which any card can carry, so approvals bind the click to this message
        // id.
        const messageId = event.messageId || null;

        // Resolve render metadata BEFORE dispatching onAction (which deletes the row).
        const render = await getAskQuestionRender(questionId);
        // New format: button id/value is an integer index into options (kept
        // short to fit Telegram's 64-byte callback_data cap). Old format:
        // the full value is embedded in actionId/value directly.
        const selectedOption = resolveSelectedOption(render, event.value, tail);
        if (!selectedOption) {
          log.warn('Ignoring card action with an unresolved option', {
            questionId,
            encodedOption: event.value || tail || '',
            adapter: adapter.name,
          });
          return;
        }
        // A pending_approvals card is never edited here: the bridge has not checked that the clicked message is that
        // approval's own card or that the clicker may decide it, so editing first would stamp the approval onto a
        // possibly counterfeit card. Dispatch, and the host edits the card the row names once the click is bound and
        // authorized. The adapter already acks the platform event. `action` comes from the render read above, not a
        // second read the winning click could race.
        if (render?.action !== undefined) {
          setupConfig.onAction(questionId, selectedOption, userId, messageId);
          return;
        }
        const title = render?.title ?? '❓ Question';
        const matched = render?.options.find((o) => o.value === selectedOption);
        const selectedLabel = matched?.selectedLabel ?? selectedOption;

        // Update the card to show the selected answer, who acted, and remove buttons
        const actorName = event.user?.userName || event.user?.fullName || '';
        const byLine = actorName ? ` — ${actorName}` : '';
        const resolution = `${selectedLabel}${byLine}`;
        try {
          const tid = event.threadId;
          await adapter.editMessage(
            tid,
            event.messageId,
            render?.question
              ? {
                  ...(isDiscordBridge
                    ? { markdown: `**${title}**\n\n${render.question}\n\n${resolution}` }
                    : {
                        card: Card({
                          title,
                          subtitle: render.question,
                          children: [CardText(resolution, { style: 'muted' })],
                        }),
                        fallbackText: `${title}\n\n${render.question}\n\n${resolution}`,
                      }),
                }
              : { markdown: `${title}\n\n${resolution}` },
          );
        } catch (err) {
          log.warn('Failed to update card after action', { err });
        }

        setupConfig.onAction(questionId, selectedOption, userId, messageId);
      });

      // The SDK acks the platform request before this runs, so a slow handler cannot hit Slack's 3s ack timeout.
      chat.onSlashCommand(async (event) => {
        const handler = slashCommandHandlers.get(event.command);
        if (!handler) return;
        try {
          await handler(event);
        } catch (err) {
          log.error('Slash command handler threw', {
            command: event.command,
            adapter: adapter.name,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      });

      await chat.initialize();

      // Start Gateway listener for adapters that support it (e.g., Discord)
      const gatewayAdapter = adapter as GatewayAdapter;
      if (gatewayAdapter.startGatewayListener) {
        gatewayAbort = new AbortController();

        // Start local HTTP server to receive forwarded Gateway events (including interactions)
        const webhookUrl = await startLocalWebhookServer(gatewayAdapter, setupConfig, config.botToken, (reason) => {
          const sinceMs = recoveryCursorMs > 0 ? recoveryCursorMs : Date.now() - 10 * 60 * 1000;
          return setupConfig.onConnectionRestored?.({ since: new Date(sinceMs).toISOString(), reason });
        });

        // Exponential backoff capped at 1h. Without this, an unrecoverable
        // failure (e.g., TokenInvalid) restarts ~10×/sec and Discord's
        // Cloudflare layer issues a multi-hour IP block. A run that lasts
        // longer than 5 minutes counts as healthy and resets the counter.
        let consecutiveFailures = 0;
        const startGateway = () => {
          if (gatewayAbort?.signal.aborted) return;
          const startedAt = Date.now();
          // Capture the long-running listener promise via waitUntil
          let listenerPromise: Promise<unknown> | undefined;
          gatewayAdapter.startGatewayListener!(
            {
              waitUntil: (p: Promise<unknown>) => {
                listenerPromise = p;
              },
            },
            24 * 60 * 60 * 1000,
            gatewayAbort!.signal,
            webhookUrl,
          )
            .then(() => {
              // startGatewayListener resolves immediately; the real work is the listenerPromise passed to waitUntil.
              if (!listenerPromise) return;
              const reschedule = (err?: unknown) => {
                if (gatewayAbort?.signal.aborted) return;
                const ranForMs = Date.now() - startedAt;
                if (ranForMs > 5 * 60 * 1000) consecutiveFailures = 0;
                else consecutiveFailures++;
                const delayMs = Math.min(60 * 60 * 1000, 2 ** consecutiveFailures * 1000);
                if (err) {
                  log.error('Gateway listener error, retrying', {
                    adapter: adapter.name,
                    err,
                    consecutiveFailures,
                    delayMs,
                  });
                } else {
                  log.info('Gateway listener expired, restarting', {
                    adapter: adapter.name,
                    consecutiveFailures,
                    delayMs,
                  });
                }
                setTimeout(startGateway, delayMs);
              };
              listenerPromise.then(() => reschedule()).catch(reschedule);
            })
            .catch((err) => {
              log.error('Gateway listener failed to start', { adapter: adapter.name, err });
            });
        };
        startGateway();
        log.info('Gateway listener started', { adapter: adapter.name });
      } else {
        // Webhook adapters register under channelType so multi-instance channels get distinct
        // `/webhook/<channelType>` paths.
        registerWebhookAdapter(chat, adapter.name, channelType);
      }

      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },

    async deliver(platformId: string, threadId: string | null, message): Promise<string | undefined> {
      // platformId is already in the adapter's encoded format (e.g. "telegram:6037840640",
      // "discord:guildId:channelId") — use it directly as the thread ID
      const tid = threadId ?? platformId;
      const content = message.content as Record<string, unknown>;

      if (content.operation === 'edit' && content.messageId) {
        const editText = transformStatusOrText(
          (content.text as string) || (content.markdown as string) || '',
          message.kind,
          platformId,
        );
        // Only status bubbles are edited (chat replies post fresh). Oversize status text truncates to one chunk:
        // extra posts would not be tracked by delivery.ts's statusTracking and would survive cleanup as stale
        // thinking tails. An edited chat reply keeps its subtext; the footer is budgeted before truncating, as on the
        // post path.
        const editSubtext =
          (message.kind === 'chat' || message.kind === 'task_list') &&
          typeof content.subtext === 'string' &&
          content.subtext.trim() &&
          config.renderSubtext
            ? content.subtext.trim()
            : null;
        const limit = config.maxTextLength
          ? Math.max(1, config.maxTextLength - (editSubtext ? editSubtext.length + SUBTEXT_BUDGET_OVERHEAD : 0))
          : undefined;
        const fitted = limit && editText.length > limit ? splitForLimit(editText, limit)[0].trimEnd() + '…' : editText;
        const editBody = editSubtext ? config.renderSubtext!(wrapBody(fitted), editSubtext) : wrapBody(fitted);
        // Edits get 429 handling too: a dropped task-list edit leaves stale progress. A task-list edit never waits
        // here (it would hold the session's queue); the host cools the row down instead (task-list-host.ts).
        const listEdit = message.kind === 'task_list';
        for (let attempt = 1; ; attempt++) {
          try {
            await adapter.editMessage(tid, content.messageId as string, editBody);
            return;
          } catch (err) {
            const retryAfterMs = parseRetryAfterMs(err);
            if (retryAfterMs === null || listEdit || attempt > MAX_RATE_LIMIT_RETRIES) throw err;
            log.info('chat-sdk-bridge: edit rate-limited, retrying', { attempt, retryAfterMs });
            await sleep(retryAfterMs + RATE_LIMIT_BUFFER_MS);
          }
        }
      }

      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        await adapter.addReaction(tid, content.messageId as string, content.emoji as string);
        return;
      }

      // Ask question card — render as Card with buttons
      if (content.type === 'ask_question' && content.questionId && content.options) {
        const questionId = content.questionId as string;
        const title = typeof content.title === 'string' ? content.title : '';
        const displayTitle = fitCardTitle(title);
        const question = typeof content.question === 'string' ? content.question : '';
        if (!title) {
          log.error('ask_question missing required title — skipping delivery', { questionId });
          return;
        }
        const options: NormalizedOption[] = normalizeOptions(content.options as never);
        if (isDiscordBridge && config.botToken) {
          return postDiscordQuestion(
            tid,
            config.botToken,
            displayTitle,
            question,
            questionId,
            options,
            config.maxTextLength,
          );
        }
        const card = Card({
          title: displayTitle,
          // Both adapters render Card.subtitle as the card description; without it the card body is blank beside its
          // buttons.
          subtitle: question,
          children: [
            Actions(
              // Encode button id/value with the option index rather than the
              // full value. Telegram caps callback_data at 64 bytes, and
              // long values (e.g. ISO datetimes, URLs) push the JSON payload
              // well past that. The onAction handlers resolve the index back
              // to the real value via getAskQuestionRender(questionId).
              options.map((opt, idx) =>
                Button({
                  id: `ncq:${questionId}:${idx}`,
                  label: opt.label,
                  value: String(idx),
                  ...(opt.style ? { style: opt.style } : {}),
                }),
              ),
            ),
          ],
        });
        const result = await adapter.postMessage(tid, {
          card,
          fallbackText: `${displayTitle}\n\n${question}\nOptions: ${options.map((o) => o.label).join(', ')}`,
        });
        return result?.id;
      }

      // Display card (send_card MCP tool) — returns immediately, no callback flow.
      // Non-URL actions are dropped: send_card's contract is fire-and-forget, so a
      // callback button would have nowhere to land. URL actions render as link buttons.
      if (content.type === 'card' && content.card && typeof content.card === 'object') {
        const cardSpec = content.card as Record<string, unknown>;
        const rawTitle = typeof cardSpec.title === 'string' ? cardSpec.title : '';
        const title = fitCardTitle(rawTitle);
        const fallbackText =
          (content.fallbackText as string) || (cardSpec.description as string) || title || rawTitle || '';

        const cardChildren: CardChild[] = [];
        if (typeof cardSpec.description === 'string' && cardSpec.description) {
          cardChildren.push(CardText(cardSpec.description));
        }
        if (Array.isArray(cardSpec.children)) {
          for (const child of cardSpec.children) {
            if (typeof child === 'string' && child) {
              cardChildren.push(CardText(child));
            } else if (
              child &&
              typeof child === 'object' &&
              typeof (child as Record<string, unknown>).text === 'string'
            ) {
              cardChildren.push(CardText((child as Record<string, string>).text));
            }
          }
        }
        if (Array.isArray(cardSpec.actions)) {
          const linkButtons = (cardSpec.actions as Array<Record<string, unknown>>)
            .filter((a) => typeof a.url === 'string' && a.url && typeof a.label === 'string' && a.label)
            .map((a) => {
              const style = a.style;
              const safeStyle: 'primary' | 'danger' | 'default' | undefined =
                style === 'primary' || style === 'danger' || style === 'default' ? style : undefined;
              return LinkButton({
                label: a.label as string,
                url: a.url as string,
                style: safeStyle,
              });
            });
          if (linkButtons.length > 0) {
            cardChildren.push(Actions(linkButtons));
          }
        }

        if (cardChildren.length === 0 && !title) {
          log.warn('send_card payload empty, skipping delivery');
          return;
        }

        const card = Card({ title, children: cardChildren });
        const result = await adapter.postMessage(tid, { card, fallbackText });
        return result?.id;
      }

      // Normal message
      const rawText = (content.markdown as string) || (content.text as string);
      const text = rawText ? transformStatusOrText(rawText, message.kind, platformId) : rawText;
      if (text) {
        // Opt-in for host notifications, so an incomplete multi-chunk report fails instead of looking delivered.
        // Ordinary chat keeps truncation: retrying would duplicate chunks the platform already accepted.
        const requireCompleteDelivery = content.requireCompleteDelivery === true;
        // Attach files if present (FileUpload format: { data, filename })
        const fileUploads = message.files?.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        // An oversize FIRST status of a turn must NOT post extra chunks: only the first chunk's id is tracked for
        // cleanup, so chunks 2+ would linger as untracked "thinking" text. Truncate to one chunk; chat replies keep
        // full multi-chunk delivery.
        // The subtext is rendered on chat replies only, not on transient status bubbles.
        const subtext =
          (message.kind === 'chat' || message.kind === 'task_list') &&
          typeof content.subtext === 'string' &&
          content.subtext.trim() &&
          config.renderSubtext
            ? content.subtext.trim()
            : null;
        // Reserve the footer's room BEFORE splitting: Discord spends it inside the text, so a body split to the exact
        // limit and then appended to would be rejected.
        const subtextBudget = subtext ? subtext.length + SUBTEXT_BUDGET_OVERHEAD : 0;
        const textLimit = config.maxTextLength ? Math.max(1, config.maxTextLength - subtextBudget) : undefined;
        const chunks: string[] =
          textLimit && text.length > textLimit
            ? message.kind === 'status' || message.kind === 'task_list'
              ? [splitForLimit(text, textLimit)[0].trimEnd() + '…']
              : splitForLimit(text, textLimit)
            : [text];
        let firstId: string | undefined;
        let chunkTid = tid;
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const attachFiles = i === 0 && fileUploads && fileUploads.length > 0;
          // One footer per reply, on the last chunk.
          const base = wrapBody(chunk);
          const body = subtext && i === chunks.length - 1 ? config.renderSubtext!(base, subtext) : base;
          let attempt = 0;
          let chunkPosted = false;
          while (!chunkPosted) {
            try {
              const result = await adapter.postMessage(chunkTid, attachFiles ? { ...body, files: fileUploads } : body);
              if (i === 0 && firstId === undefined) {
                firstId = result?.id;
                if (config.threadContinuationChunks && threadId === null && firstId) {
                  chunkTid = `${platformId}:${firstId}`;
                }
              }
              chunkPosted = true;
            } catch (err) {
              // 429: retry the same chunk after the requested delay; otherwise a rate-limited multi-chunk reply
              // silently truncates.
              const retryAfterMs = parseRetryAfterMs(err);
              attempt++;
              // A task-list post never waits here (task-list-host.ts).
              if (retryAfterMs !== null && attempt <= MAX_RATE_LIMIT_RETRIES && message.kind !== 'task_list') {
                log.info('chat-sdk-bridge: chunk rate-limited, retrying', {
                  chunkIndex: i,
                  totalChunks: chunks.length,
                  attempt,
                  maxAttempts: MAX_RATE_LIMIT_RETRIES,
                  retryAfterMs,
                });
                await sleep(retryAfterMs + RATE_LIMIT_BUFFER_MS);
                continue;
              }
              // A continuation chunk that cannot thread must not cost the rest of the message: fall back to the
              // original target from here on.
              if (i > 0 && chunkTid !== tid) {
                log.warn('chat-sdk-bridge: continuation chunk could not thread; posting at channel level', {
                  chunkIndex: i,
                  totalChunks: chunks.length,
                  attemptedThreadId: chunkTid,
                  err,
                });
                chunkTid = tid;
                attempt = 0;
                continue;
              }
              // First-chunk failures rethrow so the host retries cleanly. A mid-message failure truncates, because a
              // whole-message retry would re-post every chunk that already landed.
              if (i === 0 || requireCompleteDelivery) throw err;
              log.warn('chat-sdk-bridge: chunk post failed mid-message; truncating to avoid duplicate-on-retry', {
                chunkIndex: i,
                totalChunks: chunks.length,
                attempts: attempt,
                err,
              });
              return firstId;
            }
          }
        }
        return firstId;
      } else if (message.files && message.files.length > 0) {
        // Files only, no text
        const fileUploads = message.files.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        const result = await adapter.postMessage(tid, { markdown: '', files: fileUploads });
        return result?.id;
      }
    },

    async setTyping(platformId: string, threadId: string | null, status?: string) {
      const tid = threadId ?? platformId;
      await adapter.startTyping(tid, status);
    },

    async deleteMessage(platformId: string, threadId: string | null, messageId: string) {
      const tid = threadId ?? platformId;
      // Optional on the underlying adapter; skip silently when absent.
      const fn = (
        adapter as unknown as {
          deleteMessage?: (t: string, m: string) => Promise<void>;
        }
      ).deleteMessage;
      if (typeof fn !== 'function') return;
      await fn.call(adapter, tid, messageId);
    },

    async teardown() {
      gatewayAbort?.abort();
      await chat.shutdown();
      log.info('Chat SDK bridge shut down', { adapter: adapter.name });
    },

    isConnected() {
      return true;
    },

    async fetchThreadHistory(
      threadId: string,
      opts?: { limit?: number; excludeMessageId?: string },
    ): Promise<Array<{ sender: string; text: string; timestamp: string; isAnchor?: boolean }>> {
      const limit = opts?.limit ?? 50;
      const inThread: Array<{ sender: string; text: string; timestamp: string; isAnchor?: boolean }> = [];
      // Same inbound transform as messageToInbound, so replayed thread context does not leak the raw wire form.
      const applyInboundTransform = (t: string): string =>
        config.transformInboundText ? config.transformInboundText(t) : t;
      try {
        const result = await adapter.fetchMessages(threadId, { limit });
        const msgs = (result?.messages ?? []) as Array<{
          id: string;
          text: string;
          raw?: unknown;
          author: { userId?: string; fullName: string; userName: string; isMe: boolean };
          metadata: { dateSent: Date };
        }>;
        for (const m of msgs) {
          if (m.id === opts?.excludeMessageId) continue;
          // Replayed context gets the same raw-text recovery as the live path, or a table-only message is skipped
          // outright.
          const projected: Record<string, unknown> = { text: m.text };
          if (m.raw) appendRawText(projected, m.raw as Record<string, unknown>, config.extractRawText);
          const text = typeof projected.text === 'string' ? projected.text : '';
          if (text.length === 0) continue;
          inThread.push({
            sender: m.author.isMe
              ? 'assistant'
              : config.transformInboundSender?.(m.author) || m.author.fullName || m.author.userName || 'unknown',
            text: applyInboundTransform(text),
            timestamp: m.metadata.dateSent.toISOString(),
          });
        }
      } catch (err) {
        log.warn('fetchThreadHistory failed', {
          adapter: adapter.name,
          threadId,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // Discord's anchor messages sit outside `fetchMessages(threadId)`. `isAnchor` is descriptive, NOT a recency
      // exemption (an exemption re-prepended the parent on every follow-up wake; see src/thread-context.ts). De-dupe
      // on (sender, text) AFTER the transform on both sides: forum threads repeat the anchor in-thread, and the two
      // endpoints' timestamps do not always match.
      if (config.fetchThreadAnchor) {
        try {
          const anchors = await config.fetchThreadAnchor(threadId, { excludeMessageId: opts?.excludeMessageId });
          if (anchors && anchors.length > 0) {
            // Reverse so unshift preserves chronological order.
            for (let i = anchors.length - 1; i >= 0; i--) {
              const a = anchors[i];
              if (!a.text || a.text.length === 0) continue;
              const normalized = { ...a, text: applyInboundTransform(a.text) };
              const alreadyPresent = inThread.some((m) => m.sender === normalized.sender && m.text === normalized.text);
              if (!alreadyPresent) inThread.unshift(normalized);
            }
          }
        } catch (err) {
          log.warn('fetchThreadAnchor failed', {
            adapter: adapter.name,
            threadId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return inThread;
    },

    async recoverMissedMessages(request: ChannelRecoveryRequest): Promise<ChannelRecoveryResult> {
      return ingressGate.runRecovery(async () => {
        const requestedSinceMs = Date.parse(request.since);
        if (!Number.isFinite(requestedSinceMs)) {
          throw new Error(`Invalid channel recovery timestamp: ${request.since}`);
        }
        const sinceMs = await preserveRecoveryGap(requestedSinceMs);
        const effectiveSince = new Date(sinceMs).toISOString();
        const recoveryStartedAtMs = Date.now();

        const dead = await loadDeadTargets();
        const targetAddress = (target: ChannelRecoveryTarget): string =>
          `${target.platformId}\u0000${target.threadId ?? ''}`;
        // A dead root parks every target on that platformId.
        const deadRoots = new Set(
          Object.keys(dead)
            .filter((key) => key.endsWith('\u0000'))
            .map((key) => key.split('\u0000')[0]),
        );
        const isDeadTarget = (target: ChannelRecoveryTarget): boolean =>
          deadRoots.has(target.platformId) || targetAddress(target) in dead;
        const parkTarget = async (target: ChannelRecoveryTarget, err: unknown): Promise<void> => {
          const key = targetAddress(target);
          dead[key] = {
            until: new Date(Date.now() + DEAD_TARGET_TTL_MS).toISOString(),
            error: err instanceof Error ? err.message : String(err),
          };
          if (target.threadId === null) deadRoots.add(target.platformId);
          await state.set(recoveryDeadKey, JSON.stringify(dead));
          log.warn('Channel recovery target parked — permanent failure, next probe in 24h', {
            adapter: adapter.name,
            instance: bridgeChannelType,
            platformId: target.platformId,
            threadId: target.threadId,
            err: dead[key].error,
          });
        };
        const classify = (err: unknown): 'permanent' | 'transient' =>
          config.classifyRecoveryError?.(err) ?? 'transient';

        const targetsByAddress = new Map<string, ChannelRecoveryTarget>();
        for (const target of request.targets) {
          if (isDeadTarget(target)) continue;
          targetsByAddress.set(targetAddress(target), target);
        }
        let failedTargets = 0;
        if (config.discoverRecoveryTargets) {
          try {
            const discovery = await config.discoverRecoveryTargets({
              ...request,
              since: effectiveSince,
              targets: [...targetsByAddress.values()],
            });
            for (const target of discovery.targets) {
              if (isDeadTarget(target)) continue;
              targetsByAddress.set(targetAddress(target), target);
            }
            for (const failure of discovery.failed ?? []) {
              if (classify(failure.error) === 'permanent') {
                await parkTarget(failure.target, failure.error);
                targetsByAddress.delete(targetAddress(failure.target));
              } else {
                failedTargets++;
                log.warn('Channel recovery target discovery failed', {
                  adapter: adapter.name,
                  platformId: failure.target.platformId,
                  since: effectiveSince,
                  err: failure.error instanceof Error ? failure.error.message : String(failure.error),
                });
              }
            }
            if (!discovery.complete) failedTargets++;
          } catch (err) {
            failedTargets++;
            log.warn('Channel recovery target discovery failed', {
              adapter: adapter.name,
              since: effectiveSince,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const targets = [...targetsByAddress.values()];

        const recovered: Array<{
          target: ChannelRecoveryRequest['targets'][number];
          message: ChatMessage;
        }> = [];
        const seen = new Set<string>();

        // Page newest-first to the gap boundary; a fixed cap would retry the same pages forever on a large gap.
        // Cursor loops are rejected.
        for (const target of targets) {
          const targetThreadId =
            target.threadId ??
            (adapter.name.startsWith('slack') && !target.platformId.endsWith(':')
              ? `${target.platformId}:`
              : target.platformId);
          let cursor: string | undefined;
          let coveredBoundary = false;
          const seenCursors = new Set<string>();
          try {
            for (;;) {
              const fetchPage = config.fetchRecoveryPage ?? adapter.fetchMessages.bind(adapter);
              const result = await fetchPage(targetThreadId, {
                limit: 100,
                direction: 'backward',
                cursor,
                since: effectiveSince,
              });
              const messages = result?.messages ?? [];
              let oldestMs = Number.POSITIVE_INFINITY;
              for (const message of messages) {
                const messageMs = message.metadata.dateSent.getTime();
                oldestMs = Math.min(oldestMs, messageMs);
                if (messageMs <= sinceMs) continue;
                if (message.author.isMe) continue;
                if (message.author.isBot === true && !config.allowRecoveredBotMessage?.(message)) continue;
                if (config.inboundFilter && !config.inboundFilter(message, { recovered: true })) continue;
                const dedupeKey = `${target.platformId}\u0000${message.id}`;
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                recovered.push({ target, message });
              }
              if (oldestMs <= sinceMs || !result?.nextCursor) {
                coveredBoundary = true;
                break;
              }
              if (seenCursors.has(result.nextCursor)) {
                log.warn('Channel recovery pagination cursor repeated before gap boundary', {
                  adapter: adapter.name,
                  targetThreadId,
                  since: effectiveSince,
                  cursor: result.nextCursor,
                });
                break;
              }
              seenCursors.add(result.nextCursor);
              cursor = result.nextCursor;
            }
            if (!coveredBoundary) {
              failedTargets++;
              log.warn('Channel recovery could not reach gap boundary', {
                adapter: adapter.name,
                targetThreadId,
                since: effectiveSince,
              });
            }
          } catch (err) {
            if (classify(err) === 'permanent') {
              await parkTarget(target, err);
            } else {
              failedTargets++;
              log.warn('Channel recovery target fetch failed', {
                adapter: adapter.name,
                targetThreadId,
                since: effectiveSince,
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        recovered.sort((a, b) => a.message.metadata.dateSent.getTime() - b.message.metadata.dateSent.getTime());
        const routeStartedAtMs = Date.now();
        let recoveredMessages = 0;
        let newestRecoveredAt = 0;
        for (const { target, message } of recovered) {
          // Routing does synchronous DB work: yield every few messages so a large batch cannot stall the loop and
          // re-trigger recovery.
          if (recoveredMessages > 0 && recoveredMessages % 10 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
          let threadId = target.threadId;
          if (target.isDM) {
            threadId = message.threadId;
            if (adapter.name.startsWith('slack') && threadId.endsWith(':')) {
              threadId = `${threadId}${message.id}`;
            }
          } else if (threadId === null && message.threadId && message.threadId !== target.platformId) {
            // Some adapters model a root post as the root of a native reply thread (Slack `slack:<channel>:<ts>`);
            // keep that address. Discord roots stay null unless threadRecoveredRootMention threads them.
            threadId = message.threadId;
          }
          const isMention =
            target.isDM || message.isMention === true || config.detectRecoveredMention?.(message) === true;
          if (threadId === null && isMention && !target.isDM && config.threadRecoveredRootMention) {
            threadId = await config.threadRecoveredRootMention(target.platformId, message);
          }
          try {
            await forwardInbound(
              target.platformId,
              threadId,
              await messageToInbound(message, isMention, target.isDM, true),
              false,
            );
            recoveredMessages++;
            newestRecoveredAt = Math.max(newestRecoveredAt, message.metadata.dateSent.getTime());
          } catch (err) {
            failedTargets++;
            log.warn('Channel recovery message routing failed', {
              adapter: adapter.name,
              messageId: message.id,
              err: err instanceof Error ? err.message : String(err),
            });
            break;
          }
        }

        // Never advance the durable cursor across an incomplete target; a later pass replays the overlap safely.
        if (failedTargets === 0) {
          await completeRecovery(Math.max(newestRecoveredAt, recoveryStartedAtMs));
        }
        const routeMs = Date.now() - routeStartedAtMs;
        const totalMs = Date.now() - recoveryStartedAtMs;
        if (totalMs >= 1_000) {
          log.info('Channel recovery pass timing', {
            adapter: adapter.name,
            instance: bridgeChannelType,
            fetchMs: totalMs - routeMs,
            routeMs,
            scannedTargets: targets.length,
            recoveredMessages,
            failedTargets,
          });
        }
        return { scannedTargets: targets.length, recoveredMessages, failedTargets };
      });
    },

    async subscribe(_platformId: string, threadId: string) {
      // Chat SDK's subscription state lives on the StateAdapter (not on the
      // Chat instance itself). SqliteStateAdapter.subscribe is idempotent —
      // a second call on an already-subscribed thread is a no-op. threadId
      // is the SDK's thread id, which is what the router already has from
      // the original inbound event.
      await state.subscribe(threadId);
    },
  };

  // Only expose openDM when the underlying Chat SDK adapter implements it.
  // Delegate straight to adapter.openDM rather than going through chat.openDM:
  // the latter dispatches via inferAdapterFromUserId, which only recognizes
  // Discord snowflakes, Slack U-ids, Teams 29:-ids, and gChat users/-ids, and
  // throws for everything else (Telegram numeric ids, iMessage, Matrix, …).
  // Calling adapter.openDM directly also preserves the adapter's native
  // platform_id encoding via channelIdFromThreadId (e.g. "telegram:<chatId>"),
  // which matches what onInbound stores in messaging_groups — avoiding a
  // duplicate-row / decode-error cascade at delivery time. See user-dm.ts for
  // the direct-addressable fallback when the adapter has no openDM at all.
  if (adapter.openDM) {
    bridge.openDM = async (userHandle: string): Promise<string> => {
      const threadId = await adapter.openDM!(userHandle);
      return adapter.channelIdFromThreadId(threadId);
    };
  }

  return bridge;
}

/**
 * Start a local HTTP server to receive forwarded Gateway events.
 * This is needed because the Gateway listener in webhook-forwarding mode
 * sends ALL raw events (including INTERACTION_CREATE for button clicks)
 * to the webhookUrl, which we handle here.
 */
function startLocalWebhookServer(
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
  onConnectionRestored?: (reason: 'transport-ready' | 'transport-resumed') => void | Promise<void>,
): Promise<string> {
  return new Promise((resolve) => {
    let eventTail: Promise<void> = Promise.resolve();
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        // The Discord adapter issues one async request per raw Gateway packet and EventEmitter does not await
        // listeners, so READY and a following MESSAGE_CREATE can complete out of order. Queue the handlers and hold
        // later packets behind reconnect recovery.
        const handled = eventTail.then(() =>
          handleForwardedEvent(body, adapter, setupConfig, botToken, onConnectionRestored),
        );
        eventTail = handled.catch(() => undefined);
        handled
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          })
          .catch((err) => {
            log.error('Webhook server error', { err });
            res.writeHead(500);
            res.end('{"error":"internal"}');
          });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/webhook`;
      log.info('Local webhook server started', { port: addr.port });
      resolve(url);
    });
  });
}

export async function handleForwardedEvent(
  body: string,
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
  onConnectionRestored?: (reason: 'transport-ready' | 'transport-resumed') => void | Promise<void>,
): Promise<void> {
  let event: { type: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return;
  }

  // Handle interaction events (button clicks) — not handled by adapter's handleForwardedGatewayEvent
  if (event.type === 'GATEWAY_INTERACTION_CREATE' && event.data) {
    const interaction = event.data;
    // type 3 = MessageComponent (button/select)
    if (interaction.type === 3) {
      const customId = (interaction.data as Record<string, unknown>)?.custom_id as string;
      const decoded = typeof customId === 'string' ? decodeDiscordCustomId(customId) : undefined;
      // Only NanoClaw approval cards (`ncq:`) belong to this bridge; everything else reaches the adapter unchanged.
      if (decoded?.actionId.startsWith('ncq:')) {
        // Guild clicks carry the user at interaction.member.user; DMs at interaction.user.
        const user =
          ((interaction.member as Record<string, unknown>)?.user as Record<string, string> | undefined) ??
          (interaction.user as Record<string, string> | undefined);
        const interactionId = interaction.id as string;
        const interactionToken = interaction.token as string;
        // Approvals bind the click to this message.
        const clickedMessage = (interaction.message as Record<string, unknown> | undefined)?.id;
        const messageId = typeof clickedMessage === 'string' && clickedMessage ? clickedMessage : null;

        let questionId: string | undefined;
        let tail: string | undefined;
        if (decoded.actionId.startsWith('ncq:')) {
          const colonIdx = decoded.actionId.indexOf(':', 4);
          if (colonIdx !== -1) {
            questionId = decoded.actionId.slice(4, colonIdx);
            tail = decoded.actionId.slice(colonIdx + 1);
          }
        }

        const originalEmbeds =
          ((interaction.message as Record<string, unknown>)?.embeds as Array<Record<string, unknown>>) || [];
        const originalDescription = (originalEmbeds[0]?.description as string) || '';
        const originalContent = (
          ((interaction.message as Record<string, unknown>)?.content as string | undefined) || ''
        ).trim();
        const render = questionId ? await getAskQuestionRender(questionId) : undefined;
        // custom_id carries an option index; decode back to the real value.
        const selectedOption = resolveSelectedOption(render, decoded.value, tail);
        if (!questionId || !selectedOption) {
          log.warn('Ignoring Discord card action with an unresolved option', {
            questionId: questionId ?? '',
            encodedOption: tail ?? '',
            adapter: adapter.name,
          });
          try {
            await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                // Acknowledge without touching the card: the approval stays pending and can never read as a reject.
                type: 4,
                data: {
                  content: 'Could not verify that approval selection. The card is still pending.',
                  flags: 64,
                },
              }),
            });
          } catch (err) {
            log.error('Failed to acknowledge unresolved Discord card action', { err });
          }
          return;
        }
        if (render?.action !== undefined) {
          // Approval cards are never edited here (see the Chat SDK path): acknowledge with type 6
          // (DEFERRED_UPDATE_MESSAGE) and let the host edit the card once the click is bound and authorized.
          try {
            await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 6 }),
            });
          } catch (err) {
            log.error('Failed to acknowledge Discord answer-card action', { err });
          }
          setupConfig.onAction(questionId, selectedOption, user?.id || '', messageId);
          return;
        }
        const cardTitle = render?.title ?? ((originalEmbeds[0]?.title as string) || '❓ Question');
        const matchedOpt = render?.options.find((o) => o.value === selectedOption);
        const selectedLabel = matchedOpt?.selectedLabel ?? selectedOption;
        const resolvedQuestion = render?.question || originalDescription;
        const resolvedContent = render
          ? [`**${cardTitle}**`, resolvedQuestion, selectedLabel].filter(Boolean).join('\n\n')
          : originalContent
            ? [originalContent, selectedLabel].filter(Boolean).join('\n\n')
            : [`**${cardTitle}**`, originalDescription, selectedLabel].filter(Boolean).join('\n\n');
        try {
          await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 7, // UPDATE_MESSAGE: acknowledge and update in one call.
              data: {
                content: resolvedContent,
                embeds: [],
                components: [],
                allowed_mentions: { parse: [] },
              },
            }),
          });
        } catch (err) {
          log.error('Failed to update interaction', { err });
        }

        setupConfig.onAction(questionId, selectedOption, user?.id || '', messageId);
        return;
      }
    }
  }

  const connectionReason =
    event.type === 'GATEWAY_READY' ? 'transport-ready' : event.type === 'GATEWAY_RESUMED' ? 'transport-resumed' : null;

  // Forward other events to the adapter's webhook handler for normal processing
  const fakeRequest = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-discord-gateway-token': botToken || '',
    },
    body,
  });
  await adapter.handleWebhook(fakeRequest, {});
  if (connectionReason && onConnectionRestored) {
    try {
      await onConnectionRestored(connectionReason);
    } catch (err) {
      log.warn('Connection-restored recovery callback failed', {
        adapter: adapter.name,
        reason: connectionReason,
        err,
      });
      throw err;
    }
  }
}
