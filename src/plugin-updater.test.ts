import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./codex-sync.js', () => ({
  syncCodexSubagents: vi.fn(() => ({ targets: [], discovered: 0, writes: 0, removedFiles: 0, skipped: [] })),
  syncCodexLocalMarketplacePluginCache: vi.fn(() => ({
    target: '',
    marketplaces: 0,
    installed: [],
    updated: [],
    removed: [],
    skipped: [],
    errors: [],
  })),
}));
vi.mock('./opencode-sync.js', () => ({
  syncOpenCodeSubagents: vi.fn(() => ({ targets: [], discovered: 0, writes: 0, removedFiles: 0, skipped: [] })),
}));
vi.mock('./codex-skill-materialize.js', () => ({ refreshMaterializedCodexSkills: vi.fn(() => ({ refreshed: [] })) }));
vi.mock('./design-artifact-loop-vendor.js', () => ({ vendorDesignArtifactLoop: vi.fn(() => []) }));
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: vi.fn() }));
vi.mock('./host-lifecycle.js', () => ({ onHostStart: vi.fn(), onHostShutdown: vi.fn() }));

import { log } from './log.js';
import { runPluginUpdates } from './plugin-updater.js';

const FAKE_NPM = `#!/bin/sh
echo "$PWD $*" >> "$FAKE_NPM_LOG"
[ -e "$PWD/.npm-fails" ] && { echo "npm ERR! boom" >&2; exit 1; }
exit 0
`;

const FAKE_CODEX = `#!/bin/sh
echo "All configured Git marketplaces are already up to date."
`;

const FAKE_GIT = `#!/bin/sh
state="$PWD/.git/fake"
case "$1" in
  rev-parse) if [ -e "$state/pulled" ]; then echo new; else echo old; fi ;;
  pull)
    [ -e "$state/pull-fails" ] && { echo "fatal: pull boom" >&2; exit 1; }
    [ -e "$state/upstream-moved" ] && : > "$state/pulled"
    echo "Updating" ;;
  ls-tree) if [ -e "$state/ls-tree-fails" ]; then echo "fatal: ls-tree boom" >&2; exit 128; fi ;;
  diff)
    [ -e "$state/diff-fails" ] && { echo "fatal: diff boom" >&2; exit 128; }
    [ -e "$state/diff-out" ] && tr '\\n' '\\0' < "$state/diff-out" ;;
  *) exit 2 ;;
esac
`;

const REGISTRY_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'p' },
    'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
    'node_modules/local': { resolved: '../local', link: true },
  },
});

const GIT_DEP_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'p' },
    'node_modules/evil': { version: '1.0.0', resolved: 'git+ssh://git@example.com/evil.git#abc' },
  },
});

let tmp: string;
let home: string;
let npmLog: string;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, FAKE_NPM_LOG: process.env.FAKE_NPM_LOG };

