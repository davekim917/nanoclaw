import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ContainerConfig } from './container-config.js';
import { resolveGitHubToken } from './container-runner.js';
import {
  GITHUB_APP_SENTINEL,
  clearGitHubAppTokenCache,
  isGitHubAppMintBackedOff,
  mintOrReuseGitHubAppToken,
  peekGitHubAppTokenExpiry,
  refreshExpiringGitHubAppTokens,
  resolveGitHubAppToken,
} from './github-app-token.js';

const INSTALLATION_ID = '155749655';

/** Real RSA key so the RS256 signing path actually runs. */
const keyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-app-')), 'key.pem');
fs.writeFileSync(
  keyPath,
  crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey,
);

function appEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_APP_ID: '4684388',
    GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function mintResponse(token: string, expiresInMs = 60 * 60 * 1000): Response {
  return new Response(JSON.stringify({ token, expires_at: new Date(Date.now() + expiresInMs).toISOString() }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveGitHubAppToken', () => {
  beforeEach(() => clearGitHubAppTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  it('mints a token and sends a locally-signed App JWT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mintResponse('ghs_minted'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveGitHubAppToken(appEnv())).resolves.toBe('ghs_minted');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(init.method).toBe('POST');
    const jwt = String(init.headers.authorization).replace(/^Bearer /, '');
    const [header, payload] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims.iss).toBe('4684388');
    // iat is backdated to survive clock skew.
    expect(claims.iat).toBeLessThan(Math.floor(Date.now() / 1000));
    expect(jwt.split('.')).toHaveLength(3);
  });

  it('reuses a cached token instead of minting per spawn', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mintResponse('ghs_cached'));
    vi.stubGlobal('fetch', fetchMock);

    await resolveGitHubAppToken(appEnv());
    await resolveGitHubAppToken(appEnv());
    await resolveGitHubAppToken(appEnv());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-mints once the cached token is inside the 10-minute refresh margin', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mintResponse('ghs_stale', 5 * 60 * 1000))
      .mockResolvedValueOnce(mintResponse('ghs_fresh'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveGitHubAppToken(appEnv())).resolves.toBe('ghs_stale');
    await expect(resolveGitHubAppToken(appEnv())).resolves.toBe('ghs_fresh');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['GitHub 5xx', () => vi.fn().mockResolvedValue(new Response('boom', { status: 503 }))],
    ['network error', () => vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))],
    ['garbage body', () => vi.fn().mockResolvedValue(new Response('{}', { status: 201 }))],
  ])('returns undefined (never the sentinel) on %s', async (_label, makeMock) => {
    vi.stubGlobal('fetch', makeMock());
    await expect(resolveGitHubAppToken(appEnv())).resolves.toBeUndefined();
  });

  it('returns undefined when the private key is unreadable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      resolveGitHubAppToken(appEnv({ GITHUB_APP_PRIVATE_KEY_PATH: '/nonexistent/key.pem' })),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY_PATH'])(
    'returns undefined when %s is unset',
    async (missing) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(resolveGitHubAppToken(appEnv({ [missing]: undefined }))).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('falls back to an unexpired cached token when a re-mint fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mintResponse('ghs_first', 5 * 60 * 1000))
      .mockRejectedValueOnce(new Error('GitHub is down'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveGitHubAppToken(appEnv())).resolves.toBe('ghs_first');
    // Inside the refresh margin, so this re-mints — and the mint fails.
    await expect(resolveGitHubAppToken(appEnv())).resolves.toBe('ghs_first');
  });
});

