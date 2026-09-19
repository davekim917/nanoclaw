import { readFileSync } from 'fs';

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

import {
  applyOnecliSecrets,
  ensureOnecliAgent,
  mergeWorkgroupAndGroupSecrets,
  resolveSecretUuids,
  slackUserTokenSecrets,
  typesafeKeyPlaceholderEnv,
  __resetCachesForTest,
  __setSecretsCacheForTest,
  __test,
} from './onecli-secrets.js';

// Mock child_process so tests never call the local gateway or spawn a real
// process. `execFileSync` is mocked too — not because the module may use it,
// but so the tripwire below can prove it never does.
// Hoisted via vi.mock so it applies before the module imports.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    execSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

import { execFile, execFileSync, execSync, spawnSync } from 'child_process';

// Type-safe handles to the mocked functions. `mockedExec` keeps the historic
// name and the historic `[bin, argv]` call shape — `execFile`'s first two
// parameters are the same as `execFileSync`'s.
const mockedExec = vi.mocked(execFile) as unknown as ReturnType<typeof vi.fn>;
const syncSpies = [vi.mocked(execFileSync), vi.mocked(execSync), vi.mocked(spawnSync)];

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

/**
 * Adapts a `(bin, argv) => stdout` responder to `execFile`'s callback shape,
 * answering on a later microtask so the tests exercise the real asynchrony.
 */
function toCallbackImpl(fn: (bin: unknown, argv: unknown) => string) {
  return (bin: unknown, argv: unknown, _options: unknown, callback: unknown) => {
    const done = callback as ExecFileCallback;
    const out = fn(bin, argv);
    queueMicrotask(() => done(null, out, ''));
    return undefined;
  };
}

function respond(fn: (bin: unknown, argv: unknown) => string): void {
  mockedExec.mockImplementation(toCallbackImpl(fn));
}

function respondOnce(fn: (bin: unknown, argv: unknown) => string): void {
  mockedExec.mockImplementationOnce(toCallbackImpl(fn));
}

/**
 * Like `respond`, but every call parks until the test releases it. Lets a test
 * hold a listing open while other callers arrive, which is the only way to
 * observe whether concurrent misses coalesce onto one request.
 */
function respondDeferred(fn: (bin: unknown, argv: unknown) => string): { releaseAll: () => void; parked: number } {
  const waiting: Array<() => void> = [];
  const state = {
    releaseAll: () => {
      const pending = waiting.splice(0, waiting.length);
      for (const release of pending) release();
    },
    get parked() {
      return waiting.length;
    },
  };
  mockedExec.mockImplementation((bin: unknown, argv: unknown, _options: unknown, callback: unknown) => {
    const done = callback as ExecFileCallback;
    waiting.push(() => done(null, fn(bin, argv), ''));
    return undefined;
  });
  return state as { releaseAll: () => void; parked: number };
}

// OneCLI gateway calls go through curl. These predicates match an
// execFileSync call shaped as [bin, args].
const isAgentsListCall = (c: unknown[]): boolean =>
  c[0] === 'curl' &&
  (c[1] as string[]).some((a) => String(a).includes('/api/agents?')) &&
  !(c[1] as string[]).some((a) => String(a).includes('/grants'));
const isSecretsListCall = (c: unknown[]): boolean =>
  c[0] === 'curl' && (c[1] as string[]).some((a) => String(a).includes('/api/secrets'));
const isAgentGrantsCall = (c: unknown[]): boolean =>
  c[0] === 'curl' && (c[1] as string[]).some((a) => String(a).includes('/grants'));
const isAgentCreateCall = (c: unknown[]): boolean =>
  c[0] === 'curl' && (c[1] as string[]).some((a) => String(a).includes('/v1/agents'));
const grantMutation = (c: unknown[]): { method: string; url: string } | undefined => {
  if (c[0] !== 'curl') return undefined;
  const argv = c[1] as string[];
  const methodIndex = argv.indexOf('-X');
  const method = methodIndex >= 0 ? argv[methodIndex + 1] : undefined;
  const url = argv.find((arg) => arg.includes('/grants/secrets/'));
  return method && url ? { method, url } : undefined;
};

beforeEach(() => {
  __resetCachesForTest();
  mockedExec.mockReset();
  for (const spy of syncSpies) spy.mockReset();
});

