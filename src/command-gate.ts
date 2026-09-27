/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Intercept commands: handled by a registered handler before fan-out
 * - Normal messages: pass through unchanged
 */
import { withCentralSync } from './db/central-lease.js';
import { hasAdminPrivilege, isAnyAdmin } from './modules/permissions/db/user-roles.js';
import { hasAnyMembership } from './modules/permissions/db/agent-group-members.js';

export type GateResult =
  | { action: 'pass' }
  | { action: 'filter' }
  | { action: 'deny'; command: string; leadingMention?: boolean }
  | { action: 'intercept'; handlerName: string; command: string; args: string; leadingMention?: boolean };

export type InterceptHandler = (ctx: InterceptContext) => Promise<void>;

export interface InterceptContext {
  userId: string;
  replyMessagingGroupId: string;
  command: string;
  args: string;
}

const INTERCEPT_COMMANDS: Map<string, { handlerName: string; requiresAuth: 'admin' | 'any' }> = new Map([
  ['/dashboard-token', { handlerName: 'dashboard_token_issue', requiresAuth: 'admin' }],
]);

const interceptHandlers = new Map<string, InterceptHandler>();

export function registerInterceptHandler(name: string, h: InterceptHandler): void {
  interceptHandlers.set(name, h);
}

export function getInterceptHandler(name: string): InterceptHandler | undefined {
  return interceptHandlers.get(name);
}

export function clearInterceptHandlers(): void {
  interceptHandlers.clear();
}

const FILTERED_COMMANDS = new Set(['/start', '/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);

/** Classify the USER's text: peel everything before the final `[Latest message]\n` marker that threaded chat-sdk inbounds carry. */
function extractUserMessage(text: string): string {
  const marker = '[Latest message]\n';
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return text;
  return text.substring(idx + marker.length).trim();
}

/** Strip leading mention tokens (`<@U123>`, `@bot `), repeatedly: Discord/Slack deliver `<@U123> /cmd`, which would otherwise read as prose. */
function stripLeadingMentions(text: string): string {
  let prev: string;
  let cur = text;
  do {
    prev = cur;
    cur = cur.replace(/^\s*<@[!&]?[\w-]+(\|[^>]*)?>\s*/, ''); // Discord/Slack formal mention
    cur = cur.replace(/^\s*@[\w-]+\s+/, ''); // bare @name followed by whitespace
  } while (prev !== cur);
  return cur;
}

/**
 * Pre-fan-out gate: runs ONCE per inbound message, before the agent fan-out loop.
 * Handles INTERCEPT_COMMANDS (e.g. /dashboard-token) and FILTERED_COMMANDS.
 * ADMIN_COMMANDS are NOT intercepted here — they flow through to gateCommand at fan-out.
 */
export async function preFanoutGate(content: string, userId: string): Promise<GateResult> {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  text = extractUserMessage(text);
  const beforeMentionStrip = text;
  text = stripLeadingMentions(text);
  // Whether the raw text named a bot before the command: tells "addressed to nobody" from "addressed to another sibling".
  const leadingMention = text !== beforeMentionStrip;

  if (!text.startsWith('/')) return { action: 'pass' };

  const parts = text.split(/\s+/);
  const command = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1).join(' ');

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  const intercept = INTERCEPT_COMMANDS.get(command);
  if (intercept) {
    if (intercept.requiresAuth === 'admin') {
      // Despite the flag name, members may mint their own read-only login link (the token binds to ctx.userId).
      if (!(await isAnyAdmin(userId)) && !(await hasAnyMembership(userId)))
        return { action: 'deny', command, leadingMention };
    }
    return { action: 'intercept', handlerName: intercept.handlerName, command, args, leadingMention };
  }

  return { action: 'pass' };
}

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands.
 */
export async function gateCommand(content: string, userId: string | null, agentGroupId: string): Promise<GateResult> {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  text = extractUserMessage(text);
  text = stripLeadingMentions(text);

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (await isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

function isAdmin(userId: string | null, agentGroupId: string): Promise<boolean> {
  if (!userId) return Promise.resolve(false);
  return withCentralSync(() => hasAdminPrivilege(userId, agentGroupId), 'command gate admin check');
}
