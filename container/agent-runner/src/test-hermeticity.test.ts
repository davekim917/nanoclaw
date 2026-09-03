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
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  allowSubprocess,
  clearHermeticityAttempts,
  hermeticityAttempts,
  hermeticityMode,
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
  test('holds the requested mode across an await', async () => {
    // An async callback returns at its first `await` with its body unfinished.
    // Restoring the mode there would drop everything past the suspension back
    // to the repo default, which in `warn` executes for real — and this helper
    // is the runner's only way to enforce.
    await withHermeticityMode('enforce', async () => {
      expect(hermeticityMode()).toBe('enforce');
      await Promise.resolve();
      expect(() => execFileSync('git', ['--version'])).toThrow(/subprocess escape/);
    });
    clearHermeticityAttempts();
  });

  test('protects the checkout root, not the package working directory', () => {
    // `bun test` runs with container/agent-runner as its cwd, so roots derived
    // from the cwd would guard a directory that does not exist and leave the
    // real central database reachable by a relative path.
    const central = path.resolve(process.cwd(), '../../data/v2.db');
    enforcing(() => expect(() => fs.writeFileSync(central, 'x')).toThrow(/fs-write escape/));
    expect(fs.existsSync(central)).toBe(false);
  });

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

  test('guards the promisified form too', () => {
    // `promisify` calls the function's `nodejs.util.promisify.custom`
    // implementation instead of the function itself, so copying the original's
    // symbol across would hand every promisified caller a straight line to the
    // real binary. The guard throws ahead of the promise, so nothing spawns.
    const execFileAsync = promisify(execFile);
    enforcing(() => expect(() => execFileAsync('git', ['--version'])).toThrow(/subprocess escape — execFile\(git\)/));
  });

  test('records an escape the code under test swallows', () => {
    enforcing(() => {
      try {
        execFileSync('git', ['--version']);
      } catch {
        // Swallowed exactly as production code swallows a failing git.
      }
    });
    expect(hermeticityAttempts()).toHaveLength(1);
  });

  test('checks both operands of a rename, which mutates the source too', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-hermeticity-rename-'));
    const inTmp = path.join(root, 'a');
    fs.writeFileSync(inTmp, 'x');
    // Moving state OUT of the checkout passes a destination-only check, because
    // the destination is an innocent temp path.
    enforcing(() =>
      expect(() => fs.renameSync(path.join(process.cwd(), 'data', 'v2.db'), path.join(root, 'stolen'))).toThrow(
        /fs-write escape — fs.renameSync/,
      ),
    );
    clearHermeticityAttempts();
    enforcing(() => fs.renameSync(inTmp, path.join(root, 'b')));
    expect(hermeticityAttempts()).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
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

  test('records the write attempt without touching the protected path', () => {
    // Deliberately NOT exercised in warn mode: warn calls through, and on a box
    // where the parent happens to exist that would create a real directory
    // inside the live, fail-closed plugins mount. The throw path proves the
    // same thing, because the record is written before the throw.
    const probe = path.join(os.homedir(), 'plugins', 'runner-probe');
    enforcing(() => expect(() => fs.mkdirSync(probe)).toThrow(/fs-write escape/));
    expect(hermeticityAttempts()).toHaveLength(1);
    expect(hermeticityAttempts()[0]!.kind).toBe('fs-write');
    expect(fs.existsSync(probe)).toBe(false);
  });

  test('guards Bun.spawn and Bun.spawnSync, which child_process does not cover', () => {
    // The runner shells out through these directly — self-mod runs `opencode`
    // that way — so a guard that only wrapped Node's exports would report a
    // clean strict run while real child processes came and went.
    enforcing(() => {
      expect(() => Bun.spawn(['git', '--version'])).toThrow(/subprocess escape — Bun.spawn\(git\)/);
      expect(() => Bun.spawnSync(['git', '--version'])).toThrow(/subprocess escape — Bun.spawnSync\(git\)/);
      expect(() => Bun.spawn({ cmd: ['git', '--version'] })).toThrow(/subprocess escape — Bun.spawn\(git\)/);
    });
    clearHermeticityAttempts();

    allowSubprocess(['git']);
    enforcing(() => {
      expect(Bun.spawnSync(['git', '--version']).success).toBe(true);
    });
    expect(hermeticityAttempts()).toHaveLength(0);
  });

  test('guards a writable open, whose descriptor later writes invisibly', () => {
    enforcing(() =>
      expect(() => fs.openSync(path.join(process.cwd(), 'data', 'probe'), 'w')).toThrow(
        /fs-write escape — fs.openSync/,
      ),
    );
    clearHermeticityAttempts();

    // A read-only open mutates nothing and must stay out of the way.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-hermeticity-open-'));
    const readable = path.join(root, 'r');
    fs.writeFileSync(readable, 'x');
    enforcing(() => fs.closeSync(fs.openSync(readable, 'r')));
    expect(hermeticityAttempts()).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('follows a symlink out of the temp dir before allowing the write', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-hermeticity-symlink-'));
    const link = path.join(root, 'link');
    fs.symlinkSync(path.join(process.cwd(), 'data'), link);
    clearHermeticityAttempts();
    enforcing(() => expect(() => fs.writeFileSync(path.join(link, 'v2.db'), 'x')).toThrow(/fs-write escape/));
    fs.rmSync(root, { recursive: true, force: true });
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
