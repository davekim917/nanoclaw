import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { stripInheritedGitEnv } from './test-git-env.js';
import { allowSubprocess } from './test-hermeticity.js';

beforeAll(() => allowSubprocess(['git']));

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  execFileSync('git', args, { cwd, env, stdio: 'ignore' });
}

/** A real repository standing in for the shared checkout, plus an empty fixture dir. */
function poisonedLayout(): { victimGitDir: string; victimConfig: () => string; fixture: string } {
  const root = uniqueTmpRoot('git-env');
  const victim = path.join(root, 'victim');
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(victim, { recursive: true });
  fs.mkdirSync(fixture, { recursive: true });
  git(['init', '-q'], victim, { PATH: process.env.PATH, HOME: root });
  const victimGitDir = path.join(victim, '.git');
  return { victimGitDir, victimConfig: () => fs.readFileSync(path.join(victimGitDir, 'config'), 'utf8'), fixture };
}

describe('inherited GIT_* environment', () => {
  it('is absent from every test process', () => {
    expect(Object.keys(process.env).filter((key) => key.startsWith('GIT_'))).toEqual([]);
  });

  it('would redirect a fixture command into the poisoned repository if left in place', () => {
    const { victimGitDir, victimConfig, fixture } = poisonedLayout();
    const env = { PATH: process.env.PATH, HOME: fixture, GIT_DIR: victimGitDir };

    git(['init', '-q', '--bare'], fixture, env);

    expect(victimConfig()).toMatch(/bare = true/);
    expect(fs.existsSync(path.join(fixture, 'config'))).toBe(false);
  });

  it('keeps a fixture command in its own directory once stripped', () => {
    const { victimGitDir, victimConfig, fixture } = poisonedLayout();
    const before = victimConfig();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: fixture,
      GIT_DIR: victimGitDir,
      GIT_WORK_TREE: path.dirname(victimGitDir),
      GIT_INDEX_FILE: path.join(victimGitDir, 'index'),
      GIT_COMMON_DIR: victimGitDir,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bare',
      GIT_CONFIG_VALUE_0: 'true',
    };

    expect(stripInheritedGitEnv(env).sort()).toEqual([
      'GIT_COMMON_DIR',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_DIR',
      'GIT_INDEX_FILE',
      'GIT_WORK_TREE',
    ]);
    git(['init', '-q', '--bare'], fixture, env);

    expect(victimConfig()).toBe(before);
    expect(fs.readFileSync(path.join(fixture, 'config'), 'utf8')).toMatch(/bare = true/);
  });
});