describe('resolveGitHubToken', () => {
  const cfg = {} as ContainerConfig;
  const saved = { ...process.env };

  beforeEach(() => {
    clearGitHubAppTokenCache();
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('GITHUB_')) delete process.env[k];
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('GITHUB_')) delete process.env[k];
    }
    for (const [k, v] of Object.entries(saved)) {
      if (k.startsWith('GITHUB_') && v !== undefined) process.env[k] = v;
    }
  });

  it('passes a PAT through byte-for-byte', async () => {
    process.env.GITHUB_TOKEN_GROUP_B = 'ghp_examplePatForGroupB';
    process.env.GITHUB_TOKEN = 'ghp_globalPat';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveGitHubToken('group-b', cfg)).resolves.toBe('ghp_examplePatForGroupB');
    await expect(resolveGitHubToken('some-other-group', cfg)).resolves.toBe('ghp_globalPat');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints an App token when the scoped value is the sentinel', async () => {
    process.env.GITHUB_TOKEN = 'ghp_globalPat';
    process.env.GITHUB_TOKEN_GROUP_A = GITHUB_APP_SENTINEL;
    Object.assign(process.env, appEnv());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mintResponse('ghs_mintedToken')));

    await expect(resolveGitHubToken('group-a', cfg)).resolves.toBe('ghs_mintedToken');
    // Siblings resolve through credentialFolder 'group-a', so they hit the
    // same path; other workgroups keep their PAT.
    await expect(resolveGitHubToken('group-b', cfg)).resolves.toBe('ghp_globalPat');
  });

  it('never returns the sentinel when minting fails', async () => {
    process.env.GITHUB_TOKEN_GROUP_A = GITHUB_APP_SENTINEL;
    Object.assign(process.env, appEnv());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));

    const token = await resolveGitHubToken('group-a', cfg);
    expect(token).toBeUndefined();
    expect(token).not.toBe(GITHUB_APP_SENTINEL);
  });

  it('honours container.json githubTokenEnv ahead of the scoped lookup', async () => {
    process.env.GITHUB_TOKEN_GROUP_A = GITHUB_APP_SENTINEL;
    process.env.CUSTOM_GH = 'ghp_custom';
    await expect(resolveGitHubToken('group-a', { githubTokenEnv: 'CUSTOM_GH' } as ContainerConfig)).resolves.toBe(
      'ghp_custom',
    );
  });
});

