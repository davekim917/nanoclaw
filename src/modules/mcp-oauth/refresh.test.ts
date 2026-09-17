/**
 * The refresh half: when a row is due, what a refresh does to the three places
 * state lives (bundle file, OneCLI secret, registry row), and how the two
 * failure classes are separated.
 *
 * Hermetic: the DB is a migrated in-memory fixture, `DATA_DIR` is a per-run
 * temp dir, the OneCLI writer is mocked at its module boundary (the real one
 * shells out to `curl`), and every token request is an injected stub.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-refresh-'));

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get DATA_DIR() {
      return tmpRoot;
    },
  };
});

// log.ts installs process-wide uncaughtException handlers at module scope, so
// it is stubbed whole rather than spread (same reasoning as
// src/cli/resources/roles.test.ts:11).
const logged = { warn: [] as unknown[][], info: [] as unknown[][] };
vi.mock('../../log.js', () => ({
  log: {
    info: (...a: unknown[]) => logged.info.push(a),
    warn: (...a: unknown[]) => logged.warn.push(a),
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
  },
  setLogScrubber: () => undefined,
  isSurvivableIoError: () => false,
}));

const secretWrites: { name: string; value: string }[] = [];
/** Every call that REACHED the writer, successful or not — the backoff is only
 *  observable as the number of attempts made during an outage. */
const secretWriteAttempts = { count: 0 };
let secretWriteFails = false;
vi.mock('./onecli-secret-writer.js', () => ({
  putOnecliBearerSecret: async (spec: { name: string }, value: string) => {
    secretWriteAttempts.count++;
    if (secretWriteFails) throw new Error('gateway unreachable');
    secretWrites.push({ name: spec.name, value });
    return { id: 'secret-uuid-1', name: spec.name };
  },
  findOnecliSecretByName: async () => undefined,
  deleteOnecliSecret: async () => true,
}));

import { closeDb, initMigratedTestDb } from '../../db/index.js';
import {
  getMcpOAuthIntegration,
  markMcpOAuthIntegration,
  upsertMcpOAuthIntegration,
  type McpOAuthIntegration,
} from '../../db/mcp-oauth-integrations.js';
import { enforceHermeticity } from '../../test-hermeticity.js';
import { OAuthTokenError } from './oauth-client.js';
import {
  decideRefresh,
  refreshExpiringMcpOAuthIntegrations,
  REFRESH_MARGIN_MS,
  SECRET_WRITE_RETRY_BASE_MS,
  SECRET_WRITE_RETRY_MAX_MS,
  secretWriteRetryDelayMs,
  UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS,
  _resetMcpOAuthWarnStateForTesting,
} from './service.js';
import { readMcpOAuthBundle, writeMcpOAuthBundle } from './store.js';

enforceHermeticity();

const NOW = Date.parse('2026-09-17T12:00:00.000Z');

function row(over: Partial<McpOAuthIntegration> = {}): McpOAuthIntegration {
  return {
    name: 'dropbox-files',
    agent_group_id: 'ag-1',
    mcp_url: 'https://mcp.dropbox.com/mcp',
    resource: 'https://mcp.dropbox.com/mcp',
    authorization_endpoint: 'https://www.dropbox.com/oauth2/authorize',
    token_endpoint: 'https://api.dropboxapi.com/oauth2/token',
    registration_endpoint: 'https://www.dropbox.com/oauth2/register',
    issuer: 'https://www.dropbox.com',
    scopes: 'files.metadata.read',
    redirect_uri: 'http://127.0.0.1:8765/callback',
    bearer_secret_name: 'Dropbox-Files',
    bearer_secret_id: 'secret-uuid-1',
    host_pattern: 'mcp.dropbox.com',
    path_pattern: '/mcp',
    status: 'active',
    status_detail: null,
    expires_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
    last_refresh_at: new Date(NOW - 60 * 1000).toISOString(),
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...over,
  };
}

function tokenResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(async () => {
  await initMigratedTestDb();
  secretWrites.length = 0;
  secretWriteAttempts.count = 0;
  secretWriteFails = false;
  logged.warn.length = 0;
  logged.info.length = 0;
  _resetMcpOAuthWarnStateForTesting();
  fs.rmSync(path.join(tmpRoot, 'mcp-oauth'), { recursive: true, force: true });
});

afterEach(async () => {
  await closeDb();
});

