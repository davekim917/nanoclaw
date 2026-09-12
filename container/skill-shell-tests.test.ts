import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import type { Dirent } from 'fs';

import { describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

/**
 * Structural gate for shadow-review #724's F3: `ab-net-redact.test.sh` — the
 * only regression check on the network/HAR credential-redaction control added
 * by #700 — never ran anywhere. Nothing in this repo executes `*.test.sh` on
 * its own, so this gate runs every eligible shell suite under `pnpm test` and
 * CI without requiring a sibling wrapper someone must remember to add.
 *
 * Rather than hand-add a second one-off wrapper (and leave the next shell
 * suite exactly as ungated as this one was), this file DISCOVERS every
 * `*.test.sh` anywhere under `container/` and `scripts/` at test-collection
 * time and runs each one as its own `it()` case (see discoverShellSuites()
 * below for why the walk is recursive rather than a fixed
 * `<skill>/scripts/*.test.sh` pattern). A future shell suite is gated the
 * moment it lands, with no wrapper file to remember to add.
 *
 * Every `execFileSync('bash', …)` call below is this file's only subprocess
 * escape (`allowSubprocess(['bash'])` opts in visibly). `enforceHermeticity()`
 * guards this process's Node seams, not Bash descendants: each shell suite
 * must isolate its own external commands. The suite environment neutralizes ambient git
 * config — see buildSuiteEnv() — because `GIT_CONFIG_NOSYSTEM=1` plus a fresh
 * `HOME` alone still leaves `$XDG_CONFIG_HOME/git/config` reachable, and git
 * prefers that file over `$HOME/.gitconfig`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
/** Every root this gate discovers `*.test.sh` suites under. */
const DISCOVERY_ROOTS = [path.join(REPO_ROOT, 'container'), path.join(REPO_ROOT, 'scripts')];

allowSubprocess(['bash']);
enforceHermeticity();

/** Give each suite generous headroom over vitest's 5s default: the slowest
 * discovered suite (smoke-pr-gate.test.sh) runs real poll/claim loops with
 * short internal sleeps and takes 80-100s on this host; smoke-develop-gate.test.sh
 * takes ~30s. The rest finish in a few seconds. */
const SUITE_TIMEOUT_MS = 400_000;

/**
 * Suites that cannot run in this hermetic CI sandbox (Docker, a real browser,
 * network, or a host-only path), each with the one-line reason. Every path
 * here is asserted to still exist below, so a rename or removal fails loudly
 * instead of the exclusion silently rotting into a no-op.
 */
const EXCLUDED_SUITES: ReadonlyArray<{ relPath: string; reason: string }> = [
  {
    relPath: 'container/claude-review-wrapper.test.sh',
    reason: 'needs a candidate image argument ($1) and a real `docker run`; genuinely cannot run unattended in CI',
  },
];

const EXCLUDED_REL_PATHS = new Set(EXCLUDED_SUITES.map((s) => s.relPath));

/**
 * Every `*.test.sh` anywhere under `container/` or `scripts/`, repo-relative,
 * sorted. `container/skills/` is covered by walking `container/` — no need
 * for a second, narrower root.
 *
 * Most `container/skills/` suites live at `<skill>/scripts/<name>.test.sh`,
 * but not all — `container/skills/work-claims/claim.test.sh` sits directly
 * under the skill directory with no `scripts/` level at all, and
 * `container/claude-review-wrapper.test.sh` and
 * `scripts/check-onecli-gateway-fds.test.sh` sit outside `container/skills/`
 * entirely. A pattern hardcoded to one fixed depth or directory would
 * silently miss suites like these (and any future one that lays itself out
 * differently), which is exactly the kind of gap this file exists to close —
 * so this walks each root recursively instead of assuming a fixed shape.
 */
function discoverShellSuites(): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.test.sh')) {
        found.push(path.relative(REPO_ROOT, abs));
      }
    }
  }
  for (const root of DISCOVERY_ROOTS) walk(root);
  return [...new Set(found)].sort();
}

const ALL_SUITES = discoverShellSuites();
const RUNNABLE_SUITES = ALL_SUITES.filter((relPath) => !EXCLUDED_REL_PATHS.has(relPath));

