/**
 * The three operations behind `ncl integrations`: start a login, complete one,
 * and keep an active integration's bearer alive.
 *
 * The shape of the whole thing, once:
 *
 *   login     discovery → dynamic client registration → PKCE + authorize URL.
 *             Writes a `pending` row and a bundle holding the code verifier.
 *             Prints a URL for a human to open. No token exists yet.
 *   complete  code → token endpoint → access + refresh token. Refresh token to
 *             the host bundle store, access token to the OneCLI secret the
 *             container's bridge already reads, secret name into the group's
 *             `container.json` so the spawn path grants it.
 *   refresh   once a minute from the host sweep: any active integration inside
 *             its expiry margin gets a new access token PATCHed over the same
 *             OneCLI secret. The container never restarts; the gateway injects
 *             the new value on the next request.
 *
 * THREE WAYS IN, AND WHY PASTE IS THE DEFAULT. This host is headless and the
 * operator reaches it over ssh, so there is no browser here to redirect into.
 *
 *   paste (default)  `login` prints a URL; the operator opens it on their own
 *                    machine, the redirect fails to load on a loopback port
 *                    nothing is listening on, and the address bar holds the
 *                    code. `complete --redirect-url '<that URL>'` finishes it.
 *                    Works from anywhere, needs no tunnel, and a login happens
 *                    once per integration — so this is the one that is not
 *                    opt-in.
 *   --listen         Binds 127.0.0.1:8765 here and completes by itself IF the
 *                    operator has forwarded the port (`ssh -L 8765:127.0.0.1:8765`).
 *                    A convenience; the paste path stays open alongside it, and
 *                    a port that will not bind degrades to a warning.
 *   --device         RFC 8628, where the server publishes the endpoint for it.
 *                    No redirect at all — a user code and a URL. Neither first
 *                    target publishes the endpoint; see `device.ts`.
 *
 * Nothing here ever tries to open a browser on this host: no `xdg-open`, no
 * `$DISPLAY`, no `BROWSER`.
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
import { deleteOnecliSecret, findOnecliSecretByName, putOnecliBearerSecret } from './onecli-secret-writer.js';
import { pollDeviceToken, requestDeviceAuthorization } from './device.js';
import { startLoopbackListener, sshTunnelCommand } from './loopback.js';
import { createPkcePair, createState } from './pkce.js';
import { deleteMcpOAuthBundle, readMcpOAuthBundle, writeMcpOAuthBundle, type McpOAuthBundle } from './store.js';

/** Re-mint this far ahead of the stated expiry — same margin as the GitHub App
 *  installation token (`src/github-app-token.ts:24`), for the same reason: a
 *  container that picks the value up at the edge of the window must still get
 *  a token that outlives its first few calls. */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/**
 * How often to refresh an integration whose token endpoint returned no
 * `expires_in`. Without a stated expiry there is no margin to be inside, and
 * refreshing every tick would hammer the endpoint; twelve hours keeps a
 * silently-short token from outliving its usefulness by more than that while
 * costing two requests a day.
 */
export const UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * The documented loopback port. It serves two purposes at once and they must
 * not drift apart: it is the port in the redirect URI the authorization server
 * is told about, and the port `--listen` binds here. A redirect URI pointing at
 * one port while the listener sits on another would look like it worked and
 * never capture anything.
 */
export const DEFAULT_LOOPBACK_PORT = 8765;

export function defaultRedirectUri(port: number = DEFAULT_LOOPBACK_PORT): string {
  return `http://127.0.0.1:${port}/callback`;
}

const DEFAULT_CLIENT_NAME = 'NanoClaw';

/**
 * Integration names become a file name in the bundle store and a `--name`
 * argument everywhere else, so they are constrained once, here, rather than
 * escaped at each use.
 */
export function assertIntegrationName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error(
      `Invalid integration name "${name}" — use lowercase letters, digits and hyphens, starting with a letter or digit (max 63).`,
    );
  }
}

/**
 * Deterministic default for the OneCLI bearer secret: `<Name>-MCP-<Group>`.
 * Only a DEFAULT — `--secret` overrides it, which is how a secret that already
 * exists (one a human made before this command did) gets adopted in place
 * instead of orphaned beside a new one.
 */
export function defaultBearerSecretName(integrationName: string, groupFolder: string): string {
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
  /**
   * Opt in to the loopback listener. Off by default — see the flow note at the
   * top of this file. Requires an `ssh -L` tunnel to be useful.
   */
  listen?: boolean;
  /** Loopback port; only meaningful with `listen`. */
  port?: number;
  /** How long the listener stays up, in seconds. */
  listenTimeoutSeconds?: number;
  /** Opt in to the RFC 8628 device grant, where the server publishes one. */
  device?: boolean;
  /** Device-authorization endpoint override for a server that advertises the
   *  grant without publishing the endpoint (Dropbox). */
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
  /** Present in device mode. */
  device?: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresInSeconds: number;
  };
}

