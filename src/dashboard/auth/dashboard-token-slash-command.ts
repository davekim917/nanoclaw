/**
 * Native Slack slash-command handler for `/dashboard-token`.
 *
 * This is a SEPARATE entry point from `dashboard-token-issue.ts`'s chat
 * intercept: that one fires when a user types `/dashboard-token` as a plain
 * message the bot has to be mentioned/DM'd to see. This one fires when Slack
 * itself recognizes `/dashboard-token` as a registered slash command (app
 * manifest registration — see docs/slack-slash-commands.md) and delivers a
 * `SlashCommandEvent` directly, bypassing Slack's "not a valid command"
 * interception entirely.
 *
 * Slash commands can be invoked from any channel, including ones the bot
 * isn't a member of — so the reply MUST go through Slack's `response_url`
 * (valid regardless of channel membership) rather than a normal channel
 * post or the SDK's `channel.postEphemeral` (which posts via the
 * `chat.postEphemeral` Web API and needs the bot present in the channel).
 * The link is a bearer credential, so the reply is always ephemeral —
 * visible only to the invoking user, never posted to the channel.
 */
import type { SlashCommandEvent } from 'chat';
import { registerSlashCommandHandler } from '../../channels/chat-sdk-bridge.js';
import { isAnyAdmin } from '../../modules/permissions/db/user-roles.js';
import { hasAnyMembership } from '../../modules/permissions/db/agent-group-members.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { mintDashboardTokenUrl, formatTtl } from './dashboard-token-issue.js';
import { log } from '../../log.js';

/** Slack sends `response_url` as a normal form field on the slash-command payload. */
function extractResponseUrl(raw: unknown): string | undefined {
  const url = (raw as Record<string, unknown> | undefined)?.response_url;
  return typeof url === 'string' ? url : undefined;
}

/**
 * Reply to a slash command via Slack's `response_url` — the only reply path
 * that works regardless of whether the bot is in the invoking channel.
 * `response_type: 'ephemeral'` (the default) keeps the message visible only
 * to the invoker.
 */
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

  // Persisted identity is `<channel_type>:<Slack user id>` — same convention
  // as every other Slack-derived user id (see slack-user-identity.ts). The
  // bridge overrides `adapter.name` to the workspace's channelType, so this
  // matches exactly what the chat-intercept path produces for the same user.
  const userId = `${event.adapter.name}:${rawUserId}`;

  // Same gate as the chat-intercept path (command-gate.ts's INTERCEPT_COMMANDS
  // entry for /dashboard-token): any admin, or any existing agent-group
  // member, can mint their own read-only login link. Everyone else is denied
  // — the token binds to the invoker's identity, so this is not "mint for
  // anyone," only "mint for yourself."
  if (!isAnyAdmin(userId) && !hasAnyMembership(userId)) {
    await postEphemeralViaResponseUrl(responseUrl, "You don't have dashboard access. Ask an admin to add you.");
    return;
  }

  // dashboard_tokens.user_id is FK'd to users(id) — ensure the row exists
  // before minting (same upsert shape the chat-inbound path uses in
  // modules/permissions/index.ts's extractAndUpsertUser).
  upsertUser({
    id: userId,
    kind: event.adapter.name,
    display_name: event.user.fullName || event.user.userName || null,
    created_at: new Date().toISOString(),
  });

  const { url, ttlHours } = mintDashboardTokenUrl(userId);
  await postEphemeralViaResponseUrl(
    responseUrl,
    `Open your dashboard (valid ${formatTtl(ttlHours)}, works once):\n${url}`,
  );
}

// Side-effect registration — importing this file registers the handler.
registerSlashCommandHandler('/dashboard-token', dashboardTokenSlashCommand);
