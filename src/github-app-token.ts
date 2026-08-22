import crypto from 'crypto';
import fs from 'fs';

import { log } from './log.js';

/**
 * Sentinel value for `GITHUB_TOKEN[_<FOLDER_UPPER>]` in `.env`: "this group
 * authenticates as the GitHub App, not with a static PAT". Anything else
 * passes through untouched, so PAT-based groups are unaffected.
 *
 * Installation tokens live ~1h and the container idle ceiling is 30 min, so a
 * token minted at spawn always outlives the container it is injected into.
 */
export const GITHUB_APP_SENTINEL = 'app:github';

/** Re-mint this far ahead of the stated expiry. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** A hung mint must not hang a container spawn. */
const MINT_TIMEOUT_MS = 10_000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * In-process cache, keyed by installation id. Bounded by the number of
 * installations configured (one), so it is safe over a multi-day host run.
 */
const tokenCache = new Map<string, CachedToken>();

/** Test hook — the cache is process-global and would leak across cases. */
export function clearGitHubAppTokenCache(): void {
  tokenCache.clear();
}

/**
 * App JWT, signed locally with the private key — the key never leaves the
 * host. Mirrors the standalone minting helper kept with the install's ops scripts.
 */
function appJwt(appId: string, privateKey: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  // `iat` is backdated 60s: GitHub rejects a JWT whose iat is in the future,
  // and small clock skew between this host and GitHub is enough to trip it.
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const payload = b64({ iat: now - 60, exp: now + 540, iss: appId });
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey, 'base64url')}`;
}

/**
 * Mint (or reuse) a GitHub App installation access token.
 *
 * FAIL-SAFE: returns `undefined` rather than throwing or returning the
 * sentinel, for every failure mode — missing config, unreadable key, network
 * error, GitHub 5xx, clock skew. The caller then omits `GITHUB_TOKEN`
 * entirely: `gh`/`git` report "not authenticated" (which is true and
 * debuggable) and the container keeps working on everything else. Injecting
 * the sentinel string would produce baffling 401s; substituting a different
 * identity's PAT would silently undo the migration and mis-attribute writes.
 *
 * Note the deliberate use of global `fetch` (no proxy dispatcher): the host
 * sets no global undici dispatcher, so this bypasses the OneCLI gateway. It
 * must — the gateway overrides `authorization`, which would clobber the JWT.
 */
export async function resolveGitHubAppToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
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
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) return cached.token;

  try {
    const privateKey = fs.readFileSync(keyPath, 'utf-8');
    const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appJwt(appId, privateKey)}`,
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
    tokenCache.set(installationId, { token: body.token, expiresAtMs });
    log.info('Minted GitHub App installation token', {
      installationId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    return body.token;
  } catch (err) {
    // A cached token inside the refresh margin but not yet expired still works
    // — strictly better than nothing while GitHub is having a bad minute.
    if (cached && cached.expiresAtMs > Date.now()) {
      log.warn('GitHub App token mint failed — reusing unexpired cached token', {
        err,
        expiresAt: new Date(cached.expiresAtMs).toISOString(),
      });
      return cached.token;
    }
    log.warn('GitHub App token mint failed — omitting GITHUB_TOKEN for this spawn', { err });
    return undefined;
  }
}