/** How long an opt-in loopback listener stays up by default. */
export const DEFAULT_LISTEN_TIMEOUT_SECONDS = 600;

/**
 * Lock key for a (group, MCP URL) pair, held ONLY by `startLogin` and only
 * inside the name lock.
 *
 * #905 review P2: the name lock does not serialize two logins that use
 * different NAMES for the same target, so both could pass the duplicate check
 * below, both dynamically register a client, and only the second fail at the
 * unique index — leaving exactly the stray registration the check exists to
 * prevent. Covering the check, the registration and the upsert with a
 * target-scoped lock is what makes that check mean anything under concurrency.
 *
 * `\u0000` cannot appear in a name (`assertIntegrationName` allows
 * `[a-z0-9-]`), so a target key can never collide with one. Deadlock-free by
 * ordering: name is always taken before target, and nothing else in this module
 * takes two locks at all.
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
  // `--issuer` is NOT checked here: `discoverAuthorization` gates whichever
  // issuer it is about to fetch from, override or discovered, which is the one
  // place both arrive at (see `assertHttpsEndpoint`).
  const discovered = await discoverAuthorization(fetchImpl, input.mcpUrl, input.issuer);

  if (discovered.codeChallengeMethods.length > 0 && !discovered.codeChallengeMethods.includes('S256')) {
    throw new Error(
      `${discovered.issuer} advertises code_challenge_methods_supported=${discovered.codeChallengeMethods.join(',')} ` +
        'but not S256. NanoClaw will not fall back to `plain`.',
    );
  }

  const existingRow = await getMcpOAuthIntegration(input.name);
  // An integration's group is IMMUTABLE. Silently moving `agent_group_id` would
  // point `complete` at the new group's `container.json` while leaving the old
  // group's declaration in place, and a declared secret is granted on every
  // spawn (`src/onecli-secrets.ts:517`) — so the old group would keep a live
  // bearer, and on a shared `--secret` would keep receiving refreshed ones. The
  // two-step path is explicit about what it leaves behind, which a silent move
  // is not.
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
  // BEFORE dynamic client registration, not after: the unique index on
  // (agent_group_id, mcp_url) (migration 082:66) is enforced by the UPSERT far
  // below, and by then `registerClient` has already minted a client at the
  // provider. That client would be unreachable — no row and no bundle name it —
  // and no provider in this flow garbage-collects one. Letting the INSERT
  // discover the conflict costs a permanent stray registration per attempt.
  const conflict = await getMcpOAuthIntegrationByTarget(input.agentGroupId, input.mcpUrl);
  if (conflict && conflict.name !== input.name) {
    throw new Error(
      `Agent group ${input.agentGroupId} already has an integration for ${input.mcpUrl}: "${conflict.name}" ` +
        `(status ${conflict.status}). Re-run login under that name, or ` +
        `\`ncl integrations remove --name ${conflict.name}\` first.`,
    );
  }

  // A re-login keeps the redirect URI the client was REGISTERED with, because
  // the authorization server stored that exact string and rejects an exchange
  // that does not match it. An explicit `--redirect-uri` or `--port` overrides
  // that — the operator is naming a new binding, and the reuse check below turns
  // the mismatch into a re-registration rather than an exchange that would fail.
  const redirectUri =
    input.redirectUri ??
    (input.port !== undefined ? defaultRedirectUri(input.port) : (existingRow?.redirect_uri ?? defaultRedirectUri()));
  const scopes = input.scopes ?? discovered.scopesSupported.join(' ');

  // A re-login reuses the client already registered for this name — re-running
  // dynamic registration would mint a second client at the provider on every
  // retry, and providers do not garbage-collect those. But a registration is
  // only reusable while the three things it was bound to still hold:
  //
  //   - the authorization server is the same one (a client id is issued BY an
  //     issuer and means nothing at another);
  //   - the redirect URI is the same string (the AS stored it at registration
  //     and rejects an exchange that does not match), which is why an explicit
  //     --redirect-uri or --port is a re-registration and not a silent mismatch;
  //   - the AS has not since rejected it (`invalid_client` /
  //     `unauthorized_client`, recorded by the refresher). Replaying a rejected
  //     client id is precisely the case where "just run login again" would look
  //     like it worked and fail at the exchange.
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
    // A newly registered client has never been rejected; a reused one still
    // carries whatever the refresher recorded, which is nothing (it would not
    // have been reusable otherwise).
    clientRejectedAt: undefined,
    // A re-login keeps the old refresh token until the new code is exchanged:
    // an abandoned login must not take a working integration down with it.
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
    // The id belongs to the NAME it was resolved for. A re-login that points
    // `--secret` at a different name must drop it, or the row carries the new
    // name beside the old secret's UUID — and `remove --delete-secret` prefers
    // the id over the name (`removeIntegrationLocked`), so it would delete the
    // secret the operator just stopped using and leave the one in use. The next
    // `complete`/refresh writes the correct id back (`finalizeToken`).
    bearer_secret_id:
      existingRow && existingRow.bearer_secret_name === bearerSecretName ? existingRow.bearer_secret_id : null,
    host_pattern: mcp.hostname,
    path_pattern: mcp.pathname && mcp.pathname !== '/' ? mcp.pathname : null,
    // A re-login against a live integration stays `active` until the exchange
    // lands: the bearer in OneCLI is still good, and demoting the row to
    // `pending` here would stop the refresher renewing it mid-login.
    status: existingRow?.status === 'active' ? 'active' : 'pending',
    status_detail: 'awaiting authorization code',
    expires_at: existingRow?.expires_at ?? null,
    last_refresh_at: existingRow?.last_refresh_at ?? null,
  });
  // A write parked by an earlier failure belongs to the grant this login is
  // replacing, and to the secret name the row carried then — `--secret` may
  // just have changed it. `removeIntegrationLocked` drops it for the same
  // reason. Not reachable as a stale PATCH today (a parked write always leaves
  // the row `error`, which the upsert above demotes to `pending`, which
  // `decideRefresh` skips), so this makes the invariant local instead of
  // resting on that status coupling. After the upsert, not before: a login that
  // fails earlier has changed nothing and must not discard the retry.
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
    // `--device-endpoint` bypasses discovery, so it bypassed discovery's HTTPS
    // check too: over cleartext, a network attacker owns the device response and
    // therefore the verification URL the operator is told to visit.
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
    // Polling runs in the background: the operator needs the user code printed
    // NOW, and a CLI round trip cannot print and then keep talking.
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
        // Only demote the attempt that is still outstanding. A second `login`
        // for this name mints a new `pending.state`, and a late failure from the
        // attempt it superseded must not drag a newer — possibly already
        // successful — one back to `pending`.
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

  // Bind the port the redirect URI names, not a flag read separately: they are
  // the same number by construction (see DEFAULT_LOOPBACK_PORT).
  const redirectPort = Number(new URL(redirectUri).port);
  const port =
    Number.isInteger(redirectPort) && redirectPort > 0 ? redirectPort : (input.port ?? DEFAULT_LOOPBACK_PORT);
  const timeoutSeconds = input.listenTimeoutSeconds ?? DEFAULT_LISTEN_TIMEOUT_SECONDS;
  try {
    const listener = await startLoopbackListener(port, timeoutSeconds * 1000);
    // Same reason as the device poll: the URL has to reach the operator before
    // anything can arrive on this port.
    listener.captured
      .then((capture) =>
        // Under the lock, and re-reading: by the time a redirect lands, a later
        // `login`, a `complete` or a `remove` may have moved everything. The
        // state check inside `assertAuthorizationCode` is what rejects a capture
        // from a superseded attempt.
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
        // Includes the ordinary "nobody used the tunnel" timeout. Never fatal:
        // the paste path is still open and is what the operator was told to use
        // if the redirect did not land.
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
 * Finish a background (device) login and log the outcome — nobody is waiting on
 * a return value by the time this runs.
 *
 * `attemptState` is the `pending.state` minted by the `login` that started this
 * poll, and it is the attempt's identity. A second `login` for the same name
 * overwrites the bundle with a new client, a new state and a new device code; a
 * late success from the attempt it replaced would otherwise install a token
 * minted for the OLD client over the newer grant, keyed only by name. Re-reading
 * the bundle and comparing is enough because `login` is the only writer of
 * `pending`.
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
 * Everything that happens once a token is in hand, whichever of the three
 * flows produced it. Shared so the paste, loopback and device paths cannot
 * drift in what they leave behind — the refresh token on disk, the bearer in
 * OneCLI, the row, and the group's declaration.
 *
 * ORDER IS LOAD-BEARING. The bundle is written BEFORE the OneCLI call, because
 * the OneCLI call is the fallible one (a gateway that is down, a secret that was
 * deleted underneath us) and a server that ROTATED its refresh token has already
 * invalidated the old one by the time it answered. Writing OneCLI first and
 * crashing would leave a dead token on disk and force a human login for a grant
 * that is actually alive. The reverse failure is recoverable: fresh credentials
 * on disk and a stale bearer in OneCLI, which the next refresh fixes by itself.
 *
 * `newGrant` distinguishes the two callers, and it is not cosmetic. On a REFRESH,
 * RFC 6749 §6 lets the server omit `refresh_token` to mean "keep using the one
 * you have", so falling back is required. On a NEW authorization-code grant an
 * absent refresh token means the grant has none — falling back would resurrect
 * the token that was just replaced (after an `invalid_grant` re-login, the dead
 * one), report `hasRefreshToken: true`, mark the row active, and send the very
 * next refresh straight back to `needs_login`.
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
    // A grant that succeeded clears any earlier rejection: this client id was
    // just accepted by the authorization server.
    clientRejectedAt: undefined,
    scopes: token.scope ?? bundle.scopes,
    pending: undefined,
    updatedAt: new Date().toISOString(),
  });

  let secret;
  try {
    secret = await putOnecliBearerSecret(
      {
        name: row.bearer_secret_name,
        hostPattern: row.host_pattern,
        pathPattern: row.path_pattern,
        headerName: 'Authorization',
        valueFormat: `${token.tokenType || 'Bearer'} {value}`,
      },
      token.accessToken,
    );
  } catch (err) {
    // The credentials are safe on disk; only the bearer failed to land. `error`
    // is due on the NEXT tick regardless of the expiry written here
    // (`decideRefresh`), so the sweep retries without a human. What it retries
    // is the WRITE and not the grant: the token just minted is parked in
    // memory, and the sweep re-PATCHes the secret with it on a backoff.
    rememberPendingSecretWrite(row.name, token, expiryFrom(token, nowMs));
    await markMcpOAuthIntegration(row.name, {
      status: 'error',
      // The same wording the refresher's own write failure produces, so
      // `ncl integrations list` reads the same whichever path parked the write.
      status_detail: pendingWriteStatusDetail(row.name, err),
      expires_at: expiryFrom(token, nowMs),
      scopes: token.scope ?? row.scopes,
      last_refresh_at: new Date(nowMs).toISOString(),
    });
    throw err;
  }

  // The bearer is in the vault, so any write parked by an earlier failure is
  // superseded — retrying it would PATCH an older access token over this one.
  pendingSecretWrites.delete(row.name);

  const hasRefreshToken = Boolean(refreshToken);
  await markMcpOAuthIntegration(row.name, {
    status: 'active',
    status_detail: hasRefreshToken
      ? null
      : 'no refresh token issued — this bearer expires and cannot be renewed automatically',
    expires_at: expiryFrom(token, nowMs),
    // The GRANTED set, which a server is free to narrow. The row is what the
    // refresher sends back on `scope`, and re-sending the wider set it asked for
    // reads as a request to widen the grant — `invalid_scope` on a strict
    // server, and a permanent retry loop.
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
 * Shared validation for a redirect, however it arrived (pasted, or captured by
 * the opt-in loopback listener).
 *
 * A state mismatch means this code came from a different authorization request
 * than the one whose verifier we hold, so the exchange would fail anyway —
 * failing here says why (RFC 6749 §10.12). A redirect carrying no state at all
 * is accepted: PKCE is the binding that actually matters.
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

/**
 * Exchange a redirect the operator pasted back. THE DEFAULT PATH: no tunnel, no
 * listener, no browser on this host, and it works from any machine that can
 * reach the provider. A login happens once per integration, so the simplest
 * thing that always works is the one that is not opt-in.
 */
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
 * is what actually grants it: `applyOnecliSecrets` reconciles the group's OneCLI
 * agent to EXACTLY that declared set on every spawn
 * (`src/onecli-secrets.ts:517`), so a secret missing from the file is a secret
 * the agent is not granted, however fresh its value is. That is half of today's
 * MCP failure class: the bearer secret exists in the vault, is fresh, and is
 * simply not named in that group's `container.json` — so the agent is never
 * granted it and every call comes back 401.
 *
 * Returns true when the declaration was added, false when it was already there.
 */
