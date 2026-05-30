import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

import {
  applyOnecliSecrets,
  mergeWorkgroupAndGroupSecrets,
  slackUserTokenSecrets,
  __resetCachesForTest,
  __test,
} from './onecli-secrets.js';

// Mock child_process.execFileSync so we don't actually shell out to `onecli`
// during tests. Hoisted via vi.mock so it applies before the module imports.
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

// LIST ops now go through the gateway API via curl (the CLI caps at 20 rows), so
// a list call looks like execFileSync('curl', [..., '<base>/api/<resource>...']).
// Set ops still shell out to `onecli`. These match a mock.calls entry [bin, args].
const isAgentsListCall = (c: unknown[]): boolean =>
  c[0] === 'curl' && (c[1] as string[]).some((a) => String(a).includes('/api/agents'));
const isSecretsListCall = (c: unknown[]): boolean =>
  c[0] === 'curl' && (c[1] as string[]).some((a) => String(a).includes('/api/secrets'));

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
      name: 'madison-reed',
      identifier: 'madison-reed',
      secretMode: 'selective',
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'illie-codex',
      identifier: 'illysium-codex',
      secretMode: 'all',
    },
  ],
};

const SECRET_FIXTURE = {
  data: [
    { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Datafold-MadisonReed' },
    { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Fivetran-MadisonReed' },
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
      if (url.includes('/api/agents')) return JSON.stringify(AGENT_FIXTURE);
      if (url.includes('/api/secrets')) return JSON.stringify(SECRET_FIXTURE);
      return '';
    }
    return ''; // onecli set-secrets / set-secret-mode return empty success
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
    expect(__test.isUuid('Datafold-MadisonReed')).toBe(false);
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
    applyOnecliSecrets('madison-reed', undefined);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  test('does nothing when declarations is empty', () => {
    applyOnecliSecrets('madison-reed', []);
    expect(mockedExec).not.toHaveBeenCalled();
  });
});

describe('applyOnecliSecrets — happy path', () => {
  test('resolves names to UUIDs and calls set-secret-mode + set-secrets', () => {
    setupCliResponses();

    applyOnecliSecrets('madison-reed', ['Datafold-MadisonReed', 'Hex', 'Anthropic']);

    const rawCalls = mockedExec.mock.calls;

    // Order: agents list (UUID resolution) → secrets list (name resolution) via
    // the gateway API (curl), then set-secret-mode (defensive lock) + set-secrets
    // (declarative apply) via the onecli CLI.
    const agentsListIdx = rawCalls.findIndex(isAgentsListCall);
    const secretsListIdx = rawCalls.findIndex(isSecretsListCall);
    expect(agentsListIdx).toBeGreaterThanOrEqual(0);
    expect(secretsListIdx).toBeGreaterThan(agentsListIdx);

    const modeCall = rawCalls.find((c) => (c[1] as string[])[1] === 'set-secret-mode');
    const setCall = rawCalls.find((c) => (c[1] as string[])[1] === 'set-secrets');
    expect(modeCall?.[1] as string[]).toEqual([
      'agents',
      'set-secret-mode',
      '--id',
      '11111111-1111-1111-1111-111111111111',
      '--mode',
      'selective',
    ]);
    expect(setCall?.[1] as string[]).toEqual([
      'agents',
      'set-secrets',
      '--id',
      '11111111-1111-1111-1111-111111111111',
      '--secret-ids',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,cccccccc-cccc-cccc-cccc-cccccccccccc,dddddddd-dddd-dddd-dddd-dddddddddddd',
    ]);
  });

  test('accepts UUIDs passed directly in declarations', () => {
    setupCliResponses();

    applyOnecliSecrets('madison-reed', ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);

    const setSecretsCall = mockedExec.mock.calls.find(
      (c) => (c[1] as string[])[0] === 'agents' && (c[1] as string[])[1] === 'set-secrets',
    );
    expect(setSecretsCall).toBeDefined();
    const argv = setSecretsCall![1] as string[];
    expect(argv).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  test('mixes names and UUIDs in a single call', () => {
    setupCliResponses();

    applyOnecliSecrets('madison-reed', ['Datafold-MadisonReed', 'cccccccc-cccc-cccc-cccc-cccccccccccc']);

    const setSecretsCall = mockedExec.mock.calls.find(
      (c) => (c[1] as string[])[0] === 'agents' && (c[1] as string[])[1] === 'set-secrets',
    );
    const argv = setSecretsCall![1] as string[];
    const idsArg = argv[argv.length - 1];
    expect(idsArg).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  test('always forces mode to selective regardless of current mode', () => {
    setupCliResponses();

    // illie-codex is currently in mode `all` per fixture. After apply,
    // we still set-secret-mode selective. The mode-flip is unconditional
    // when onecliSecrets is set — that's the declarative posture.
    applyOnecliSecrets('illysium-codex', ['Hex']);

    const modeCall = mockedExec.mock.calls.find((c) => (c[1] as string[])[1] === 'set-secret-mode');
    expect(modeCall).toBeDefined();
    expect((modeCall![1] as string[]).at(-1)).toBe('selective');
  });
});

describe('applyOnecliSecrets — fail-closed paths', () => {
  test("throws when agent identifier doesn't exist in vault", () => {
    setupCliResponses();

    expect(() => applyOnecliSecrets('does-not-exist', ['Anthropic'])).toThrow(
      /agent with identifier "does-not-exist" not found/,
    );
    // No set-secrets should have been issued
    const setSecretsCall = mockedExec.mock.calls.find(
      (c) => (c[1] as string[])[0] === 'agents' && (c[1] as string[])[1] === 'set-secrets',
    );
    expect(setSecretsCall).toBeUndefined();
  });

  test("throws when a declared secret NAME doesn't resolve", () => {
    setupCliResponses();

    expect(() => applyOnecliSecrets('madison-reed', ['Datafold-MadisonReed', 'Mistyped-Name'])).toThrow(
      /secret\(s\) not found in vault: Mistyped-Name/,
    );
    // No set-secrets should have been issued — fail-closed before apply
    const setSecretsCall = mockedExec.mock.calls.find(
      (c) => (c[1] as string[])[0] === 'agents' && (c[1] as string[])[1] === 'set-secrets',
    );
    expect(setSecretsCall).toBeUndefined();
  });

  test("throws when a declared UUID doesn't exist in vault", () => {
    setupCliResponses();
    const phantomUuid = '99999999-9999-9999-9999-999999999999';

    expect(() => applyOnecliSecrets('madison-reed', [phantomUuid])).toThrow(
      new RegExp(`secret\\(s\\) not found in vault: ${phantomUuid}`),
    );
  });

  test('reports ALL unresolvable names in one error', () => {
    setupCliResponses();

    expect(() => applyOnecliSecrets('madison-reed', ['Bad-One', 'Anthropic', 'Bad-Two'])).toThrow(/Bad-One, Bad-Two/);
  });
});

describe('applyOnecliSecrets — caching', () => {
  test('reuses cached identifier→UUID after first lookup', () => {
    setupCliResponses();

    applyOnecliSecrets('madison-reed', ['Anthropic']);
    const firstCallCount = mockedExec.mock.calls.filter(isAgentsListCall).length;

    applyOnecliSecrets('madison-reed', ['Hex']);
    const secondCallCount = mockedExec.mock.calls.filter(isAgentsListCall).length;

    // First call populated the cache; second call should NOT re-list agents.
    expect(secondCallCount).toBe(firstCallCount);
  });

  test('cache miss triggers refresh of agents list', () => {
    // First call resolves 'madison-reed'. Then we add a NEW agent fixture
    // that contains an identifier we'll ask for — the cache miss should
    // re-issue `agents list` and discover it.
    let callsToAgentsList = 0;
    mockedExec.mockImplementation((bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (bin === 'curl') {
        const url = argv.join(' ');
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

    applyOnecliSecrets('madison-reed', ['Anthropic']);
    expect(callsToAgentsList).toBe(1);

    applyOnecliSecrets('newly-created-identifier', ['Anthropic']);
    expect(callsToAgentsList).toBe(2);
  });
});

describe('mergeWorkgroupAndGroupSecrets — C3', () => {
  test('test_merge_workgroup_baseline_plus_group_additive', () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Datafold-Illysium']);
    expect(result).toEqual(['Anthropic', 'Exa', 'Datafold-Illysium']);
  });

  test('test_merge_dedup_when_group_repeats_workgroup_secret', () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Anthropic', 'Datafold-Illysium']);
    // Anthropic appears in both — only one copy in output, workgroup order preserved
    expect(result).toEqual(['Anthropic', 'Exa', 'Datafold-Illysium']);
  });

  test('test_merge_empty_workgroup_passes_through', () => {
    const result = mergeWorkgroupAndGroupSecrets([], ['Datafold-Illysium']);
    expect(result).toEqual(['Datafold-Illysium']);
  });

  test('test_merge_empty_group_passes_through', () => {
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], []);
    expect(result).toEqual(['Anthropic', 'Exa']);
  });

  test('test_merge_per_group_cannot_subtract', () => {
    // Per-group list is additive only — cannot remove workgroup secrets
    const result = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Datafold-Illysium']);
    // Anthropic + Exa from workgroup MUST be present
    expect(result).toContain('Anthropic');
    expect(result).toContain('Exa');
    expect(result).toContain('Datafold-Illysium');
  });

  test('handles undefined workgroup secrets', () => {
    const result = mergeWorkgroupAndGroupSecrets(undefined, ['Datafold-Illysium']);
    expect(result).toEqual(['Datafold-Illysium']);
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
  const merged = ['Anthropic', 'Slack-User-Token-Madison-Reed', 'Slack-Bot-Token-MR', 'GranolaAPI'];

  test('convention match selects the user-token secret, not the bot token', () => {
    expect(slackUserTokenSecrets(merged)).toEqual(['Slack-User-Token-Madison-Reed']);
  });

  test('convention is case-insensitive', () => {
    expect(slackUserTokenSecrets(['slack-USER-token-x'])).toEqual(['slack-USER-token-x']);
  });

  test('explicit names take precedence over the convention', () => {
    // An explicitly-named secret that does NOT match the convention is still
    // selected; a convention-matching secret NOT in the explicit list is not.
    expect(slackUserTokenSecrets(['Slack-MR', 'Slack-User-Token-Madison-Reed'], ['Slack-MR'])).toEqual(['Slack-MR']);
  });

  test('explicit match is case-insensitive and returns names as they appear', () => {
    expect(slackUserTokenSecrets(['Slack-MR'], ['slack-mr'])).toEqual(['Slack-MR']);
  });

  test('no match returns empty', () => {
    expect(slackUserTokenSecrets(['Anthropic', 'GranolaAPI'])).toEqual([]);
    expect(slackUserTokenSecrets([])).toEqual([]);
  });

  test('empty explicit list falls back to convention', () => {
    expect(slackUserTokenSecrets(merged, [])).toEqual(['Slack-User-Token-Madison-Reed']);
  });
});
