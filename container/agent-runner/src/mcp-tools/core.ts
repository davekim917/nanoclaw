/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import crypto from 'crypto';
import { outcomeReportingEnabled } from '../outcome-reporting.js';
import { OUTCOME_PURPOSES, renderWorkOutcome, type TrustedRequestIdentity } from '../outcome-reporting-schema.js';
import fs from 'fs';
import path from 'path';

import { awaitDeliveryAck } from '../db/delivery-acks.js';
import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { chatBudgetExhausted, isChatMuted } from '../modules/mailbox/index.js';

// Shared refusal copy for send paths under the physical chat budget. Edits and
// reactions stay allowed — amending the already-sent message is the sanctioned
// escape hatch once the budget is spent.
function chatSendDenial(): string | null {
  if (isChatMuted()) {
    return 'Chat sends are disabled for this task (muteChat). Alerts go through the outbox file contract; your completion report goes in the ledger.';
  }
  if (chatBudgetExhausted()) {
    return 'The per-turn chat send budget for this scheduled task is used up. Do not post follow-up or summary messages. If something essential is missing, amend the message you already sent with edit_message.';
  }
  return null;
}
import { getCurrentInReplyTo } from '../db/session-state.js';
import { resolveRequestCandidate } from '../modules/mailbox/session-state.js';
import { getSessionRouting, getTaskSeriesId } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

// send_file safety constants — mirror v1's ipc-mcp-stdio.ts behavior.
const SEND_FILE_MAX_BYTES = 50 * 1024 * 1024; // Slack's own cap is 1GB but most adapters fail long before
const SEND_FILE_ALLOWED_PREFIXES = [
  '/workspace/agent',
  '/workspace/worktrees',
  '/workspace/workgroup',
  '/workspace/extra',
  '/tmp/',
];
const SEND_FILE_ACK_TIMEOUT_MS = 30_000;

// Content-hash dedup for send_file. Browser-driver agents often take
// snapshots of the same rendered page multiple times — without dedup the
// user gets flooded with identical images. Map is per-container, resets
// on restart; that's fine since the dedup window only needs to cover the
// lifespan of a turn-chain on the same topic.
const sentFileHashes = new Map<string, string>();

// Exported for unit testing — the prefix set is the security boundary for
// send_file, so it is asserted directly rather than only through the full
// send_file path (which short-circuits on a non-existent file before the
// allowlist check is reached).
//
// Match on a path-separator boundary, not bare startsWith, so a prefix-lookalike
// (e.g. /workspace/workgroup-evil) cannot satisfy /workspace/workgroup. Mirrors
// poll-loop.ts's isAllowedFileEventPath. `p === prefix` still allows the exact
// dir itself.
export function isAllowedFilePath(p: string): boolean {
  return SEND_FILE_ALLOWED_PREFIXES.some((prefix) => {
    const boundary = prefix.endsWith(path.sep) ? prefix : `${prefix}${path.sep}`;
    return p === prefix || p.startsWith(boundary);
  });
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

// Final response routing uses this envelope, but an MCP tool already has an
// explicit routing field. A model can carry the final-response habit into a
// send_message call, which otherwise exposes the envelope as literal chat
// text. Recognize only one complete, top-level routing envelope: XML in prose
// or code blocks remains user content.
const ROUTING_MESSAGE_OPENER_RE = /<message\s+to="([^"]*)"\s*>/g;
// Matches ONLY the leading opener (used to find where its content starts,
// and to short-circuit text that isn't a routing envelope at all).
const ROUTING_MESSAGE_LEADING_OPENER_RE = /^\s*<message\s+to="[^"]*"\s*>/;
const ROUTING_MESSAGE_CLOSER = '</message>';

