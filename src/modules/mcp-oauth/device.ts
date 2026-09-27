/**
 * Device authorization grant (RFC 8628), opt-in. Servers rarely publish
 * `device_authorization_endpoint` in their metadata, so `--device` refuses
 * rather than guessing a URL unless `--device-endpoint` is supplied.
 */
import { assertHttpsEndpoint, type FetchLike } from './discovery.js';
import { OAuthTokenError, type TokenResponse } from './oauth-client.js';

const DEVICE_TIMEOUT_MS = 15_000;

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Pre-filled variant; show it when present, it saves typing the user code. */
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export async function requestDeviceAuthorization(
  fetchImpl: FetchLike,
  input: { deviceAuthorizationEndpoint: string; clientId: string; scopes?: string; resource?: string },
): Promise<DeviceAuthorization> {
  const form = new URLSearchParams({ client_id: input.clientId });
  if (input.scopes) form.set('scope', input.scopes);
  if (input.resource) form.set('resource', input.resource);

  const res = await fetchImpl(input.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(DEVICE_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Device authorization request returned ${res.status} from ${input.deviceAuthorizationEndpoint}`);
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed.device_code !== 'string' || typeof parsed.user_code !== 'string') {
    throw new Error(
      `Device authorization response from ${input.deviceAuthorizationEndpoint} is missing device_code/user_code`,
    );
  }
  const verificationUri =
    typeof parsed.verification_uri === 'string'
      ? parsed.verification_uri
      : typeof parsed.verification_url === 'string'
        ? // Some servers still use Google's pre-RFC spelling.
          parsed.verification_url
        : undefined;
  if (!verificationUri) {
    throw new Error(
      `Device authorization response from ${input.deviceAuthorizationEndpoint} is missing verification_uri`,
    );
  }
  return {
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    // Printed for a human to open, so held to the same HTTPS bar as a fetched URL.
    verificationUri: assertHttpsEndpoint('verification_uri', verificationUri),
    verificationUriComplete:
      typeof parsed.verification_uri_complete === 'string'
        ? assertHttpsEndpoint('verification_uri_complete', parsed.verification_uri_complete)
        : undefined,
    expiresInSeconds: typeof parsed.expires_in === 'number' ? parsed.expires_in : 900,
    // RFC 8628 §3.2: absent means 5 seconds.
    intervalSeconds: typeof parsed.interval === 'number' ? parsed.interval : 5,
  };
}

/** Injected so tests do not sleep for real. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the token endpoint until the human approves (RFC 8628 §3.4-3.5).
 * `authorization_pending` keeps waiting and `slow_down` adds five seconds for
 * good — treating either as failure would abandon a login in progress.
 * Everything else, including `access_denied` and `expired_token`, is terminal.
 */
export async function pollDeviceToken(
  fetchImpl: FetchLike,
  input: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    deviceCode: string;
    intervalSeconds: number;
    expiresInSeconds: number;
    resource?: string;
  },
  deps: { sleep?: Sleep; now?: () => number } = {},
): Promise<TokenResponse> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + input.expiresInSeconds * 1000;
  let intervalMs = input.intervalSeconds * 1000;

  for (;;) {
    if (now() >= deadline) {
      throw new OAuthTokenError('expired_token', 400, 'the device code expired before it was approved');
    }
    await sleep(intervalMs);

    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: input.deviceCode,
      client_id: input.clientId,
    });
    if (input.clientSecret) form.set('client_secret', input.clientSecret);
    if (input.resource) form.set('resource', input.resource);

    const res = await fetchImpl(input.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      signal: AbortSignal.timeout(DEVICE_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // An unparseable error body is never echoed: it can contain what was sent.
    }

    if (res.ok) {
      if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
        throw new Error(`Token endpoint ${input.tokenEndpoint} returned no access_token`);
      }
      return {
        accessToken: parsed.access_token,
        refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
        expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined,
        scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
        tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : 'Bearer',
      };
    }

    const code = typeof parsed.error === 'string' ? parsed.error : `http_${res.status}`;
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') {
      intervalMs += 5_000;
      continue;
    }
    throw new OAuthTokenError(
      code,
      res.status,
      typeof parsed.error_description === 'string' ? parsed.error_description : undefined,
    );
  }
}
