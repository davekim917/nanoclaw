/**
 * The operations behind `ncl integrations`:
 *
 *   login     discovery → dynamic client registration → PKCE + authorize URL.
 *             Writes a `pending` row and a bundle holding the code verifier.
 *   complete  code → tokens. Refresh token to the host bundle store, access
 *             token to the OneCLI secret the container's bridge reads, secret
 *             name into the group's `container.json` so the spawn grants it.
 *   refresh   from the host sweep: an active integration inside its expiry
 *             margin gets a new access token PATCHed over the same secret.
 *
 * The host is headless and reached over ssh, so paste is the default: the
 * operator opens the URL on their own machine and pastes back the failed
 * loopback redirect. `--listen` (needs an `ssh -L` tunnel) and `--device`
 * (RFC 8628) are opt-in. Nothing here ever tries to open a browser on this host.
 */
import { getAgentGroup, getAllAgentGroups, getAllWorkgroupOnecliSecrets } from '../../db/agent-groups.js';
import {
  deleteMcpOAuthIntegration,
  getMcpOAuthIntegration,
  getMcpOAuthIntegrationByTarget,
  listMcpOAuthIntegrations,
  markMcpOAuthIntegration,
  upsertMcpOAuthIntegration,
  type McpOAuthIntegration,
} from '../../db/mcp-oauth-integrations.js';
import { readContainerConfig, updateContainerConfig } from '../../container-config.js';
import { log } from '../../log.js';
import { assertHttpsEndpoint, discoverAuthorization, type FetchLike } from './discovery.js';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  isUnrecoverableGrantError,
  OAuthTokenError,
  parseRedirectResponse,
  refreshAccessToken,
  registerClient,
  type TokenResponse,
} from './oauth-client.js';
import {
  deleteOnecliSecret,
  findOnecliSecretByName,
  putOnecliBearerSecret,
  type OnecliSecretRef,
} from './onecli-secret-writer.js';
import { pollDeviceToken, requestDeviceAuthorization } from './device.js';
import { startLoopbackListener, sshTunnelCommand } from './loopback.js';
import { createPkcePair, createState } from './pkce.js';
import { deleteMcpOAuthBundle, readMcpOAuthBundle, writeMcpOAuthBundle, type McpOAuthBundle } from './store.js';

/** Re-mint this far ahead of the stated expiry, so a container picking the value up at the edge still gets a usable token. */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/**
 * Refresh interval for a token endpoint that returned no `expires_in`: there is
 * no margin to be inside, and refreshing every tick would hammer the endpoint.
 */
export const UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Both the port in the registered redirect URI and the port `--listen` binds;
 * they must not drift, or the listener would never capture anything.
 */
const DEFAULT_LOOPBACK_PORT = 8765;

function defaultRedirectUri(port: number = DEFAULT_LOOPBACK_PORT): string {
  return `http://127.0.0.1:${port}/callback`;
}

const DEFAULT_CLIENT_NAME = 'NanoClaw';

/** Names become a bundle-store file name and a CLI argument, so they are constrained once, here. */
function assertIntegrationName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error(
      `Invalid integration name "${name}" — use lowercase letters, digits and hyphens, starting with a letter or digit (max 63).`,
    );
  }
}

/**
 * Default OneCLI bearer secret name, `<Name>-MCP-<Group>`. `--secret` overrides
 * it, which adopts an existing hand-made secret in place instead of orphaning it.
 */
function defaultBearerSecretName(integrationName: string, groupFolder: string): string {
  const titled = (s: string) =>
    s
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  return `${titled(integrationName)}-MCP-${titled(groupFolder)}`;
}

function expiryFrom(token: TokenResponse, nowMs: number): string | null {
  return token.expiresIn ? new Date(nowMs + token.expiresIn * 1000).toISOString() : null;
}

export interface LoginInput {
  name: string;
  mcpUrl: string;
  agentGroupId: string;
  scopes?: string;
  issuer?: string;
  redirectUri?: string;
  secretName?: string;
  clientName?: string;
  /** Extra authorize-endpoint parameters, e.g. `token_access_type=offline`. */
  extraAuthorizeParams?: Record<string, string>;
  /** Suppress the RFC 8707 `resource` parameter for a server that rejects it. */
  noResourceIndicator?: boolean;
  /** Opt in to the loopback listener; useful only with an `ssh -L` tunnel. */
  listen?: boolean;
  port?: number;
  /** Listener lifetime, in seconds. */
  listenTimeoutSeconds?: number;
  device?: boolean;
  /** Device-authorization endpoint for a server that advertises the grant without publishing it. */
  deviceEndpoint?: string;
}

export interface LoginResult {
  name: string;
  /** The URL a human opens. Absent in device mode, which has no redirect. */
  authorizationUrl?: string;
  state: string;
  redirectUri: string;
  scopes: string;
  bearerSecretName: string;
  tokenEndpoint: string;
  registered: 'dynamic' | 'reused';
  mode: 'paste' | 'listen' | 'device';
  /** Present when `--listen` bound a port. */
  loopback?: { port: number; sshTunnelCommand: string; timeoutSeconds: number };
  /** Present when `--listen` could NOT bind — the paste path still works. */
  loopbackError?: string;
  device?: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresInSeconds: number;
  };
}

const DEFAULT_LISTEN_TIMEOUT_SECONDS = 600;

/**
 * Lock key for a (group, MCP URL) pair, taken by `startLogin` inside the name
 * lock. Two logins under different NAMES for one target could otherwise both
 * pass the duplicate check and both register a client, leaving a stray
 * registration. `\u0000` cannot appear in a name, so keys cannot collide.
 * Deadlock-free: name is always taken before target.
 */
function targetLockKey(agentGroupId: string, mcpUrl: string): string {
  return `\u0000target\u0000${agentGroupId}\u0000${mcpUrl}`;
}

export function startLogin(input: LoginInput, fetchImpl: FetchLike = fetch): Promise<LoginResult> {
  assertIntegrationName(input.name);
  return withIntegrationLock(input.name, () =>
    withIntegrationLock(targetLockKey(input.agentGroupId, input.mcpUrl), () => startLoginLocked(input, fetchImpl)),
  );
}

