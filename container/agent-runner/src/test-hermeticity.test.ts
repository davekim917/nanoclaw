/**
 * Proves the agent-runner hermeticity tripwire actually bites (issue #305).
 *
 * Each case drives a real call through the same module specifier production
 * code imports, so if the `bunfig.toml` preload wiring ever comes undone these
 * fail rather than pass vacuously. Enforcement is switched off around the calls
 * that must be observed rather than thrown from — that is the "remove the
 * tripwire and assert the recorded attempt count is non-zero" case.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  allowSubprocess,
  clearHermeticityAttempts,
  hermeticityAttempts,
  resetHermeticityAllowances,
  withHermeticityMode,
} from './test-hermeticity.js';

afterEach(() => {
  clearHermeticityAttempts();
  resetHermeticityAllowances();
});

/**
 * The repo default is `warn`, and `bun test` shares one process across every
 * file — so enforcement is scoped to the call rather than set for the file,
 * which would leak into every suite that ran afterwards.
 */
function enforcing<T>(fn: () => T): T {
  return withHermeticityMode('enforce', fn);
}

describe('hermeticity tripwire', () => {
  test('throws on a subprocess spawn, naming the command', () => {
    enforcing(() =>
      expect(() => execFileSync('git', ['--version'])).toThrow(/subprocess escape — execFileSync\(git\)/),
    );
  });

  test('records the subprocess attempt even with enforcement off', () => {
    const output = withHermeticityMode('warn', () => execFileSync('git', ['--version'], { encoding: 'utf8' }));
    expect(output).toMatch(/^git version/);
    expect(hermeticityAttempts().length).toBeGreaterThan(0);
    expect(hermeticityAttempts()[0]!.kind).toBe('subprocess');
    expect(hermeticityAttempts()[0]!.callSite).toContain('test-hermeticity.test.ts');
  });

  test('lets an opted-in command through', () => {
    allowSubprocess(['git']);
    enforcing(() => {
      expect(execFileSync('git', ['--version'], { encoding: 'utf8' })).toMatch(/^git version/);
    });
    expect(hermeticityAttempts()).toHaveLength(0);
  });

  test('throws before a network request leaves the process', () => {
    enforcing(() => expect(() => fetch('https://api.github.com/meta')).toThrow(/network escape — fetch/));
  });

  test('throws on a write into ~/plugins', () => {
    enforcing(() =>
      expect(() => fs.mkdirSync(path.join(os.homedir(), 'plugins', 'runner-hermeticity-probe'))).toThrow(
        /fs-write escape — fs.mkdirSync/,
      ),
    );
  });

  test('records the write attempt with enforcement off', () => {
    withHermeticityMode('warn', () => {
      try {
        fs.mkdirSync(path.join(os.homedir(), 'plugins', 'runner-probe', 'nested'));
      } catch (error) {
        // The real ENOENT from mkdir without `recursive`; the record asserted
        // below is what is under test. Anything else is a genuine failure.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
    expect(hermeticityAttempts().length).toBeGreaterThan(0);
    expect(hermeticityAttempts()[0]!.kind).toBe('fs-write');
  });

  test('leaves temp-directory fixtures alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-hermeticity-'));
    enforcing(() => fs.writeFileSync(path.join(root, 'f'), 'ok'));
    expect(fs.readFileSync(path.join(root, 'f'), 'utf8')).toBe('ok');
    fs.rmSync(root, { recursive: true, force: true });
    expect(hermeticityAttempts()).toHaveLength(0);
  });

  test('checks the destination of a two-path call, not the source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-hermeticity-copy-'));
    const source = path.join(root, 'src');
    fs.writeFileSync(source, 'payload');
    enforcing(() => fs.copyFileSync(source, path.join(root, 'dest')));
    expect(hermeticityAttempts()).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
