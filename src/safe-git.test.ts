import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repositoryConfigPath, safeGitArgs, safeGitEnv, safeGitFilterNames } from './safe-git.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-git-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository whose README.md is stat-dirty and selected by the filter `name`, whose clean driver drops a sentinel. */
function repoWithFilter(name: string): { repo: string; sentinel: string } {
  const repo = path.join(root, 'repo');
  const sentinel = path.join(root, 'filter-ran');
  const driver = path.join(root, 'driver.sh');
  fs.writeFileSync(driver, `#!/bin/sh\ntouch ${sentinel}\ncat\n`, { mode: 0o755 });
  git(root, ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  git(repo, ['config', `filter.${name}.clean`, driver]);
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), `* filter=${name}\n`);
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(repo, 'README.md'), old, old);
  return { repo, sentinel };
}

describe('safeGitArgs filter neutralization', () => {
  for (const name of ['plain', 'a=b', 'a=b=c', '=', 'dot.ted']) {
    it(`neutralizes a repository filter named ${JSON.stringify(name)}`, () => {
      const { repo, sentinel } = repoWithFilter(name);
      const gitDir = path.join(repo, '.git');
      expect(safeGitFilterNames(gitDir, repo)).toEqual([name]);

      execFileSync('git', safeGitArgs(['-C', repo, 'status', '--porcelain'], repositoryConfigPath(gitDir)), {
        env: safeGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(fs.existsSync(sentinel)).toBe(false);

      // The fixture is live: plain git runs the driver.
      fs.utimesSync(path.join(repo, 'README.md'), new Date(0), new Date(0));
      git(repo, ['status', '--porcelain']);
      expect(fs.existsSync(sentinel)).toBe(true);
    });
  }

  it('refuses to run when the override values are missing from the environment', () => {
    const { repo } = repoWithFilter('a=b');
    const gitDir = path.join(repo, '.git');
    expect(() =>
      execFileSync('git', safeGitArgs(['-C', repo, 'status', '--porcelain'], repositoryConfigPath(gitDir)), {
        env: { PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow(/missing environment variable/);
  });
});
