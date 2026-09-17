/**
 * Device authorization grant (RFC 8628) — the flow designed for exactly this
 * situation: the machine running the client has no browser.
 *
 * NOT THE DEFAULT, and the reason is discovery, not preference. RFC 8628 §4
 * puts the endpoint in authorization-server metadata as
 * `device_authorization_endpoint`, and neither first target publishes one:
 * Amplitude's metadata does not list the grant at all, and Dropbox's lists
 * `device_code` in `grant_types_supported` while publishing no endpoint to
 * start it at (verified 2026-09-17 against
 * https://www.dropbox.com/.well-known/oauth-authorization-server). So `--device`
 * refuses with that fact rather than guessing a URL, unless the operator supplies
 * `--device-endpoint`. When a server does publish one, this is the nicest flow
 * on an ssh session: no tunnel, no paste, no redirect at all.
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
    // Printed for a human to open, so it is held to the same bar as a URL this
    // host would fetch — see `assertHttpsEndpoint`'s note on the one gate.
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

/** Injected so the polling test does not spend real seconds sleeping. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the token endpoint until the human approves (RFC 8628 §3.4-3.5).
 *
 * The two non-terminal codes are the whole point of the loop:
 * `authorization_pending` means keep waiting at the current interval, and
 * `slow_down` means the server wants the interval increased by five seconds
 * permanently — treating either as a failure would abandon a login the operator
 * is in the middle of completing. Everything else, including `access_denied`
 * and `expired_token`, is terminal.
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
      // Same rule as the other token path: an unparseable error body is never
      // echoed, because it can contain what was sent to it.
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
