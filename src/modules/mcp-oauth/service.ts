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
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  deleteMcpOAuthIntegration,
  getMcpOAuthIntegration,
  listMcpOAuthIntegrations,
  markMcpOAuthIntegration,
  upsertMcpOAuthIntegration,
  type McpOAuthIntegration,
} from '../../db/mcp-oauth-integrations.js';
import { updateContainerConfig } from '../../container-config.js';
import { log } from '../../log.js';
import { discoverAuthorization, type FetchLike } from './discovery.js';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  isUnrecoverableGrantError,
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

export async function startLogin(input: LoginInput, fetchImpl: FetchLike = fetch): Promise<LoginResult> {
  assertIntegrationName(input.name);

  const group = await getAgentGroup(input.agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${input.agentGroupId}`);

  const mcp = new URL(input.mcpUrl);
  const discovered = await discoverAuthorization(fetchImpl, input.mcpUrl, input.issuer);

  if (discovered.codeChallengeMethods.length > 0 && !discovered.codeChallengeMethods.includes('S256')) {
    throw new Error(
      `${discovered.issuer} advertises code_challenge_methods_supported=${discovered.codeChallengeMethods.join(',')} ` +
        'but not S256. NanoClaw will not fall back to `plain`.',
    );
  }

  const existingRow = await getMcpOAuthIntegration(input.name);
  // A re-login keeps the redirect URI the client was REGISTERED with unless the
  // operator names a new one: the authorization server stored that exact string
  // at registration and rejects an exchange that does not match it, so silently
  // following a changed --port would break the very login it was meant to help.
  const redirectUri = input.redirectUri ?? existingRow?.redirect_uri ?? defaultRedirectUri(input.port);
  const scopes = input.scopes ?? discovered.scopesSupported.join(' ');

  // A re-login reuses the client already registered for this name. Re-running
  // dynamic registration would mint a second client at the provider on every
  // retry — providers do not garbage-collect those, and the operator would be
  // the one to notice.
  const previous = readMcpOAuthBundle(input.name);
  let clientId = previous?.clientId;
  let clientSecret = previous?.clientSecret;
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
    // A re-login keeps the old refresh token until the new code is exchanged:
    // an abandoned login must not take a working integration down with it.
    refreshToken: previous?.refreshToken,
    accessToken: previous?.accessToken,
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
    bearer_secret_id: existingRow?.bearer_secret_id ?? null,
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
    const deviceEndpoint = input.deviceEndpoint ?? discovered.deviceAuthorizationEndpoint;
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
      .then((token) => finishInBackground(input.name, token))
      .catch((err: unknown) => {
        log.warn('MCP OAuth device login did not complete', { integration: input.name, err });
        void markMcpOAuthIntegration(input.name, {
          status: 'pending',
          status_detail: `device login failed: ${err instanceof Error ? err.message : String(err)}`,
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
      .then(async (capture) => {
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
        await finalizeToken(row, bundle, token);
      })
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

/** Finish a background (device) login and log the outcome — nobody is waiting
 *  on a return value by the time this runs. */
async function finishInBackground(name: string, token: TokenResponse): Promise<void> {
  const row = await getMcpOAuthIntegration(name);
  const bundle = readMcpOAuthBundle(name);
  if (!row || !bundle) return;
  await finalizeToken(row, bundle, token);
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
 * drift in what they leave behind — the bearer in OneCLI, the refresh token on
 * disk, the row, and the group's declaration.
 */
async function finalizeToken(
  row: McpOAuthIntegration,
  bundle: McpOAuthBundle,
  token: TokenResponse,
): Promise<CompleteResult> {
  const nowMs = Date.now();
  const secret = await putOnecliBearerSecret(
    {
      name: row.bearer_secret_name,
      hostPattern: row.host_pattern,
      pathPattern: row.path_pattern,
      headerName: 'Authorization',
      valueFormat: `${token.tokenType || 'Bearer'} {value}`,
    },
    token.accessToken,
  );

  writeMcpOAuthBundle({
    ...bundle,
    // A server that issues no refresh token on the exchange leaves the previous
    // one in place rather than wiping it: for a re-login that is still the live
    // grant, and for a first login there was nothing to lose.
    refreshToken: token.refreshToken ?? bundle.refreshToken,
    accessToken: token.accessToken,
    scopes: token.scope ?? bundle.scopes,
    pending: undefined,
    updatedAt: new Date().toISOString(),
  });

  const hasRefreshToken = Boolean(token.refreshToken ?? bundle.refreshToken);
  await markMcpOAuthIntegration(row.name, {
    status: 'active',
    status_detail: hasRefreshToken
      ? null
      : 'no refresh token issued — this bearer expires and cannot be renewed automatically',
    expires_at: expiryFrom(token, nowMs),
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
export async function completeLogin(
  input: { name: string; redirectResponse: string },
  fetchImpl: FetchLike = fetch,
): Promise<CompleteResult> {
  assertIntegrationName(input.name);
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

  return finalizeToken(row, bundle, token);
}

/**
 * Add the bearer secret to the group's `container.json` `onecliSecrets`, which
 * is what actually grants it: `applyOnecliSecrets` reconciles the group's OneCLI
 * agent to EXACTLY that declared set on every spawn
 * (`src/onecli-secrets.ts:487`), so a secret missing from the file is a secret
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
  let added = false;
  await updateContainerConfig(group.folder, (config) => {
    const current = config.onecliSecrets ?? [];
    if (current.includes(secretName)) return;
    config.onecliSecrets = [...current, secretName];
    added = true;
  });
  return added;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh
// ─────────────────────────────────────────────────────────────────────────────

export type RefreshDecision =
  | { refresh: false; reason: 'not-active' | 'no-expiry-yet' | 'within-window' }
  | { refresh: true; reason: 'expiring' | 'expired' | 'unknown-expiry-interval' };

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

/** Warned-once set, so an integration needing a human says so on one tick, not
 *  every tick. Cleared when the row leaves `needs_login`. */
const warnedNeedsLogin = new Set<string>();

export function _resetMcpOAuthWarnStateForTesting(): void {
  warnedNeedsLogin.clear();
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

  for (const row of rows) {
    if (row.status !== 'needs_login') warnedNeedsLogin.delete(row.name);
    const decision = decideRefresh(row, now);
    if (!decision.refresh) continue;
    outcome.checked++;

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
      continue;
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

      const secret = await putOnecliBearerSecret(
        {
          name: row.bearer_secret_name,
          hostPattern: row.host_pattern,
          pathPattern: row.path_pattern,
          headerName: 'Authorization',
          valueFormat: `${token.tokenType || 'Bearer'} {value}`,
        },
        token.accessToken,
      );

      // Refresh-token ROTATION: a server that returns a new refresh token has
      // invalidated the old one, so the store has to move before the next tick
      // or the integration locks itself out. Written before the DB row for the
      // same reason — a crash between the two leaves a usable token on disk and
      // a stale expiry, which the next tick fixes, rather than the reverse.
      writeMcpOAuthBundle({
        ...bundle,
        refreshToken: token.refreshToken ?? bundle.refreshToken,
        accessToken: token.accessToken,
        scopes: token.scope ?? bundle.scopes,
        updatedAt: new Date().toISOString(),
      });

      await markMcpOAuthIntegration(row.name, {
        status: 'active',
        status_detail: null,
        expires_at: expiryFrom(token, Date.now()),
        bearer_secret_id: secret.id,
        last_refresh_at: new Date().toISOString(),
      });
      outcome.refreshed.push(row.name);
      log.info('MCP OAuth access token refreshed', {
        integration: row.name,
        reason: decision.reason,
        expiresAt: expiryFrom(token, Date.now()),
        rotatedRefreshToken: Boolean(token.refreshToken && token.refreshToken !== bundle.refreshToken),
      });
    } catch (err) {
      if (isUnrecoverableGrantError(err)) {
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
        continue;
      }
      await markMcpOAuthIntegration(row.name, {
        status: 'error',
        status_detail: err instanceof Error ? err.message : String(err),
      });
      outcome.failed.push(row.name);
      log.warn('MCP OAuth refresh failed — will retry next sweep', { integration: row.name, err });
    }
  }

  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// Remove
// ─────────────────────────────────────────────────────────────────────────────

export interface RemoveResult {
  name: string;
  removedRow: boolean;
  removedBundle: boolean;
  removedSecret: boolean;
  secretName: string | null;
}

/**
 * Forget an integration. The OneCLI secret is left alone unless
 * `deleteSecret` is asked for: it may be one the operator made by hand and
 * other things may match on it, and an accidental delete is not recoverable
 * from here — the vault has no read-back. The group's `container.json`
 * declaration is left alone for the same reason; an undeclared-but-present
 * secret is inert, a deleted one that something still declares fails the spawn
 * closed (`src/onecli-secrets.ts:432`).
 */
export async function removeIntegration(name: string, options: { deleteSecret?: boolean } = {}): Promise<RemoveResult> {
  assertIntegrationName(name);
  const row = await getMcpOAuthIntegration(name);
  let removedSecret = false;
  if (options.deleteSecret && row) {
    const ref = row.bearer_secret_id
      ? { id: row.bearer_secret_id, name: row.bearer_secret_name }
      : await findOnecliSecretByName(row.bearer_secret_name);
    if (ref) removedSecret = await deleteOnecliSecret(ref.id);
  }
  const removedBundle = deleteMcpOAuthBundle(name);
  const removedRow = await deleteMcpOAuthIntegration(name);
  return { name, removedRow, removedBundle, removedSecret, secretName: row?.bearer_secret_name ?? null };
}
