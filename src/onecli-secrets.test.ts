import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

import {
  applyOnecliSecrets,
  ensureOnecliAgent,
  mergeWorkgroupAndGroupSecrets,
  slackUserTokenSecrets,
  __resetCachesForTest,
  __test,
} from './onecli-secrets.js';

// Mock child_process.execFileSync so tests never call the local gateway.
// Hoisted via vi.mock so it applies before the module imports.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from 'child_process';

// Type-safe handle to the mocked function.
const mockedExec = vi.mocked(execFileSync);

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
  mockedExec.mockImplementation((bin: unknown, rawArgs: unknown) => {
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

describe('isUuid', () => {
  test('accepts canonical UUID', () => {
    expect(__test.isUuid('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(true);
  });

  test('accepts mixed-case hex', () => {
    expect(__test.isUuid('AAaaAAaa-AAAA-aaaa-AAAA-aaaaAAAAaaaa')).toBe(true);
  });

  test('rejects non-UUID strings (secret names)', () => {
    expect(__test.isUuid('Datafold-ExampleRetail')).toBe(false);
    expect(__test.isUuid('Anthropic')).toBe(false);
    expect(__test.isUuid('')).toBe(false);
  });

  test('rejects malformed UUIDs', () => {
    expect(__test.isUuid('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa')).toBe(false); // short
    expect(__test.isUuid('zzzzzzzz-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(false); // bad hex
  });
});

describe('applyOnecliSecrets — no-op paths', () => {
  test('does nothing when declarations is undefined', () => {
    applyOnecliSecrets('example-retail', undefined);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  test('does nothing when declarations is empty', () => {
    applyOnecliSecrets('example-retail', []);
    expect(mockedExec).not.toHaveBeenCalled();
  });
});

describe('ensureOnecliAgent', () => {
  test('lists once and skips create for an existing agent, then reuses the cache', () => {
    setupCliResponses();

    expect(ensureOnecliAgent({ name: 'Example Retail', identifier: 'example-retail' })).toEqual({
      name: 'Example Retail',
      identifier: 'example-retail',
      created: false,
    });
    expect(ensureOnecliAgent({ name: 'Example Retail', identifier: 'example-retail' })).toEqual({
      name: 'Example Retail',
      identifier: 'example-retail',
      created: false,
    });

    expect(mockedExec.mock.calls.filter(isAgentsListCall)).toHaveLength(1);
    expect(mockedExec.mock.calls.filter(isAgentCreateCall)).toHaveLength(0);
  });

  test('creates a missing agent once and caches the returned UUID', () => {
    mockedExec.mockImplementation((bin: unknown, rawArgs: unknown) => {
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

    expect(ensureOnecliAgent({ name: 'New Agent', identifier: 'new-agent' })).toEqual({
      name: 'New Agent',
      identifier: 'new-agent',
      created: true,
    });
    expect(ensureOnecliAgent({ name: 'New Agent', identifier: 'new-agent' }).created).toBe(false);
    expect(mockedExec.mock.calls.filter(isAgentsListCall)).toHaveLength(1);
    expect(mockedExec.mock.calls.filter(isAgentCreateCall)).toHaveLength(1);
  });

  test('treats a create race returning 409 as success only after the agent is visible', () => {
    let listCalls = 0;
    mockedExec.mockImplementation((bin: unknown, rawArgs: unknown) => {
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

    expect(ensureOnecliAgent({ name: 'Raced Agent', identifier: 'raced-agent' }).created).toBe(false);
    expect(listCalls).toBe(2);
  });

  test('fails closed on an unexpected create response', () => {
    mockedExec.mockImplementation((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin !== 'curl') return '';
      const url = argv.join(' ');
      if (url.includes('/api/agents?')) return JSON.stringify({ data: [] });
      if (url.includes('/v1/agents')) return `${JSON.stringify({ error: 'unavailable' })}\n503`;
      return '';
    });

    expect(() => ensureOnecliAgent({ name: 'New Agent', identifier: 'new-agent' })).toThrow(
      /OneCLI agent create failed with HTTP 503/,
    );
  });
});

describe('applyOnecliSecrets — happy path', () => {
  test('uses the grants API instead of removed legacy OneCLI agent commands', () => {
    setupCliResponses();

    applyOnecliSecrets('example-retail', ['Anthropic']);

    expect(mockedExec.mock.calls.some(isAgentGrantsCall)).toBe(true);
    expect(mockedExec.mock.calls.some((c) => c[0] === 'onecli')).toBe(false);
  });

  test('resolves names to UUIDs and attaches each missing secret grant', () => {
    setupCliResponses();

    applyOnecliSecrets('example-retail', ['Datafold-ExampleRetail', 'Hex', 'Anthropic']);

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

  test('accepts UUIDs passed directly in declarations', () => {
    setupCliResponses();

    applyOnecliSecrets('example-retail', ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);

    const mutations = mockedExec.mock.calls.map(grantMutation).filter(Boolean);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.url).toContain('/grants/secrets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  test('mixes names and UUIDs in a single call', () => {
    setupCliResponses();

    applyOnecliSecrets('example-retail', ['Datafold-ExampleRetail', 'cccccccc-cccc-cccc-cccc-cccccccccccc']);

    const urls = mockedExec.mock.calls
      .map(grantMutation)
      .filter((mutation): mutation is { method: string; url: string } => Boolean(mutation))
      .map((mutation) => mutation.url);
    expect(urls).toEqual([
      expect.stringContaining('/grants/secrets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      expect.stringContaining('/grants/secrets/cccccccc-cccc-cccc-cccc-cccccccccccc'),
    ]);
  });

  test('removes undeclared secret grants before adding missing grants without touching connections', () => {
    mockedExec.mockImplementation((bin: unknown, rawArgs: unknown) => {
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

    applyOnecliSecrets('example-retail', ['Datafold-ExampleRetail', 'Anthropic']);

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

describe('applyOnecliSecrets — fail-closed paths', () => {
  test("throws when agent identifier doesn't exist in vault", () => {
    setupCliResponses();

    expect(() => applyOnecliSecrets('does-not-exist', ['Anthropic'])).toThrow(
      /agent with identifier "does-not-exist" not found/,
    );
    expect(mockedExec.mock.calls.map(grantMutation).filter(Boolean)).toHaveLength(0);
  });

  test("throws when a declared secret NAME doesn't resolve", () => {
    setupCliResponses();

    expect(() => applyOnecliSecrets('example-retail', ['Datafold-ExampleRetail', 'Mistyped-Name'])).toThrow(
      /secret\(s\) not found in vault: Mistyped-Name/,
    );
    // No grant mutation should have been issued — fail-closed before apply.
    expect(mockedExec.mock.calls.map(grantMutation).filter(Boolean)).toHaveLength(0);
  });

  test("throws when a declared UUID doesn't exist in vault", () => {
    setupCliResponses();
    const phantomUuid = '99999999-9999-9999-9999-999999999999';

    expect(() => applyOnecliSecrets('example-retail', [phantomUuid])).toThrow(
      new RegExp(`secret\\(s\\) not found in vault: ${phantomUuid}`),
    );
  });

  test('reports ALL unresolvable names in one error', () => {
    setupCliResponses();

    expect(() => applyOnecliSecrets('example-retail', ['Bad-One', 'Anthropic', 'Bad-Two'])).toThrow(/Bad-One, Bad-Two/);
  });

  test('throws without mutating when the grants response is malformed', () => {
    setupCliResponses();
    mockedExec.mockImplementationOnce(() => JSON.stringify(AGENT_FIXTURE));
    mockedExec.mockImplementationOnce(() => JSON.stringify(SECRET_FIXTURE));
    mockedExec.mockImplementationOnce(() => JSON.stringify({ mode: 'grants', connections: [], secrets: [] }));

    expect(() => applyOnecliSecrets('example-retail', ['Anthropic'])).toThrow(/Malformed OneCLI grants response/);
    expect(mockedExec.mock.calls.map(grantMutation).filter(Boolean)).toHaveLength(0);
  });
});

describe('applyOnecliSecrets — caching', () => {
  test('reuses cached identifier→UUID after first lookup', () => {
    setupCliResponses();

    applyOnecliSecrets('example-retail', ['Anthropic']);
    const firstCallCount = mockedExec.mock.calls.filter(isAgentsListCall).length;

    applyOnecliSecrets('example-retail', ['Hex']);
    const secondCallCount = mockedExec.mock.calls.filter(isAgentsListCall).length;

    // First call populated the cache; second call should NOT re-list agents.
    expect(secondCallCount).toBe(firstCallCount);
  });

  test('cache miss triggers refresh of agents list', () => {
    // First call resolves 'example-retail'. Then we add a NEW agent fixture
    // that contains an identifier we'll ask for — the cache miss should
    // re-issue `agents list` and discover it.
    let callsToAgentsList = 0;
    mockedExec.mockImplementation((bin: unknown, rawArgs: unknown) => {
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

    applyOnecliSecrets('example-retail', ['Anthropic']);
    expect(callsToAgentsList).toBe(1);

    applyOnecliSecrets('newly-created-identifier', ['Anthropic']);
    expect(callsToAgentsList).toBe(2);
  });
});

describe('mergeWorkgroupAndGroupSecrets — C3', () => {
  test('test_merge_workgroup_baseline_plus_group_additive', () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Datafold-Example Labs']);
    expect(result).toEqual(['Anthropic', 'Exa', 'Datafold-Example Labs']);
  });

  test('test_merge_dedup_when_group_repeats_workgroup_secret', () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Anthropic', 'Datafold-Example Labs']);
    // Anthropic appears in both — only one copy in output, workgroup order preserved
    expect(result).toEqual(['Anthropic', 'Exa', 'Datafold-Example Labs']);
  });

  test('test_merge_empty_workgroup_passes_through', () => {
    const result = mergeWorkgroupAndGroupSecrets([], ['Datafold-Example Labs']);
    expect(result).toEqual(['Datafold-Example Labs']);
  });

  test('test_merge_empty_group_passes_through', () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], []);
    expect(result).toEqual(['Anthropic', 'Exa']);
  });

  test('test_merge_per_group_cannot_subtract', () => {
    // Per-group list is additive only — cannot remove workgroup secrets
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Datafold-Example Labs']);
    // Anthropic + Exa from workgroup MUST be present
    expect(result).toContain('Anthropic');
    expect(result).toContain('Exa');
    expect(result).toContain('Datafold-Example Labs');
  });

  test('handles undefined workgroup secrets', () => {
    const result = mergeWorkgroupAndGroupSecrets(undefined, ['Datafold-Example Labs']);
    expect(result).toEqual(['Datafold-Example Labs']);
  });

  test('handles undefined group secrets', () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic'], undefined);
    expect(result).toEqual(['Anthropic']);
  });

  test('handles both undefined', () => {
    const result = mergeWorkgroupAndGroupSecrets(undefined, undefined);
    expect(result).toEqual([]);
  });
});

describe('slackUserTokenSecrets', () => {
  const merged = ['Anthropic', 'Slack-User-Token-example-retail', 'Slack-Bot-Token-Example-Retail', 'GranolaAPI'];

  test('convention match selects the user-token secret, not the bot token', () => {
    expect(slackUserTokenSecrets(merged)).toEqual(['Slack-User-Token-example-retail']);
  });

  test('convention is case-insensitive', () => {
    expect(slackUserTokenSecrets(['slack-USER-token-x'])).toEqual(['slack-USER-token-x']);
  });

  test('explicit names take precedence over the convention', () => {
    // An explicitly-named secret that does NOT match the convention is still
    // selected; a convention-matching secret NOT in the explicit list is not.
    expect(
      slackUserTokenSecrets(['Slack-Example-Retail', 'Slack-User-Token-example-retail'], ['Slack-Example-Retail']),
    ).toEqual(['Slack-Example-Retail']);
  });

  test('explicit match is case-insensitive and returns names as they appear', () => {
    expect(slackUserTokenSecrets(['Slack-Example-Retail'], ['slack-example-retail'])).toEqual(['Slack-Example-Retail']);
  });

  test('no match returns empty', () => {
    expect(slackUserTokenSecrets(['Anthropic', 'GranolaAPI'])).toEqual([]);
    expect(slackUserTokenSecrets([])).toEqual([]);
  });

  test('empty explicit list falls back to convention', () => {
    expect(slackUserTokenSecrets(merged, [])).toEqual(['Slack-User-Token-example-retail']);
  });
});
