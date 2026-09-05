import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
// (davekim917/nanoclaw#355 review thread)
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  isSurvivableIoError: vi.fn(() => false),
}));

// Mock child_process — store the mock fns so tests can configure them. The
// adoption helpers use the argv forms (`execFileSync`, `spawn`) so a container
// name never meets a shell; the legacy helpers use the string form.
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  cleanupOrphansStrict,
  listInstallContainersWithScope,
  killContainerHard,
  runtimeShowsRunning,
  waitForContainerExit,
} from './container-runtime.js';
import {
  CONTAINER_GROUP_LABEL_KEY,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_SESSION_LABEL_KEY,
  CONTAINER_WORKGROUP_LABEL_KEY,
} from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});

describe('cleanupOrphansStrict', () => {
  it('test_startup_refuses_cutover_when_orphan_absence_is_unproved', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('runtime listing failed');
    });

    expect(() => cleanupOrphansStrict()).toThrow(/prove install-scoped container absence/);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('stops install-scoped containers and proves the postcondition with a second listing', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\n').mockReturnValueOnce('').mockReturnValueOnce('');

    expect(cleanupOrphansStrict()).toEqual(['nanoclaw-a-1']);
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-a-1`, {
      stdio: 'pipe',
    });
  });

  it('throws when an install-scoped container remains after cleanup', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\n').mockReturnValueOnce('').mockReturnValueOnce('nanoclaw-a-1\n');

    expect(() => cleanupOrphansStrict()).toThrow(/still running/);
  });
});

describe('listInstallContainersWithScope', () => {
  it('reads the three scope labels beside the name', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-v2-a-1\twg-a\tsess-a\tgrp-a\n');

    expect(listInstallContainersWithScope()).toEqual([
      { name: 'nanoclaw-v2-a-1', workgroupId: 'wg-a', sessionId: 'sess-a', groupId: 'grp-a' },
    ]);
    const command = mockExecSync.mock.calls[0][0] as string;
    expect(command).toContain(`--filter label=${CONTAINER_INSTALL_LABEL}`);
    for (const key of [CONTAINER_WORKGROUP_LABEL_KEY, CONTAINER_SESSION_LABEL_KEY, CONTAINER_GROUP_LABEL_KEY]) {
      expect(command).toContain(`{{.Label "${key}"}}`);
    }
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('reads a missing label as null — unknown scope, never an empty string', () => {
    // Divergence 7: every container spawned before the labels shipped looks
    // like this, and the boot door must treat it as unknown scope.
    mockExecSync.mockReturnValueOnce('nanoclaw-v2-legacy-1\t\t\t\n');

    expect(listInstallContainersWithScope()).toEqual([
      { name: 'nanoclaw-v2-legacy-1', workgroupId: null, sessionId: null, groupId: null },
    ]);
  });

  it('returns an empty inventory for an empty listing', () => {
    mockExecSync.mockReturnValueOnce('\n');
    expect(listInstallContainersWithScope()).toEqual([]);
  });

  it('fails closed when the runtime listing fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('runtime listing failed');
    });

    expect(() => listInstallContainersWithScope()).toThrow(/prove install-scoped container absence/);
// --- adoption helpers (seam 4 series E) ---

describe('runtimeShowsRunning', () => {
  it('is true only for an exact-name match', () => {
    // The runtime's `name=` filter is a substring match, so a listing for
    // `nanoclaw-v2-a-1` can carry `nanoclaw-v2-a-10` too.
    mockExecFileSync.mockReturnValueOnce('nanoclaw-v2-a-10\nnanoclaw-v2-a-1\n');
    expect(runtimeShowsRunning('nanoclaw-v2-a-1')).toBe(true);

    mockExecFileSync.mockReturnValueOnce('nanoclaw-v2-a-10\n');
    expect(runtimeShowsRunning('nanoclaw-v2-a-1')).toBe(false);

    mockExecFileSync.mockReturnValueOnce('');
    expect(runtimeShowsRunning('nanoclaw-v2-a-1')).toBe(false);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      [
        'ps',
        '--filter',
        `label=${CONTAINER_INSTALL_LABEL}`,
        '--filter',
        'name=nanoclaw-v2-a-1',
        '--format',
        '{{.Names}}',
      ],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('a listing failure throws (not false)', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });
    // "Cannot prove absence" is never "absent": the caller picks its closed side.
    expect(() => runtimeShowsRunning('nanoclaw-v2-a-1')).toThrow('Cannot connect to the Docker daemon');
  });

  it('an invalid name is refused before any subprocess', () => {
    expect(() => runtimeShowsRunning('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => runtimeShowsRunning('')).toThrow('Invalid container name');
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('waitForContainerExit', () => {
  it('spawns `docker wait <name>` with argv, no shell', () => {
    const child = { pid: 4242 };
    mockSpawn.mockReturnValueOnce(child);

    expect(waitForContainerExit('nanoclaw-v2-a-1')).toBe(child);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args, options] = mockSpawn.mock.calls[0] as [string, string[], { shell?: unknown; stdio: unknown }];
    expect(bin).toBe(CONTAINER_RUNTIME_BIN);
    expect(args).toEqual(['wait', 'nanoclaw-v2-a-1']);
    expect(options.shell).toBeUndefined();
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('an invalid name is refused before any subprocess', () => {
    expect(() => waitForContainerExit('foo$(whoami)')).toThrow('Invalid container name');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('killContainerHard', () => {
  it('issues `docker kill <name>` with argv', () => {
    killContainerHard('nanoclaw-v2-a-1');
    expect(mockExecFileSync).toHaveBeenCalledWith(CONTAINER_RUNTIME_BIN, ['kill', 'nanoclaw-v2-a-1'], {
      stdio: 'pipe',
    });
  });

  it('an invalid name is refused before any subprocess', () => {
    expect(() => killContainerHard('foo`id`')).toThrow('Invalid container name');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