/**
 * Recognize a leading `<message to="...">...</message>` envelope, terminating
 * at the FIRST closing tag — never the last, and never a nested one.
 *
 * This used to be a single regex whose inner group was a tempered token,
 * `(?:(?!<\/message>)[\s\S])*` — "anything that isn't the start of a
 * closing tag" — to stop at the first `</message>` instead of a plain
 * greedy `[\s\S]*` backtracking to the last one. But a tempered token still
 * re-runs its negative lookahead at every character position, and under
 * Bun/JSC that per-character backtracking hits an internal engine limit:
 * on a legitimate body at roughly 688KB and up the match SILENTLY fails —
 * no error, no timeout, just "not a routing envelope" — and even below
 * that threshold it costs on the order of 0.4s/MB. A chat message or
 * send_file caption can legitimately be that large (a long report, a
 * pasted log), so this scans with `indexOf` instead: O(n), no
 * backtracking, no size cliff.
 *
 * Terminating at the first closing tag (rather than requiring a UNIQUE one)
 * is deliberate, not just an artifact of the scan: a nested, un-addressed
 * `<message>` inside the envelope — e.g. `<message to="x">See <message>hi
 * </message> for detail</message>` — must not be silently unwrapped past
 * the inner tag to the outer one. Stopping at the first `</message>` (the
 * inner one here) leaves "for detail</message>" as trailing, non-whitespace
 * content, which fails the check below and rejects the whole thing as not
 * one complete envelope — the same outcome as an unclosed envelope, not a
 * guess at which closing tag was "really" meant.
 */
function stripRoutingEnvelope(text: string): string | undefined {
  const opener = text.match(ROUTING_MESSAGE_LEADING_OPENER_RE);
  if (!opener) return undefined;
  const contentStart = opener[0].length;
  const closeIdx = text.indexOf(ROUTING_MESSAGE_CLOSER, contentStart);
  if (closeIdx === -1) return undefined;
  const rest = text.slice(closeIdx + ROUTING_MESSAGE_CLOSER.length);
  if (!/^\s*$/.test(rest)) return undefined;
  return text.slice(contentStart, closeIdx);
}

function normalizeToolMessageText(
  text: string,
  callerTool: 'send_message' | 'send_file' | 'edit_message',
): { text: string } | { error: string } {
  // An inline example or fenced code block does not begin with an envelope,
  // so preserve it exactly. `<message>` without a routing attribute is also
  // ordinary XML, not a NanoClaw routing instruction.
  if (!ROUTING_MESSAGE_LEADING_OPENER_RE.test(text)) return { text };

  const openers = [...text.matchAll(ROUTING_MESSAGE_OPENER_RE)];
  if (openers.length !== 1) {
    const destinations = [...new Set(openers.map((opener) => opener[1]))];
    const detail = destinations.length > 1 ? ` to multiple destinations (${destinations.join(', ')})` : '';
    return {
      error: `text contains multiple routing message envelopes${detail}. ` + `Use one ${callerTool} call per message.`,
    };
  }

  const envelope = stripRoutingEnvelope(text);
  if (envelope === undefined) {
    return {
      error:
        'text starts with a routing message envelope but is not one complete `<message to="...">...</message>` block.',
    };
  }

  return {
    error:
      'text uses an obsolete `<message to="...">...</message>` delivery envelope. ' +
      `Pass the body directly to ${callerTool}; its routing fields are authoritative.`,
  };
}

// Mirrors the host's THREAD_KEY_PATTERN (src/db/thread-key-anchors.ts), which
// re-checks every row: the runner's check is for a useful error, the host's is
// the one that holds.
const THREAD_KEY_MAX_LENGTH = 128;
const THREAD_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const THREAD_KEY_DESCRIPTION =
  'Optional stable id for ONE incident or topic (e.g. "db-backup-job-42-since-run-9001"). First post with a key is a new top-level post; later posts with the SAME key — any fire, any day — go in that post\'s thread; a NEW key is a new top-level post, so mint a new key when an incident ends and another begins. Omit for ordinary messages. Letters, digits, . _ : - only; max 128 chars. No effect when posting into the current conversation\'s thread.';

