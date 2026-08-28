import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { evaluateBoot, markDeployBootHealthy, performRollback, runDeployCrashGuard } from './deploy-crash-guard.js';

let root: string;

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
  execFile: (cmd: string, args: string[]) => void;
  exit: (code: number) => never;
  now: () => number;
} {
  return {
    execFile: (cmd: string, args: string[]) => {
      execCalls.push([cmd, ...args]);
      // Simulate no pre-deploy docker tag existing.
      if (cmd === 'docker' && args[0] === 'inspect') throw new Error('no such image');
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