async function ensureSecretDeclared(agentGroupId: string, secretName: string): Promise<boolean> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return false;
  // Read-only fast path. The refresh path calls this on every successful
  // refresh, and `updateContainerConfig` rewrites the file unconditionally
  // (`src/container-config.ts:1547`, in place — `:1427`), so without this an
  // already-declared secret would cost a locked rewrite of container.json per
  // refresh. The locked read-modify-write below still decides the real answer.
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
 * The inverse of `ensureSecretDeclared`: drop these spellings of the bearer
 * from the group's `container.json` `onecliSecrets`, leaving every other
 * declaration exactly as it was. Only `remove --delete-secret` calls it, and
 * only just before deleting the secret they name (#929).
 *
 * `spellings` is the secret NAME and, when the vault ref resolved, its UUID:
 * `onecliSecrets` accepts either (`resolveSecretUuids`,
 * `src/onecli-secrets.ts:449`), `ensureSecretDeclared` only ever writes the
 * name, but an operator may have declared the UUID by hand — and once the
 * secret is deleted, a leftover declaration in EITHER spelling aborts the
 * spawn. Matching is exact, as `matchDeclarations` compares
 * (`src/onecli-secrets.ts:473`).
 *
 * Returns true when at least one declaration was removed.
 */
async function ensureSecretUndeclared(agentGroupId: string, spellings: string[]): Promise<boolean> {
  const group = await getAgentGroup(agentGroupId);
  // No group means no `container.json` to declare anything in, so there is
  // nothing to undo. Not a failure: the caller's delete is still correct.
  if (!group) return false;
  const drop = new Set(spellings);
  // Read-only fast path, the mirror of `ensureSecretDeclared`'s: a rewrite of
  // container.json takes the file lock, and an integration whose bearer was
  // never declared is the common case for a hand-made `--secret`.
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

// ─────────────────────────────────────────────────────────────────────────────
// Refresh
// ─────────────────────────────────────────────────────────────────────────────

export type RefreshDecision =
  | { refresh: false; reason: 'not-active' | 'no-expiry-yet' | 'within-window' }
  | { refresh: true; reason: 'expiring' | 'expired' | 'unknown-expiry-interval' | 'retry-after-error' };

/**
 * Pure: should this row be refreshed right now?
 *
 * `needs_login` is terminal for the refresher — the refresh token is dead, and
 * retrying it every 60 s would put a failing request to the provider on a
 * permanent loop and bury the one WARN that told the operator to act.
 * `pending` has never had a token at all.
 */
export function decideRefresh(row: McpOAuthIntegration, nowMs: number): RefreshDecision {
  if (row.status !== 'active' && row.status !== 'error') return { refresh: false, reason: 'not-active' };

  // `error` means the LAST attempt failed, which is a statement about the
  // attempt and not about the token's clock. Running it through the expiry
  // window below would defer the retry until the token it could not deliver is
  // nearly dead — about 50 minutes for a typical one-hour token, and 12 hours
  // for one the server gave no `expires_in` for. Both contradict the
  // retry-next-sweep this status exists to request. The terminal cases are
  // still bounded: a dead grant becomes `needs_login` (which returns above) and
  // a row with no refresh token on file becomes `needs_login` on its first
  // retry, so "due every tick" cannot become an unbounded loop.
  if (row.status === 'error') return { refresh: true, reason: 'retry-after-error' };

  if (!row.expires_at) {
    const lastMs = row.last_refresh_at ? Date.parse(row.last_refresh_at) : NaN;
    if (!Number.isFinite(lastMs)) return { refresh: false, reason: 'no-expiry-yet' };
    return nowMs - lastMs >= UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS
      ? { refresh: true, reason: 'unknown-expiry-interval' }
      : { refresh: false, reason: 'within-window' };
  }

  const expiresMs = Date.parse(row.expires_at);
  // An unparseable expiry is treated as due rather than ignored: the
  // alternative is an integration that silently never refreshes again.
  if (!Number.isFinite(expiresMs)) return { refresh: true, reason: 'expired' };
  if (expiresMs <= nowMs) return { refresh: true, reason: 'expired' };
  return expiresMs - nowMs <= REFRESH_MARGIN_MS
    ? { refresh: true, reason: 'expiring' }
    : { refresh: false, reason: 'within-window' };
}

/**
 * Serializes every mutation of one integration — its row, its bundle file and
 * its OneCLI secret are three stores that must move together.
 *
 * The case that needs it: a refresh reads a row and its bundle, then awaits the
 * token endpoint. `remove --delete-secret` runs in that window and deletes all
 * three. The refresh continuation then re-writes the bundle and recreates the
 * vault secret, while its own UPDATE silently matches zero rows — and because
 * `remove` deliberately leaves the group's `container.json` declaration alone,
 * `applyOnecliSecrets` grants that resurrected secret again on the next spawn
 * (`src/onecli-secrets.ts:517`). A credential that `ncl integrations list` says
 * is gone would be live.
 *
 * In-process is sufficient and is the established shape: the host is one Node
 * process and `src/onecli-secrets.ts:168` serializes its own read-modify-write
 * against the same vault the same way.
 */
const integrationLocks = new Map<string, Promise<unknown>>();

async function withIntegrationLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const previous = integrationLocks.get(name) ?? Promise.resolve();
  // Run whether the predecessor settled or threw — one failure must not wedge
  // every later operation on this integration.
  const run = previous.then(fn, fn);
  const guarded = run.then(
    () => undefined,
    () => undefined,
  );
  integrationLocks.set(name, guarded);
  try {
    return await run;
  } finally {
    // Drop the entry only when nothing queued behind us, so the map stays the
    // size of the live integrations rather than growing forever.
    if (integrationLocks.get(name) === guarded) integrationLocks.delete(name);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parked vault writes
// ─────────────────────────────────────────────────────────────────────────────

/** First retry one tick later; doubling, capped. */
export const SECRET_WRITE_RETRY_BASE_MS = 60 * 1000;
export const SECRET_WRITE_RETRY_MAX_MS = 15 * 60 * 1000;

export function secretWriteRetryDelayMs(attempts: number): number {
  const doubled = SECRET_WRITE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(doubled, SECRET_WRITE_RETRY_MAX_MS);
}

/**
 * An access token that was successfully MINTED and could not be written to the
 * OneCLI secret.
 *
 * WHY IN MEMORY AND NOT IN THE BUNDLE. The bundle store holds the credentials
 * that MINT a bearer and deliberately never the bearer itself (`store.ts`:
 * "WHAT IS NOT HERE: the ACCESS token") — a read of that directory must not
 * yield a token that works right now. Parking it in the host process keeps that
 * true. The cost is that a host restart forgets the parked write, and the next
 * sweep does a full refresh instead; that is correct, because the refresh token
 * on disk is current and a restart is not a gateway outage.
 */
interface ParkedSecretWrite {
  accessToken: string;
  tokenType: string;
  scope: string | null;
  /** Expiry of THIS access token, so a token the outage outlived is dropped. */
  expiresAt: string | null;
  /** When the token endpoint issued it. The only clock a token with no stated
   *  `expires_in` has, and what `last_refresh_at` is set from on recovery. */
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
 * True once the parked token is too close to its own expiry to be worth
 * writing. Uses the same margin the refresher admits a row on, so a token
 * dropped here is immediately replaced by a fresh grant rather than leaving a
 * gap.
 *
 * A token with no stated `expires_in` has no expiry to judge, and treating that
 * as "never spent" parked it forever (#905 review round 2): an outage longer
 * than its real lifetime would end with a dead bearer written to the vault and
 * no fresh grant ever attempted. It is bounded by the same interval the
 * refresher already uses for an unknown expiry — past that, a refresh was due
 * anyway, so nothing is lost by re-minting.
 */
function parkedTokenIsSpent(parked: ParkedSecretWrite, nowMs: number): boolean {
  if (!parked.expiresAt) return nowMs - parked.mintedAtMs >= UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS;
  const expiresMs = Date.parse(parked.expiresAt);
  if (!Number.isFinite(expiresMs)) return true;
  return expiresMs - nowMs <= REFRESH_MARGIN_MS;
}

/** Retry ONLY the vault write, with the token that was already minted. */
async function retryPendingSecretWrite(
  row: McpOAuthIntegration,
  parked: ParkedSecretWrite,
  outcome: RefreshOutcome,
): Promise<void> {
  try {
    const secret = await putOnecliBearerSecret(
      {
        name: row.bearer_secret_name,
        hostPattern: row.host_pattern,
        pathPattern: row.path_pattern,
        headerName: 'Authorization',
        valueFormat: `${parked.tokenType} {value}`,
      },
      parked.accessToken,
    );
    pendingSecretWrites.delete(row.name);
    await markMcpOAuthIntegration(row.name, {
      status: 'active',
      status_detail: null,
      expires_at: parked.expiresAt,
      scopes: parked.scope ?? row.scopes,
      bearer_secret_id: secret.id,
      // The MINT time, not now. For a token with no stated expiry
      // `decideRefresh` measures its 12-hour interval from this column, and
      // stamping it with the recovery time would hand a token that is already
      // hours old another full interval.
      last_refresh_at: new Date(parked.mintedAtMs).toISOString(),
    });
    // The same tail `finalizeToken` runs: a bearer the group does not declare
    // is a bearer the agent is never granted (`src/onecli-secrets.ts`
    // `applyOnecliSecrets`).
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

/** Warned-once set, so an integration needing a human says so on one tick, not
 *  every tick. Cleared when the row leaves `needs_login`. */
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
 * Refresh every integration inside its margin. Called once per sweep tick.
 *
 * Opportunistic, like the GitHub App re-mint it sits next to: one integration's
 * failure never stops the others, and a transient failure just leaves the row
 * in `error` to be retried on the next tick with the token it already has.
 */
export async function refreshExpiringMcpOAuthIntegrations(fetchImpl: FetchLike = fetch): Promise<RefreshOutcome> {
  const rows = await listMcpOAuthIntegrations();
  const outcome: RefreshOutcome = { checked: 0, refreshed: [], failed: [], needsLogin: [] };
  const now = Date.now();

  for (const listed of rows) {
    if (listed.status !== 'needs_login') warnedNeedsLogin.delete(listed.name);
    // Cheap admission test on the snapshot. The decision that COUNTS is taken
    // again inside the lock, against the re-read row.
    if (!decideRefresh(listed, now).refresh) continue;
    await withIntegrationLock(listed.name, () => refreshOne(listed.name, outcome, fetchImpl));
  }

  return outcome;
}

/**
 * Refresh exactly one integration, under its lock.
 *
 * The row is RE-READ here rather than taken from the listing: the listing is a
 * snapshot, and everything that could have changed it — a `complete`, a
 * `remove`, an earlier tick still finishing — holds this same lock, so the read
 * inside it is the current truth. A row that has gone means the integration was
 * removed while this tick was queued behind it, and there is nothing to do.
 */
async function refreshOne(name: string, outcome: RefreshOutcome, fetchImpl: FetchLike): Promise<void> {
  const row = await getMcpOAuthIntegration(name);
  if (!row) return;

  // RE-DECIDED HERE, not carried in from the listing. The listing was taken
  // before the lock, and everything that changes the answer — a `complete`, an
  // overlapping sweep that was queued ahead of this one, a `remove` — holds
  // this same lock. Acting on the stale decision is how two passes both refresh
  // the same integration: the first rotates the refresh token, the second sends
  // the one it read from the snapshot, and a server that rotates on every
  // refresh has already invalidated it. That costs a human re-login.
  const decision = decideRefresh(row, Date.now());
  if (!decision.refresh) return;
  outcome.checked++;

  // An earlier attempt minted a token and could not get it into the vault. The
  // token endpoint is NOT called again for it: the grant succeeded, only the
  // write failed, and re-running the grant against a server that rotates
  // refresh tokens burns a rotation per tick for a vault that is down.
  const parked = pendingSecretWrites.get(row.name);
  if (parked) {
    if (parkedTokenIsSpent(parked, Date.now())) {
      // Outlived by the outage. A dead bearer is worth nothing in the vault, so
      // stop retrying the write and fall through to a fresh grant.
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
    // write. A server that returned a new refresh token has already
    // invalidated the old one, so a crash after the secret write but before
    // this one would leave a dead token on disk and turn a live grant into a
    // forced human login. Ordered the other way round, the worst case is a
    // fresh token on disk beside a stale bearer, which the next tick fixes.
    // RFC 6749 §6 permits an omitted `refresh_token` on a refresh response and
    // it means "keep the one you have" — which is why the fallback is correct
    // HERE and wrong in `finalizeToken`'s new-grant path.
    writeMcpOAuthBundle({
      ...bundle,
      refreshToken: token.refreshToken ?? bundle.refreshToken,
      scopes: token.scope ?? bundle.scopes,
      updatedAt: new Date().toISOString(),
    });

    let secret;
    try {
      secret = await putOnecliBearerSecret(
        {
          name: row.bearer_secret_name,
          hostPattern: row.host_pattern,
          pathPattern: row.path_pattern,
          headerName: 'Authorization',
          valueFormat: `${token.tokenType || 'Bearer'} {value}`,
        },
        token.accessToken,
      );
    } catch (err) {
      // Park the minted token and let the backoff own the retry, rather than
      // falling into the generic handler below, which would leave the row due
      // on every tick and send this integration back to the token endpoint once
      // a minute for as long as the gateway is down.
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
      // Track a narrowing the server applied on this refresh, so the next one
      // asks for what it actually has (see the note in `finalizeToken`).
      scopes: token.scope ?? row.scopes,
      bearer_secret_id: secret.id,
      last_refresh_at: new Date().toISOString(),
    });
    // The same tail `finalizeToken` and `retryPendingSecretWrite` run (#911
    // item 3). `finalizeToken` marks the row `active` BEFORE it declares the
    // secret, so a declaration that failed there (container.json locked or
    // unwritable) left an active integration whose bearer the group is never
    // granted — and nothing after it ever declared it again. Its failure is
    // logged, not rethrown: the bearer is already in the vault, and falling
    // into the handler below would mark the row `error`, which is due every
    // tick (`decideRefresh`) — a fresh grant per minute for a config problem.
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
      // `invalid_client` / `unauthorized_client` condemn the REGISTRATION, not
      // just the grant. Recording that is what makes the "run login again"
      // advice true: without it the next login finds a stored clientId, skips
      // dynamic registration, and replays the credentials the server just
      // refused.
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

// ─────────────────────────────────────────────────────────────────────────────
// Remove
// ─────────────────────────────────────────────────────────────────────────────

export interface RemoveResult {
  name: string;
  removedRow: boolean;
  removedBundle: boolean;
  removedSecret: boolean;
  /** Whether `--delete-secret` was asked for. The declaration is only ever
   *  touched then, so it is what tells a formatter which line to print. */
  deleteSecretRequested: boolean;
  /** True when this call dropped the bearer from the owning group's
   *  `container.json` `onecliSecrets`. Only meaningful alongside
   *  `deleteSecretRequested`, which is the only path that reaches it — and by
   *  then no OTHER site declares it, because a site elsewhere refuses the
   *  whole call. */
  undeclaredSecret: boolean;
  secretName: string | null;
}

/**
 * Forget an integration. The OneCLI secret is left alone unless
 * `deleteSecret` is asked for: it may be one the operator made by hand and
 * other things may match on it, and an accidental delete is not recoverable
 * from here — the vault has no read-back.
 *
 * `deleteSecret` is SUBTRACTIVE-OR-NOTHING (#929). It refuses unless the
 * owning group's own `container.json` is the only place the bearer is
 * declared, and then drops it there before deleting the vault secret.
 *
 * Why a refusal and not a wider edit. A declaration lives in two kinds of
 * place, and the spawn takes their UNION: the workgroup's
 * `workgroups.onecli_secrets` and the group's own `container.json`
 * `onecliSecrets` (`mergeWorkgroupAndGroupSecrets`,
 * `src/onecli-secrets.ts:566` — "neither list can subtract from the other";
 * merged at `src/container-runner.ts:7077`). So an edit to one group's file
 * cannot take back a workgroup declaration, and it cannot touch a sibling's
 * file at all. Deleting a secret any of those still names makes
 * `resolveSecretUuids` throw (`src/onecli-secrets.ts:464`) and aborts EVERY
 * spawn that inherits it — for a workgroup-level declaration that is every
 * group in the workgroup, not just this one. Refusing keeps the property the
 * whole path is built on: either the declaration and the secret both go, or
 * nothing does.
 *
 * Why the removal does the group-level undeclare at all, rather than leaving
 * it to the operator as it used to: `refreshOne` re-declares the bearer on
 * every successful refresh (`service.ts:1210`), so a refresh between a hand
 * edit and this call re-declared the name this call was about to delete —
 * producing exactly the spawn-abort above. Both run under the same per-name
 * lock (`withIntegrationLock`, taken by `removeIntegration` and by
 * `refreshExpiringMcpOAuthIntegrations` at `service.ts:1066`), so doing it
 * here closes that window rather than narrowing it.
 *
 * Plain `remove` still leaves the declaration alone everywhere: an
 * undeclared-but-present secret is inert, but an undeclared one the operator
 * still wants granted is a 401 they did not ask for.
 */
export function removeIntegration(name: string, options: { deleteSecret?: boolean } = {}): Promise<RemoveResult> {
  assertIntegrationName(name);
  return withIntegrationLock(name, () => removeIntegrationLocked(name, options));
}

/** One place that declares the bearer, for the refusal message to name. */
interface SecretDeclarationSite {
  /** What the operator has to edit. */
  where: string;
  /** How to edit it. */
  fix: string;
  /** The spelling found there — the name, or the secret's vault UUID. */
  declared: string;
}

/**
 * Every place OTHER than `ownerGroupId`'s own `container.json` that declares
 * one of these spellings. Empty means `--delete-secret` may proceed.
 *
 * Both spellings are matched because `onecliSecrets` accepts either a name or
 * a vault UUID (`resolveSecretUuids`, `src/onecli-secrets.ts:449`), compared
 * exactly (`matchDeclarations`, `:473`) — and once the secret is gone, a
 * leftover declaration in either one aborts the spawn.
 *
 * The group files are read with `readContainerConfig` deliberately, not a
 * stricter reader: it answers `emptyConfig()` for both an absent file
 * (`src/container-config.ts:1283`) and one it cannot parse (`:1290`), and the
 * spawn path asks the same question through the same function
 * (`readContainerConfigForSpawn`, `:1310`, non-strict unless an operator
 * spawn fence is up). A scan that disagreed with the thing it is protecting
 * would refuse on declarations the spawn never sees.
 */
async function findForeignSecretDeclarations(
  ownerGroupId: string,
  spellings: string[],
): Promise<SecretDeclarationSite[]> {
  const wanted = new Set(spellings);
  const sites: SecretDeclarationSite[] = [];
  // Workgroups first, and the owner's own workgroup is NOT exempt: its
  // declaration is inherited by this group too, and nothing in this group's
  // file can subtract it.
  for (const workgroup of await getAllWorkgroupOnecliSecrets()) {
    for (const declared of workgroup.secrets) {
      if (!wanted.has(declared)) continue;
      sites.push({
        where: `workgroup ${workgroup.id} (workgroups.onecli_secrets)`,
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
        where: `agent group ${group.id} (groups/${group.folder}/container.json onecliSecrets)`,
        fix: `remove "${declared}" from groups/${group.folder}/container.json`,
        declared,
      });
    }
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
    // REFUSE BEFORE ANYTHING IS TOUCHED if the bearer is declared somewhere
    // this call cannot itself remove it from. See the note on
    // `removeIntegration`: the spawn takes the union, so deleting the secret
    // under a workgroup declaration would abort every spawn in that
    // workgroup.
    const foreign = await findForeignSecretDeclarations(row.agent_group_id, spellings);
    if (foreign.length > 0) {
      log.error('MCP OAuth remove --delete-secret refused: the bearer is declared outside this group', {
        integration: name,
        agentGroupId: row.agent_group_id,
        secretName: row.bearer_secret_name,
        sites: foreign.map((site) => site.where),
      });
      throw new Error(
        `Refusing to delete "${row.bearer_secret_name}": it is still declared in ${foreign.length} place(s) this ` +
          `command cannot edit, and deleting it would abort every spawn that inherits the declaration. Nothing was ` +
          `deleted.\n` +
          foreign.map((site) => `  - ${site.where} declares "${site.declared}" — ${site.fix}`).join('\n') +
          `\nDrop those declarations first, then run this again. To end the integration without touching the ` +
          `secret, use \`ncl integrations remove --name ${name}\` on its own.`,
      );
    }
    // UNDECLARE FIRST, and abort the whole removal if it fails. The two orders
    // fail in very different ways: declaration-then-delete leaves a group
    // declaring a secret that no longer exists, which fails EVERY spawn closed
    // and needs a hand edit to escape; delete-then-declaration leaves at worst
    // a declaration of a name that is simply not in the vault yet — and here,
    // because nothing is deleted when the undeclare throws, it leaves the
    // integration exactly as it was, so re-running the same command is the
    // whole recovery.
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
      // The declaration is already gone, so a failure here cannot produce the
      // spawn-abort shape. It leaves an orphan secret in the vault, which is
      // inert and named in the error, and the row untouched, so a retry
      // resolves the same ref again.
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
