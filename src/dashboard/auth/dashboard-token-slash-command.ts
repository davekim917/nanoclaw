/**
 * Native Slack `/dashboard-token` slash command, separate from `dashboard-token-issue.ts`'s chat intercept (which
 * needs the bot to see a plain message). Slash commands can run in channels the bot is not in, so the reply MUST use
 * Slack's `response_url`, not a channel post or `chat.postEphemeral`. The link is a bearer credential, so the reply
 * is always ephemeral.
 */
import type { SlashCommandEvent } from 'chat';
import { registerSlashCommandHandler } from '../../channels/chat-sdk-bridge.js';
import { isAnyAdmin } from '../../modules/permissions/db/user-roles.js';
import { hasAnyMembership } from '../../modules/permissions/db/agent-group-members.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { mintDashboardTokenUrl, formatTtl } from './dashboard-token-issue.js';
import { log } from '../../log.js';

function extractResponseUrl(raw: unknown): string | undefined {
  const url = (raw as Record<string, unknown> | undefined)?.response_url;
  return typeof url === 'string' ? url : undefined;
}

/** `response_url` works regardless of the bot's channel membership; ephemeral by default. */
async function postEphemeralViaResponseUrl(responseUrl: string, text: string): Promise<void> {
  try {
    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text }),
    });
    if (!res.ok) {
      log.warn('dashboardTokenSlashCommand: response_url POST failed', { status: res.status });
    }
  } catch (err) {
    log.error('dashboardTokenSlashCommand: response_url POST threw', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function dashboardTokenSlashCommand(event: SlashCommandEvent): Promise<void> {
  const responseUrl = extractResponseUrl(event.raw);
  const rawUserId = event.user.userId;
  if (!responseUrl || !rawUserId) {
    log.error('dashboardTokenSlashCommand: missing response_url or user id', {
      adapter: event.adapter.name,
      hasResponseUrl: !!responseUrl,
    });
    return;
  }

  // `<channel_type>:<Slack user id>`, matching what the chat-intercept path produces (the bridge sets `adapter.name`
  // to the workspace's channelType).
  const userId = `${event.adapter.name}:${rawUserId}`;

  // Same gate as the chat intercept: any admin or agent-group member may mint a link for themselves only.
  if (!(await isAnyAdmin(userId)) && !(await hasAnyMembership(userId))) {
    await postEphemeralViaResponseUrl(responseUrl, "You don't have dashboard access. Ask an admin to add you.");
    return;
  }

  // dashboard_tokens.user_id is FK'd to users(id), so the row must exist before minting.
  await upsertUser({
    id: userId,
    kind: event.adapter.name,
    display_name: event.user.fullName || event.user.userName || null,
    created_at: new Date().toISOString(),
  });

  const { url, ttlHours } = await mintDashboardTokenUrl(userId);
  await postEphemeralViaResponseUrl(
    responseUrl,
    `Open your dashboard (valid ${formatTtl(ttlHours)}, works once):\n${url}`,
  );
}

registerSlashCommandHandler('/dashboard-token', dashboardTokenSlashCommand);
