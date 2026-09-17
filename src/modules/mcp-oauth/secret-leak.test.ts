/**
 * Issue #876 P2-1 — the OneCLI API key must not be able to reach argv, a thrown
 * message, `mcp_oauth_integrations.status_detail` or a log line.
 *
 * The bug this pins: `onecli-secret-writer.ts` put
 * `-H "Authorization: Bearer ${ONECLI_API_KEY}"` in curl's ARGV, and rethrew
 * `execFile`'s error verbatim. Node composes that error's `.message` as
 * `Command failed: <the whole argv>`, and the callers in `service.ts` write
 * `err.message` into a DB column that `ncl integrations list/get` prints, and
 * into a `log.warn`. One gateway outage was enough to publish the key.
 *
 * So the fake `execFile` below does BOTH halves of the real thing: it records
 * the argv it was handed, and it fails with an error whose `.message` contains
 * the full argv — which is how the leak would come back if the key ever returns
 * to argv, or if anyone starts forwarding `error.message` again.
 *
 * Hermetic: `child_process` is mocked whole, the DB is an in-memory migrated
 * fixture, `DATA_DIR` is a per-run temp dir, and no request leaves the process.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inspect } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-leak-'));

/**
 * Hoisted, because `vi.mock` factories run before module-scope initializers and
 * two of these are read EAGERLY: `config.js` logs while it parses `.env`, which
 * reaches the log mock, and the config factory returns the key by value.
 *
 * SENTINEL is distinctive enough that a partial echo is still caught.
 */
const { SENTINEL, logged, invocations } = vi.hoisted(() => ({
  SENTINEL: 'sk-onecli-SENTINEL-8f2a1c-DO-NOT-LEAK',
  logged: [] as unknown[][],
  /** Every curl invocation the code under test made: argv and the stdin it wrote. */
  invocations: [] as { argv: string[]; stdin: string }[],
}));

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    ONECLI_API_KEY: SENTINEL,
    ONECLI_URL: 'http://127.0.0.1:10254',
    get DATA_DIR() {
      return tmpRoot;
    },
  };
});

vi.mock('../../log.js', () => ({
  log: {
    info: (...a: unknown[]) => logged.push(a),
    warn: (...a: unknown[]) => logged.push(a),
    error: (...a: unknown[]) => logged.push(a),
    debug: (...a: unknown[]) => logged.push(a),
    fatal: (...a: unknown[]) => logged.push(a),
  },
  setLogScrubber: () => undefined,
  isSurvivableIoError: () => false,
}));

vi.mock('../../container-config.js', () => ({
  updateContainerConfig: async () => ({}),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: (bin: string, argv: string[], _options: unknown, callback: unknown) => {
      const done = callback as (e: Error | null, out: string, err: string) => void;
      const record = { argv, stdin: '' };
      invocations.push(record);
      // Exactly how Node reports a failed child: the message is the command
      // line. If the key is in argv, it is in here.
      const error: NodeJS.ErrnoException = new Error(
        `Command failed: ${bin} ${argv.join(' ')}\ncurl: (7) Failed to connect to 127.0.0.1 port 10254`,
      );
      error.code = 7 as unknown as string;
      queueMicrotask(() => done(error, '', ''));
      return {
        stdin: {
          on: () => undefined,
          end: (chunk?: string) => {
            record.stdin = chunk ?? '';
          },
        },
      };
    },
  };
});

import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { markMcpOAuthIntegration, upsertMcpOAuthIntegration } from '../../db/mcp-oauth-integrations.js';
import { getMcpOAuthIntegration } from '../../db/mcp-oauth-integrations.js';
import { enforceHermeticity } from '../../test-hermeticity.js';
import type { FetchLike } from './discovery.js';
import { putOnecliBearerSecret } from './onecli-secret-writer.js';
import { _resetMcpOAuthWarnStateForTesting, refreshExpiringMcpOAuthIntegrations } from './service.js';
import { writeMcpOAuthBundle } from './store.js';

enforceHermeticity();

const NAME = 'dropbox-files';

