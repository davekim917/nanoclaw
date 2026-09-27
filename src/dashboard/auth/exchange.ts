import crypto from 'crypto';
import { consumeDashboardToken } from '../db/dashboard-tokens.js';
import { resolveServerKey, buildSetCookie } from './cookie.js';
import { checkOrigin, register } from '../router.js';
import type { Handler } from '../router.js';

export const exchangeHandler: Handler = async (req) => {
  const originDeny = checkOrigin(req);
  if (originDeny) return originDeny;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).token !== 'string') {
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawToken = (body as { token: string }).token;
  const serverKey = resolveServerKey();
  const tokenHmac = crypto.createHmac('sha256', serverKey).update(rawToken).digest('hex');

  const record = await consumeDashboardToken(tokenHmac);
  if (!record) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Browsers refuse Secure cookies over plain HTTP to non-loopback hosts, so for http://<lan-ip> the Secure attribute
  // must be omitted or the user loops back to the auth gate. Reverse proxies set X-Forwarded-Proto when terminating
  // TLS.
  const xfp = req.headers.get('x-forwarded-proto');
  const hostHeader = req.headers.get('host') ?? '';
  const hostname = hostHeader.split(':')[0] ?? '';
  const isLoopbackHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const requestIsHttps = xfp === 'https' || isLoopbackHost;

  const cookie = buildSetCookie({ user_id: record.user_id, expires_at: record.expires_at }, serverKey, {
    secure: requestIsHttps,
  });

  return new Response(JSON.stringify({ user_id: record.user_id, expires_at: record.expires_at }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
};

register('POST', '/dashboard/api/auth/exchange', exchangeHandler);