function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function npmCalls(): string[] {
  if (!fs.existsSync(npmLog)) return [];
  return fs
    .readFileSync(npmLog, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replaceAll(`${home}/plugins/`, ''));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function useBin(bin: string): void {
  process.env.PATH = `${bin}:/usr/bin:/bin`;
}

beforeEach(() => {
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-updater-'));
  home = path.join(tmp, 'home');
  npmLog = path.join(tmp, 'npm.log');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  process.env.HOME = home;
  process.env.FAKE_NPM_LOG = npmLog;
  const bin = path.join(tmp, 'bin');
  writeExecutable(path.join(bin, 'npm'), FAKE_NPM);
  writeExecutable(path.join(bin, 'codex'), FAKE_CODEX);
  useBin(bin);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('with real git: installs only where the pulled range changed a lockfile', () => {
  const gitEnv = () => ({
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf-8', stdio: 'pipe' });

  let upstream: string;

  beforeEach(() => {
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    upstream = path.join(tmp, 'upstream');
    fs.mkdirSync(upstream);
    git(upstream, 'init', '-q', '-b', 'main');
    write(path.join(upstream, 'package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/changed/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/unchanged/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/deleted/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/gitdep/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/never-installed/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/tracked/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'README.md'), 'v1\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'v1');
    git(tmp, 'clone', '-q', upstream, path.join(home, 'plugins', 'bootstrap'));
    for (const dir of ['.', 'plugins/changed', 'plugins/unchanged', 'plugins/deleted', 'plugins/gitdep']) {
      fs.mkdirSync(path.join(home, 'plugins', 'bootstrap', dir, 'node_modules'), { recursive: true });
    }
  });

  afterEach(() => {
    delete process.env.GIT_CONFIG_NOSYSTEM;
  });

  it('runs npm ci --ignore-scripts in each changed lockfile dir and nowhere else', async () => {
    write(path.join(upstream, 'package-lock.json'), REGISTRY_LOCK + '\n');
    write(path.join(upstream, 'plugins/changed/package-lock.json'), REGISTRY_LOCK + '\n');
    fs.rmSync(path.join(upstream, 'plugins/deleted/package-lock.json'));
    write(path.join(upstream, 'plugins/gitdep/package-lock.json'), GIT_DEP_LOCK);
    write(path.join(upstream, 'plugins/never-installed/package-lock.json'), REGISTRY_LOCK + '\n');
    write(path.join(upstream, 'plugins/tracked/package-lock.json'), REGISTRY_LOCK + '\n');
    write(path.join(upstream, 'plugins/tracked/node_modules/planted.js'), '');
    write(path.join(upstream, 'plugins/unchanged/package.json'), '{}');
    write(path.join(upstream, 'plugins/new/package-lock.json.bak'), REGISTRY_LOCK);
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'v2');
    write(path.join(upstream, 'README.md'), 'v3\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'v3');

    const results = await runPluginUpdates();

    expect(results).toEqual([{ plugin: 'bootstrap', changed: true }]);
    expect(npmCalls().sort()).toEqual([
      'bootstrap ci --ignore-scripts --prefix bootstrap',
      'bootstrap/plugins/changed ci --ignore-scripts --prefix bootstrap/plugins/changed',
    ]);
    expect(log.info).toHaveBeenCalledWith('Plugin dependencies installed', {
      plugin: 'bootstrap',
      dir: 'plugins/changed',
      command: `npm ci --ignore-scripts --prefix ${home}/plugins/bootstrap/plugins/changed`,
    });
    expect(log.info).toHaveBeenCalledWith('Plugin dependencies installed', {
      plugin: 'bootstrap',
      dir: '.',
      command: `npm ci --ignore-scripts --prefix ${home}/plugins/bootstrap`,
    });
    expect(log.info).toHaveBeenCalledWith('Plugin lockfile changed; no existing install to refresh', {
      plugin: 'bootstrap',
      dir: 'plugins/never-installed',
    });
    expect(log.info).toHaveBeenCalledWith('Plugin lockfile changed; no existing install to refresh', {
      plugin: 'bootstrap',
      dir: 'plugins/tracked',
    });
    expect(vi.mocked(log.warn).mock.calls).toEqual([
      [
        'Plugin dependency install refused',
        expect.objectContaining({
          plugin: 'bootstrap',
          dir: 'plugins/gitdep',
          reason: expect.stringContaining('node_modules/evil'),
        }),
      ],
    ]);
  });

  it('runs nothing when the pull brings no commits', async () => {
    const results = await runPluginUpdates();

    expect(results).toEqual([{ plugin: 'bootstrap', changed: false }]);
    expect(npmCalls()).toEqual([]);
  });

  it('runs nothing when the pulled range touches no lockfile', async () => {
    write(path.join(upstream, 'README.md'), 'v2\n');
    git(upstream, 'commit', '-q', '-am', 'v2');

    const results = await runPluginUpdates();

    expect(results).toEqual([{ plugin: 'bootstrap', changed: true }]);
    expect(npmCalls()).toEqual([]);
  });
});

describe('with fake git: failures stay inside their plugin', () => {
  function fakePlugin(name: string, state: Record<string, string>, lockfiles: Record<string, string> = {}): string {
    const dir = path.join(home, 'plugins', name);
    for (const [file, content] of Object.entries(state)) write(path.join(dir, '.git/fake', file), content);
    for (const [file, content] of Object.entries(lockfiles)) {
      write(path.join(dir, file), content);
      fs.mkdirSync(path.join(dir, path.dirname(file), 'node_modules'), { recursive: true });
    }
    return dir;
  }

  beforeEach(() => {
    writeExecutable(path.join(tmp, 'bin', 'git'), FAKE_GIT);
  });

  it('a failing npm ci warns and does not stop other plugins or their installs', async () => {
    const broken = fakePlugin(
      'broken',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': REGISTRY_LOCK },
    );
    write(path.join(broken, '.npm-fails'), '');
    fakePlugin(
      'healthy',
      { 'upstream-moved': '', 'diff-out': 'sub/package-lock.json\n' },
      { 'sub/package-lock.json': REGISTRY_LOCK },
    );

    const results = await runPluginUpdates();

    expect(results.sort((a, b) => a.plugin.localeCompare(b.plugin))).toEqual([
      { plugin: 'broken', changed: true },
      { plugin: 'healthy', changed: true },
    ]);
    expect(npmCalls().sort()).toEqual([
      'broken ci --ignore-scripts --prefix broken',
      'healthy/sub ci --ignore-scripts --prefix healthy/sub',
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install failed',
      expect.objectContaining({
        plugin: 'broken',
        dir: '.',
        command: `npm ci --ignore-scripts --prefix ${home}/plugins/broken`,
      }),
    );
  });

  it('a failing lockfile diff warns and installs nothing for that plugin', async () => {
    fakePlugin('p', { 'upstream-moved': '', 'diff-fails': '' }, { 'package-lock.json': REGISTRY_LOCK });

    const results = await runPluginUpdates();

    expect(results).toEqual([{ plugin: 'p', changed: true }]);
    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin lockfile diff failed; skipping dependency install',
      expect.objectContaining({ plugin: 'p' }),
    );
  });

  it('a failing install-provenance check warns and installs nothing for that lockfile', async () => {
    fakePlugin(
      'p',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n', 'ls-tree-fails': '' },
      { 'package-lock.json': REGISTRY_LOCK },
    );

    const results = await runPluginUpdates();

    expect(results).toEqual([{ plugin: 'p', changed: true }]);
    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install failed',
      expect.objectContaining({ plugin: 'p', err: expect.stringContaining('ls-tree boom') }),
    );
  });

  it('a failing pull installs nothing and does not stop other plugins', async () => {
    fakePlugin('down', { 'pull-fails': '', 'diff-out': 'package-lock.json\n' }, { 'package-lock.json': REGISTRY_LOCK });
    fakePlugin(
      'up',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': REGISTRY_LOCK },
    );

    const results = await runPluginUpdates();

    expect(results.find((r) => r.plugin === 'down')).toMatchObject({ changed: false, error: expect.any(String) });
    expect(results.find((r) => r.plugin === 'up')).toEqual({ plugin: 'up', changed: true });
    expect(npmCalls()).toEqual(['up ci --ignore-scripts --prefix up']);
  });

  const lockWith = (entry: Record<string, unknown>) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'p' }, 'node_modules/dep': entry } });

  it.each([
    ['a git URL over https', { version: '1.0.0', resolved: 'https://github.com/o/r.git#abc' }],
    ['a git+ssh URL', { version: '1.0.0', resolved: 'git+ssh://git@example.com/o/r.git#abc' }],
    ['another registry host', { version: '1.0.0', resolved: 'https://registry.example.com/dep/-/dep-1.0.0.tgz' }],
    ['a plain http registry URL', { version: '1.0.0', resolved: 'http://registry.npmjs.org/dep/-/dep-1.0.0.tgz' }],
    ['a relative file path', { version: '1.0.0', resolved: 'file:../dep' }],
    ['no resolved and a non-semver version', { version: 'github:o/r' }],
    ['no resolved and no version', {}],
  ])('refuses a lockfile whose dependency has %s', async (_label, entry) => {
    fakePlugin(
      'p',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': lockWith(entry) },
    );

    await runPluginUpdates();

    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install refused',
      expect.objectContaining({ plugin: 'p', reason: expect.stringContaining('node_modules/dep') }),
    );
  });

  it('installs a lockfile whose dependency has no resolved but a semver version', async () => {
    fakePlugin(
      'p',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': lockWith({ version: '1.2.3-beta.1' }) },
    );

    await runPluginUpdates();

    expect(npmCalls()).toEqual(['p ci --ignore-scripts --prefix p']);
  });

  it('refuses a directory whose npm-shrinkwrap.json would take precedence', async () => {
    fakePlugin(
      'p',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': REGISTRY_LOCK, 'npm-shrinkwrap.json': GIT_DEP_LOCK },
    );

    await runPluginUpdates();

    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install refused',
      expect.objectContaining({ plugin: 'p', reason: expect.stringContaining('npm-shrinkwrap.json') }),
    );
  });

  it('refuses a lockfile that predates lockfileVersion 2', async () => {
    fakePlugin(
      'old',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: {} }) },
    );

    await runPluginUpdates();

    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install refused',
      expect.objectContaining({ plugin: 'old', reason: 'lockfile predates lockfileVersion 2' }),
    );
  });
});