afterEach(() => {
  // Tripwire: nothing in this module may reach a BLOCKING child_process call.
  // A sync curl here parks the host event loop for the whole gateway round
  // trip on every container spawn — issue #315.
  for (const spy of syncSpies) expect(spy).not.toHaveBeenCalled();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const AGENT_FIXTURE = {
  data: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'example-retail',
      identifier: 'example-retail',
      secretMode: 'selective',
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'helper-codex',
      identifier: 'example-labs-codex',
      secretMode: 'all',
    },
  ],
};

const SECRET_FIXTURE = {
  data: [
    { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Datafold-ExampleRetail' },
    { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Fivetran-ExampleRetail' },
    { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'Hex' },
    { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', name: 'Anthropic' },
  ],
};

function setupCliResponses(): void {
  respond((bin: unknown, rawArgs: unknown) => {
    const argv = (rawArgs ?? []) as string[];
    // LIST ops go through the gateway API via curl; route by the URL in argv.
    if (bin === 'curl') {
      const url = argv.join(' ');
      if (url.includes('/grants')) {
        const agentId = url.match(/\/api\/agents\/([^/]+)\/grants/)?.[1];
        return JSON.stringify({ agentId, mode: 'grants', connections: [], secrets: [] });
      }
      if (url.includes('/api/agents')) return JSON.stringify(AGENT_FIXTURE);
      if (url.includes('/api/secrets')) return JSON.stringify(SECRET_FIXTURE);
      return '';
    }
    return '';
  });
}

describe('isUuid', async () => {
  test('accepts canonical UUID', async () => {
    expect(__test.isUuid('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(true);
  });

  test('accepts mixed-case hex', async () => {
    expect(__test.isUuid('AAaaAAaa-AAAA-aaaa-AAAA-aaaaAAAAaaaa')).toBe(true);
  });

  test('rejects non-UUID strings (secret names)', async () => {
    expect(__test.isUuid('Datafold-ExampleRetail')).toBe(false);
    expect(__test.isUuid('Anthropic')).toBe(false);
    expect(__test.isUuid('')).toBe(false);
  });

  test('rejects malformed UUIDs', async () => {
    expect(__test.isUuid('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa')).toBe(false); // short
    expect(__test.isUuid('zzzzzzzz-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(false); // bad hex
  });
});

describe('applyOnecliSecrets — no-op paths', async () => {
  test('does nothing when declarations is undefined', async () => {
    await applyOnecliSecrets('example-retail', undefined);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  test('does nothing when declarations is empty', async () => {
    await applyOnecliSecrets('example-retail', []);
    expect(mockedExec).not.toHaveBeenCalled();
  });
});

describe('ensureOnecliAgent', async () => {
  test('lists once and skips create for an existing agent, then reuses the cache', async () => {
    setupCliResponses();

    await expect(ensureOnecliAgent({ name: 'Example Retail', identifier: 'example-retail' })).resolves.toEqual({
      name: 'Example Retail',
      identifier: 'example-retail',
      created: false,
    });
    await expect(ensureOnecliAgent({ name: 'Example Retail', identifier: 'example-retail' })).resolves.toEqual({
      name: 'Example Retail',
      identifier: 'example-retail',
      created: false,
    });

    expect(mockedExec.mock.calls.filter(isAgentsListCall)).toHaveLength(1);
    expect(mockedExec.mock.calls.filter(isAgentCreateCall)).toHaveLength(0);
  });

  test('creates a missing agent once and caches the returned UUID', async () => {
    respond((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      const url = argv.join(' ');
      if (url.includes('/api/agents?')) return JSON.stringify({ data: [] });
      if (url.includes('/v1/agents')) {
        return `${JSON.stringify({
          id: '33333333-3333-3333-3333-333333333333',
          name: 'New Agent',
          identifier: 'new-agent',
        })}\n201`;
      }
      return '';
    });

    await expect(ensureOnecliAgent({ name: 'New Agent', identifier: 'new-agent' })).resolves.toEqual({
      name: 'New Agent',
      identifier: 'new-agent',
      created: true,
    });
    expect((await ensureOnecliAgent({ name: 'New Agent', identifier: 'new-agent' })).created).toBe(false);
    expect(mockedExec.mock.calls.filter(isAgentsListCall)).toHaveLength(1);
    expect(mockedExec.mock.calls.filter(isAgentCreateCall)).toHaveLength(1);
  });

  test('treats a create race returning 409 as success only after the agent is visible', async () => {
    let listCalls = 0;
    respond((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      const url = argv.join(' ');
      if (url.includes('/api/agents?')) {
        listCalls++;
        return listCalls === 1
          ? JSON.stringify({ data: [] })
          : JSON.stringify({
              data: [
                {
                  id: '33333333-3333-3333-3333-333333333333',
                  name: 'Raced Agent',
                  identifier: 'raced-agent',
                },
              ],
            });
      }
      if (url.includes('/v1/agents')) return `${JSON.stringify({ error: 'already exists' })}\n409`;
      return '';
    });

    expect((await ensureOnecliAgent({ name: 'Raced Agent', identifier: 'raced-agent' })).created).toBe(false);
    expect(listCalls).toBe(2);
  });

  test('fails closed on an unexpected create response', async () => {
    respond((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      const url = argv.join(' ');
      if (url.includes('/api/agents?')) return JSON.stringify({ data: [] });
      if (url.includes('/v1/agents')) return `${JSON.stringify({ error: 'unavailable' })}\n503`;
      return '';
    });

    await expect(ensureOnecliAgent({ name: 'New Agent', identifier: 'new-agent' })).rejects.toThrow(
      /OneCLI agent create failed with HTTP 503/,
    );
  });
});

describe('applyOnecliSecrets — happy path', async () => {
  test('uses the grants API instead of removed legacy OneCLI agent commands', async () => {
    setupCliResponses();

    await applyOnecliSecrets('example-retail', ['Anthropic']);

    expect(mockedExec.mock.calls.some(isAgentGrantsCall)).toBe(true);
    expect(mockedExec.mock.calls.some((c) => c[0] === 'onecli')).toBe(false);
  });

  test('resolves names to UUIDs and attaches each missing secret grant', async () => {
    setupCliResponses();

    await applyOnecliSecrets('example-retail', ['Datafold-ExampleRetail', 'Hex', 'Anthropic']);

    const rawCalls = mockedExec.mock.calls;

    // Order: agents list (UUID resolution) → secrets list (name resolution)
    // → grants read → missing grant mutations, all via the gateway API.
    const agentsListIdx = rawCalls.findIndex(isAgentsListCall);
    const secretsListIdx = rawCalls.findIndex(isSecretsListCall);
    const grantsIdx = rawCalls.findIndex(isAgentGrantsCall);
    expect(agentsListIdx).toBeGreaterThanOrEqual(0);
    expect(secretsListIdx).toBeGreaterThan(agentsListIdx);
    expect(grantsIdx).toBeGreaterThan(secretsListIdx);

    expect(rawCalls.map(grantMutation).filter(Boolean)).toEqual([
      {
        method: 'PUT',
        url: 'http://127.0.0.1:10254/api/agents/11111111-1111-1111-1111-111111111111/grants/secrets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
      {
        method: 'PUT',
        url: 'http://127.0.0.1:10254/api/agents/11111111-1111-1111-1111-111111111111/grants/secrets/cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      {
        method: 'PUT',
        url: 'http://127.0.0.1:10254/api/agents/11111111-1111-1111-1111-111111111111/grants/secrets/dddddddd-dddd-dddd-dddd-dddddddddddd',
      },
    ]);
  });

  test('accepts UUIDs passed directly in declarations', async () => {
    setupCliResponses();

    await applyOnecliSecrets('example-retail', ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);

    const mutations = mockedExec.mock.calls.map(grantMutation).filter(Boolean);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.url).toContain('/grants/secrets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  test('mixes names and UUIDs in a single call', async () => {
    setupCliResponses();

    await applyOnecliSecrets('example-retail', ['Datafold-ExampleRetail', 'cccccccc-cccc-cccc-cccc-cccccccccccc']);

    const urls = mockedExec.mock.calls
      .map(grantMutation)
      .filter((mutation): mutation is { method: string; url: string } => Boolean(mutation))
      .map((mutation) => mutation.url);
    expect(urls).toEqual([
      expect.stringContaining('/grants/secrets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      expect.stringContaining('/grants/secrets/cccccccc-cccc-cccc-cccc-cccccccccccc'),
    ]);
  });

  test('removes undeclared secret grants before adding missing grants without touching connections', async () => {
    respond((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      const url = argv.join(' ');
      if (url.includes('/grants')) {
        return JSON.stringify({
          agentId: '11111111-1111-1111-1111-111111111111',
          mode: 'grants',
          connections: [{ connectionId: 'connection-that-must-not-change' }],
          secrets: [
            { secretId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
            { secretId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
          ],
        });
      }
      if (url.includes('/api/agents')) return JSON.stringify(AGENT_FIXTURE);
      if (url.includes('/api/secrets')) return JSON.stringify(SECRET_FIXTURE);
      return '';
    });

    await applyOnecliSecrets('example-retail', ['Datafold-ExampleRetail', 'Anthropic']);

    expect(mockedExec.mock.calls.map(grantMutation).filter(Boolean)).toEqual([
      {
        method: 'DELETE',
        url: 'http://127.0.0.1:10254/api/agents/11111111-1111-1111-1111-111111111111/grants/secrets/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      },
      {
        method: 'PUT',
        url: 'http://127.0.0.1:10254/api/agents/11111111-1111-1111-1111-111111111111/grants/secrets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
    ]);
    expect(mockedExec.mock.calls.flatMap((call) => call[1] as string[]).join(' ')).not.toContain(
      'connection-that-must-not-change',
    );
  });
});

describe('applyOnecliSecrets — fail-closed paths', async () => {
  test("throws when agent identifier doesn't exist in vault", async () => {
    setupCliResponses();

    await expect(applyOnecliSecrets('does-not-exist', ['Anthropic'])).rejects.toThrow(
      /agent with identifier "does-not-exist" not found/,
    );
    expect(mockedExec.mock.calls.map(grantMutation).filter(Boolean)).toHaveLength(0);
  });

  test("throws when a declared secret NAME doesn't resolve", async () => {
    setupCliResponses();

    await expect(applyOnecliSecrets('example-retail', ['Datafold-ExampleRetail', 'Mistyped-Name'])).rejects.toThrow(
      /secret\(s\) not found in vault: Mistyped-Name/,
    );
    // No grant mutation should have been issued — fail-closed before apply.
    expect(mockedExec.mock.calls.map(grantMutation).filter(Boolean)).toHaveLength(0);
  });

  test("throws when a declared UUID doesn't exist in vault", async () => {
    setupCliResponses();
    const phantomUuid = '99999999-9999-9999-9999-999999999999';

    await expect(applyOnecliSecrets('example-retail', [phantomUuid])).rejects.toThrow(
      new RegExp(`secret\\(s\\) not found in vault: ${phantomUuid}`),
    );
  });

  test('reports ALL unresolvable names in one error', async () => {
    setupCliResponses();

    await expect(applyOnecliSecrets('example-retail', ['Bad-One', 'Anthropic', 'Bad-Two'])).rejects.toThrow(
      /Bad-One, Bad-Two/,
    );
  });

  test('throws without mutating when the grants response is malformed', async () => {
    setupCliResponses();
    respondOnce(() => JSON.stringify(AGENT_FIXTURE));
    respondOnce(() => JSON.stringify(SECRET_FIXTURE));
    respondOnce(() => JSON.stringify({ mode: 'grants', connections: [], secrets: [] }));

    await expect(applyOnecliSecrets('example-retail', ['Anthropic'])).rejects.toThrow(
      /Malformed OneCLI grants response/,
    );
    expect(mockedExec.mock.calls.map(grantMutation).filter(Boolean)).toHaveLength(0);
  });
});

describe('applyOnecliSecrets — caching', async () => {
  test('reuses cached identifier→UUID after first lookup', async () => {
    setupCliResponses();

    await applyOnecliSecrets('example-retail', ['Anthropic']);
    const firstCallCount = mockedExec.mock.calls.filter(isAgentsListCall).length;

    await applyOnecliSecrets('example-retail', ['Hex']);
    const secondCallCount = mockedExec.mock.calls.filter(isAgentsListCall).length;

    // First call populated the cache; second call should NOT re-list agents.
    expect(secondCallCount).toBe(firstCallCount);
  });

  test('cache miss triggers refresh of agents list', async () => {
    // First call resolves 'example-retail'. Then we add a NEW agent fixture
    // that contains an identifier we'll ask for — the cache miss should
    // re-issue `agents list` and discover it.
    let callsToAgentsList = 0;
    respond((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin === 'curl') {
        const url = argv.join(' ');
        if (url.includes('/grants')) {
          const agentId = url.match(/\/api\/agents\/([^/]+)\/grants/)?.[1];
          return JSON.stringify({ agentId, mode: 'grants', connections: [], secrets: [] });
        }
        if (url.includes('/api/agents')) {
          callsToAgentsList++;
          if (callsToAgentsList === 1) return JSON.stringify(AGENT_FIXTURE);
          // Second call: include a new agent
          return JSON.stringify({
            data: [
              ...AGENT_FIXTURE.data,
              {
                id: '33333333-3333-3333-3333-333333333333',
                name: 'newly-created',
                identifier: 'newly-created-identifier',
                secretMode: 'selective',
              },
            ],
          });
        }
        if (url.includes('/api/secrets')) return JSON.stringify(SECRET_FIXTURE);
        return '';
      }
      return '';
    });

    await applyOnecliSecrets('example-retail', ['Anthropic']);
    expect(callsToAgentsList).toBe(1);

    await applyOnecliSecrets('newly-created-identifier', ['Anthropic']);
    expect(callsToAgentsList).toBe(2);
  });
});

describe('mergeWorkgroupAndGroupSecrets — C3', async () => {
  test('test_merge_workgroup_baseline_plus_group_additive', async () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Datafold-Example Labs']);
    expect(result).toEqual(['Anthropic', 'Exa', 'Datafold-Example Labs']);
  });

  test('test_merge_dedup_when_group_repeats_workgroup_secret', async () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Anthropic', 'Datafold-Example Labs']);
    // Anthropic appears in both — only one copy in output, workgroup order preserved
    expect(result).toEqual(['Anthropic', 'Exa', 'Datafold-Example Labs']);
  });

  test('test_merge_empty_workgroup_passes_through', async () => {
    const result = mergeWorkgroupAndGroupSecrets([], ['Datafold-Example Labs']);
    expect(result).toEqual(['Datafold-Example Labs']);
  });

  test('test_merge_empty_group_passes_through', async () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], []);
    expect(result).toEqual(['Anthropic', 'Exa']);
  });

  test('test_merge_per_group_cannot_subtract', async () => {
    // Per-group list is additive only — cannot remove workgroup secrets
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Datafold-Example Labs']);
    // Anthropic + Exa from workgroup MUST be present
    expect(result).toContain('Anthropic');
    expect(result).toContain('Exa');
    expect(result).toContain('Datafold-Example Labs');
  });

  test('handles undefined workgroup secrets', async () => {
    const result = mergeWorkgroupAndGroupSecrets(undefined, ['Datafold-Example Labs']);
    expect(result).toEqual(['Datafold-Example Labs']);
  });

  test('handles undefined group secrets', async () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic'], undefined);
    expect(result).toEqual(['Anthropic']);
  });

  test('handles both undefined', async () => {
    const result = mergeWorkgroupAndGroupSecrets(undefined, undefined);
    expect(result).toEqual([]);
  });
});

describe('slackUserTokenSecrets', async () => {
  const merged = ['Anthropic', 'Slack-User-Token-example-retail', 'Slack-Bot-Token-Example-Retail', 'GranolaAPI'];

  test('convention match selects the user-token secret, not the bot token', async () => {
    expect(slackUserTokenSecrets(merged)).toEqual(['Slack-User-Token-example-retail']);
  });

  test('convention is case-insensitive', async () => {
    expect(slackUserTokenSecrets(['slack-USER-token-x'])).toEqual(['slack-USER-token-x']);
  });

  test('explicit names take precedence over the convention', async () => {
    // An explicitly-named secret that does NOT match the convention is still
    // selected; a convention-matching secret NOT in the explicit list is not.
    expect(
      slackUserTokenSecrets(['Slack-Example-Retail', 'Slack-User-Token-example-retail'], ['Slack-Example-Retail']),
    ).toEqual(['Slack-Example-Retail']);
  });

  test('explicit match is case-insensitive and returns names as they appear', async () => {
    expect(slackUserTokenSecrets(['Slack-Example-Retail'], ['slack-example-retail'])).toEqual(['Slack-Example-Retail']);
  });

  test('no match returns empty', async () => {
    expect(slackUserTokenSecrets(['Anthropic', 'GranolaAPI'])).toEqual([]);
    expect(slackUserTokenSecrets([])).toEqual([]);
  });

  test('empty explicit list falls back to convention', async () => {
    expect(slackUserTokenSecrets(merged, [])).toEqual(['Slack-User-Token-example-retail']);
  });
});

// ── #315 regression suite ────────────────────────────────────────────────────
//
// The host event loop stalled ~20×/hour (p50 18 s) because this module ran the
// OneCLI control-API calls with `execFileSync('curl', …)` on every container
// spawn. These tests hold the seam async and keep the fail-closed contract.

describe('#315 — no blocking child_process on the spawn path', () => {
  test('a full resolve/ensure/apply cycle never calls a sync child_process API', async () => {
    setupCliResponses();

    await ensureOnecliAgent({ name: 'Example Retail', identifier: 'example-retail' });
    await applyOnecliSecrets('example-retail', ['Anthropic', 'Hex']);

    // The afterEach tripwire asserts this too; stated here so the intent is
    // visible at the point of failure.
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
    expect(mockedExec).toHaveBeenCalled();
  });

  test('the module source contains no synchronous child_process call', () => {
    const source = readFileSync(new URL('./onecli-secrets.ts', import.meta.url), 'utf-8');
    // Call syntax, not the bare word — the prose above `curl()` names the old
    // API on purpose, to say why it is gone.
    for (const banned of ['execFileSync', 'execSync', 'spawnSync']) {
      expect(source).not.toMatch(new RegExp(`\\b${banned}\\s*\\(`));
    }
    // And it must not even import them.
    const importLine = source.match(/^import \{[^}]*\} from 'child_process';$/m)?.[0];
    expect(importLine).toBe("import { execFile } from 'child_process';");
  });

  test('the spawn path awaits both gateway calls', () => {
    const source = readFileSync(new URL('./container-runner.ts', import.meta.url), 'utf-8');
    expect(source).toContain('await ensureOnecliAgent(');
    expect(source).toContain('await applyOnecliSecrets(');
    // A bare call would silently drop the rejection and spawn uncredentialed.
    expect(source).not.toMatch(/(?<!await )(?<!\w)ensureOnecliAgent\(\{/);
    expect(source).not.toMatch(/(?<!await )(?<!\w)applyOnecliSecrets\(/);
  });

  test('both entry points return promises rather than blocking', () => {
    setupCliResponses();
    const ensured = ensureOnecliAgent({ name: 'Example Retail', identifier: 'example-retail' });
    const applied = applyOnecliSecrets('example-retail', ['Anthropic']);
    expect(ensured).toBeInstanceOf(Promise);
    expect(applied).toBeInstanceOf(Promise);
    return Promise.all([ensured, applied]);
  });
});

describe('#315 — secrets listing is cached, never at the cost of fail-closed', () => {
  test('a second spawn inside the TTL does not re-list secrets', async () => {
    setupCliResponses();

    await applyOnecliSecrets('example-retail', ['Anthropic']);
    expect(mockedExec.mock.calls.filter(isSecretsListCall)).toHaveLength(1);

    await applyOnecliSecrets('example-retail', ['Hex']);
    expect(mockedExec.mock.calls.filter(isSecretsListCall)).toHaveLength(1);
  });

  test('a secret added to the vault after the cache filled still resolves', async () => {
    let secretsListCalls = 0;
    respond((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      const url = argv.join(' ');
      if (url.includes('/grants')) {
        const agentId = url.match(/\/api\/agents\/([^/]+)\/grants/)?.[1];
        return JSON.stringify({ agentId, mode: 'grants', connections: [], secrets: [] });
      }
      if (url.includes('/api/agents')) return JSON.stringify(AGENT_FIXTURE);
      if (url.includes('/api/secrets')) {
        secretsListCalls++;
        if (secretsListCalls === 1) return JSON.stringify(SECRET_FIXTURE);
        return JSON.stringify({
          data: [...SECRET_FIXTURE.data, { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', name: 'Freshly-Added' }],
        });
      }
      return '';
    });

    await applyOnecliSecrets('example-retail', ['Anthropic']);
    expect(secretsListCalls).toBe(1);

    // Served from cache first, missed, force-refreshed, resolved — no throw.
    await applyOnecliSecrets('example-retail', ['Freshly-Added']);
    expect(secretsListCalls).toBe(2);
    expect(mockedExec.mock.calls.map(grantMutation).filter(Boolean)).toContainEqual({
      method: 'PUT',
      url: 'http://127.0.0.1:10254/api/agents/11111111-1111-1111-1111-111111111111/grants/secrets/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    });
  });

  test('a genuinely missing secret still fails closed after the forced refresh', async () => {
    setupCliResponses();

    await applyOnecliSecrets('example-retail', ['Anthropic']);
    const listsBefore = mockedExec.mock.calls.filter(isSecretsListCall).length;

    await expect(applyOnecliSecrets('example-retail', ['Never-Existed'])).rejects.toThrow(
      /secret\(s\) not found in vault: Never-Existed/,
    );
    // It re-read the vault before refusing, rather than trusting the cache.
    expect(mockedExec.mock.calls.filter(isSecretsListCall).length).toBe(listsBefore + 1);
    expect(mockedExec.mock.calls.map(grantMutation).filter(Boolean)).toHaveLength(1);
  });
});

describe('#315 — concurrent spawns of one identity stay serialized', () => {
  test('two overlapping applies do not union their grant sets', async () => {
    let grantsReads = 0;
    let granted: string[] = ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
    respond((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      const url = argv.join(' ');
      const mutation = grantMutation([bin, argv]);
      if (mutation) {
        const secretId = mutation.url.split('/grants/secrets/')[1];
        granted =
          mutation.method === 'PUT' ? [...new Set([...granted, secretId])] : granted.filter((id) => id !== secretId);
        return '';
      }
      if (url.includes('/grants')) {
        grantsReads++;
        return JSON.stringify({
          agentId: '11111111-1111-1111-1111-111111111111',
          mode: 'grants',
          connections: [],
          secrets: granted.map((secretId) => ({ secretId })),
        });
      }
      if (url.includes('/api/agents')) return JSON.stringify(AGENT_FIXTURE);
      if (url.includes('/api/secrets')) return JSON.stringify(SECRET_FIXTURE);
      return '';
    });

    // Interleaved without the lock, both would read `granted` before either
    // wrote, and the vault would end up holding BOTH sets.
    await Promise.all([
      applyOnecliSecrets('example-retail', ['Datafold-ExampleRetail']),
      applyOnecliSecrets('example-retail', ['Hex']),
    ]);

    expect(grantsReads).toBe(2);
    expect(granted).toEqual(['cccccccc-cccc-cccc-cccc-cccccccccccc']);
  });

  test('a failed apply does not wedge the next spawn of the same identity', async () => {
    setupCliResponses();

    await expect(applyOnecliSecrets('example-retail', ['Mistyped-Name'])).rejects.toThrow(/not found in vault/);
    await expect(applyOnecliSecrets('example-retail', ['Anthropic'])).resolves.toBeUndefined();
  });
});

describe('#315 — the secrets cache staleness window is bounded and specified', () => {
  /**
   * A cached HIT is only as fresh as the TTL, and a rename is the case that
   * shows it: the old declaration name keeps resolving until the entry expires.
   * That window is a deliberate trade against re-listing on every spawn (the
   * stall this PR removes), so it is pinned here rather than left to drift.
   */
  test('a renamed secret resolves from cache inside the TTL and fails closed after it', async () => {
    const startedAt = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);

    let renamed = false;
    respond((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      const url = argv.join(' ');
      if (url.includes('/grants')) {
        const agentId = url.match(/\/api\/agents\/([^/]+)\/grants/)?.[1];
        return JSON.stringify({ agentId, mode: 'grants', connections: [], secrets: [] });
      }
      if (url.includes('/api/agents')) return JSON.stringify(AGENT_FIXTURE);
      if (url.includes('/api/secrets')) {
        if (!renamed) return JSON.stringify(SECRET_FIXTURE);
        return JSON.stringify({
          data: SECRET_FIXTURE.data.map((secret) =>
            secret.name === 'Anthropic' ? { ...secret, name: 'Anthropic-Renamed' } : secret,
          ),
        });
      }
      return '';
    });

    await applyOnecliSecrets('example-retail', ['Anthropic']);
    renamed = true;

    // Inside the TTL: still resolves, to the same secret's unchanged UUID.
    // No widening — this is the UUID the operator's own declaration already
    // resolved to on the previous spawn.
    await expect(applyOnecliSecrets('example-retail', ['Anthropic'])).resolves.toBeUndefined();

    // Past the TTL: the stale entry is gone and the spawn fails closed.
    now.mockReturnValue(startedAt + 61 * 1000);
    await expect(applyOnecliSecrets('example-retail', ['Anthropic'])).rejects.toThrow(
      /secret\(s\) not found in vault: Anthropic/,
    );
  });
});

// ── #319 review r2 — concurrent cache refreshes coalesce ─────────────────────
//
// A host restart wakes many agent groups at once. The per-identity lock does
// not serialize them, because they hold different identities, so without
// single-flight every one of them sees the same empty cache and starts its own
// `?limit=10000` listing.

describe('#319 review r2 — cold-cache stampede', () => {
  test('concurrent agent-cache misses issue exactly one agents listing', async () => {
    const deferred = respondDeferred((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      return argv.join(' ').includes('/api/agents') ? JSON.stringify(AGENT_FIXTURE) : '';
    });

    // Eight distinct identities, so the per-identity lock cannot help.
    const identifiers = Array.from({ length: 8 }, (_, i) => `example-retail-${i}`);
    const pending = Promise.allSettled(
      identifiers.map((identifier) => ensureOnecliAgent({ name: identifier, identifier })),
    );

    // Let every caller reach the listing before any response arrives.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedExec.mock.calls.filter(isAgentsListCall)).toHaveLength(1);

    deferred.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    deferred.releaseAll();
    await pending;

    expect(mockedExec.mock.calls.filter(isAgentsListCall)).toHaveLength(1);
  });

  test('concurrent secret resolutions issue exactly one secrets listing', async () => {
    const deferred = respondDeferred((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      return argv.join(' ').includes('/api/secrets') ? JSON.stringify(SECRET_FIXTURE) : '';
    });

    const pending = Promise.all(Array.from({ length: 8 }, () => resolveSecretUuids(['Anthropic'])));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedExec.mock.calls.filter(isSecretsListCall)).toHaveLength(1);

    deferred.releaseAll();
    const resolved = await pending;

    expect(mockedExec.mock.calls.filter(isSecretsListCall)).toHaveLength(1);
    // Every caller gets the real answer, not a placeholder.
    for (const uuids of resolved) expect(uuids).toEqual(['dddddddd-dddd-dddd-dddd-dddddddddddd']);
  });

  test('a failed listing rejects its waiters and does not poison the next call', async () => {
    let attempt = 0;
    respond((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      if (!argv.join(' ').includes('/api/secrets')) return '';
      attempt++;
      if (attempt === 1) throw new Error('gateway unreachable');
      return JSON.stringify(SECRET_FIXTURE);
    });

    const results = await Promise.allSettled(Array.from({ length: 4 }, () => resolveSecretUuids(['Anthropic'])));
    // Fail-closed: nobody proceeds on a listing that never arrived.
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(attempt).toBe(1);

    // The in-flight entry is cleared, so the next caller retries rather than
    // inheriting the failure forever.
    await expect(resolveSecretUuids(['Anthropic'])).resolves.toEqual(['dddddddd-dddd-dddd-dddd-dddddddddddd']);
    expect(attempt).toBe(2);
  });

  test('a forced refresh does not join a listing that started before it', async () => {
    // Cache warmed WITHOUT the secret, so the next resolution misses and forces.
    let listings = 0;
    respond((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      if (!argv.join(' ').includes('/api/secrets')) return '';
      listings++;
      if (listings === 1) return JSON.stringify(SECRET_FIXTURE);
      return JSON.stringify({
        data: [...SECRET_FIXTURE.data, { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', name: 'Added-Late' }],
      });
    });

    await resolveSecretUuids(['Anthropic']);
    expect(listings).toBe(1);

    // The forced re-read must be its own request. Joining an in-flight listing
    // that began before the miss could return pre-addition data and refuse a
    // spawn for a secret that exists.
    await expect(resolveSecretUuids(['Added-Late'])).resolves.toEqual(['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee']);
    expect(listings).toBe(2);
  });
});

describe('typesafeKeyPlaceholderEnv — gated on the api.typesafe.ai grant', () => {
  const typesafe = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    name: 'TypeSafe',
    type: 'generic',
    hostPattern: 'api.typesafe.ai',
    pathPattern: null,
  };
  const other = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    name: 'Pocket',
    type: 'generic',
    hostPattern: 'public.heypocketai.com',
    pathPattern: null,
  };
  beforeEach(() => __setSecretsCacheForTest([typesafe, other] as never));

  test('a Claude container granted TypeSafe gets a placeholder key', () => {
    expect(typesafeKeyPlaceholderEnv('claude', ['Pocket', 'TypeSafe'])).toEqual([
      '-e',
      'TYPESAFE_API_KEY=onecli-gateway-injected',
    ]);
  });

  test('a grant by UUID counts the same as by name', () => {
    expect(typesafeKeyPlaceholderEnv('claude', [typesafe.id])).toHaveLength(2);
  });

  test("no TypeSafe grant, no key: the plugin never sends that group's text", () => {
    expect(typesafeKeyPlaceholderEnv('claude', ['Pocket'])).toEqual([]);
    expect(typesafeKeyPlaceholderEnv('claude', [])).toEqual([]);
  });

  test('non-Claude providers never get it', () => {
    expect(typesafeKeyPlaceholderEnv('codex', ['TypeSafe'])).toEqual([]);
    expect(typesafeKeyPlaceholderEnv('opencode', ['TypeSafe'])).toEqual([]);
  });

  test('a cold cache yields no key (safe fallback, not a throw)', () => {
    __resetCachesForTest();
    expect(typesafeKeyPlaceholderEnv('claude', ['TypeSafe'])).toEqual([]);
  });
});