beforeEach(async () => {
  await initMigratedTestDb();
  invocations.length = 0;
  logged.length = 0;
  _resetMcpOAuthWarnStateForTesting();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(path.join(tmpRoot, 'mcp-oauth'), { recursive: true, force: true });
});

/** Everything a value could be printed as, concatenated. */
function everyRendering(value: unknown): string {
  const parts = [String(value), inspect(value, { depth: 6 })];
  if (value instanceof Error) parts.push(value.message, value.stack ?? '', JSON.stringify({ err: value }));
  try {
    parts.push(JSON.stringify(value));
  } catch {
    // Circular — `inspect` above already covered it.
  }
  return parts.join('\n');
}

describe('the OneCLI API key never reaches argv', () => {
  it('sends the Authorization header on stdin, not on the command line', async () => {
    await expect(putOnecliBearerSecret({ ...SPEC }, 'access-token-1')).rejects.toThrow();
    expect(invocations.length).toBeGreaterThan(0);
    for (const call of invocations) {
      expect(call.argv.join(' ')).not.toContain(SENTINEL);
      // …and it really is being sent, so this is not passing by simply
      // dropping the credential.
      expect(call.stdin).toContain(`Authorization: Bearer ${SENTINEL}`);
    }
  });
});

const SPEC = {
  name: 'Dropbox-MCP-Axis',
  hostPattern: 'mcp.dropbox.com',
  pathPattern: '/mcp',
  headerName: 'Authorization',
  valueFormat: 'Bearer {value}',
};

describe('a curl failure is rethrown without the command line', () => {
  it('names the operation and the exit code, and nothing else', async () => {
    const err = await putOnecliBearerSecret({ ...SPEC }, 'access-token-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(everyRendering(err)).not.toContain(SENTINEL);
    expect((err as Error).message).toBe(
      'OneCLI GET /api/secrets?limit=10000 failed: curl exit code 7 (could not connect)',
    );
  });
});

describe('a failed refresh publishes nothing sensitive', () => {
  /** A row that is due, with a refresh token on file and a token endpoint that
   *  answers — so the ONLY thing that fails is the vault write. */
  async function seedDueIntegration(): Promise<void> {
    await upsertMcpOAuthIntegration({
      name: NAME,
      agent_group_id: 'ag-1',
      mcp_url: 'https://mcp.dropbox.com/mcp',
      resource: 'https://mcp.dropbox.com/mcp',
      authorization_endpoint: 'https://www.dropbox.com/oauth2/authorize',
      token_endpoint: 'https://api.dropboxapi.com/oauth2/token',
      registration_endpoint: null,
      issuer: 'https://www.dropbox.com',
      scopes: 'files.metadata.read',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      bearer_secret_name: SPEC.name,
      bearer_secret_id: null,
      host_pattern: 'mcp.dropbox.com',
      path_pattern: '/mcp',
      status: 'active',
      status_detail: null,
      expires_at: new Date(Date.now() - 1000).toISOString(),
      last_refresh_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    await markMcpOAuthIntegration(NAME, { status: 'active' });
    writeMcpOAuthBundle({
      name: NAME,
      clientId: 'client-1',
      refreshToken: 'rt-1',
      updatedAt: new Date().toISOString(),
    });
  }

  const tokenEndpoint: FetchLike = async () =>
    ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, token_type: 'Bearer' }),
    }) as unknown as Response;

  it('keeps the key out of status_detail and out of every log call', async () => {
    await seedDueIntegration();

    const outcome = await refreshExpiringMcpOAuthIntegrations(tokenEndpoint);
    expect(outcome.failed).toEqual([NAME]);

    const row = await getMcpOAuthIntegration(NAME);
    expect(row?.status).toBe('error');
    // The operator still learns what broke…
    expect(row?.status_detail).toContain('OneCLI secret write failed');
    // …without learning the key.
    expect(row?.status_detail ?? '').not.toContain(SENTINEL);

    expect(logged.length).toBeGreaterThan(0);
    for (const call of logged) expect(everyRendering(call)).not.toContain(SENTINEL);
  });
});