async function startLoginLocked(input: LoginInput, fetchImpl: FetchLike): Promise<LoginResult> {
  const group = await getAgentGroup(input.agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${input.agentGroupId}`);

  const mcp = new URL(input.mcpUrl);
  // `--issuer` is gated inside `discoverAuthorization`, where override and discovered issuers meet.
  const discovered = await discoverAuthorization(fetchImpl, input.mcpUrl, input.issuer);

  if (discovered.codeChallengeMethods.length > 0 && !discovered.codeChallengeMethods.includes('S256')) {
    throw new Error(
      `${discovered.issuer} advertises code_challenge_methods_supported=${discovered.codeChallengeMethods.join(',')} ` +
        'but not S256. NanoClaw will not fall back to `plain`.',
    );
  }

  const existingRow = await getMcpOAuthIntegration(input.name);
  // An integration's group is IMMUTABLE: a silent move would leave the old
  // group's declaration in place, and a declared secret is granted on every
  // spawn, so the old group would keep a live (and refreshed) bearer.
  if (existingRow && existingRow.agent_group_id !== input.agentGroupId) {
    throw new Error(
      `Integration "${input.name}" belongs to agent group ${existingRow.agent_group_id}. ` +
        'An integration cannot change groups in place — the old group keeps its container.json ' +
        'declaration and would keep being granted the bearer. To move it: ' +
        `ncl integrations remove --name ${input.name}, then drop "${existingRow.bearer_secret_name}" ` +
        "from that group's container.json onecliSecrets — and from its workgroup's onecli_secrets if it " +
        'is declared there too — then log in again under the new group. Not --delete-secret: a --secret ' +
        'may name a secret other groups are granted, and deleting it takes it from all of them.',
    );
  }
  // BEFORE dynamic client registration: letting the unique-index UPSERT below
  // find the conflict would leave a registered client at the provider that no
  // row names and no provider garbage-collects.
  const conflict = await getMcpOAuthIntegrationByTarget(input.agentGroupId, input.mcpUrl);
  if (conflict && conflict.name !== input.name) {
    throw new Error(
      `Agent group ${input.agentGroupId} already has an integration for ${input.mcpUrl}: "${conflict.name}" ` +
        `(status ${conflict.status}). Re-run login under that name, or ` +
        `\`ncl integrations remove --name ${conflict.name}\` first.`,
    );
  }

  // A re-login keeps the redirect URI the client was REGISTERED with: the AS
  // rejects an exchange that does not match it. `--redirect-uri`/`--port`
  // override it, which the reuse check below turns into a re-registration.
  const redirectUri =
    input.redirectUri ??
    (input.port !== undefined ? defaultRedirectUri(input.port) : (existingRow?.redirect_uri ?? defaultRedirectUri()));
  const scopes = input.scopes ?? discovered.scopesSupported.join(' ');

  // A re-login reuses the registered client (providers do not garbage-collect
  // clients), but only while the issuer and redirect URI are unchanged and the
  // AS has not since rejected it (`invalid_client`/`unauthorized_client`,
  // recorded by the refresher) — replaying a rejected client id would look like
  // it worked and fail at the exchange.
  const previous = readMcpOAuthBundle(input.name);
  const reusable =
    previous?.clientId &&
    !previous.clientRejectedAt &&
    (!existingRow?.issuer || existingRow.issuer === discovered.issuer) &&
    (!existingRow?.redirect_uri || existingRow.redirect_uri === redirectUri);
  let clientId = reusable ? previous?.clientId : undefined;
  let clientSecret = reusable ? previous?.clientSecret : undefined;
  let registered: 'dynamic' | 'reused' = 'reused';
  if (!clientId) {
    if (!discovered.registrationEndpoint) {
      throw new Error(
        `${discovered.issuer} advertises no registration_endpoint, so NanoClaw cannot register a client for you. ` +
          'Create an OAuth app there by hand and re-run with --client-id (not yet supported), or keep using a static secret.',
      );
    }
    const client = await registerClient(fetchImpl, discovered.registrationEndpoint, {
      clientName: input.clientName ?? DEFAULT_CLIENT_NAME,
      redirectUri,
      scopes: scopes || undefined,
    });
    clientId = client.clientId;
    clientSecret = client.clientSecret;
    registered = 'dynamic';
  }

  const pkce = createPkcePair();
  const state = createState();

  const bearerSecretName = input.secretName ?? defaultBearerSecretName(input.name, group.folder);

  const bundle: McpOAuthBundle = {
    name: input.name,
    clientId,
    clientSecret,
    clientRejectedAt: undefined,
    // Keep the old refresh token until the new code is exchanged: an abandoned
    // login must not take a working integration down.
    refreshToken: reusable ? previous?.refreshToken : undefined,
    scopes: scopes || undefined,
    pending: { state, codeVerifier: pkce.verifier, startedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  };
  writeMcpOAuthBundle(bundle);

  await upsertMcpOAuthIntegration({
    name: input.name,
    agent_group_id: input.agentGroupId,
    mcp_url: input.mcpUrl,
    resource: input.noResourceIndicator ? null : (discovered.resource ?? null),
    authorization_endpoint: discovered.authorizationEndpoint,
    token_endpoint: discovered.tokenEndpoint,
    registration_endpoint: discovered.registrationEndpoint ?? null,
    issuer: discovered.issuer,
    scopes: scopes || null,
    redirect_uri: redirectUri,
    bearer_secret_name: bearerSecretName,
    // The id belongs to the NAME it was resolved for. `remove --delete-secret`
    // prefers the id, so keeping it beside a new `--secret` name would delete
    // the wrong secret; the next `complete`/refresh writes the right id.
    bearer_secret_id:
      existingRow && existingRow.bearer_secret_name === bearerSecretName ? existingRow.bearer_secret_id : null,
    host_pattern: mcp.hostname,
    path_pattern: mcp.pathname && mcp.pathname !== '/' ? mcp.pathname : null,
    // A live integration stays `active` until the exchange lands: its bearer is
    // still good, and `pending` would stop the refresher mid-login.
    status: existingRow?.status === 'active' ? 'active' : 'pending',
    status_detail: 'awaiting authorization code',
    expires_at: existingRow?.expires_at ?? null,
    last_refresh_at: existingRow?.last_refresh_at ?? null,
  });
  // A write parked by an earlier failure belongs to the grant being replaced,
  // and to the secret name the row carried then. After the upsert, so a login
  // that fails earlier has changed nothing and keeps the retry.
  pendingSecretWrites.delete(input.name);

  const base: LoginResult = {
    name: input.name,
    authorizationUrl: buildAuthorizeUrl({
      authorizationEndpoint: discovered.authorizationEndpoint,
      clientId,
      redirectUri,
      scopes: scopes || undefined,
      state,
      codeChallenge: pkce.challenge,
      resource: input.noResourceIndicator ? undefined : discovered.resource,
      extraParams: input.extraAuthorizeParams,
    }),
    state,
    redirectUri,
    scopes,
    bearerSecretName,
    tokenEndpoint: discovered.tokenEndpoint,
    registered,
    mode: 'paste',
  };

  if (input.device) {
    // `--device-endpoint` bypasses discovery's HTTPS check: over cleartext an
    // attacker owns the verification URL the operator is told to visit.
    const deviceEndpoint = input.deviceEndpoint
      ? assertHttpsEndpoint('--device-endpoint', input.deviceEndpoint)
      : discovered.deviceAuthorizationEndpoint;
    if (!deviceEndpoint) {
      const advertises = discovered.grantTypesSupported.includes('device_code');
      throw new Error(
        `${discovered.issuer} publishes no device_authorization_endpoint, so --device has nothing to call.` +
          (advertises
            ? ' Its metadata does list the `device_code` grant (Dropbox does exactly this), but RFC 8628 §4 puts the' +
              ' endpoint in metadata and this one does not — pass --device-endpoint if you know it.'
            : ' Its metadata does not list the `device_code` grant at all.') +
          ' Drop --device to use the default paste flow.',
      );
    }
    const authorization = await requestDeviceAuthorization(fetchImpl, {
      deviceAuthorizationEndpoint: deviceEndpoint,
      clientId,
      scopes: scopes || undefined,
      resource: input.noResourceIndicator ? undefined : discovered.resource,
    });
    // In the background: the operator needs the user code printed NOW.
    void pollDeviceToken(fetchImpl, {
      tokenEndpoint: discovered.tokenEndpoint,
      clientId,
      clientSecret,
      deviceCode: authorization.deviceCode,
      intervalSeconds: authorization.intervalSeconds,
      expiresInSeconds: authorization.expiresInSeconds,
      resource: input.noResourceIndicator ? undefined : discovered.resource,
    })
      .then((token) => finishInBackground(input.name, state, token))
      .catch((err: unknown) => {
        log.warn('MCP OAuth device login did not complete', { integration: input.name, err });
        // Only demote the attempt still outstanding: a late failure from a
        // superseded attempt must not drag a newer one back to `pending`.
        void withIntegrationLock(input.name, async () => {
          const current = readMcpOAuthBundle(input.name);
          if (current?.pending?.state !== state) return;
          await markMcpOAuthIntegration(input.name, {
            status: 'pending',
            status_detail: `device login failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }).catch(() => undefined);
      });

    return {
      ...base,
      authorizationUrl: undefined,
      mode: 'device',
      device: {
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        verificationUriComplete: authorization.verificationUriComplete,
        expiresInSeconds: authorization.expiresInSeconds,
      },
    };
  }

  if (!input.listen) return base;

  // Bind the port the redirect URI names; they are the same number by construction.
  const redirectPort = Number(new URL(redirectUri).port);
  const port =
    Number.isInteger(redirectPort) && redirectPort > 0 ? redirectPort : (input.port ?? DEFAULT_LOOPBACK_PORT);
  const timeoutSeconds = input.listenTimeoutSeconds ?? DEFAULT_LISTEN_TIMEOUT_SECONDS;
  try {
    const listener = await startLoopbackListener(port, timeoutSeconds * 1000);
    // In the background, like the device poll: the URL must reach the operator first.
    listener.captured
      .then((capture) =>
        // Under the lock: a later login/complete/remove may have moved
        // everything, and `assertAuthorizationCode`'s state check rejects a
        // capture from a superseded attempt.
        withIntegrationLock(input.name, async () => {
          const row = await getMcpOAuthIntegration(input.name);
          const bundle = readMcpOAuthBundle(input.name);
          if (!row || !bundle?.pending) return;
          const code = assertAuthorizationCode(capture, bundle.pending.state);
          const token = await exchangeAuthorizationCode(fetchImpl, {
            tokenEndpoint: row.token_endpoint,
            clientId: bundle.clientId,
            clientSecret: bundle.clientSecret,
            code,
            codeVerifier: bundle.pending.codeVerifier,
            redirectUri: row.redirect_uri,
            resource: row.resource ?? undefined,
          });
          await finalizeToken(row, bundle, token, { newGrant: true });
        }),
      )
      .catch((err: unknown) => {
        // Includes the ordinary timeout. Never fatal: the paste path is still open.
        log.info('MCP OAuth loopback listener closed without completing', { integration: input.name, err });
      });

    return {
      ...base,
      mode: 'listen',
      loopback: { port: listener.port, sshTunnelCommand: sshTunnelCommand(listener.port), timeoutSeconds },
    };
  } catch (err) {
    return { ...base, loopbackError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Finish a background (device) login and log the outcome. `attemptState` is
 * the attempt's identity: a late success from an attempt a newer `login`
 * replaced would otherwise install a token for the OLD client over the newer
 * grant. `login` is the only writer of `pending`, so re-reading suffices.
 */
function finishInBackground(name: string, attemptState: string, token: TokenResponse): Promise<void> {
  return withIntegrationLock(name, () => finishInBackgroundLocked(name, attemptState, token));
}

async function finishInBackgroundLocked(name: string, attemptState: string, token: TokenResponse): Promise<void> {
  const row = await getMcpOAuthIntegration(name);
  const bundle = readMcpOAuthBundle(name);
  if (!row || !bundle) return;
  if (bundle.pending?.state !== attemptState) {
    log.warn('MCP OAuth device login completed for a superseded attempt — discarded', { integration: name });
    return;
  }
  await finalizeToken(row, bundle, token, { newGrant: true });
}

export interface CompleteResult {
  name: string;
  expiresAt: string | null;
  scopes: string | null;
  secretName: string;
  secretId: string;
  grantedToGroup: boolean;
  hasRefreshToken: boolean;
}

/**
 * Everything that happens once a token is in hand, whichever flow produced it.
 *
 * ORDER IS LOAD-BEARING: the bundle is written BEFORE the fallible OneCLI call,
 * because a server that ROTATED its refresh token has already invalidated the
 * old one. The reverse failure (fresh credentials on disk, stale bearer in
 * OneCLI) is fixed by the next refresh.
 *
 * `newGrant` matters: on a refresh an omitted `refresh_token` means "keep the
 * one you have" (RFC 6749 §6); on a new grant it means there is none, and
 * falling back would resurrect the token just replaced.
 */
async function finalizeToken(
  row: McpOAuthIntegration,
  bundle: McpOAuthBundle,
  token: TokenResponse,
  options: { newGrant: boolean },
): Promise<CompleteResult> {
  const nowMs = Date.now();
  const refreshToken = options.newGrant ? token.refreshToken : (token.refreshToken ?? bundle.refreshToken);

  writeMcpOAuthBundle({
    ...bundle,
    refreshToken,
    // A grant that succeeded clears any earlier client rejection.
    clientRejectedAt: undefined,
    scopes: token.scope ?? bundle.scopes,
    pending: undefined,
    updatedAt: new Date().toISOString(),
  });

  let secret;
  try {
    secret = await putIntegrationBearer(row, token.tokenType || 'Bearer', token.accessToken);
  } catch (err) {
    // The credentials are safe on disk; only the bearer failed to land. The
    // minted token is parked in memory and the sweep retries the WRITE, not the
    // grant, on a backoff.
    rememberPendingSecretWrite(row.name, token, expiryFrom(token, nowMs));
    await markMcpOAuthIntegration(row.name, {
      status: 'error',
      // Same wording as the refresher's own write failure.
      status_detail: pendingWriteStatusDetail(row.name, err),
      expires_at: expiryFrom(token, nowMs),
      scopes: token.scope ?? row.scopes,
      last_refresh_at: new Date(nowMs).toISOString(),
    });
    throw err;
  }

  // Any parked write is superseded; retrying it would PATCH an older token over this one.
  pendingSecretWrites.delete(row.name);

  const hasRefreshToken = Boolean(refreshToken);
  await markMcpOAuthIntegration(row.name, {
    status: 'active',
    status_detail: hasRefreshToken
      ? null
      : 'no refresh token issued — this bearer expires and cannot be renewed automatically',
    expires_at: expiryFrom(token, nowMs),
    // The GRANTED set: re-sending a wider requested set on refresh reads as a
    // widening request — `invalid_scope` on a strict server, forever.
    scopes: token.scope ?? row.scopes,
    bearer_secret_id: secret.id,
    last_refresh_at: new Date(nowMs).toISOString(),
  });

  const grantedToGroup = await ensureSecretDeclared(row.agent_group_id, row.bearer_secret_name);

  log.info('MCP OAuth integration connected', {
    integration: row.name,
    agentGroupId: row.agent_group_id,
    secretName: row.bearer_secret_name,
    expiresAt: expiryFrom(token, nowMs),
    hasRefreshToken,
  });

  return {
    name: row.name,
    expiresAt: expiryFrom(token, nowMs),
    scopes: token.scope ?? row.scopes,
    secretName: row.bearer_secret_name,
    secretId: secret.id,
    grantedToGroup,
    hasRefreshToken,
  };
}

/**
 * Shared validation for a redirect, pasted or captured. A state mismatch means
 * the code came from a different request than the verifier we hold; a missing
 * state is accepted, since PKCE is the binding that matters.
 */
function assertAuthorizationCode(
  parsed: { code?: string; state?: string; error?: string; errorDescription?: string },
  expectedState: string,
): string {
  if (parsed.error) {
    throw new Error(
      `Authorization was refused: ${parsed.error}${parsed.errorDescription ? ` (${parsed.errorDescription})` : ''}`,
    );
  }
  if (!parsed.code) throw new Error('No authorization code found in the pasted value.');
  if (parsed.state !== undefined && parsed.state !== expectedState) {
    throw new Error(
      'State mismatch — the pasted redirect belongs to a different login. Re-run `ncl integrations login`.',
    );
  }
  return parsed.code;
}

/** Exchange a redirect the operator pasted back — the default path. */
export function completeLogin(
  input: { name: string; redirectResponse: string },
  fetchImpl: FetchLike = fetch,
): Promise<CompleteResult> {
  assertIntegrationName(input.name);
  return withIntegrationLock(input.name, () => completeLoginLocked(input, fetchImpl));
}

async function completeLoginLocked(
  input: { name: string; redirectResponse: string },
  fetchImpl: FetchLike,
): Promise<CompleteResult> {
  const row = await getMcpOAuthIntegration(input.name);
  if (!row) throw new Error(`No integration named "${input.name}" — run \`ncl integrations login\` first.`);
  const bundle = readMcpOAuthBundle(input.name);
  if (!bundle?.pending) {
    throw new Error(`No login in progress for "${input.name}" — re-run \`ncl integrations login\`.`);
  }

  const code = assertAuthorizationCode(parseRedirectResponse(input.redirectResponse), bundle.pending.state);

  const token = await exchangeAuthorizationCode(fetchImpl, {
    tokenEndpoint: row.token_endpoint,
    clientId: bundle.clientId,
    clientSecret: bundle.clientSecret,
    code,
    codeVerifier: bundle.pending.codeVerifier,
    redirectUri: row.redirect_uri,
    resource: row.resource ?? undefined,
  });

  return finalizeToken(row, bundle, token, { newGrant: true });
}

/**
 * Add the bearer secret to the group's `container.json` `onecliSecrets`, which
 * is what grants it: the spawn reconciles the OneCLI agent to EXACTLY that set,
 * so an undeclared secret is a 401 however fresh its value. True when added.
 */
async function ensureSecretDeclared(agentGroupId: string, secretName: string): Promise<boolean> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return false;
  // Read-only fast path: called on every refresh, and `updateContainerConfig`
  // rewrites the file unconditionally under a lock.
  if ((readContainerConfig(group.folder).onecliSecrets ?? []).includes(secretName)) return false;
  let added = false;
  await updateContainerConfig(group.folder, (config) => {
    const current = config.onecliSecrets ?? [];
    if (current.includes(secretName)) return;
    config.onecliSecrets = [...current, secretName];
    added = true;
  });
  return added;
}

/**
 * Inverse of `ensureSecretDeclared`, called only by `remove --delete-secret`
 * just before deleting the secret. `spellings` is the name and, when resolved,
 * the UUID: `onecliSecrets` accepts either, and once the secret is deleted a
 * leftover declaration in EITHER spelling aborts the spawn. True when removed.
 */
async function ensureSecretUndeclared(agentGroupId: string, spellings: string[]): Promise<boolean> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return false;
  const drop = new Set(spellings);
  // Read-only fast path, mirroring `ensureSecretDeclared`.
  if (!(readContainerConfig(group.folder).onecliSecrets ?? []).some((name) => drop.has(name))) return false;
  let removed = false;
  await updateContainerConfig(group.folder, (config) => {
    const current = config.onecliSecrets ?? [];
    const kept = current.filter((name) => !drop.has(name));
    if (kept.length === current.length) return;
    config.onecliSecrets = kept;
    removed = true;
  });
  return removed;
}

export type RefreshDecision =
  | { refresh: false; reason: 'not-active' | 'no-expiry-yet' | 'within-window' }
  | { refresh: true; reason: 'expiring' | 'expired' | 'unknown-expiry-interval' | 'retry-after-error' };

/**
 * Pure: should this row be refreshed now? `needs_login` is terminal (retrying
 * a dead refresh token every tick would bury the WARN that asked for a human);
 * `pending` has never had a token.
 */
export function decideRefresh(row: McpOAuthIntegration, nowMs: number): RefreshDecision {
  if (row.status !== 'active' && row.status !== 'error') return { refresh: false, reason: 'not-active' };

  // `error` is due every tick: it describes the last attempt, not the token's
  // clock, and the expiry window would defer the retry until the token is
  // nearly dead. Bounded: a dead grant or missing refresh token becomes `needs_login`.
  if (row.status === 'error') return { refresh: true, reason: 'retry-after-error' };

  if (!row.expires_at) {
    const lastMs = row.last_refresh_at ? Date.parse(row.last_refresh_at) : NaN;
    if (!Number.isFinite(lastMs)) return { refresh: false, reason: 'no-expiry-yet' };
    return nowMs - lastMs >= UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS
      ? { refresh: true, reason: 'unknown-expiry-interval' }
      : { refresh: false, reason: 'within-window' };
  }

  const expiresMs = Date.parse(row.expires_at);
  // Unparseable expiry counts as due; otherwise the integration never refreshes again.
  if (!Number.isFinite(expiresMs)) return { refresh: true, reason: 'expired' };
  if (expiresMs <= nowMs) return { refresh: true, reason: 'expired' };
  return expiresMs - nowMs <= REFRESH_MARGIN_MS
    ? { refresh: true, reason: 'expiring' }
    : { refresh: false, reason: 'within-window' };
}

/**
 * Serializes every mutation of one integration: its row, bundle file and
 * OneCLI secret must move together. Without it, a refresh awaiting the token
 * endpoint while `remove --delete-secret` runs would re-write the bundle and
 * recreate the vault secret, which the untouched declaration would then grant
 * on the next spawn. In-process suffices: the host is one Node process.
 */
const integrationLocks = new Map<string, Promise<unknown>>();

async function withIntegrationLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const previous = integrationLocks.get(name) ?? Promise.resolve();
  // Run whether the predecessor settled or threw, so one failure cannot wedge the chain.
  const run = previous.then(fn, fn);
  const guarded = run.then(
    () => undefined,
    () => undefined,
  );
  integrationLocks.set(name, guarded);
  try {
    return await run;
  } finally {
    if (integrationLocks.get(name) === guarded) integrationLocks.delete(name);
  }
}

/** First retry one tick later; doubling, capped. */
export const SECRET_WRITE_RETRY_BASE_MS = 60 * 1000;
export const SECRET_WRITE_RETRY_MAX_MS = 15 * 60 * 1000;

export function secretWriteRetryDelayMs(attempts: number): number {
  const doubled = SECRET_WRITE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(doubled, SECRET_WRITE_RETRY_MAX_MS);
}

/**
 * An access token that was MINTED but could not be written to the OneCLI
 * secret. Held in memory, never in the bundle store, which must not yield a
 * currently-working token; a host restart just means a full refresh next sweep.
 */
interface ParkedSecretWrite {
  accessToken: string;
  tokenType: string;
  scope: string | null;
  /** Expiry of THIS access token, so a token the outage outlived is dropped. */
  expiresAt: string | null;
  /** When the token was issued: the only clock for a token with no `expires_in`. */
  mintedAtMs: number;
  attempts: number;
  nextAttemptAtMs: number;
}

const pendingSecretWrites = new Map<string, ParkedSecretWrite>();

function rememberPendingSecretWrite(
  name: string,
  token: TokenResponse,
  expiresAt: string | null,
  mintedAtMs: number = Date.now(),
): void {
  const attempts = (pendingSecretWrites.get(name)?.attempts ?? 0) + 1;
  pendingSecretWrites.set(name, {
    accessToken: token.accessToken,
    tokenType: token.tokenType || 'Bearer',
    scope: token.scope ?? null,
    expiresAt,
    mintedAtMs,
    attempts,
    nextAttemptAtMs: Date.now() + secretWriteRetryDelayMs(attempts),
  });
}

function pendingWriteStatusDetail(name: string, err: unknown): string {
  const parked = pendingSecretWrites.get(name);
  const wait = parked ? Math.round(secretWriteRetryDelayMs(parked.attempts) / 1000) : 0;
  return (
    `token minted but the OneCLI secret write failed: ${err instanceof Error ? err.message : String(err)} ` +
    `(attempt ${parked?.attempts ?? 1}; retrying the write in ~${wait}s, not the grant)`
  );
}

/**
 * True once the parked token is too close to its expiry to be worth writing
 * (same margin the refresher uses, so a fresh grant replaces it without a gap).
 * A token with no stated expiry is bounded by the unknown-expiry interval;
 * "never spent" would park it forever and write a dead bearer after a long outage.
 */
function parkedTokenIsSpent(parked: ParkedSecretWrite, nowMs: number): boolean {
  if (!parked.expiresAt) return nowMs - parked.mintedAtMs >= UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS;
  const expiresMs = Date.parse(parked.expiresAt);
  if (!Number.isFinite(expiresMs)) return true;
  return expiresMs - nowMs <= REFRESH_MARGIN_MS;
}

function putIntegrationBearer(
  row: McpOAuthIntegration,
  tokenType: string,
  accessToken: string,
): Promise<OnecliSecretRef> {
  return putOnecliBearerSecret(
    {
      name: row.bearer_secret_name,
      hostPattern: row.host_pattern,
      pathPattern: row.path_pattern,
      headerName: 'Authorization',
      valueFormat: `${tokenType} {value}`,
    },
    accessToken,
  );
}

/** Retry ONLY the vault write, with the token that was already minted. */
async function retryPendingSecretWrite(
  row: McpOAuthIntegration,
  parked: ParkedSecretWrite,
  outcome: RefreshOutcome,
): Promise<void> {
  try {
    const secret = await putIntegrationBearer(row, parked.tokenType, parked.accessToken);
    pendingSecretWrites.delete(row.name);
    await markMcpOAuthIntegration(row.name, {
      status: 'active',
      status_detail: null,
      expires_at: parked.expiresAt,
      scopes: parked.scope ?? row.scopes,
      bearer_secret_id: secret.id,
      // The MINT time, not now: the unknown-expiry interval is measured from this column.
      last_refresh_at: new Date(parked.mintedAtMs).toISOString(),
    });
    // Same tail as `finalizeToken`: an undeclared bearer is never granted.
    await ensureSecretDeclared(row.agent_group_id, row.bearer_secret_name);
    outcome.refreshed.push(row.name);
    log.info('MCP OAuth bearer write recovered', {
      integration: row.name,
      attempts: parked.attempts,
      expiresAt: parked.expiresAt,
    });
  } catch (err) {
    rememberPendingSecretWrite(
      row.name,
      { accessToken: parked.accessToken, tokenType: parked.tokenType, scope: parked.scope ?? undefined },
      parked.expiresAt,
      parked.mintedAtMs,
    );
    await markMcpOAuthIntegration(row.name, {
      status: 'error',
      status_detail: pendingWriteStatusDetail(row.name, err),
    });
    outcome.failed.push(row.name);
    log.warn('MCP OAuth bearer write still failing — backing off', {
      integration: row.name,
      attempts: pendingSecretWrites.get(row.name)?.attempts,
      err,
    });
  }
}

/** Warn once per integration needing a human; cleared when the row leaves `needs_login`. */
const warnedNeedsLogin = new Set<string>();

export function _resetMcpOAuthWarnStateForTesting(): void {
  warnedNeedsLogin.clear();
  pendingSecretWrites.clear();
}

export interface RefreshOutcome {
  checked: number;
  refreshed: string[];
  failed: string[];
  needsLogin: string[];
}

/**
 * Refresh every integration inside its margin, once per sweep tick. One
 * failure never stops the others; a transient one leaves the row in `error`.
 */
export async function refreshExpiringMcpOAuthIntegrations(fetchImpl: FetchLike = fetch): Promise<RefreshOutcome> {
  const rows = await listMcpOAuthIntegrations();
  const outcome: RefreshOutcome = { checked: 0, refreshed: [], failed: [], needsLogin: [] };
  const now = Date.now();

  for (const listed of rows) {
    if (listed.status !== 'needs_login') warnedNeedsLogin.delete(listed.name);
    // Cheap admission on the snapshot; the decision that counts is re-taken under the lock.
    if (!decideRefresh(listed, now).refresh) continue;
    await withIntegrationLock(listed.name, () => refreshOne(listed.name, outcome, fetchImpl));
  }

  return outcome;
}

/** Refresh one integration under its lock, re-reading the row (gone = removed while queued). */
async function refreshOne(name: string, outcome: RefreshOutcome, fetchImpl: FetchLike): Promise<void> {
  const row = await getMcpOAuthIntegration(name);
  if (!row) return;

  // RE-DECIDED under the lock: acting on the snapshot's decision lets two passes
  // refresh the same integration, and the second sends a refresh token the
  // first already rotated away — a forced human re-login.
  const decision = decideRefresh(row, Date.now());
  if (!decision.refresh) return;
  outcome.checked++;

  // A minted token awaiting its vault write: do NOT call the token endpoint
  // again, which would burn a refresh-token rotation per tick while the vault is down.
  const parked = pendingSecretWrites.get(row.name);
  if (parked) {
    if (parkedTokenIsSpent(parked, Date.now())) {
      // Outlived by the outage: drop it and fall through to a fresh grant.
      pendingSecretWrites.delete(row.name);
    } else if (Date.now() < parked.nextAttemptAtMs) {
      return;
    } else {
      await retryPendingSecretWrite(row, parked, outcome);
      return;
    }
  }

  const bundle = readMcpOAuthBundle(row.name);
  if (!bundle?.refreshToken) {
    if (!warnedNeedsLogin.has(row.name)) {
      warnedNeedsLogin.add(row.name);
      log.warn('MCP OAuth integration has no refresh token — re-login required', {
        integration: row.name,
        agentGroupId: row.agent_group_id,
        mcpUrl: row.mcp_url,
      });
    }
    await markMcpOAuthIntegration(row.name, {
      status: 'needs_login',
      status_detail: 'no refresh token on file — run `ncl integrations login`',
    });
    outcome.needsLogin.push(row.name);
    return;
  }

  try {
    const token = await refreshAccessToken(fetchImpl, {
      tokenEndpoint: row.token_endpoint,
      clientId: bundle.clientId,
      clientSecret: bundle.clientSecret,
      refreshToken: bundle.refreshToken,
      scopes: row.scopes ?? undefined,
      resource: row.resource ?? undefined,
    });

    // Refresh-token ROTATION lands on disk FIRST, before the fallible OneCLI
    // write (see `finalizeToken`). An omitted `refresh_token` on a refresh means
    // "keep the one you have" (RFC 6749 §6), so the fallback is correct HERE.
    writeMcpOAuthBundle({
      ...bundle,
      refreshToken: token.refreshToken ?? bundle.refreshToken,
      scopes: token.scope ?? bundle.scopes,
      updatedAt: new Date().toISOString(),
    });

    let secret;
    try {
      secret = await putIntegrationBearer(row, token.tokenType || 'Bearer', token.accessToken);
    } catch (err) {
      // Park the minted token and let the backoff own the retry; the generic
      // handler would re-hit the token endpoint every tick while the gateway is down.
      rememberPendingSecretWrite(row.name, token, expiryFrom(token, Date.now()));
      await markMcpOAuthIntegration(row.name, {
        status: 'error',
        status_detail: pendingWriteStatusDetail(row.name, err),
      });
      outcome.failed.push(row.name);
      log.warn('MCP OAuth bearer write failed — token is minted, retrying the write only', {
        integration: row.name,
        attempts: pendingSecretWrites.get(row.name)?.attempts,
        err,
      });
      return;
    }

    pendingSecretWrites.delete(row.name);

    await markMcpOAuthIntegration(row.name, {
      status: 'active',
      status_detail: null,
      expires_at: expiryFrom(token, Date.now()),
      // Track any narrowing the server applied (see `finalizeToken`).
      scopes: token.scope ?? row.scopes,
      bearer_secret_id: secret.id,
      last_refresh_at: new Date().toISOString(),
    });
    // Re-declare on every refresh: a declaration that failed in `finalizeToken`
    // would otherwise never be retried. Logged, not rethrown: the bearer is in
    // the vault, and `error` would force a fresh grant per tick for a config problem.
    try {
      await ensureSecretDeclared(row.agent_group_id, row.bearer_secret_name);
    } catch (err) {
      log.warn('MCP OAuth bearer refreshed but declaring it in container.json failed', {
        integration: row.name,
        secretName: row.bearer_secret_name,
        err,
      });
    }
    outcome.refreshed.push(row.name);
    log.info('MCP OAuth access token refreshed', {
      integration: row.name,
      reason: decision.reason,
      expiresAt: expiryFrom(token, Date.now()),
      rotatedRefreshToken: Boolean(token.refreshToken && token.refreshToken !== bundle.refreshToken),
    });
  } catch (err) {
    if (isUnrecoverableGrantError(err)) {
      // `invalid_client`/`unauthorized_client` condemn the REGISTRATION: record
      // it so the next login re-registers instead of replaying refused credentials.
      if (err instanceof OAuthTokenError && err.code !== 'invalid_grant') {
        writeMcpOAuthBundle({ ...bundle, clientRejectedAt: new Date().toISOString() });
      }
      await markMcpOAuthIntegration(row.name, {
        status: 'needs_login',
        status_detail: `token endpoint rejected the grant: ${err instanceof Error ? err.message : String(err)}`,
      });
      outcome.needsLogin.push(row.name);
      if (!warnedNeedsLogin.has(row.name)) {
        warnedNeedsLogin.add(row.name);
        log.warn('MCP OAuth refresh token rejected — re-login required', {
          integration: row.name,
          agentGroupId: row.agent_group_id,
          mcpUrl: row.mcp_url,
          err,
        });
      }
      return;
    }
    await markMcpOAuthIntegration(row.name, {
      status: 'error',
      status_detail: err instanceof Error ? err.message : String(err),
    });
    outcome.failed.push(row.name);
    log.warn('MCP OAuth refresh failed — will retry next sweep', { integration: row.name, err });
  }
}

export interface RemoveResult {
  name: string;
  removedRow: boolean;
  removedBundle: boolean;
  removedSecret: boolean;
  /** Whether `--delete-secret` was asked for; only then is the declaration touched. */
  deleteSecretRequested: boolean;
  /** True when this call dropped the bearer from the owning group's `onecliSecrets`. */
  undeclaredSecret: boolean;
  secretName: string | null;
}

/**
 * Forget an integration. The OneCLI secret is left alone unless `deleteSecret`
 * is asked for: it may be hand-made, and a delete is unrecoverable from here.
 *
 * `deleteSecret` is SUBTRACTIVE-OR-NOTHING: it refuses unless the owning
 * group's own `container.json` is the only thing still declaring the bearer,
 * then undeclares it there and deletes the secret. The spawn takes the UNION of
 * workgroup and group declarations, so deleting a secret anything else still
 * names would abort every spawn that inherits it.
 *
 * The undeclare happens here, under the per-name lock the refresher also takes,
 * because a refresh re-declares the bearer. Plain `remove` leaves declarations
 * alone: an undeclared secret the operator still wants would be a 401.
 */
export function removeIntegration(name: string, options: { deleteSecret?: boolean } = {}): Promise<RemoveResult> {
  assertIntegrationName(name);
  return withIntegrationLock(name, () => removeIntegrationLocked(name, options));
}

/** One thing that still depends on the bearer, for the refusal to name. */
interface SecretDeclarationSite {
  where: string;
  fix: string;
  /** The spelling found there: the name, or the secret's vault UUID. */
  declared: string;
}

/**
 * Everything still depending on this bearer that `--delete-secret` cannot fix
 * itself; empty means the delete may proceed:
 *
 *   1. any workgroup's `onecli_secrets`, including the owner's own (the merge
 *      is union-only);
 *   2. any OTHER group's `container.json`;
 *   3. any other integration in this group sharing the same `--secret` (the
 *      UNIQUE index is on (agent_group_id, mcp_url), not the secret), whose
 *      next refresh would self-heal only hours later.
 *
 * Sources 1-2 match both spellings (name or vault UUID). Group files are read
 * with `readContainerConfig`, as the spawn path does, so the scan cannot refuse
 * on declarations the spawn never sees. The millisecond window between this
 * scan and the delete is deliberately left open: closing it would mean locking
 * every group's config across a vault round-trip.
 */
async function findForeignSecretDeclarations(
  ownerGroupId: string,
  integrationName: string,
  spellings: string[],
): Promise<SecretDeclarationSite[]> {
  const wanted = new Set(spellings);
  const sites: SecretDeclarationSite[] = [];
  for (const workgroup of await getAllWorkgroupOnecliSecrets()) {
    for (const declared of workgroup.secrets) {
      if (!wanted.has(declared)) continue;
      sites.push({
        where: `workgroup ${workgroup.id} (workgroups.onecli_secrets) declares "${declared}"`,
        fix: `pnpm exec tsx scripts/set-workgroup-secrets.ts ${workgroup.id} --secrets <the list without "${declared}">`,
        declared,
      });
    }
  }
  for (const group of await getAllAgentGroups()) {
    if (group.id === ownerGroupId) continue;
    for (const declared of readContainerConfig(group.folder).onecliSecrets ?? []) {
      if (!wanted.has(declared)) continue;
      sites.push({
        where: `agent group ${group.id} (groups/${group.folder}/container.json onecliSecrets) declares "${declared}"`,
        fix: `remove "${declared}" from groups/${group.folder}/container.json`,
        declared,
      });
    }
  }
  for (const other of await listMcpOAuthIntegrations()) {
    if (other.name === integrationName) continue;
    if (!wanted.has(other.bearer_secret_name)) continue;
    sites.push({
      where: `integration ${other.name} (agent group ${other.agent_group_id}) uses "${other.bearer_secret_name}" as its bearer`,
      fix: `remove it too, or re-run its login with a different --secret`,
      declared: other.bearer_secret_name,
    });
  }
  return sites;
}

async function removeIntegrationLocked(name: string, options: { deleteSecret?: boolean }): Promise<RemoveResult> {
  const row = await getMcpOAuthIntegration(name);
  const deleteSecretRequested = Boolean(options.deleteSecret);
  let removedSecret = false;
  let undeclaredSecret = false;
  if (deleteSecretRequested && row) {
    const ref = row.bearer_secret_id
      ? { id: row.bearer_secret_id, name: row.bearer_secret_name }
      : await findOnecliSecretByName(row.bearer_secret_name);
    const spellings = [row.bearer_secret_name, ...(ref ? [ref.id] : [])];
    // REFUSE BEFORE ANYTHING IS TOUCHED if anything this call cannot edit still
    // depends on the bearer (see `findForeignSecretDeclarations`).
    const foreign = await findForeignSecretDeclarations(row.agent_group_id, name, spellings);
    if (foreign.length > 0) {
      log.error('MCP OAuth remove --delete-secret refused: the bearer is still in use outside this group', {
        integration: name,
        agentGroupId: row.agent_group_id,
        secretName: row.bearer_secret_name,
        sites: foreign.map((site) => site.where),
      });
      throw new Error(
        `Refusing to delete "${row.bearer_secret_name}": ${foreign.length} other place(s) this command cannot edit ` +
          `still depend on it, and deleting it would break them. Nothing was deleted.\n` +
          foreign.map((site) => `  - ${site.where} — ${site.fix}`).join('\n') +
          `\nClear those first, then run this again. To end the integration without touching the secret, use ` +
          `\`ncl integrations remove --name ${name}\` on its own.`,
      );
    }
    // UNDECLARE FIRST, and abort the whole removal if it fails: a declaration of
    // a deleted secret fails EVERY spawn closed, while a failed undeclare here
    // leaves the integration untouched and a re-run recovers.
    try {
      undeclaredSecret = await ensureSecretUndeclared(row.agent_group_id, spellings);
    } catch (err) {
      log.error('MCP OAuth remove --delete-secret aborted: could not undeclare the bearer in container.json', {
        integration: name,
        agentGroupId: row.agent_group_id,
        secretName: row.bearer_secret_name,
        err,
      });
      throw new Error(
        `Could not remove "${row.bearer_secret_name}" from the onecliSecrets of agent group ${row.agent_group_id}: ` +
          `${err instanceof Error ? err.message : String(err)}. Nothing was deleted — the integration, its bearer ` +
          `secret and the declaration are all untouched. Fix the container.json write and run the same command again.`,
        { cause: err },
      );
    }
    if (ref) {
      // The declaration is already gone, so a failure here leaves only an inert
      // orphan secret (named in the error) and the row, so a retry resolves it again.
      removedSecret = await deleteOnecliSecret(ref.id);
    }
  }
  pendingSecretWrites.delete(name);
  const removedBundle = deleteMcpOAuthBundle(name);
  const removedRow = await deleteMcpOAuthIntegration(name);
  return {
    name,
    removedRow,
    removedBundle,
    removedSecret,
    deleteSecretRequested,
    undeclaredSecret,
    secretName: row?.bearer_secret_name ?? null,
  };
}
