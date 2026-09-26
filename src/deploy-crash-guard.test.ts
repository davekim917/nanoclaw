import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateBoot,
  markDeployBootHealthy,
  performRollback,
  readRestartedUnits,
  runDeployCrashGuard,
} from './deploy-crash-guard.js';

let root: string;

interface RollbackManifestForTest {
  commit: string;
  imageBase: string;
  timestamp: string;
  node?: string;
  restartedUnits?: unknown;
}

function writeManifest(ageMs: number, commit = 'a'.repeat(40)): void {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'deploy-rollback.json'),
    JSON.stringify({
      commit,
      imageBase: 'nanoclaw-test',
      timestamp: new Date(Date.now() - ageMs).toISOString(),
    }),
  );
}

function readAttempts(): number | null {
  try {
    const raw = fs.readFileSync(path.join(root, 'data', 'deploy-boot-attempts.json'), 'utf-8');
    return (JSON.parse(raw) as { attempts: number }).attempts;
  } catch {
    return null;
  }
}

const exitError = new Error('exit called');

function fakeDeps(execCalls: string[][]): {
  execFile: (cmd: string, args: string[]) => string;
  exit: (code: number) => never;
  now: () => number;
} {
  return {
    execFile: (cmd: string, args: string[]) => {
      execCalls.push([cmd, ...args]);
      // Simulate no pre-deploy docker tag existing.
      if (cmd === 'docker' && args[0] === 'inspect') throw new Error('no such image');
      return '';
    },
    exit: () => {
      throw exitError;
    },
    now: () => Date.now(),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-guard-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('evaluateBoot', () => {
  it('no manifest → no-op', () => {
    expect(evaluateBoot(null, 0, Date.now())).toBe('no-op');
  });

  it('fresh manifest arms on boots 1 and 2, rolls back on boot 3', () => {
    const manifest = { commit: 'c', imageBase: 'i', timestamp: new Date().toISOString() };
    expect(evaluateBoot(manifest, 0, Date.now())).toBe('arm');
    expect(evaluateBoot(manifest, 1, Date.now())).toBe('arm');
    expect(evaluateBoot(manifest, 2, Date.now())).toBe('rollback');
  });

  it('manifest older than the window is stale, whatever the attempt count', () => {
    const manifest = {
      commit: 'c',
      imageBase: 'i',
      timestamp: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    };
    expect(evaluateBoot(manifest, 5, Date.now())).toBe('stale');
  });

  it('unparseable or future timestamp is stale, never a rollback trigger', () => {
    expect(evaluateBoot({ commit: 'c', imageBase: 'i', timestamp: 'garbage' }, 5, Date.now())).toBe('stale');
    expect(
      evaluateBoot(
        { commit: 'c', imageBase: 'i', timestamp: new Date(Date.now() + 60_000).toISOString() },
        5,
        Date.now(),
      ),
    ).toBe('stale');
  });
});

describe('runDeployCrashGuard', () => {
  it('records each armed boot attempt before the app loads', () => {
    writeManifest(0);
    runDeployCrashGuard(root, fakeDeps([]));
    expect(readAttempts()).toBe(1);
    runDeployCrashGuard(root, fakeDeps([]));
    expect(readAttempts()).toBe(2);
  });

  it('on a shadow host, neither counts boots nor rolls back, even on the rollback boot', () => {
    writeManifest(0);
    fs.writeFileSync(
      path.join(root, 'data', 'deploy-boot-attempts.json'),
      JSON.stringify({ attempts: 2, timestamp: new Date().toISOString() }),
    );
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_SHADOW=1\n');
    vi.stubEnv('NANOCLAW_SHADOW', undefined);
    const calls: string[][] = [];
    try {
      expect(() => runDeployCrashGuard(root, fakeDeps(calls))).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(calls).toEqual([]);
    expect(readAttempts()).toBe(2);
    expect(fs.existsSync(path.join(root, 'data', 'deploy-rollback.json'))).toBe(true);
  });

  it('cleans up a stale manifest and does not count the boot', () => {
    writeManifest(31 * 60 * 1000);
    runDeployCrashGuard(root, fakeDeps([]));
    expect(fs.existsSync(path.join(root, 'data', 'deploy-rollback.json'))).toBe(false);
    expect(readAttempts()).toBe(null);
  });

  it('third boot performs the rollback and exits', () => {
    writeManifest(0);
    fs.writeFileSync(
      path.join(root, 'data', 'deploy-boot-attempts.json'),
      JSON.stringify({ attempts: 2, timestamp: new Date().toISOString() }),
    );
    const calls: string[][] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => runDeployCrashGuard(root, fakeDeps(calls))).toThrow(exitError);
    expect(calls).toContainEqual(['git', 'reset', '--hard', 'a'.repeat(40)]);
  });

  it('a Node runtime change since deploy refuses rollback, disarms, and explains', () => {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'data', 'deploy-rollback.json'),
      JSON.stringify({
        commit: 'd'.repeat(40),
        imageBase: 'nanoclaw-test',
        timestamp: new Date().toISOString(),
        node: 'v20.19.5',
      }),
    );
    fs.writeFileSync(
      path.join(root, 'data', 'deploy-boot-attempts.json'),
      JSON.stringify({ attempts: 2, timestamp: new Date().toISOString() }),
    );
    const calls: string[][] = [];
    // Would be a rollback boot, but the manifest's runtime differs from ours.
    expect(() => runDeployCrashGuard(root, fakeDeps(calls))).not.toThrow();
    expect(calls).toEqual([]);
    // Disarmed with an explanatory failed status.
    expect(fs.existsSync(path.join(root, 'data', 'deploy-rollback.json'))).toBe(false);
    const status = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'deploy-status.json'), 'utf-8')) as {
      status: string;
      error: string;
    };
    expect(status.status).toBe('failed');
    expect(status.error).toContain('Node runtime changed since deploy');
  });

  it('evaluateBoot: matching or absent manifest node never trips runtime-changed', () => {
    const base = { commit: 'c', imageBase: 'i', timestamp: new Date().toISOString() };
    expect(evaluateBoot({ ...base, node: 'v22.0.0' }, 2, Date.now(), 'v22.0.0')).toBe('rollback');
    expect(evaluateBoot(base, 2, Date.now(), 'v22.0.0')).toBe('rollback');
    expect(evaluateBoot({ ...base, node: 'v20.19.5' }, 0, Date.now(), 'v22.0.0')).toBe('runtime-changed');
  });

  it('a corrupt attempts file never blocks a normal boot', () => {
    writeManifest(0);
    fs.writeFileSync(path.join(root, 'data', 'deploy-boot-attempts.json'), 'not json');
    expect(() => runDeployCrashGuard(root, fakeDeps([]))).not.toThrow();
    expect(readAttempts()).toBe(1);
  });
});