const IN_PLACE_THREAD_KEY_DESCRIPTION =
  'Optional. The thread_key the target message was sent with, when it went into an incident thread — routes this to the message inside that thread. Omit otherwise.';

/** Validate an optional thread_key argument. Blank or absent → no key. Exported for tests. */
export function parseThreadKey(raw: unknown): { threadKey: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { threadKey: null };
  if (typeof raw !== 'string') return { error: 'thread_key must be a string' };
  const key = raw.trim();
  if (!key) return { threadKey: null };
  if (key.length > THREAD_KEY_MAX_LENGTH) {
    return { error: `thread_key is too long (${key.length} characters, max ${THREAD_KEY_MAX_LENGTH})` };
  }
  if (!THREAD_KEY_PATTERN.test(key)) {
    return {
      error: 'thread_key may contain only letters, digits, and . _ : - and must start with a letter or digit',
    };
  }
  return { threadKey: key };
}

/**
 * Resolve a destination name to routing fields.
 *
 * If `to` is omitted, use the session's default reply routing (channel +
 * thread the conversation is in) — the agent replies in place.
 *
 * If `to` is specified, look up the named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string | undefined,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  if (!to) {
    if (getTaskSeriesId()) {
      return { error: `to is required for task sessions. Options: ${destinationList()}` };
    }

    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }

    // Legacy/internal sessions may not have a routing row. Preserve the
    // unambiguous one-destination fallback while failing closed when several
    // destinations exist.
    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }

  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // Same chat as the session (by platform_id, not bot instance — siblings reach
    // one channel through different channel_types) → keep the thread.
    const session = getSessionRouting();
    const threadId = session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description:
      'Send a structured public message. Omit `to` for the CURRENT conversation; pass it only for a requested different destination. Use reply for requested interaction, outcome for one finished human work item, urgent/decision for material exceptions, handoff for actionable coordination, and progress only for an internal work record. The harness owns acknowledgment/liveness. A container file path is not user-accessible; attach it with send_file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1"). Optional when replying in this conversation.',
        },
        text: {
          type: 'string',
          description: 'Message content; for outcome, the short product result and why it matters.',
        },
        purpose: {
          type: 'string',
          enum: [...OUTCOME_PURPOSES],
          description:
            'Required for opted-in channel sends. Progress stays internal; outcome is one finished human work item; reply is requested human interaction; urgent/decision preserve real incidents and authority; handoff is actionable coordination.',
        },
        outcome: {
          type: 'object',
          properties: {
            workItem: {
              type: 'string',
              description:
                'Legacy original GitHub PR/issue or Slack request URL. Omit when using the harness requestId.',
            },
            requestId: {
              type: 'integer',
              description:
                'Harness-supplied id from the original inbound <message id="…"> or <task id="…">. Required when several requests are available.',
            },
            verified: { type: 'string' },
            evidence: { type: 'string', description: 'Optional accessible HTTPS evidence link.' },
            remaining: { type: 'string' },
            needsYou: { type: 'string' },
          },
          required: ['verified'],
        },
        thread_key: { type: 'string', description: THREAD_KEY_DESCRIPTION },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const rawText = args.text as string;
    if (!rawText) return err('text is required');
    const normalized = normalizeToolMessageText(rawText, 'send_message');
    if ('error' in normalized) return err(normalized.error);
    let text = normalized.text;
    if (!text) return err('text is required');

    const key = parseThreadKey(args.thread_key);
    if ('error' in key) return err(key.error);

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const policy = outcomeReportingEnabled() && routing.channel_type !== 'agent';
    const purpose = args.purpose;
    if (policy && !OUTCOME_PURPOSES.some((value) => value === purpose))
      return err(
        'Choose an explicit purpose: progress stays internal; outcome, reply, urgent, decision or actionable handoff may reach the channel.',
      );
    let reportedOutcome = args.outcome;
    if (policy && purpose === 'outcome') {
      try {
        const rawOutcome = args.outcome as Record<string, unknown> | undefined;
        let trustedRequest: TrustedRequestIdentity | undefined;
        if (rawOutcome?.workItem === undefined) {
          const candidate = resolveRequestCandidate(rawOutcome?.requestId);
          // The runner validates only that this request id came from its trusted candidate set.
          // The host reopens that inbound row and derives the authoritative origin key.
          trustedRequest = {
            sessionId: 'runner-validation',
            messageId: candidate.messageId,
            sequence: candidate.sequence,
          };
          reportedOutcome = { ...rawOutcome, requestId: candidate.sequence };
        }
        text = renderWorkOutcome(text, reportedOutcome, trustedRequest).text;
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    }
    const internal = policy && purpose === 'progress';
    const id = generateId();
    const denial = internal ? null : chatSendDenial();
    if (denial) return err(denial);
    const seq = await writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: internal ? 'work_log' : 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        text,
        ...(key.threadKey ? { threadKey: key.threadKey } : {}),
        ...(policy
          ? {
              reporting: {
                version: 1,
                purpose,
                ...(purpose === 'outcome' ? { outcome: reportedOutcome, summary: normalized.text } : {}),
              },
            }
          : {}),
      }),
    });

    if (seq < 0)
      return err(
        'Message was not queued: chat budget or mute rejected it. Use the existing authorized outbox/card route where required.',
      );
    if (internal) return ok(`Recorded internally (id: ${seq}); no channel message was sent.`);
    if (policy && purpose === 'outcome') {
      const ack = await awaitDeliveryAck(id, 5000);
      if (!ack)
        return ok(
          `Outcome queued (id: ${seq}); delivery unconfirmed. Reuse the same work item; do not report delivery as confirmed or create a replacement key.`,
        );
      if (ack.status === 'failed') return err(`Outcome not delivered: ${ack.error ?? 'host rejected delivery'}`);
      return ok(
        `Outcome receipt confirmed (id: ${seq}, platform_message_id: ${ack.platformMessageId ?? 'unknown'}). This may reuse an already delivered report; do not post a second summary.`,
      );
    }
    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description:
      'Send a file from your workspace. Omit `to` to post in the current conversation (the thread/channel you are working in) — the default, regardless of destination count. Pass `to` only to reach a different destination than the current conversation. Use this to deliver artifacts you produced — charts, PDFs, generated images, reports, self-contained HTML — rather than dumping their contents into chat. A container path is never openable by the user directly; this is how they actually receive the file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name. Optional when replying in this conversation.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
        thread_key: { type: 'string', description: THREAD_KEY_DESCRIPTION },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string;
    if (!filePath) return err('path is required');

    // Same final-response habit send_message guards against: a caption wrapped
    // in a routing envelope would otherwise reach the channel as literal
    // `<message to="...">` text. Rejects before anything is staged.
    let caption = '';
    if (args.text) {
      const normalized = normalizeToolMessageText(args.text as string, 'send_file');
      if ('error' in normalized) return err(normalized.error);
      caption = normalized.text;
    }

    const key = parseThreadKey(args.thread_key);
    if ('error' in key) return err(key.error);

    const denial = chatSendDenial();
    if (denial) return err(denial);

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    // Follow symlinks for the allowlist check so a link inside /workspace
    // pointing to a host-sensitive file can't sneak out via send_file.
    let realPath: string;
    try {
      realPath = fs.realpathSync(resolvedPath);
    } catch {
      return err('Path not allowed for send_file.');
    }
    if (!isAllowedFilePath(realPath)) {
      return err(`Path not allowed for send_file. Files must be under ${SEND_FILE_ALLOWED_PREFIXES.join(', ')}.`);
    }

    const stat = fs.statSync(realPath);
    if (stat.size === 0) return err('File is empty.');
    if (stat.size > SEND_FILE_MAX_BYTES) {
      return err(
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max ${SEND_FILE_MAX_BYTES / 1024 / 1024}MB.`,
      );
    }

    // path.basename strips any traversal in the optional display name.
    const filename = path.basename((args.filename as string) || path.basename(realPath));

    // SHA-256 dedup — browser-driver agents frequently snapshot the same
    // page, producing identical images the user doesn't need twice.
    const fileContent = fs.readFileSync(realPath);
    const contentHash = crypto.createHash('sha256').update(fileContent).digest('hex');
    const prior = sentFileHashes.get(contentHash);
    if (prior) {
      return err(
        `Duplicate content: "${filename}" is identical to previously sent "${prior}". NOT sent. If this is a browser screenshot, the page likely hasn't changed — navigate or wait for re-render, then re-capture.`,
      );
    }

    const id = generateId();
    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, filename), fileContent);

    await writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify(
        key.threadKey
          ? { text: caption, files: [filename], threadKey: key.threadKey }
          : { text: caption, files: [filename] },
      ),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filename}), awaiting host ack`);

    // Wait for the host to actually deliver. Without this, the agent would
    // report success for Slack uploads that silently failed (missing OAuth
    // scope, size limit, adapter transient error past retry count). v2's
    // host-owned `delivered` table carries the outcome (migration adds the
    // `error` column).
    const ack = await awaitDeliveryAck(id, SEND_FILE_ACK_TIMEOUT_MS);
    if (!ack) {
      // Treat timeout as "sent — delivery unconfirmed". Record the hash
      // anyway so a retry with the same content is deduped.
      sentFileHashes.set(contentHash, filename);
      return ok(
        `File "${filename}" sent to ${routing.resolvedName} (id: ${id}) — delivery unconfirmed (host did not respond within ${SEND_FILE_ACK_TIMEOUT_MS / 1000}s).`,
      );
    }
    if (ack.status === 'delivered') {
      sentFileHashes.set(contentHash, filename);
      return ok(
        `File "${filename}" delivered to ${routing.resolvedName} (id: ${id}${ack.platformMessageId ? `, platform_message_id: ${ack.platformMessageId}` : ''}).`,
      );
    }
    // Failed — surface the host's error to the agent. Do not record the
    // hash: a corrected retry (different file, or after fixing the scope)
    // should be allowed through.
    return err(
      `File upload failed for "${filename}" to ${routing.resolvedName}: ${ack.error ?? 'unknown error'}. The file is staged at ${realPath}.`,
    );
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
        thread_key: { type: 'string', description: IN_PLACE_THREAD_KEY_DESCRIPTION },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const rawText = args.text as string;
    if (!seq || !rawText) return err('messageId and text are required');
    const key = parseThreadKey(args.thread_key);
    if ('error' in key) return err(key.error);
    const normalized = normalizeToolMessageText(rawText, 'edit_message');
    if ('error' in normalized) return err(normalized.error);
    const text = normalized.text;
    if (!text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    await writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify(
        key.threadKey
          ? { operation: 'edit', messageId: platformId, text, threadKey: key.threadKey }
          : { operation: 'edit', messageId: platformId, text },
      ),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description:
      'Add an emoji reaction to an inbound message, addressed by the numeric #N id shown on it. Good for lightweight acknowledgment when a full reply would be noise — eyes for seen, white_check_mark for done.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
        thread_key: { type: 'string', description: IN_PLACE_THREAD_KEY_DESCRIPTION },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');
    const key = parseThreadKey(args.thread_key);
    if ('error' in key) return err(key.error);

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    await writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify(
        key.threadKey
          ? { operation: 'reaction', messageId: platformId, emoji, threadKey: key.threadKey }
          : { operation: 'reaction', messageId: platformId, emoji },
      ),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction]);
