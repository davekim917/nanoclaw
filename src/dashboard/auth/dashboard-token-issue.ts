import crypto from 'crypto';
import { getDeliveryAdapter } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { issueDashboardToken } from '../db/dashboard-tokens.js';
import { dashboardSessionTtlHours, resolveServerKey } from './cookie.js';
import { registerInterceptHandler } from '../../command-gate.js';
import type { InterceptContext } from '../../command-gate.js';
import { ensureUserDm } from '../../modules/permissions/user-dm.js';
import { log } from '../../log.js';

/**
 * Mints a dashboard token and its one-shot login URL; shared by the chat intercept and the Slack slash command so the
 * token/HMAC/URL logic exists once.
 */
export async function mintDashboardTokenUrl(userId: string): Promise<{ url: string; ttlHours: number }> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const serverKey = resolveServerKey();
  const tokenHmac = crypto.createHmac('sha256', serverKey).update(rawToken).digest('hex');

  // Token TTL must match the cookie Max-Age; both come from `dashboardSessionTtlHours()`.
  const ttlHours = dashboardSessionTtlHours();
  await issueDashboardToken(userId, tokenHmac, ttlHours);

  // NANOCLAW_DASHBOARD_URL (full URL) wins; otherwise NANOCLAW_DASHBOARD_HOST (default localhost),
  // NANOCLAW_DASHBOARD_PROTOCOL and WEBHOOK_PORT (default 3000). The protocol defaults to http because the host binds
  // plain HTTP; set https when TLS terminates upstream.
  const dashboardUrl = (() => {
    const fullUrl = process.env.NANOCLAW_DASHBOARD_URL;
    if (fullUrl) return fullUrl.replace(/\/+$/, '') + '/observatory/';
    const host = process.env.NANOCLAW_DASHBOARD_HOST ?? 'localhost';
    const port = process.env.WEBHOOK_PORT ?? '3000';
    const protocol = process.env.NANOCLAW_DASHBOARD_PROTOCOL ?? 'http';
    return `${protocol}://${host}:${port}/observatory/`;
  })();

  // The token rides in the URL FRAGMENT, which browsers never send to the server, so it cannot land in an access or
  // proxy log. Single-use and TTL-bound.
  return { url: `${dashboardUrl}#token=${rawToken}`, ttlHours };
}

function loginLinkText(url: string, ttlHours: number): string {
  return `Open your dashboard (valid ${formatTtl(ttlHours)}, works once):\n${url}`;
}

export async function dashboardTokenIssue(ctx: InterceptContext): Promise<void> {
  const mg = await getMessagingGroup(ctx.replyMessagingGroupId);
  if (!mg) {
    log.error('dashboardTokenIssue: messaging group not found', { replyMessagingGroupId: ctx.replyMessagingGroupId });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('dashboardTokenIssue: no delivery adapter available');
    return;
  }

  // The token is a bearer credential: whoever loads the URL first authenticates as the invoker. In a group every
  // member sees the message, so the link is routed to the invoker's DM instead. `privacySafeLogs`: a resolution
  // failure must not log the invoker's handle or a raw platform error.
  const deliveryMg = mg.is_group ? await ensureUserDm(ctx.userId, { privacySafeLogs: true }) : mg;

  if (!deliveryMg) {
    // No DM path: fail closed. Mint nothing, and say nothing that reveals a credential exists to mint. The handle
    // stays out of the log here too.
    log.warn('dashboardTokenIssue: no private delivery path, refusing to mint', {
      channelType: mg.channel_type,
    });
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      null,
      'chat',
      JSON.stringify({ text: "I can't send that privately here. DM me and run it again." }),
    );
    return;
  }

  const { url, ttlHours } = await mintDashboardTokenUrl(ctx.userId);
  await adapter.deliver(
    deliveryMg.channel_type,
    deliveryMg.platform_id,
    null,
    'chat',
    JSON.stringify({ text: loginLinkText(url, ttlHours) }),
  );

  // Leave a credential-free breadcrumb in the channel so the invoker checks DMs.
  if (deliveryMg.id !== mg.id) {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      null,
      'chat',
      JSON.stringify({ text: 'Sent you a DM with your dashboard link.' }),
    );
  }
}

export function formatTtl(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '1 day' : `${days} days`;
  }
  return `${hours}h`;
}

registerInterceptHandler('dashboard_token_issue', dashboardTokenIssue);
