import crypto from 'crypto';
import fs from 'fs';

import { log } from './log.js';

/**
 * Sentinel value for `GITHUB_TOKEN[_<FOLDER_UPPER>]` in `.env`: "this group
 * authenticates as the GitHub App, not with a static PAT". Anything else
 * passes through untouched, so PAT-based groups are unaffected.
 *
 * Installation tokens live ~1h and the container idle ceiling is 30 min, so a
 * token minted at spawn USUALLY outlives the container it is injected into.
 * That assumption broke on 2026-08-23: a container working past one hour
 * watched its token die mid-session. A running container's env is frozen at
 * spawn, so nothing here can fix that case once it happens — what this module
 * adds is (a) `refreshExpiringGitHubAppTokens`, called from the host sweep, so
 * any RESPAWN gets a freshly minted token instead of one near death, and (b)
 * TTL surfaced through the capabilities snapshot, so an agent can tell "my
 * container's copy expired" (restart fixes it) from "the credential is dead"
 * (a human must act).
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
  refreshFailures.clear();
  mintsInFlight.clear();
}

/**
 * Expiry of the CACHED installation token, without minting or any network
 * IO. Used by the capabilities snapshot so agents can see how much life the
 * credential has; `undefined` means nothing cached yet (or PAT-based auth).
 */
export function peekGitHubAppTokenExpiry(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  if (!installationId) return undefined;
  const cached = tokenCache.get(installationId);
  return cached ? new Date(cached.expiresAtMs).toISOString() : undefined;
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
  const resolved = await mintOrReuseGitHubAppToken(env);
  return resolved?.token;
}

export interface GitHubAppTokenInfo {
  token: string;
  expiresAtMs: number;
}

/**
 * Mint (or reuse) the installation token, returning its expiry alongside the
 * secret so callers can surface TTL to agents (capabilities snapshot).
 */
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

  // In-flight dedup: a sweep refresh and a spawn mint can race on the same
  // installation. Sharing one promise means one network mint, and whichever
  // caller started first wins the cache write — no stale-over-fresh overwrite.
  try {
    return await mintWithDedup(env, installationId);
  } catch (err) {
    // A cached token inside the refresh margin but not yet expired still works
    // — strictly better than nothing while GitHub is having a bad minute.
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

/**
 * Re-mint every cached installation token that is inside its refresh margin,
 * WITHOUT a live consumer asking. Called from the host sweep so the cache
 * usually holds a fresh-margined token for the next spawn.
 *
 * SCOPE HONESTY (review finding, 2026-08-25): this does NOT and cannot fix a
 * token dying inside an already-running container — that container's env was
 * frozen at its spawn and nothing re-reads the host cache. What it fixes is
 * the respawn path: a container respawning at any moment gets a token minted
 * seconds ago, not one already 55 minutes into a 60-minute life (the on-demand
 * path would re-mint anyway, but only by paying the mint latency inline; this
 * keeps spawns fast and failures pre-warmed). Failures are logged with a
 * per-installation backoff so a persistently broken config cannot warn-spam
 * every sweep tick forever. Returns the number of tokens re-minted.
 */
const REFRESH_FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const refreshFailures = new Map<string, number>();
/** Per-installation in-flight mint promises — dedupes concurrent spawn/refresh mints. */
const mintsInFlight = new Map<string, Promise<CachedToken>>();

export async function refreshExpiringGitHubAppTokens(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (tokenCache.size === 0) return 0;
  const now = Date.now();
  let minted = 0;
  for (const installationId of tokenCache.keys()) {
    const cached = tokenCache.get(installationId);
    if (!cached || cached.expiresAtMs - REFRESH_MARGIN_MS > now) continue;
    // Backoff: a failed refresh leaves the old (still-unexpired) token in
    // place; retrying every 60s tick adds nothing until GitHub or the config
    // changes, so stand down for ten minutes after each failure.
    const lastFail = refreshFailures.get(installationId);
    if (lastFail !== undefined && now - lastFail < REFRESH_FAILURE_BACKOFF_MS) continue;
    try {
      // Same deduped path as spawn-time mints — one network mint even when
      // the sweep and a spawn race on the same installation.
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

/** Single mint implementation — both the on-demand and proactive paths call this. */
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

/**
 * Mint with per-installation in-flight dedup. A sweep refresh and a spawn
 * mint racing on the same installation share one promise and one network
 * mint; whichever caller started first wins the cache write.
 */
function mintWithDedup(env: NodeJS.ProcessEnv, installationId: string): Promise<CachedToken> {
  const inflight = mintsInFlight.get(installationId);
  if (inflight) return inflight;
  const attempt = mintInstallationToken(env, installationId).finally(() => {
    mintsInFlight.delete(installationId);
  });
  mintsInFlight.set(installationId, attempt);
  return attempt;
}
