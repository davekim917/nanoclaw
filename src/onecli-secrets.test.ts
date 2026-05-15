import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

import { applyOnecliSecrets, __resetCachesForTest, __test } from './onecli-secrets.js';

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
  mockedExec.mockImplementation((_bin: unknown, rawArgs: unknown) => {
    const argv = (rawArgs ?? []) as string[];
    if (argv[0] === 'agents' && argv[1] === 'list') return JSON.stringify(AGENT_FIXTURE);
    if (argv[0] === 'secrets' && argv[1] === 'list') return JSON.stringify(SECRET_FIXTURE);
    return ''; // set-secrets / set-secret-mode return empty success
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

    const calls = mockedExec.mock.calls.map((c) => c[1] as string[]);

    // Order: agents list (UUID resolution), secrets list (name resolution),
    // set-secret-mode (defensive lock), set-secrets (declarative apply)
    expect(calls[0]).toEqual(['agents', 'list']);
    expect(calls[1]).toEqual(['secrets', 'list']);
    expect(calls[2]).toEqual([
      'agents',
      'set-secret-mode',
      '--id',
      '11111111-1111-1111-1111-111111111111',
      '--mode',
      'selective',
    ]);
    expect(calls[3]).toEqual([
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
    expect(idsArg).toBe(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,cccccccc-cccc-cccc-cccc-cccccccccccc',
    );
  });

  test('always forces mode to selective regardless of current mode', () => {
    setupCliResponses();

    // illie-codex is currently in mode `all` per fixture. After apply,
    // we still set-secret-mode selective. The mode-flip is unconditional
    // when onecliSecrets is set — that's the declarative posture.
    applyOnecliSecrets('illysium-codex', ['Hex']);

    const modeCall = mockedExec.mock.calls.find(
      (c) => (c[1] as string[])[1] === 'set-secret-mode',
    );
    expect(modeCall).toBeDefined();
    expect((modeCall![1] as string[]).at(-1)).toBe('selective');
  });
});

describe('applyOnecliSecrets — fail-closed paths', () => {
  test('throws when agent identifier doesn\'t exist in vault', () => {
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

  test('throws when a declared secret NAME doesn\'t resolve', () => {
    setupCliResponses();

    expect(() =>
      applyOnecliSecrets('madison-reed', ['Datafold-MadisonReed', 'Mistyped-Name']),
    ).toThrow(/secret\(s\) not found in vault: Mistyped-Name/);
    // No set-secrets should have been issued — fail-closed before apply
    const setSecretsCall = mockedExec.mock.calls.find(
      (c) => (c[1] as string[])[0] === 'agents' && (c[1] as string[])[1] === 'set-secrets',
    );
    expect(setSecretsCall).toBeUndefined();
  });

  test('throws when a declared UUID doesn\'t exist in vault', () => {
    setupCliResponses();
    const phantomUuid = '99999999-9999-9999-9999-999999999999';

    expect(() => applyOnecliSecrets('madison-reed', [phantomUuid])).toThrow(
      new RegExp(`secret\\(s\\) not found in vault: ${phantomUuid}`),
    );
  });

  test('reports ALL unresolvable names in one error', () => {
    setupCliResponses();

    expect(() =>
      applyOnecliSecrets('madison-reed', ['Bad-One', 'Anthropic', 'Bad-Two']),
    ).toThrow(/Bad-One, Bad-Two/);
  });
});

describe('applyOnecliSecrets — caching', () => {
  test('reuses cached identifier→UUID after first lookup', () => {
    setupCliResponses();

    applyOnecliSecrets('madison-reed', ['Anthropic']);
    const firstCallCount = mockedExec.mock.calls.filter(
      (c) => (c[1] as string[])[0] === 'agents' && (c[1] as string[])[1] === 'list',
    ).length;

    applyOnecliSecrets('madison-reed', ['Hex']);
    const secondCallCount = mockedExec.mock.calls.filter(
      (c) => (c[1] as string[])[0] === 'agents' && (c[1] as string[])[1] === 'list',
    ).length;

    // First call populated the cache; second call should NOT re-list agents.
    expect(secondCallCount).toBe(firstCallCount);
  });

  test('cache miss triggers refresh of agents list', () => {
    // First call resolves 'madison-reed'. Then we add a NEW agent fixture
    // that contains an identifier we'll ask for — the cache miss should
    // re-issue `agents list` and discover it.
    let callsToAgentsList = 0;
    mockedExec.mockImplementation((_bin: unknown, rawArgs: unknown) => {
      const argv = (rawArgs ?? []) as string[];
      if (argv[0] === 'agents' && argv[1] === 'list') {
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
      if (argv[0] === 'secrets' && argv[1] === 'list') return JSON.stringify(SECRET_FIXTURE);
      return '';
    });

    applyOnecliSecrets('madison-reed', ['Anthropic']);
    expect(callsToAgentsList).toBe(1);

    applyOnecliSecrets('newly-created-identifier', ['Anthropic']);
    expect(callsToAgentsList).toBe(2);
  });
});