/**
 * The environment a shell suite runs under: a fresh `HOME` (never the real
 * one) plus `GIT_CONFIG_NOSYSTEM=1`, so a suite can't pick up this host's or
 * runner's git config, gitignore, or dotfiles and behave differently between
 * a dev machine and CI.
 *
 * `HOME` and `GIT_CONFIG_NOSYSTEM` alone are not enough: git resolves its
 * "global" config from `$XDG_CONFIG_HOME/git/config` in preference to
 * `$HOME/.gitconfig`, and `GIT_CONFIG_NOSYSTEM` only silences `/etc/gitconfig`
 * (or whatever `$GIT_CONFIG_SYSTEM` names) — it does nothing about the global
 * file. Spreading `...process.env` first therefore used to let an ambient
 * `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL` or `GIT_CONFIG_SYSTEM` straight
 * through, so a hostile or merely unusual value on the host/runner (an
 * `insteadOf` rewrite, a `core.hooksPath`) could silently change what a
 * suite's own git commands read or ran. Remove the two explicit config-file
 * overrides after the spread and pin XDG under the fresh home instead. That
 * keeps host config out while still letting a suite that deliberately writes
 * `$HOME/.gitconfig` inspect its own configuration.
 */
function buildSuiteEnv(freshHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: freshHome,
    GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: path.join(freshHome, '.config'),
  };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_SYSTEM;
  return env;
}

function formatShellSuiteFailure(relPath: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const output = typeof err === 'object' && err !== null ? (err as { stdout?: unknown; stderr?: unknown }) : {};
  return `${relPath} failed: ${detail}\n${output.stdout === undefined ? '' : String(output.stdout)}\n${
    output.stderr === undefined ? '' : String(output.stderr)
  }`;
}

