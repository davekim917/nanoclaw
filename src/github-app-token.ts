import crypto from 'crypto';
import fs from 'fs';

import { log } from './log.js';

/**
 * `GITHUB_TOKEN[_<FOLDER_UPPER>]` value meaning "authenticate as the GitHub App". Installation tokens live ~1h
 * and a running container's env is frozen at spawn, so a long-lived container can outlive its token.
 */
export const GITHUB_APP_SENTINEL = 'app:github';

const REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** A hung mint must not hang a container spawn. */
const MINT_TIMEOUT_MS = 10_000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

export function clearGitHubAppTokenCache(): void {
  tokenCache.clear();
  refreshFailures.clear();
  mintsInFlight.clear();
}

/** No network IO; `undefined` means nothing cached yet (or PAT-based auth). */
export function peekGitHubAppTokenExpiry(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  if (!installationId) return undefined;
  const cached = tokenCache.get(installationId);
  return cached ? new Date(cached.expiresAtMs).toISOString() : undefined;
}

function appJwt(appId: string, privateKey: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  // `iat` backdated 60s: GitHub rejects a future iat, and small clock skew trips it.
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const payload = b64({ iat: now - 60, exp: now + 540, iss: appId });
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey, 'base64url')}`;
}

/**
 * Fail-safe: returns `undefined` on every failure, so the caller omits `GITHUB_TOKEN` (never the sentinel, which
 * gives baffling 401s, nor another identity's PAT, which mis-attributes writes).
 * Uses global `fetch` to bypass the OneCLI gateway, which would override `authorization` and clobber the JWT.
 */
export async function resolveGitHubAppToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const resolved = await mintOrReuseGitHubAppToken(env);
  return resolved?.token;
}

export interface GitHubAppTokenInfo {
  token: string;
  expiresAtMs: number;
}

export async function mintOrReuseGitHubAppToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubAppTokenInfo | undefined> {
  const appId = env.GITHUB_APP_ID;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId || !installationId || !keyPath) {
    log.warn('GitHub App sentinel set but app config incomplete — omitting GITHUB_TOKEN', {
      hasAppId: Boolean(appId),
      hasInstallationId: Boolean(installationId),
      hasKeyPath: Boolean(keyPath),
    });
    return undefined;
  }

  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) {
    return { token: cached.token, expiresAtMs: cached.expiresAtMs };
  }

  // Backoff guards only starting a new mint (an in-flight one is always awaited), so during an outage a spawn
  // gets the fail-safe result at once instead of blocking for the full mint timeout.
  if (!mintsInFlight.has(installationId) && isGitHubAppMintBackedOff(installationId)) {
    if (cached && cached.expiresAtMs > Date.now()) {
      return { token: cached.token, expiresAtMs: cached.expiresAtMs };
    }
    return undefined;
  }

  try {
    return await mintWithDedup(env, installationId);
  } catch (err) {
    if (cached && cached.expiresAtMs > Date.now()) {
      log.warn('GitHub App token mint failed — reusing unexpired cached token', {
        err,
        expiresAt: new Date(cached.expiresAtMs).toISOString(),
      });
      return { token: cached.token, expiresAtMs: cached.expiresAtMs };
    }
    log.warn('GitHub App token mint failed — omitting GITHUB_TOKEN for this spawn', { err });
    return undefined;
  }
}

const REFRESH_FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const refreshFailures = new Map<string, number>();
const mintsInFlight = new Map<string, Promise<CachedToken>>();

export function isGitHubAppMintBackedOff(installationId: string, now: number = Date.now()): boolean {
  const lastFail = refreshFailures.get(installationId);
  return lastFail !== undefined && now - lastFail < REFRESH_FAILURE_BACKOFF_MS;
}

/**
 * Re-mints cached tokens inside their refresh margin, for the NEXT spawn: it cannot fix a token dying inside an
 * already-running container. Returns the number re-minted.
 */
export async function refreshExpiringGitHubAppTokens(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (tokenCache.size === 0) return 0;
  const now = Date.now();
  let minted = 0;
  for (const installationId of tokenCache.keys()) {
    const cached = tokenCache.get(installationId);
    if (!cached || cached.expiresAtMs - REFRESH_MARGIN_MS > now) continue;
    if (isGitHubAppMintBackedOff(installationId, now)) continue;
    try {
      const fresh = await mintWithDedup(env, installationId);
      refreshFailures.delete(installationId);
      minted += 1;
      log.info('Proactively refreshed expiring GitHub App installation token', {
        installationId,
        oldExpiresAt: new Date(cached.expiresAtMs).toISOString(),
        newExpiresAt: new Date(fresh.expiresAtMs).toISOString(),
      });
    } catch (err) {
      refreshFailures.set(installationId, now);
      log.warn('Proactive GitHub App token refresh failed — backing off 10 minutes', { err, installationId });
    }
  }
  return minted;
}

async function mintInstallationToken(env: NodeJS.ProcessEnv, installationId: string): Promise<CachedToken> {
  const privateKey = fs.readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH ?? '', 'utf-8');
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${appJwt(env.GITHUB_APP_ID ?? '', privateKey)}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== 'string' || !body.token) throw new Error('response has no token');
  const expiresAtMs = Date.parse(String(body.expires_at));
  if (!Number.isFinite(expiresAtMs)) throw new Error(`unparseable expires_at: ${String(body.expires_at)}`);
  const fresh = { token: body.token, expiresAtMs };
  tokenCache.set(installationId, fresh);
  return fresh;
}

/** Racing sweep and spawn mints share one promise, so a stale result can't overwrite a fresh one. */
function mintWithDedup(env: NodeJS.ProcessEnv, installationId: string): Promise<CachedToken> {
  const inflight = mintsInFlight.get(installationId);
  if (inflight) return inflight;
  const attempt = mintInstallationToken(env, installationId).finally(() => {
    mintsInFlight.delete(installationId);
  });
  mintsInFlight.set(installationId, attempt);
  return attempt;
}
