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
 * Mint a fresh dashboard token for `userId` and build its one-shot login URL.
 * Shared by every entry point that can issue a dashboard link — the chat
 * intercept command below and the native Slack slash-command handler
 * (`../../channels/slash-commands.ts`) — so the token/HMAC/URL logic exists
 * exactly once.
 */
export async function mintDashboardTokenUrl(userId: string): Promise<{ url: string; ttlHours: number }> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const serverKey = resolveServerKey();
  const tokenHmac = crypto.createHmac('sha256', serverKey).update(rawToken).digest('hex');

  // Token TTL must match cookie Max-Age (post-build QA fix MF-2). Both
  // server-side cookie expiry and client-side cookie deletion end at the
  // same wall-clock time — both read from `dashboardSessionTtlHours()`.
  const ttlHours = dashboardSessionTtlHours();
  await issueDashboardToken(userId, tokenHmac, ttlHours);

  // Build the URL to send to the user. Three env vars give precise control:
  //   NANOCLAW_DASHBOARD_URL      — full URL (e.g. https://dash.example.com); takes precedence
  //   NANOCLAW_DASHBOARD_HOST     — hostname (default 'localhost')
  //   NANOCLAW_DASHBOARD_PROTOCOL — 'http' | 'https' (default: derived from host — http for loopback, http for direct LAN/WAN access without TLS, https only when explicitly set)
  //   WEBHOOK_PORT                — port (default 3000)
  // Default protocol is http because the host bind is plain HTTP. Set NANOCLAW_DASHBOARD_PROTOCOL=https
  // when terminating TLS upstream (Cloudflare Tunnel, Caddy, nginx, Tailscale Funnel, etc.).
  const dashboardUrl = (() => {
    const fullUrl = process.env.NANOCLAW_DASHBOARD_URL;
    if (fullUrl) return fullUrl.replace(/\/+$/, '') + '/observatory/';
    const host = process.env.NANOCLAW_DASHBOARD_HOST ?? 'localhost';
    const port = process.env.WEBHOOK_PORT ?? '3000';
    const protocol = process.env.NANOCLAW_DASHBOARD_PROTOCOL ?? 'http';
    return `${protocol}://${host}:${port}/observatory/`;
  })();

  // The token rides in the URL FRAGMENT, which browsers never send to the
  // server, so it cannot land in an access or proxy log on the way in; the
  // SPA reads it, exchanges it, and scrubs it from the address bar and
  // history. Single-use and TTL-bound either way.
  return { url: `${dashboardUrl}#token=${rawToken}`, ttlHours };
}

/** Login-link text, shared by the DM-direct and DM-redirect paths below. */
function loginLinkText(url: string, ttlHours: number): string {
  // One clickable link, not a token to copy by hand.
  return `Open your dashboard (valid ${formatTtl(ttlHours)}, works once):\n${url}`;
}

export async function dashboardTokenIssue(ctx: InterceptContext): Promise<void> {
  const mg = getMessagingGroup(ctx.replyMessagingGroupId);
  if (!mg) {
    log.error('dashboardTokenIssue: messaging group not found', { replyMessagingGroupId: ctx.replyMessagingGroupId });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('dashboardTokenIssue: no delivery adapter available');
    return;
  }

  // The token is a bearer credential: whoever loads the URL first
  // authenticates as `ctx.userId`, no matter who actually clicked it. A DM
  // is safe (only the invoker is present). A group/channel is NOT — every
  // member sees the message, so the token must never be posted there. Route
  // it to the invoker's DM instead, opening one lazily if needed (same
  // primitive approvals/host notifications already use to cold-DM a user).
  // privacySafeLogs: this DM is about to carry a bearer dashboard token — a
  // resolution failure here must not write the invoker's platform handle or
  // any raw platform error into the host log.
  const deliveryMg = mg.is_group ? await ensureUserDm(ctx.userId, { privacySafeLogs: true }) : mg;

  if (!deliveryMg) {
    // No DM path on this platform (no adapter openDM support, or it threw —
    // e.g. the user has DMs closed). Fail closed: mint nothing, and say
    // nothing that reveals a credential exists to mint.
    // Same privacy rule as the ensureUserDm call above: the invoker's
    // namespaced handle stays out of the host log on the failure path too.
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

  // Redirected to a DM from a group — leave a credential-free breadcrumb in
  // the channel so the invoker knows to check DMs instead of assuming the
  // command silently failed.
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

// Side-effect registration — importing this file registers the handler.
registerInterceptHandler('dashboard_token_issue', dashboardTokenIssue);
