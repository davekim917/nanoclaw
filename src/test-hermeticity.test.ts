/**
 * Proves the hermeticity tripwire (issue #305) actually bites.
 *
 * A guard that is silently inert is worse than none, so each case here drives a
 * real call through the guarded seam: `child_process` and `fs` are reached
 * through the same module specifiers production code imports, so if the
 * `setupFiles` wiring ever comes undone these fail rather than pass vacuously.
 *
 * Enforcement is switched off around the calls that must be observed rather
 * than thrown from — that is the "remove the tripwire and assert the recorded
 * attempt count is non-zero" case from the issue.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  allowSubprocess,
  allowWritesTo,
  clearHermeticityAttempts,
  enforceHermeticity,
  hermeticityAttempts,
  hermeticityMode,
  withHermeticityMode,
} from './test-hermeticity.js';

// The repo default is `warn` while the backlog of leaking suites is worked off
// (issue #305), so this file opts itself into the strict guard — which is also
// the ratchet any newly-hermetic suite should use.
beforeAll(() => enforceHermeticity());
afterEach(() => clearHermeticityAttempts());

describe('mode', () => {
  it('is enforcing inside this file', () => {
    expect(hermeticityMode()).toBe('enforce');
  });
});

describe('subprocess guard', () => {
  it('throws with the command and the call site', () => {
    expect(() => execFileSync('git', ['--version'])).toThrow(/subprocess escape — execFileSync\(git\)/);
  });

  it('records the attempt even when enforcement is off', () => {
    // The tripwire "removed": callers that swallow errors would otherwise let a
    // real escape pass as a green test, so the record is the load-bearing half.
    const output = withHermeticityMode('warn', () => execFileSync('git', ['--version'], { encoding: 'utf8' }));
    expect(output).toMatch(/^git version/);
    expect(hermeticityAttempts().length).toBeGreaterThan(0);
    expect(hermeticityAttempts()[0]).toMatchObject({ kind: 'subprocess', api: 'execFileSync', target: 'git' });
    expect(hermeticityAttempts()[0].callSite).toContain('test-hermeticity.test.ts');
  });

  it('lets an opted-in command through', () => {
    allowSubprocess(['git']);
    expect(execFileSync('git', ['--version'], { encoding: 'utf8' })).toMatch(/^git version/);
    expect(hermeticityAttempts()).toHaveLength(0);
  });
});

describe('network guard', () => {
  it('throws before a request leaves the process', () => {
    // The guard throws synchronously, ahead of the real fetch, so nothing
    // leaves the process and a `.catch()` on the call site cannot swallow it.
    expect(() => fetch('https://api.github.com/meta')).toThrow(/network escape — fetch/);
  });

  it('records the attempt when enforcement is off', () => {
    // Recorded synchronously, before the real fetch is ever reached — so no
    // packet leaves the box even in warn mode's assertion path.
    withHermeticityMode('warn', () => {
      void fetch('https://api.github.com/meta').catch(() => undefined);
    });
    expect(hermeticityAttempts()).toHaveLength(1);
    expect(hermeticityAttempts()[0]).toMatchObject({ kind: 'network', api: 'fetch' });
  });
});

describe('out-of-tree write guard', () => {
  const escape = path.join(os.homedir(), 'plugins', 'nanoclaw-hermeticity-probe');

  it('throws on a write into ~/plugins', () => {
    expect(() => fs.mkdirSync(escape)).toThrow(/fs-write escape — fs.mkdirSync/);
  });

  it('throws on a write into the repo data directory', () => {
    expect(() => fs.writeFileSync(path.join(process.cwd(), 'data', 'probe'), 'x')).toThrow(/fs-write escape/);
  });

  it('records the attempt without writing when enforcement is off', () => {
    // `warn` calls through, so the probe must be a path whose real write fails
    // anyway — mkdir without recursive under a directory that does not exist.
    withHermeticityMode('warn', () => {
      try {
        fs.mkdirSync(path.join(os.homedir(), 'plugins', 'hermeticity-probe', 'nested'));
      } catch (error) {
        // The real ENOENT from mkdir without `recursive`; anything else is a
        // genuine failure and must not be swallowed. The record asserted below
        // is what is actually under test.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
    expect(hermeticityAttempts().length).toBeGreaterThan(0);
    expect(hermeticityAttempts()[0].kind).toBe('fs-write');
  });

  it('checks the destination of a two-path call, not the source', () => {
    // fs.copyFileSync(src, dest) writes `dest`. Guarding argument 0 flagged a
    // container mount that was only READING a real credential file.
    const root = globalThis.uniqueTmpRoot('hermeticity-copy');
    fs.mkdirSync(root, { recursive: true });
    const source = path.join(root, 'src');
    fs.writeFileSync(source, 'payload');
    fs.copyFileSync(source, path.join(root, 'dest'));
    expect(hermeticityAttempts()).toHaveLength(0);

    expect(() => fs.copyFileSync(source, path.join(os.homedir(), 'plugins', 'probe'))).toThrow(
      /fs-write escape — fs.copyFileSync/,
    );
  });

  it('leaves temp-directory fixtures alone', () => {
    const root = globalThis.uniqueTmpRoot('hermeticity');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'f'), 'ok');
    expect(fs.readFileSync(path.join(root, 'f'), 'utf8')).toBe('ok');
    expect(hermeticityAttempts()).toHaveLength(0);
  });

  it('honours an explicit allowWritesTo opt-in', () => {
    const root = path.join(os.homedir(), '.nanoclaw-hermeticity-optin');
    expect(() => fs.mkdirSync(root)).toThrow(/fs-write escape/);
    clearHermeticityAttempts();
    allowWritesTo(root);
    fs.mkdirSync(root, { recursive: true });
    fs.rmSync(root, { recursive: true, force: true });
    expect(hermeticityAttempts()).toHaveLength(0);
  });
});
