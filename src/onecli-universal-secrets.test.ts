import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetUniversalSecretsCache, computeMerge, resolveUniversalSecrets } from './onecli-universal-secrets.js';

describe('computeMerge', () => {
  it('returns null when every universal is already present', () => {
    expect(computeMerge(['a', 'b', 'c'], ['a', 'b'])).toBe(null);
  });

  it('appends missing universals to the existing assignment', () => {
    expect(computeMerge(['a', 'b'], ['b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles an empty current assignment', () => {
    expect(computeMerge([], ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('handles an empty universal list (no-op)', () => {
    expect(computeMerge(['a', 'b'], [])).toBe(null);
  });

  it('preserves order of the current assignment', () => {
    expect(computeMerge(['c', 'a', 'b'], ['d', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('resolveUniversalSecrets', () => {
  const granola = { id: 'g-1', name: 'Granola', hostPattern: 'mcp.granola.ai' };
  const exa = { id: 'e-1', name: 'Exa', hostPattern: 'mcp.exa.ai' };
  const ambiguousA = { id: 'gh-a', name: 'GitHub', hostPattern: 'api.github.com' };
  const ambiguousB = { id: 'gh-b', name: 'GitHub', hostPattern: 'api.github.com' };

  it('returns empty array when no names configured', () => {
    expect(resolveUniversalSecrets([], [granola, exa])).toEqual([]);
  });

  it('resolves names to secret records', () => {
    expect(resolveUniversalSecrets(['Granola', 'Exa'], [granola, exa])).toEqual([granola, exa]);
  });

  it('skips missing names instead of throwing (pre-declaration pattern)', () => {
    const result = resolveUniversalSecrets(['Granola', 'NotYetMigrated'], [granola]);
    expect(result).toEqual([granola]);
  });

  it('picks first match when a name is ambiguous', () => {
    const result = resolveUniversalSecrets(['GitHub'], [ambiguousA, ambiguousB]);
    expect(result).toEqual([ambiguousA]);
  });

  it('returns empty when no configured name matches', () => {
    expect(resolveUniversalSecrets(['Nope'], [granola])).toEqual([]);
  });
});

describe('sync orchestration (mocked fetch + mocked config)', () => {
  const agentRecords = [
    { id: 'uuid-sunday', name: 'sunday', identifier: 'ag-sunday' },
    { id: 'uuid-other', name: 'other', identifier: 'ag-other' },
  ];
  const secretRecords = [
    { id: 'sec-granola', name: 'Granola', hostPattern: 'mcp.granola.ai' },
    { id: 'sec-exa', name: 'Exa', hostPattern: 'mcp.exa.ai' },
    { id: 'sec-other', name: 'Deepgram', hostPattern: 'api.deepgram.com' },
  ];

  type FetchCall = { url: string; method: string; body?: unknown };
  let calls: FetchCall[];

  function setupFetch(opts: { sundayAssigned?: string[]; otherAssigned?: string[]; failPut?: boolean } = {}): void {
    const sundayAssigned = opts.sundayAssigned ?? [];
    const otherAssigned = opts.otherAssigned ?? [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const bodyStr = init?.body ? String(init.body) : undefined;
        const body = bodyStr ? JSON.parse(bodyStr) : undefined;
        calls.push({ url, method, body });

        if (method === 'GET' && url.endsWith('/api/secrets')) {
          return new Response(JSON.stringify(secretRecords), { status: 200 });
        }
        if (method === 'GET' && url.endsWith('/api/agents')) {
          return new Response(JSON.stringify(agentRecords), { status: 200 });
        }
        if (method === 'GET' && url.endsWith('/api/agents/uuid-sunday/secrets')) {
          return new Response(JSON.stringify(sundayAssigned), { status: 200 });
        }
        if (method === 'GET' && url.endsWith('/api/agents/uuid-other/secrets')) {
          return new Response(JSON.stringify(otherAssigned), { status: 200 });
        }
        if (method === 'PUT' && url.includes('/secrets')) {
          if (opts.failPut) return new Response('boom', { status: 500 });
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }),
    );
  }

  beforeEach(() => {
    // Reset modules BEFORE the per-test doMock so the fresh import picks up
    // the mocked config. If we reset in afterEach, the first test runs with
    // whatever module state was already cached from the top-of-file static
    // import — and the config mock silently misses.
    vi.resetModules();
    calls = [];
    vi.doMock('./config.js', () => ({
      NANOCLAW_UNIVERSAL_SECRETS: 'Granola,Exa,NotYetMigrated',
      ONECLI_API_KEY: 'test-key',
      ONECLI_URL: 'http://127.0.0.1:10254',
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('./config.js');
  });

  async function importModule() {
    const mod = await import('./onecli-universal-secrets.js');
    mod.__resetUniversalSecretsCache();
    return mod;
  }

  it('end-to-end: resolves identifier, merges assignments, PUTs camelCase body', async () => {
    setupFetch({ sundayAssigned: ['sec-anthropic'] });
    const mod = await importModule();

    await mod.syncAgentUniversalSecretsByIdentifier('ag-sunday');

    const putCall = calls.find((c) => c.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(putCall!.url).toContain('/api/agents/uuid-sunday/secrets');
    // Must send camelCase `secretIds`, existing entry preserved, universals appended.
    expect(putCall!.body).toEqual({ secretIds: ['sec-anthropic', 'sec-granola', 'sec-exa'] });
  });

  it('end-to-end: skips PUT when all universals are already assigned', async () => {
    setupFetch({ sundayAssigned: ['sec-granola', 'sec-exa', 'sec-anthropic'] });
    const mod = await importModule();

    await mod.syncAgentUniversalSecretsByIdentifier('ag-sunday');

    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined();
  });

  it('end-to-end: unknown identifier logs and no-ops (no PUT)', async () => {
    setupFetch();
    const mod = await importModule();

    await mod.syncAgentUniversalSecretsByIdentifier('ag-does-not-exist');

    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined();
  });

  it('end-to-end: PUT failure is swallowed (does not throw to caller)', async () => {
    setupFetch({ sundayAssigned: [], failPut: true });
    const mod = await importModule();

    await expect(mod.syncAgentUniversalSecretsByIdentifier('ag-sunday')).resolves.toBeUndefined();
  });

  it('startup backfill: iterates every agent', async () => {
    setupFetch({ sundayAssigned: [], otherAssigned: [] });
    const mod = await importModule();

    await mod.syncAllAgentsUniversalSecrets();

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts.map((p) => p.url)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/api/agents/uuid-sunday/secrets'),
        expect.stringContaining('/api/agents/uuid-other/secrets'),
      ]),
    );
  });
});