describe('mintOrReuseGitHubAppToken / peek / proactive refresh', () => {
  beforeEach(() => clearGitHubAppTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  it('returns expiry alongside the token on mint and cache hit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mintResponse('ghs_a', 30 * 60 * 1000)));
    const first = await mintOrReuseGitHubAppToken(appEnv());
    expect(first?.token).toBe('ghs_a');
    expect(new Date(first!.expiresAtMs).getTime()).toBeGreaterThan(Date.now());

    // Cache hit: no second fetch, same info.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const second = await mintOrReuseGitHubAppToken(appEnv());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(second).toEqual(first);

    // Peek sees the cache without network.
    expect(peekGitHubAppTokenExpiry(appEnv())).toBe(new Date(first!.expiresAtMs).toISOString());
    expect(peekGitHubAppTokenExpiry({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('refreshExpiringGitHubAppTokens re-mints only tokens inside the margin', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mintResponse('ghs_old', 30 * 60 * 1000)));
    await mintOrReuseGitHubAppToken(appEnv());

    // Fresh token, far from expiry: no-op, zero mints, fetch untouched.
    const idle = vi.fn();
    vi.stubGlobal('fetch', idle);
    await expect(refreshExpiringGitHubAppTokens(appEnv())).resolves.toBe(0);
    expect(idle).not.toHaveBeenCalled();

    // Force the cached token inside the refresh margin: re-mints and replaces it.
    clearGitHubAppTokenCache();
    vi.stubGlobal(
      'fetch',
      // A 5-min-life token is inside the 10-min refresh margin the moment it
      // is cached, so the sweep must re-mint it.
      vi.fn().mockResolvedValue(mintResponse('ghs_soon', 5 * 60 * 1000)),
    );
    await mintOrReuseGitHubAppToken(appEnv());
    // A 5-min-life token is already inside the 10-min refresh margin the moment
    // it is cached, so the sweep must re-mint it.
    const refreshMock = vi.fn().mockResolvedValue(mintResponse('ghs_new', 60 * 60 * 1000));
    vi.stubGlobal('fetch', refreshMock);
    await expect(refreshExpiringGitHubAppTokens(appEnv())).resolves.toBe(1);
    await expect(mintOrReuseGitHubAppToken(appEnv())).resolves.toMatchObject({ token: 'ghs_new' });
  });

  it('refreshExpiringGitHubAppTokens swallows mint failures and keeps the old token', async () => {
    clearGitHubAppTokenCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mintResponse('ghs_soon2', 5 * 60 * 1000)));
    await mintOrReuseGitHubAppToken(appEnv());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(refreshExpiringGitHubAppTokens(appEnv())).resolves.toBe(0);
    await expect(mintOrReuseGitHubAppToken(appEnv())).resolves.toMatchObject({ token: 'ghs_soon2' });
  });

  it('mintOrReuseGitHubAppToken honors the proactive backoff — no fresh mint attempt', async () => {
    // Seed a token already inside the refresh margin, then let the proactive
    // sweep fail against it once — this is what sets the backoff.
    clearGitHubAppTokenCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mintResponse('ghs_stale', 5 * 60 * 1000)));
    await mintOrReuseGitHubAppToken(appEnv());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(refreshExpiringGitHubAppTokens(appEnv())).resolves.toBe(0);
    expect(isGitHubAppMintBackedOff(INSTALLATION_ID)).toBe(true);

    // Round-1's fix already caps concurrent App-sentinel groups to one mint
    // timeout per tick via in-flight dedup — this asserts the DIFFERENT
    // problem: without the backoff check, the token-file refresh sweep still
    // fires a brand new attempt on every subsequent tick. A fresh, captured
    // fetch mock proves whether this call reaches the network at all. Only
    // Date.now is mocked (not fake timers), so AbortSignal.timeout inside the
    // real mint path — unreached here — is never at risk of hanging the test.
    const realNow = Date.now();
    const freshAttempt = vi.fn();
    vi.stubGlobal('fetch', freshAttempt);
    await expect(mintOrReuseGitHubAppToken(appEnv())).resolves.toMatchObject({ token: 'ghs_stale' });
    expect(freshAttempt).not.toHaveBeenCalled();

    // Once the unexpired-but-in-margin token itself actually expires while
    // still backed off, there is nothing to fall back to — FAIL-SAFE
    // `undefined`, still no network attempt.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 6 * 60 * 1000);
    await expect(mintOrReuseGitHubAppToken(appEnv())).resolves.toBeUndefined();
    expect(freshAttempt).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it('mintOrReuseGitHubAppToken retries once the backoff window elapses', async () => {
    clearGitHubAppTokenCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mintResponse('ghs_stale2', 5 * 60 * 1000)));
    await mintOrReuseGitHubAppToken(appEnv());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(refreshExpiringGitHubAppTokens(appEnv())).resolves.toBe(0);

    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60 * 1000 + 1);
    expect(isGitHubAppMintBackedOff(INSTALLATION_ID)).toBe(false);
    const retried = vi.fn().mockResolvedValue(mintResponse('ghs_recovered', 60 * 60 * 1000));
    vi.stubGlobal('fetch', retried);
    await expect(mintOrReuseGitHubAppToken(appEnv())).resolves.toMatchObject({ token: 'ghs_recovered' });
    expect(retried).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });
});

describe('mint dedup', () => {
  beforeEach(() => clearGitHubAppTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  it('concurrent spawn + refresh mints share one network call', async () => {
    clearGitHubAppTokenCache();
    // Seed the cache with an inside-the-margin token: now BOTH a consumer
    // resolve and the proactive sweep want to re-mint simultaneously, and
    // the in-flight map must collapse those two wants into one fetch.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mintResponse('ghs_seed', 5 * 60 * 1000)));
    await mintOrReuseGitHubAppToken(appEnv());

    const fetchMock = vi.fn(async () => mintResponse('ghs_shared', 60 * 60 * 1000));
    vi.stubGlobal('fetch', fetchMock);

    const [resolved, refreshed] = await Promise.all([
      mintOrReuseGitHubAppToken(appEnv()),
      refreshExpiringGitHubAppTokens(appEnv()),
    ]);

    expect(resolved?.token).toBe('ghs_shared');
    expect(refreshed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Settled cache now serves the shared token without further network.
    await expect(mintOrReuseGitHubAppToken(appEnv())).resolves.toMatchObject({ token: 'ghs_shared' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
