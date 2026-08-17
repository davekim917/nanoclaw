import crypto from 'crypto';
import { getDeliveryAdapter } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { issueDashboardToken } from '../db/dashboard-tokens.js';
import { dashboardSessionTtlHours, resolveServerKey } from './cookie.js';
import { registerInterceptHandler } from '../../command-gate.js';
import type { InterceptContext } from '../../command-gate.js';
import { log } from '../../log.js';

export async function dashboardTokenIssue(ctx: InterceptContext): Promise<void> {
  const mg = getMessagingGroup(ctx.replyMessagingGroupId);
  if (!mg) {
    log.error('dashboardTokenIssue: messaging group not found', { replyMessagingGroupId: ctx.replyMessagingGroupId });
    return;
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const serverKey = resolveServerKey();
  const tokenHmac = crypto.createHmac('sha256', serverKey).update(rawToken).digest('hex');

  // Token TTL must match cookie Max-Age (post-build QA fix MF-2). Both
  // server-side cookie expiry and client-side cookie deletion end at the
  // same wall-clock time — both read from `dashboardSessionTtlHours()`.
  const ttlHours = dashboardSessionTtlHours();
  issueDashboardToken(ctx.userId, tokenHmac, ttlHours);

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

  const adapter = getDeliveryAdapter();
  if (adapter) {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      null,
      'chat',
      JSON.stringify({
        // One clickable link, not a token to copy by hand. The token rides in
        // the URL FRAGMENT, which browsers never send to the server, so it
        // cannot land in an access or proxy log on the way in; the SPA reads
        // it, exchanges it, and scrubs it from the address bar and history.
        // Single-use and TTL-bound either way.
        text: `Open your dashboard (valid ${formatTtl(ttlHours)}, works once):\n${dashboardUrl}#token=${rawToken}`,
      }),
    );
  } else {
    log.warn('dashboardTokenIssue: no delivery adapter available');
  }
}

function formatTtl(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '1 day' : `${days} days`;
  }
  return `${hours}h`;
}

// Side-effect registration — importing this file registers the handler.
registerInterceptHandler('dashboard_token_issue', dashboardTokenIssue);
