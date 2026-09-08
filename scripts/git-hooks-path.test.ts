/**
 * The hooks in `.husky/` are this fork's only pre-remote gate, and they had
 * never run on a PR branch push: every PR is developed in a linked worktree,
 * and `husky` pins `core.hooksPath` to the RELATIVE `.husky/_`, which a linked
 * worktree resolves against ITS OWN top level — a directory that does not
 * exist, because `.husky/_/.gitignore` is `*`. Git runs zero hooks and says
 * nothing.
 *
 * These tests pin both halves of the fix: the `prepare` wiring that re-pins the
 * path after every `pnpm install` (husky resets it), and the script's actual
 * behaviour against a real git repository with a real linked worktree.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['git', 'sh']);
enforceHermeticity();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'pin-git-hooks-path.sh');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(name: string): string {
  // realpath because macOS hands back /var/folders/... symlinked from /private,
  // and the assertions below compare paths git reports against paths we built.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A git repository shaped like this one: `.husky/` tracked, `.husky/_` present
 * but UNTRACKED (husky generates it; `.husky/_/.gitignore` is `*`), and
 * `core.hooksPath` left where husky puts it — the relative `.husky/_`.
 */
function fixture(): { main: string; marker: string } {
  const main = tempRoot('hooks-path');
  git(main, ['init', '--quiet', '-b', 'main']);
  git(main, ['config', 'user.email', 'test@example.invalid']);
  git(main, ['config', 'user.name', 'Hooks Path Test']);
  git(main, ['config', 'core.hooksPath', '.husky/_']);

  fs.mkdirSync(path.join(main, '.husky', '_'), { recursive: true });
  fs.writeFileSync(path.join(main, '.husky', '_', '.gitignore'), '*');
  const marker = path.join(main, 'hook-ran.log');
  // Recording `--show-toplevel` rather than a bare "I ran" line: `.husky/pre-push`
  // keys its whole scan off that value (`.husky/pre-push:5`), so the test proves
  // the property the real hooks depend on, not just that something executed.
  const hook = path.join(main, '.husky', '_', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ngit rev-parse --show-toplevel >> ${JSON.stringify(marker)}\n`);
  fs.chmodSync(hook, 0o755);

  fs.writeFileSync(path.join(main, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(main, 'README.md'), 'fixture\n');
  git(main, ['add', '.husky/pre-commit', 'README.md']);
  git(main, ['commit', '--quiet', '-m', 'fixture']);
  // That commit already tripped the hook; start the ledger empty.
  fs.rmSync(marker, { force: true });
  return { main, marker };
}

/** Every `--show-toplevel` the fixture hook has recorded so far. */
function hookRuns(marker: string): string[] {
  if (!fs.existsSync(marker)) return [];
  return fs
    .readFileSync(marker, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => fs.realpathSync(line));
}

function commit(cwd: string, message: string): void {
  git(cwd, ['commit', '--quiet', '--allow-empty', '-m', message]);
}

describe('prepare wiring', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('runs the pinning script from prepare, after husky', () => {
    const prepare = pkg.scripts.prepare;
    expect(prepare).toContain('husky');
    expect(prepare).toContain('scripts/pin-git-hooks-path.sh');
    // Order is load-bearing, not cosmetic: `husky` REWRITES core.hooksPath back
    // to the relative `.husky/_` every time it runs, so pinning before it would
    // be undone on the same install.
    expect(prepare.indexOf('husky')).toBeLessThan(prepare.indexOf('scripts/pin-git-hooks-path.sh'));
  });

  it('ships the script it names', () => {
    expect(fs.existsSync(script)).toBe(true);
    expect(fs.readFileSync(script, 'utf8').startsWith('#!/bin/sh')).toBe(true);
  });
});

describe('pin-git-hooks-path.sh', () => {
  it('makes hooks run from a linked worktree, which the relative path does not', () => {
    const { main, marker } = fixture();

    // Baseline: from the main checkout the relative path already works, so a
    // later failure cannot be blamed on a mis-built fixture hook.
    commit(main, 'from main');
    expect(hookRuns(marker)).toEqual([main]);
    fs.rmSync(marker);

    const linked = path.join(tempRoot('hooks-path-wt'), 'wt');
    git(main, ['worktree', 'add', '--quiet', '-b', 'topic', linked]);

    // The bug: `.husky/_` is untracked, so it does not exist in the worktree,
    // and git resolves the relative hooksPath there and silently finds nothing.
    expect(fs.existsSync(path.join(linked, '.husky', '_'))).toBe(false);
    commit(linked, 'from the worktree, ungated');
    expect(hookRuns(marker)).toEqual([]);

    const pinned = spawnSync('sh', [script], { cwd: linked, encoding: 'utf8' });
    expect(pinned.status).toBe(0);

    // One shared `.git/config`, so both checkouts see the same absolute value.
    const configured = git(linked, ['config', '--get', 'core.hooksPath']);
    expect(path.isAbsolute(configured)).toBe(true);
    expect(configured).toBe(path.join(main, '.husky', '_'));
    expect(git(main, ['config', '--get', 'core.hooksPath'])).toBe(configured);

    commit(linked, 'from the worktree, gated');
    // The hook ran, and saw the WORKTREE as its top level — not the main
    // checkout whose `.husky/_` supplied the script.
    expect(hookRuns(marker)).toEqual([linked]);
  });

  it('is idempotent and re-pins after husky resets the relative path', () => {
    const { main } = fixture();
    const absolute = path.join(main, '.husky', '_');

    expect(spawnSync('sh', [script], { cwd: main, encoding: 'utf8' }).status).toBe(0);
    expect(git(main, ['config', '--get', 'core.hooksPath'])).toBe(absolute);

    expect(spawnSync('sh', [script], { cwd: main, encoding: 'utf8' }).status).toBe(0);
    expect(git(main, ['config', '--get', 'core.hooksPath'])).toBe(absolute);

    // What husky does on every `pnpm install` — and the reason this is a
    // `prepare` step rather than a one-off `git config`.
    git(main, ['config', 'core.hooksPath', '.husky/_']);
    expect(spawnSync('sh', [script], { cwd: main, encoding: 'utf8' }).status).toBe(0);
    expect(git(main, ['config', '--get', 'core.hooksPath'])).toBe(absolute);
  });

  it('writes the SHARED config even with extensions.worktreeConfig enabled', () => {
    // This repository has `extensions.worktreeConfig = true`. That matters,
    // because it is what makes per-worktree overrides possible at all — and if
    // the pin landed in one, a single `pnpm install` would fix one worktree
    // instead of all of them. It does not: `git config` writes the shared
    // `.git/config` unless given `--worktree`, and only `core.bare` and
    // `core.worktree` are per-worktree implicitly. Pinned here so nobody has to
    // re-derive it from the git docs.
    const { main } = fixture();
    git(main, ['config', 'extensions.worktreeConfig', 'true']);
    const linked = path.join(tempRoot('hooks-path-wtcfg'), 'wt');
    git(main, ['worktree', 'add', '--quiet', '-b', 'wtcfg', linked]);

    expect(spawnSync('sh', [script], { cwd: linked, encoding: 'utf8' }).status).toBe(0);

    const origin = git(linked, ['config', '--show-origin', '--get', 'core.hooksPath']);
    expect(origin).toContain(path.join(main, '.git', 'config'));
    expect(origin).not.toContain('config.worktree');
    // The value one install pinned is what every other worktree reads.
    expect(git(main, ['config', '--get', 'core.hooksPath'])).toBe(path.join(main, '.husky', '_'));
  });

  it('exits 0 and configures nothing outside a git repository', () => {
    const plain = tempRoot('hooks-path-nogit');
    const result = spawnSync('sh', [script], { cwd: plain, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fs.readdirSync(plain)).toEqual([]);
  });

  it('leaves a repository that carries no .husky/ alone', () => {
    const other = tempRoot('hooks-path-other');
    git(other, ['init', '--quiet', '-b', 'main']);
    const result = spawnSync('sh', [script], { cwd: other, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: other }).status).not.toBe(0);
  });
});