describe('performRollback', () => {
  it('restores dist and node_modules snapshots, writes status, disarms, exits', () => {
    writeManifest(0);
    for (const name of ['dist', 'node_modules']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'marker'), 'new-broken');
      fs.mkdirSync(path.join(root, `${name}.pre-deploy`), { recursive: true });
      fs.writeFileSync(path.join(root, `${name}.pre-deploy`, 'marker'), 'old-good');
    }
    const calls: string[][] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const manifest = {
      commit: 'b'.repeat(40),
      imageBase: 'nanoclaw-test',
      timestamp: new Date().toISOString(),
    };

    expect(() => performRollback(root, manifest, 3, fakeDeps(calls))).toThrow(exitError);

    // Snapshots swapped in; the broken build preserved as .failed.
    expect(fs.readFileSync(path.join(root, 'dist', 'marker'), 'utf-8')).toBe('old-good');
    expect(fs.readFileSync(path.join(root, 'node_modules', 'marker'), 'utf-8')).toBe('old-good');
    expect(fs.readFileSync(path.join(root, 'dist.failed', 'marker'), 'utf-8')).toBe('new-broken');
    // Checkout reset requested.
    expect(calls).toContainEqual(['git', 'reset', '--hard', 'b'.repeat(40)]);
    // Status written for the post-rollback boot to announce.
    const status = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'deploy-status.json'), 'utf-8')) as {
      status: string;
      error: string;
    };
    expect(status.status).toBe('failed');
    expect(status.error).toContain('rolled back automatically after 3 failed boots');
    // Disarmed: no manifest, no attempts — a failed rollback must not loop.
    expect(fs.existsSync(path.join(root, 'data', 'deploy-rollback.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'data', 'deploy-boot-attempts.json'))).toBe(false);
  });

  it('missing snapshots still reset the checkout and report honestly', () => {
    writeManifest(0);
    const calls: string[][] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const manifest = {
      commit: 'c'.repeat(40),
      imageBase: '',
      timestamp: new Date().toISOString(),
    };
    expect(() => performRollback(root, manifest, 3, fakeDeps(calls))).toThrow(exitError);
    expect(calls).toContainEqual(['git', 'reset', '--hard', 'c'.repeat(40)]);
    const status = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'deploy-status.json'), 'utf-8')) as {
      error: string;
    };
    expect(status.error).toContain('commit cccccccc');
  });

  it('restores runnable artifacts without discarding tracked source changes', () => {
    writeManifest(0);
    for (const name of ['dist', 'node_modules']) {
      fs.mkdirSync(path.join(root, `${name}.pre-deploy`), { recursive: true });
      fs.writeFileSync(path.join(root, `${name}.pre-deploy`, 'marker'), 'old-good');
    }
    const calls: string[][] = [];
    const deps = fakeDeps(calls);
    deps.execFile = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'status') return ' M src/providers/index.ts\n';
      if (cmd === 'docker' && args[0] === 'inspect') throw new Error('no such image');
      return '';
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      performRollback(root, { commit: 'd'.repeat(40), imageBase: '', timestamp: new Date().toISOString() }, 3, deps),
    ).toThrow(exitError);

    expect(calls).toContainEqual(['git', 'status', '--porcelain', '--untracked-files=no']);
    expect(calls.some(([cmd, action]) => cmd === 'git' && action === 'reset')).toBe(false);
    const status = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'deploy-status.json'), 'utf-8')) as {
      error: string;
    };
    expect(status.error).toContain('tracked source changes preserved');
  });
});