describe('decideRefresh', () => {
  it('leaves a token with plenty of life alone', () => {
    expect(decideRefresh(row(), NOW)).toEqual({ refresh: false, reason: 'within-window' });
  });

  it('refreshes inside the margin, and at the margin boundary', () => {
    expect(decideRefresh(row({ expires_at: new Date(NOW + REFRESH_MARGIN_MS - 1).toISOString() }), NOW).refresh).toBe(
      true,
    );
    expect(decideRefresh(row({ expires_at: new Date(NOW + REFRESH_MARGIN_MS).toISOString() }), NOW)).toEqual({
      refresh: true,
      reason: 'expiring',
    });
    expect(decideRefresh(row({ expires_at: new Date(NOW + REFRESH_MARGIN_MS + 1).toISOString() }), NOW).refresh).toBe(
      false,
    );
  });

  it('refreshes an already-expired token', () => {
    expect(decideRefresh(row({ expires_at: new Date(NOW - 1).toISOString() }), NOW)).toEqual({
      refresh: true,
      reason: 'expired',
    });
  });

  it('never touches pending or needs_login — a dead grant must not be retried every tick', () => {
    const due = new Date(NOW - 1).toISOString();
    expect(decideRefresh(row({ status: 'pending', expires_at: due }), NOW).refresh).toBe(false);
    expect(decideRefresh(row({ status: 'needs_login', expires_at: due }), NOW).refresh).toBe(false);
    // `error` IS retried — that is the difference between the two failure classes.
    expect(decideRefresh(row({ status: 'error', expires_at: due }), NOW).refresh).toBe(true);
  });

  // Round-2 review F1: `error` is a statement about the last ATTEMPT, not about
  // the token's clock. Deferring it to the expiry window left a failed bearer
  // write unusable for ~50 minutes of a one-hour token, and 12 hours when the
  // server stated no expiry — the opposite of the next-sweep retry the status
  // asks for.
  it('retries an `error` row on the next tick whatever its expiry says', () => {
    expect(
      decideRefresh(row({ status: 'error', expires_at: new Date(NOW + 60 * 60 * 1000).toISOString() }), NOW),
    ).toEqual({ refresh: true, reason: 'retry-after-error' });
    expect(
      decideRefresh(row({ status: 'error', expires_at: null, last_refresh_at: new Date(NOW).toISOString() }), NOW),
    ).toEqual({ refresh: true, reason: 'retry-after-error' });
  });

  it('falls back to a fixed interval when the server stated no expiry', () => {
    const noExpiry = (lastRefreshAgoMs: number) =>
      decideRefresh(row({ expires_at: null, last_refresh_at: new Date(NOW - lastRefreshAgoMs).toISOString() }), NOW);
    expect(noExpiry(UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS - 1).refresh).toBe(false);
    expect(noExpiry(UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS)).toEqual({
      refresh: true,
      reason: 'unknown-expiry-interval',
    });
    // Never exchanged at all: nothing to refresh from.
    expect(decideRefresh(row({ expires_at: null, last_refresh_at: null }), NOW)).toEqual({
      refresh: false,
      reason: 'no-expiry-yet',
    });
  });

  it('treats an unparseable expiry as due rather than as "never again"', () => {
    expect(decideRefresh(row({ expires_at: 'not-a-date' }), NOW)).toEqual({ refresh: true, reason: 'expired' });
  });
});

