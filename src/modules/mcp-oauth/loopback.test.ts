/**
 * The opt-in loopback listener and the device grant.
 *
 * The listener cases bind an ephemeral port on 127.0.0.1 and drive it with
 * `http.get` from the same process — local only, no DNS, no outbound socket.
 * The device cases inject both `fetch` and `sleep`, so polling costs no real
 * time.
 */
import http from 'http';
import os from 'os';

import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../../test-hermeticity.js';
import { pollDeviceToken, requestDeviceAuthorization } from './device.js';
import { startLoopbackListener, sshTunnelCommand } from './loopback.js';
import { OAuthTokenError } from './oauth-client.js';

enforceHermeticity();

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      // `agent: false` forces a fresh socket per request. Node's global agent
      // keeps connections alive, and a reused socket would still be served by a
      // server that has already stopped listening — which would make the
      // "closes after one capture" assertion below pass for the wrong reason.
      .get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response;
}

describe('loopback listener', () => {
  it('captures the code and state from the redirect, then closes', async () => {
    const listener = await startLoopbackListener(0, 5_000);
    const page = await get(listener.port, '/callback?code=abc&state=st-1');

    expect(page.status).toBe(200);
    expect(page.body).toContain('go back to your terminal');
    await expect(listener.captured).resolves.toEqual({
      code: 'abc',
      state: 'st-1',
      error: undefined,
      errorDescription: undefined,
    });

    // One shot: the port is released as soon as it has what it came for.
    await expect(get(listener.port, '/callback?code=zzz')).rejects.toThrow();
  });

  it('ignores a favicon hit rather than treating it as the redirect', async () => {
    const listener = await startLoopbackListener(0, 5_000);
    const stray = await get(listener.port, '/favicon.ico');
    expect(stray.status).toBe(404);

    // Still listening — the real redirect can still land.
    const page = await get(listener.port, '/callback?code=real&state=s');
    expect(page.status).toBe(200);
    await expect(listener.captured).resolves.toMatchObject({ code: 'real' });
  });

  it('captures a denial so the operator is told why, not left waiting', async () => {
    const listener = await startLoopbackListener(0, 5_000);
    const page = await get(listener.port, '/callback?error=access_denied&error_description=nope');
    expect(page.status).toBe(400);
    await expect(listener.captured).resolves.toMatchObject({ error: 'access_denied', errorDescription: 'nope' });
  });

  it('rejects `captured` when nothing arrives before the deadline', async () => {
    const listener = await startLoopbackListener(0, 25);
    await expect(listener.captured).rejects.toThrow(/No redirect reached/);
  });

  it('refuses a port already in use, so the caller can fall back to paste', async () => {
    const first = await startLoopbackListener(0, 5_000);
    // Nothing awaits this rejection in production either — the caller catches
    // the `startLoopbackListener` rejection, not `captured`.
    first.captured.catch(() => undefined);
    await expect(startLoopbackListener(first.port, 5_000)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    first.close();
  });

  it('prints an ssh -L line with matching ports on both sides', () => {
    const line = sshTunnelCommand(8765);
    expect(line).toBe(`ssh -L 8765:127.0.0.1:8765 ${os.userInfo().username}@${os.hostname()}`);
  });
});

describe('device grant', () => {
  it("reads the device authorization response, defaulting the interval to RFC 8628's 5s", async () => {
    let body = '';
    const auth = await requestDeviceAuthorization(
      async (_url, init) => {
        body = String(init?.body);
        return response({
          device_code: 'dc-1',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://example.test/device',
          expires_in: 1800,
        });
      },
      { deviceAuthorizationEndpoint: 'https://example.test/device_authorization', clientId: 'c', scopes: 'mcp:read' },
    );

    expect(auth).toEqual({
      deviceCode: 'dc-1',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://example.test/device',
      verificationUriComplete: undefined,
      expiresInSeconds: 1800,
      intervalSeconds: 5,
    });
    expect(new URLSearchParams(body).get('scope')).toBe('mcp:read');
  });

  it('accepts the pre-RFC `verification_url` spelling', async () => {
    const auth = await requestDeviceAuthorization(
      async () => response({ device_code: 'dc', user_code: 'u', verification_url: 'https://g.test/device' }),
      { deviceAuthorizationEndpoint: 'https://g.test/da', clientId: 'c' },
    );
    expect(auth.verificationUri).toBe('https://g.test/device');
  });

  it('keeps polling through authorization_pending and backs off on slow_down', async () => {
    const slept: number[] = [];
    const replies = [
      response({ error: 'authorization_pending' }, 400),
      response({ error: 'slow_down' }, 400),
      response({ error: 'authorization_pending' }, 400),
      response({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' }),
    ];

    const token = await pollDeviceToken(
      async () => replies.shift()!,
      {
        tokenEndpoint: 'https://t.test/token',
        clientId: 'c',
        deviceCode: 'dc',
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
      { sleep: async (ms) => void slept.push(ms) },
    );

    expect(token.accessToken).toBe('at');
    // 5s, 5s, then +5s permanently after the slow_down.
    expect(slept).toEqual([5000, 5000, 10000, 10000]);
  });

  it('stops on a terminal error instead of polling forever', async () => {
    const err = await pollDeviceToken(
      async () => response({ error: 'access_denied', error_description: 'user refused' }, 400),
      {
        tokenEndpoint: 'https://t.test/token',
        clientId: 'c',
        deviceCode: 'dc',
        intervalSeconds: 1,
        expiresInSeconds: 900,
      },
      { sleep: async () => undefined },
    ).catch((e: unknown) => e);

    expect((err as OAuthTokenError).code).toBe('access_denied');
  });

  it('gives up when the device code expires', async () => {
    let now = 0;
    const err = await pollDeviceToken(
      async () => response({ error: 'authorization_pending' }, 400),
      {
        tokenEndpoint: 'https://t.test/token',
        clientId: 'c',
        deviceCode: 'dc',
        intervalSeconds: 5,
        expiresInSeconds: 10,
      },
      {
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      },
    ).catch((e: unknown) => e);

    expect((err as OAuthTokenError).code).toBe('expired_token');
  });
});