describe('every container skill shell test suite (*.test.sh)', () => {
  it('discovery found the known shell suites (floor, not a fixed count)', () => {
    // A regression in the discovery glob (wrong directory depth, wrong
    // extension, wrong root) would otherwise silently collapse this to zero
    // suites and pass green. Floor rather than exact count: a new *.test.sh
    // landing anywhere under container/ or scripts/ should not have to edit
    // this number.
    expect(ALL_SUITES.length).toBeGreaterThanOrEqual(13);
    expect(ALL_SUITES).toContain('container/skills/agent-browser/scripts/ab-net-redact.test.sh');
    // Proves the scripts/ root is actually walked, not just container/.
    expect(ALL_SUITES).toContain('scripts/check-onecli-gateway-fds.test.sh');
  });

  it('every excluded suite path still exists', () => {
    for (const { relPath } of EXCLUDED_SUITES) {
      const abs = path.join(REPO_ROOT, relPath);
      let isFile = false;
      try {
        isFile = statSync(abs).isFile();
      } catch {
        isFile = false;
      }
      expect(isFile, `excluded suite no longer exists at ${relPath} — update or remove this entry`).toBe(true);
    }
  });

  it('ignores a hostile ambient XDG_CONFIG_HOME/GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM', () => {
    // Simulates a dev machine or CI runner whose ambient environment already
    // carries these three vars, pointed at a config with an `insteadOf`
    // rewrite and a bogus `core.hooksPath` — exactly the class of ambient git
    // config this repo has been bitten by twice (docs/review-notes.md).
    const freshHome = mkdtempSync(path.join(tmpdir(), 'skill-shell-test-home-'));
    const hostileXdg = mkdtempSync(path.join(tmpdir(), 'skill-shell-test-hostile-xdg-'));
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    const savedSystem = process.env.GIT_CONFIG_SYSTEM;
    let probeCwd: string | undefined;
    try {
      mkdirSync(path.join(hostileXdg, 'git'), { recursive: true });
      const hostileConfigPath = path.join(hostileXdg, 'git', 'config');
      writeFileSync(
        hostileConfigPath,
        '[url "https://github.com/"]\n' +
          '\tinsteadOf = https://hostile.invalid/\n' +
          '[core]\n' +
          '\thooksPath = /nonexistent/hostile-hooks\n',
      );

      // The rest of this test's assertions run with the ambient environment
      // already contaminated — buildSuiteEnv() spreads `...process.env` first,
      // so this is what a real CI runner or dev machine would hand it.
      process.env.XDG_CONFIG_HOME = hostileXdg;
      process.env.GIT_CONFIG_GLOBAL = hostileConfigPath;
      process.env.GIT_CONFIG_SYSTEM = hostileConfigPath;

      // Run from an empty, repo-less directory (never this checkout): a probe
      // run from inside the real repo would pick up ITS legitimate local
      // `core.hooksPath` (husky sets `.husky/_`), which has nothing to do with
      // ambient global/system config and would make this test meaningless.
      probeCwd = mkdtempSync(path.join(tmpdir(), 'skill-shell-test-probe-cwd-'));

      // Sanity check the fixture is real: this is the OLD (pre-fix) env —
      // fresh HOME and GIT_CONFIG_NOSYSTEM=1 only — reading the hostile
      // insteadOf straight back. If this assertion ever failed, the test below
      // would be proving nothing.
      const oldEnv = { ...process.env, HOME: freshHome, GIT_CONFIG_NOSYSTEM: '1' };
      const leakedInsteadOf = execFileSync(
        'bash',
        ['-c', 'git config --get url.https://github.com/.insteadOf; exit 0'],
        { encoding: 'utf-8', cwd: probeCwd, env: oldEnv },
      ).trim();
      expect(leakedInsteadOf).toBe('https://hostile.invalid/');
      const leakedHooksPath = execFileSync('bash', ['-c', 'git config --get core.hooksPath; exit 0'], {
        encoding: 'utf-8',
        cwd: probeCwd,
        env: oldEnv,
      }).trim();
      expect(leakedHooksPath).toBe('/nonexistent/hostile-hooks');

      // The suite's real sandbox env must not see it, even though
      // `process.env` still carries the hostile values at the point
      // buildSuiteEnv() spreads it.
      const insteadOf = execFileSync('bash', ['-c', 'git config --get url.https://github.com/.insteadOf; exit 0'], {
        encoding: 'utf-8',
        cwd: probeCwd,
        env: buildSuiteEnv(freshHome),
      }).trim();
      expect(insteadOf).toBe('');

      const hooksPath = execFileSync('bash', ['-c', 'git config --get core.hooksPath; exit 0'], {
        encoding: 'utf-8',
        cwd: probeCwd,
        env: buildSuiteEnv(freshHome),
      }).trim();
      expect(hooksPath).toBe('');

      // Removing, rather than pinning, the explicit global path means a suite
      // can still make and verify an isolated `$HOME/.gitconfig` of its own.
      expect(buildSuiteEnv(freshHome).GIT_CONFIG_GLOBAL).toBeUndefined();
      expect(buildSuiteEnv(freshHome).GIT_CONFIG_SYSTEM).toBeUndefined();
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
      if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = savedSystem;
      if (probeCwd) rmSync(probeCwd, { recursive: true, force: true });
      rmSync(freshHome, { recursive: true, force: true });
      rmSync(hostileXdg, { recursive: true, force: true });
    }
  });

  it('keeps the runner error message with suite stdout and stderr', () => {
    const failure = Object.assign(new Error('spawn ENOENT'), { stdout: 'suite stdout', stderr: 'suite stderr' });
    expect(formatShellSuiteFailure('container/example.test.sh', failure)).toContain('spawn ENOENT');
    expect(formatShellSuiteFailure('container/example.test.sh', failure)).toContain('suite stdout');
    expect(formatShellSuiteFailure('container/example.test.sh', failure)).toContain('suite stderr');
  });

  for (const relPath of RUNNABLE_SUITES) {
    const suitePath = path.join(REPO_ROOT, relPath);
    it(
      `passes: ${relPath}`,
      () => {
        const freshHome = mkdtempSync(path.join(tmpdir(), 'skill-shell-test-home-'));
        try {
          execFileSync('bash', [suitePath], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: buildSuiteEnv(freshHome),
          });
        } catch (err) {
          throw new Error(formatShellSuiteFailure(relPath, err));
        } finally {
          rmSync(freshHome, { recursive: true, force: true });
        }
      },
      SUITE_TIMEOUT_MS,
    );
  }
});