/**
 * #822 r1: the sibling restarts deploy.sh performs before the handoff have to
 * survive the POST-handoff rollback too. Concrete sequence the shell tests
 * cannot reach: the sibling is restarted onto the deployed commit, the
 * `systemctl restart nanoclaw-v2` kills the deploy shell along with its
 * in-memory unit list, the new build crash-loops, and on the third boot this
 * guard resets the checkout — while the watcher stays resident on the rejected
 * code and keeps mirroring it, under a status line announcing a clean rollback.
 * The shell's list is gone by then, so the deploy records it in the manifest.
 */
describe('performRollback puts the deploy’s restarted services back', () => {
  /** A rolled-back manifest listing `units` as restarted by the deploy. */
  function manifestWith(restartedUnits: unknown): RollbackManifestForTest {
    return { commit: 'e'.repeat(40), imageBase: '', timestamp: new Date().toISOString(), restartedUnits };
  }

  function rollback(manifest: RollbackManifestForTest, execCalls: string[][], failUnit?: string): void {
    const base = fakeDeps(execCalls);
    const deps = {
      ...base,
      execFile: (cmd: string, args: string[]) => {
        if (failUnit && cmd === 'sudo' && args[2] === failUnit) {
          execCalls.push([cmd, ...args]);
          throw new Error('Failed to restart: unit not found');
        }
        return base.execFile(cmd, args);
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => performRollback(root, manifest as never, 3, deps as never)).toThrow(exitError);
  }

  function statusError(): string {
    return (JSON.parse(fs.readFileSync(path.join(root, 'logs', 'deploy-status.json'), 'utf-8')) as { error: string })
      .error;
  }

  function restartedUnitCalls(calls: string[][]): string[] {
    return calls.filter(([cmd, sub]) => cmd === 'sudo' && sub === 'systemctl').map((c) => c[3]);
  }

  it('restarts each listed unit, after the checkout is back', () => {
    const calls: string[][] = [];
    rollback(manifestWith(['nanoclaw-codex-sync.service']), calls);
    expect(restartedUnitCalls(calls)).toEqual(['nanoclaw-codex-sync.service']);
    // Order matters: restarting before the reset would boot the sibling onto
    // the very code being rolled back.
    const resetAt = calls.findIndex(([cmd, action]) => cmd === 'git' && action === 'reset');
    const restartAt = calls.findIndex(([cmd]) => cmd === 'sudo');
    expect(resetAt).toBeGreaterThanOrEqual(0);
    expect(restartAt).toBeGreaterThan(resetAt);
    expect(statusError()).toContain('nanoclaw-codex-sync.service');
  });

  it('surfaces a failed restart in the operator-facing status instead of throwing', () => {
    const calls: string[][] = [];
    rollback(manifestWith(['a.service', 'nanoclaw-codex-sync.service']), calls, 'a.service');
    // The failure does not abort the rollback — a throw here would crash the
    // boot with the manifest still armed.
    expect(restartedUnitCalls(calls)).toEqual(['a.service', 'nanoclaw-codex-sync.service']);
    expect(statusError()).toContain('a.service FAILED TO RESTART');
    expect(statusError()).toContain('nanoclaw-codex-sync.service');
  });

  it('refuses a malformed list loudly rather than reading it as nothing to do', () => {
    // `null` is in here deliberately (r2 MEDIUM): a manifest carrying an
    // explicit null is present-but-wrong, not a manifest from before the field
    // existed, and reading it as the latter reset the checkout, restarted
    // nothing, and reported the rollback as complete.
    for (const bad of [
      'nanoclaw-codex-sync.service',
      ['nanoclaw-codex-sync'],
      [42],
      ['a.service; rm -rf /'],
      null,
      { 0: 'a.service' },
    ]) {
      fs.rmSync(path.join(root, 'logs'), { recursive: true, force: true });
      const calls: string[][] = [];
      rollback(manifestWith(bad), calls);
      expect(restartedUnitCalls(calls), JSON.stringify(bad)).toEqual([]);
      expect(statusError(), JSON.stringify(bad)).toContain('SIBLING SERVICES NOT RESTARTED');
    }
  });

  it('restarts nothing when the deploy restarted nothing, and never claims it did', () => {
    const empty: string[][] = [];
    rollback(manifestWith([]), empty);
    expect(restartedUnitCalls(empty)).toEqual([]);
    expect(statusError()).not.toContain('FAILED TO RESTART');
    expect(statusError()).not.toContain('SIBLING SERVICES NOT RESTARTED');

    // A manifest from a deploy.sh that predates the field: also nothing to do,
    // but a different fact, and not one the guard may confuse with a malformed
    // list either.
    fs.rmSync(path.join(root, 'logs'), { recursive: true, force: true });
    const legacy: string[][] = [];
    rollback({ commit: 'f'.repeat(40), imageBase: '', timestamp: new Date().toISOString() }, legacy);
    expect(restartedUnitCalls(legacy)).toEqual([]);
    expect(statusError()).not.toContain('SIBLING SERVICES NOT RESTARTED');
  });

  it('leaves them alone when the reset was skipped, and says so', () => {
    const calls: string[][] = [];
    const base = fakeDeps(calls);
    const deps = {
      ...base,
      // Tracked changes present -> performRollback skips the commit reset.
      execFile: (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'status') {
          calls.push([cmd, ...args]);
          return ' M src/foo.ts\n';
        }
        return base.execFile(cmd, args);
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      performRollback(root, manifestWith(['nanoclaw-codex-sync.service']) as never, 3, deps as never),
    ).toThrow(exitError);
    expect(restartedUnitCalls(calls)).toEqual([]);
    expect(statusError()).toContain('1 sibling service(s) left running');
  });
});

describe('readRestartedUnits', () => {
  it('separates absent, empty and malformed', () => {
    // Only a MISSING KEY is legacy-absence. JSON cannot express `undefined`, so
    // `undefined` here means the writer omitted the key; an explicit null is a
    // manifest that says something and says it wrong (r2 MEDIUM — reading null
    // as absent collapsed present-but-malformed into "nothing to do").
    expect(readRestartedUnits(undefined)).toEqual({ kind: 'absent' });
    expect(readRestartedUnits(null)).toMatchObject({ kind: 'malformed' });
    expect(readRestartedUnits(null)).toMatchObject({ detail: expect.stringContaining('null') });
    expect(readRestartedUnits([])).toEqual({ kind: 'units', units: [] });
    expect(readRestartedUnits(['a.service', 'nanoclaw-unit-alert@.service'])).toEqual({
      kind: 'units',
      units: ['a.service', 'nanoclaw-unit-alert@.service'],
    });
    for (const bad of ['a.service', 42, {}, ['a.timer'], ['a service.service'], [''], [null]]) {
      expect(readRestartedUnits(bad), JSON.stringify(bad)).toMatchObject({ kind: 'malformed' });
    }
  });
});

describe('markDeployBootHealthy', () => {
  it('disarms the guard', () => {
    writeManifest(0);
    runDeployCrashGuard(root, fakeDeps([]));
    expect(readAttempts()).toBe(1);
    markDeployBootHealthy(root);
    expect(fs.existsSync(path.join(root, 'data', 'deploy-rollback.json'))).toBe(false);
    expect(readAttempts()).toBe(null);
  });
});