describe('refreshExpiringMcpOAuthIntegrations', () => {
  // `refreshToken: null` means "no refresh token on file". It is NOT
  // `undefined`: a default parameter fires on an explicit `undefined` too, so
  // the no-token case would silently have been handed 'rt-old'.
  async function seed(over: Partial<McpOAuthIntegration> = {}, refreshToken: string | null = 'rt-old') {
    const r = row({ expires_at: new Date(Date.now() + 60_000).toISOString(), ...over });
    const { created_at: _c, updated_at: _u, ...insertable } = r;
    await upsertMcpOAuthIntegration(insertable);
    writeMcpOAuthBundle({
      name: r.name,
      clientId: 'client-1',
      refreshToken: refreshToken ?? undefined,
      scopes: r.scopes ?? undefined,
      updatedAt: new Date().toISOString(),
    });
    return r;
  }

  it('mints a new bearer, writes it to OneCLI, and moves the expiry on', async () => {
    await seed();
    const outcome = await refreshExpiringMcpOAuthIntegrations(async () =>
      tokenResponse({ access_token: 'at-new', expires_in: 14400, token_type: 'Bearer' }),
    );

    expect(outcome.refreshed).toEqual(['dropbox-files']);
    expect(secretWrites).toEqual([{ name: 'Dropbox-Files', value: 'at-new' }]);

    const after = await getMcpOAuthIntegration('dropbox-files');
    expect(after!.status).toBe('active');
    expect(Date.parse(after!.expires_at!)).toBeGreaterThan(Date.now() + 14000 * 1000);
    expect(after!.bearer_secret_id).toBe('secret-uuid-1');
  });

  it('persists a ROTATED refresh token — otherwise the next tick locks itself out', async () => {
    await seed();
    await refreshExpiringMcpOAuthIntegrations(async () =>
      tokenResponse({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, token_type: 'Bearer' }),
    );
    expect(readMcpOAuthBundle('dropbox-files')!.refreshToken).toBe('rt-new');
  });

  it('keeps the old refresh token when the server reissues none', async () => {
    await seed();
    await refreshExpiringMcpOAuthIntegrations(async () =>
      tokenResponse({ access_token: 'at-new', expires_in: 3600, token_type: 'Bearer' }),
    );
    expect(readMcpOAuthBundle('dropbox-files')!.refreshToken).toBe('rt-old');
  });

  it('marks needs_login on invalid_grant and warns exactly once across ticks', async () => {
    await seed();
    const dead = async () => tokenResponse({ error: 'invalid_grant', error_description: 'revoked' }, 400);

    const first = await refreshExpiringMcpOAuthIntegrations(dead);
    expect(first.needsLogin).toEqual(['dropbox-files']);
    expect((await getMcpOAuthIntegration('dropbox-files'))!.status).toBe('needs_login');
    expect(logged.warn).toHaveLength(1);

    // Second tick: the row is `needs_login`, so decideRefresh skips it entirely
    // — no second request to the provider and no second WARN.
    let calls = 0;
    await refreshExpiringMcpOAuthIntegrations(async () => {
      calls++;
      return dead();
    });
    expect(calls).toBe(0);
    expect(logged.warn).toHaveLength(1);
  });

  it('leaves a transient failure in `error` so the next tick retries it', async () => {
    await seed();
    const outcome = await refreshExpiringMcpOAuthIntegrations(async () =>
      tokenResponse({ error: 'server_error' }, 503),
    );
    expect(outcome.failed).toEqual(['dropbox-files']);

    const after = await getMcpOAuthIntegration('dropbox-files');
    expect(after!.status).toBe('error');
    // The bearer in OneCLI is untouched — the old token may still have life.
    expect(secretWrites).toHaveLength(0);
    expect(decideRefresh(after!, Date.now())).toEqual({ refresh: true, reason: 'retry-after-error' });
  });

  it('needs a login when the bundle has no refresh token at all', async () => {
    await seed({}, null);
    const outcome = await refreshExpiringMcpOAuthIntegrations(async () => {
      throw new Error('must not reach the token endpoint');
    });
    expect(outcome.needsLogin).toEqual(['dropbox-files']);
    expect((await getMcpOAuthIntegration('dropbox-files'))!.status_detail).toMatch(/no refresh token/);
  });

  it('one integration failing does not stop the next', async () => {
    await seed({ name: 'a-mr', mcp_url: 'https://a.test/mcp' });
    await seed({ name: 'b-mr', mcp_url: 'https://b.test/mcp', bearer_secret_name: 'B-Secret' });

    let call = 0;
    const outcome = await refreshExpiringMcpOAuthIntegrations(async () => {
      call++;
      return call === 1
        ? tokenResponse({ error: 'temporarily_unavailable' }, 503)
        : tokenResponse({ access_token: 'at-new', expires_in: 3600, token_type: 'Bearer' });
    });

    // Rows are listed name-ascending, so `a-mr` takes the 503 and `b-mr` still runs.
    expect(outcome.failed).toEqual(['a-mr']);
    expect(outcome.refreshed).toEqual(['b-mr']);
  });

  // Round-1 review F1: the OneCLI write is the fallible step, and a server that
  // rotated its refresh token has already killed the old one. Writing OneCLI
  // first and crashing would leave a dead token on disk.
  it('persists a rotated refresh token even when the OneCLI write then fails', async () => {
    await seed();
    secretWriteFails = true;

    const outcome = await refreshExpiringMcpOAuthIntegrations(async () =>
      tokenResponse({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, token_type: 'Bearer' }),
    );

    expect(outcome.failed).toEqual(['dropbox-files']);
    // The token that is now the only working one survived the failure.
    expect(readMcpOAuthBundle('dropbox-files')!.refreshToken).toBe('rt-new');
  });

  // Round-1 review F5: the host-side exception covers the credentials needed to
  // MINT a bearer, not a live bearer.
  it('never writes an access token into the host bundle', async () => {
    await seed();
    await refreshExpiringMcpOAuthIntegrations(async () =>
      tokenResponse({ access_token: 'at-new-secret-value', expires_in: 3600, token_type: 'Bearer' }),
    );
    const raw = fs.readFileSync(path.join(tmpRoot, 'mcp-oauth', 'dropbox-files.json'), 'utf-8');
    expect(raw).not.toContain('at-new-secret-value');
    expect(Object.keys(JSON.parse(raw) as object)).not.toContain('accessToken');
  });

  // Round-1 review F3: `invalid_client` condemns the REGISTRATION, so the next
  // login has to register again instead of replaying the refused client id.
  it('records a rejected client id, and leaves a plain invalid_grant unmarked', async () => {
    await seed();
    await refreshExpiringMcpOAuthIntegrations(async () => tokenResponse({ error: 'invalid_client' }, 401));
    expect(readMcpOAuthBundle('dropbox-files')!.clientRejectedAt).toBeTruthy();

    await initMigratedTestDb();
    _resetMcpOAuthWarnStateForTesting();
    await seed({ name: 'other-int', mcp_url: 'https://other.test/mcp' });
    await refreshExpiringMcpOAuthIntegrations(async () => tokenResponse({ error: 'invalid_grant' }, 400));
    // The grant is dead but the client is fine — re-registering would mint an
    // orphan at the provider for nothing.
    expect(readMcpOAuthBundle('other-int')!.clientRejectedAt).toBeUndefined();
  });

  // Round-2 review F2: a server may GRANT less than was asked for. Re-sending
  // the requested set on the next refresh reads as an attempt to widen the
  // grant, which a strict server answers with `invalid_scope` — a permanent
  // retry loop.
  it('records a narrowed scope and asks for exactly that next time', async () => {
    await seed({ scopes: 'files.metadata.read files.content.write' });

    let sent = '';
    await refreshExpiringMcpOAuthIntegrations(async (_url, init) => {
      sent = new URLSearchParams(String(init?.body)).get('scope') ?? '';
      return tokenResponse({
        access_token: 'at-new',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'files.metadata.read',
      });
    });
    expect(sent).toBe('files.metadata.read files.content.write');
    expect((await getMcpOAuthIntegration('dropbox-files'))!.scopes).toBe('files.metadata.read');

    // Second pass: the row now carries the granted set, so that is what goes out.
    await markMcpOAuthIntegration('dropbox-files', { status: 'error' });
    await refreshExpiringMcpOAuthIntegrations(async (_url, init) => {
      sent = new URLSearchParams(String(init?.body)).get('scope') ?? '';
      return tokenResponse({ access_token: 'at-3', expires_in: 3600, token_type: 'Bearer' });
    });
    expect(sent).toBe('files.metadata.read');
  });

  it('bundle files are 0600 inside a 0700 directory', async () => {
    await seed();
    const dir = path.join(tmpRoot, 'mcp-oauth');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'dropbox-files.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses a path-traversing integration name rather than sanitizing it', () => {
    expect(() => readMcpOAuthBundle('../../etc/passwd')).toThrow(/Refusing to use/);
  });
});

describe('OAuthTokenError', () => {
  it('renders code and description together', () => {
    expect(new OAuthTokenError('invalid_grant', 400, 'expired').message).toBe('invalid_grant: expired');
    expect(new OAuthTokenError('invalid_grant', 400).message).toBe('invalid_grant');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #876 P3(b) and P3(c) — what two overlapping sweeps and a gateway outage
// are allowed to cost at the PROVIDER.
// ─────────────────────────────────────────────────────────────────────────────

describe('overlapping sweeps do not double-refresh (P3b)', () => {
  async function seedDue(): Promise<void> {
    const r = row({ expires_at: new Date(Date.now() + 60_000).toISOString() });
    const { created_at: _c, updated_at: _u, ...insertable } = r;
    await upsertMcpOAuthIntegration(insertable);
    writeMcpOAuthBundle({
      name: r.name,
      clientId: 'client-1',
      refreshToken: 'rt-old',
      updatedAt: new Date().toISOString(),
    });
  }

  it('re-decides inside the lock, so the second pass finds the row no longer due', async () => {
    await seedDue();
    const grants: string[] = [];
    const tokenEndpoint = async () => {
      grants.push(`grant-${grants.length + 1}`);
      return tokenResponse({
        access_token: `at-${grants.length}`,
        // Rotating, which is what makes the second grant destructive: it
        // invalidates the token the first one just stored.
        refresh_token: `rt-${grants.length}`,
        expires_in: 3600,
        token_type: 'Bearer',
      });
    };

    const [first, second] = await Promise.all([
      refreshExpiringMcpOAuthIntegrations(tokenEndpoint),
      refreshExpiringMcpOAuthIntegrations(tokenEndpoint),
    ]);

    expect(grants).toEqual(['grant-1']);
    expect([...first.refreshed, ...second.refreshed]).toEqual(['dropbox-files']);
    expect(readMcpOAuthBundle('dropbox-files')!.refreshToken).toBe('rt-1');
    // The pass that skipped did not count the row as due either.
    expect(first.checked + second.checked).toBe(1);
  });
});

describe('a OneCLI outage costs one grant, not one per minute (P3c)', () => {
  async function seedDue(): Promise<void> {
    const r = row({ expires_at: new Date(Date.now() + 60_000).toISOString() });
    const { created_at: _c, updated_at: _u, ...insertable } = r;
    await upsertMcpOAuthIntegration(insertable);
    writeMcpOAuthBundle({
      name: r.name,
      clientId: 'client-1',
      refreshToken: 'rt-old',
      updatedAt: new Date().toISOString(),
    });
  }

  it('parks the minted token and retries the WRITE on a backoff, never the grant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await seedDue();
      secretWriteFails = true;

      const grants: string[] = [];
      const tokenEndpoint = async () => {
        grants.push(`grant-${grants.length + 1}`);
        return tokenResponse({
          access_token: 'at-minted',
          refresh_token: `rt-rotated-${grants.length}`,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      };

      const first = await refreshExpiringMcpOAuthIntegrations(tokenEndpoint);
      expect(first.failed).toEqual(['dropbox-files']);
      expect(grants).toEqual(['grant-1']);
      const afterFirst = await getMcpOAuthIntegration('dropbox-files');
      expect(afterFirst!.status).toBe('error');
      expect(afterFirst!.status_detail).toContain('retrying the write');

      // The row is `error`, so it is due on EVERY tick. Without the backoff
      // this is where the provider gets hit once a minute for the length of
      // the outage — and each grant rotates the refresh token.
      for (let i = 0; i < 5; i++) await refreshExpiringMcpOAuthIntegrations(tokenEndpoint);
      expect(grants).toEqual(['grant-1']);
      expect(secretWrites).toEqual([]);
      // …and the gateway is not hammered either: one attempt, then silence
      // until the backoff window opens.
      expect(secretWriteAttempts.count).toBe(1);

      // The gateway comes back. The parked token — not a new one — lands.
      vi.setSystemTime(NOW + SECRET_WRITE_RETRY_BASE_MS + 1000);
      secretWriteFails = false;
      const recovered = await refreshExpiringMcpOAuthIntegrations(tokenEndpoint);

      expect(grants).toEqual(['grant-1']);
      expect(recovered.refreshed).toEqual(['dropbox-files']);
      expect(secretWrites).toEqual([{ name: 'Dropbox-Files', value: 'at-minted' }]);
      const after = await getMcpOAuthIntegration('dropbox-files');
      expect(after!.status).toBe('active');
      expect(after!.status_detail).toBeNull();
      // The rotation from the one grant that did happen is still on disk.
      expect(readMcpOAuthBundle('dropbox-files')!.refreshToken).toBe('rt-rotated-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off exponentially and stops at the cap', () => {
    expect(secretWriteRetryDelayMs(1)).toBe(SECRET_WRITE_RETRY_BASE_MS);
    expect(secretWriteRetryDelayMs(2)).toBe(2 * SECRET_WRITE_RETRY_BASE_MS);
    expect(secretWriteRetryDelayMs(4)).toBe(8 * SECRET_WRITE_RETRY_BASE_MS);
    expect(secretWriteRetryDelayMs(99)).toBe(SECRET_WRITE_RETRY_MAX_MS);
    expect(SECRET_WRITE_RETRY_MAX_MS).toBe(15 * 60 * 1000);
  });

  it('gives up on a parked token the outage outlived, and mints a fresh one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await seedDue();
      secretWriteFails = true;
      const grants: string[] = [];
      const tokenEndpoint = async () => {
        grants.push(`grant-${grants.length + 1}`);
        return tokenResponse({ access_token: `at-${grants.length}`, expires_in: 3600, token_type: 'Bearer' });
      };

      await refreshExpiringMcpOAuthIntegrations(tokenEndpoint);
      expect(grants).toEqual(['grant-1']);

      // Past the parked token's own usable life. Writing it now would put a
      // dead bearer in the vault, so the refresher must go back to the
      // token endpoint.
      secretWriteFails = false;
      vi.setSystemTime(NOW + 3600 * 1000);
      await refreshExpiringMcpOAuthIntegrations(tokenEndpoint);

      expect(grants).toEqual(['grant-1', 'grant-2']);
      expect(secretWrites).toEqual([{ name: 'Dropbox-Files', value: 'at-2' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
