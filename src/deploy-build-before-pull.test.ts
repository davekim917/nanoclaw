/**
 * The whole deploy, run for real against a throwaway origin and live checkout,
 * with fakes only at the edges (docker, container/build.sh, pnpm, systemctl).
 *
 * The running host checks the spawn image's dependency label against the
 * agent-runner source it booted with, so the image for the target commit has
 * to be built before the live checkout moves (no build on the critical path)
 * and may become the spawn image only right before the restart that boots the
 * matching source. A string assertion cannot see what the checkout and the
 * spawn tag held at each step; fakes that record it can.
 */
import { createHash } from 'crypto';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAKE_DOCKER = `#!/bin/bash
echo "$*" >> "$DOCKER_CALLS"
case "$1" in
  inspect)
    [ -d "$DOCKER_STATE/$2" ] || exit 1
    if [ "$3" = "--format" ]; then
      key=$(printf '%s' "$4" | sed -n 's/.*Labels "\\([^"]*\\)".*/\\1/p')
      cat "$DOCKER_STATE/$2/$key" 2>/dev/null
    fi
    ;;
  tag)
    [ -d "$DOCKER_STATE/$2" ] || exit 1
    rm -rf "$DOCKER_STATE/$3" && cp -r "$DOCKER_STATE/$2" "$DOCKER_STATE/$3"
    ;;
  image)
    [ "$2" = "rm" ] && [ -d "$DOCKER_STATE/$3" ] && rm -rf "$DOCKER_STATE/$3"
    ;;
esac
exit 0
`;

/** Labels the image the way container/build.sh does, and records what it saw. */
const FAKE_BUILD = `#!/bin/bash
set -e
ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
{
  echo "root=$ROOT"
  echo "tree_head=$(git -C "$ROOT" rev-parse HEAD)"
  echo "live_head=$(git -C "$LIVE" rev-parse HEAD)"
  echo "logs=$(readlink -f "$ROOT/logs")"
  echo "ref=$CONTAINER_IMAGE_REF"
  echo "tag=$1"
  echo "lease=$NANOCLAW_IMAGE_RETENTION_HOURS"
  echo "install_root=$NANOCLAW_PROJECT_ROOT"
} > "$BUILD_RECORD"
[ -z "$ON_BUILD" ] || bash -c "$ON_BUILD"
[ -z "$FAIL_BUILD" ] || exit 1
PKG_SHA=$(sha256sum "$ROOT/container/agent-runner/package.json" | awk '{print $1}')
LOCK_SHA=$(sha256sum "$ROOT/container/agent-runner/bun.lock" | awk '{print $1}')
DEPS=$(printf '%s%s' "$PKG_SHA" "$LOCK_SHA" | sha256sum | cut -c1-16)
[ -z "$WRONG_DEPS" ] || DEPS=0000000000000000
mkdir -p "$DOCKER_STATE/$CONTAINER_IMAGE_REF"
git -C "$ROOT" rev-parse HEAD > "$DOCKER_STATE/$CONTAINER_IMAGE_REF/nanoclaw.commit"
echo "$DEPS" > "$DOCKER_STATE/$CONTAINER_IMAGE_REF/nanoclaw.agentRunnerDepsHash"
`;

/** Every step records the commit checked out and the commit the spawn tag carries at that moment. */
const RECORD_STEP = `echo "$STEP head=$(git -C "$LIVE" rev-parse HEAD) latest=$(cat "$DOCKER_STATE/$SPAWN_REF/nanoclaw.commit" 2>/dev/null)" >> "$EVENTS"`;

const FAKE_PNPM = `#!/bin/bash
STEP="pnpm $*"
${RECORD_STEP}
case "$*" in
  "run build") [ -z "$FAIL_HOST_BUILD" ] || exit 1 ;;
esac
exit 0
`;

const FAKE_SYSTEMCTL = `#!/bin/bash
sub="$1"; shift
case "$sub" in
  list-units) echo "nanoclaw-v2.service loaded active running Fake unit" ;;
  show) printf 'Id=nanoclaw-v2.service\\nType=simple\\nWorkingDirectory=%s\\n' "$LIVE" ;;
  is-active) exit 0 ;;
  restart)
    STEP="restart $1"
    ${RECORD_STEP}
    [ -z "$FAIL_RESTART" ] || exit 1
    ;;
esac
exit 0
`;

interface Harness {
  dir: string;
  seed: string;
  live: string;
  bin: string;
  tmp: string;
  state: string;
  base: string;
  first: string;
  target: string;
}

let h: Harness;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

function depsHash(repo: string): string {
  const sha = (f: string): string =>
    createHash('sha256')
      .update(fs.readFileSync(path.join(repo, 'container/agent-runner', f)))
      .digest('hex');
  return createHash('sha256')
    .update(sha('package.json') + sha('bun.lock'))
    .digest('hex')
    .slice(0, 16);
}

function commitAll(message: string): string {
  git(h.seed, 'add', '-A');
  git(h.seed, 'commit', '-q', '-m', message);
  git(h.seed, 'push', '-q', 'origin', 'HEAD:main');
  return git(h.seed, 'rev-parse', 'HEAD');
}

function setLabels(ref: string, commit: string, deps: string): void {
  write(path.join(h.state, ref, 'nanoclaw.commit'), `${commit}\n`);
  write(path.join(h.state, ref, 'nanoclaw.agentRunnerDepsHash'), `${deps}\n`);
}

function label(tag: string, key = 'nanoclaw.commit'): string | null {
  const file = path.join(h.state, `${h.base}:${tag}`, key);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim() : null;
}

/** Origin at a first commit carrying the real deploy.sh, the live checkout cloned from it, its image built. */
function setUp(targetChangesContainer = true): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-build-before-pull-'));
  const seed = path.join(dir, 'seed');
  const live = path.join(dir, 'live');
  const bin = path.join(dir, 'bin');
  const tmp = path.join(dir, 'tmp');
  const state = path.join(dir, 'docker');
  for (const d of [seed, bin, tmp, state]) fs.mkdirSync(d);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(dir, 'origin.git')]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  git(seed, 'remote', 'add', 'origin', path.join(dir, 'origin.git'));
  write(path.join(bin, 'docker'), FAKE_DOCKER, 0o755);
  write(path.join(bin, 'pnpm'), FAKE_PNPM, 0o755);
  write(path.join(bin, 'systemctl'), FAKE_SYSTEMCTL, 0o755);
  write(path.join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n', 0o755);

  for (const f of ['scripts/deploy.sh', 'scripts/write-deploy-json.mjs', 'setup/lib/install-slug.sh']) {
    write(path.join(seed, f), fs.readFileSync(path.join(root, f), 'utf-8'), 0o755);
  }
  write(path.join(seed, 'package.json'), '{"version":"1.0.0"}\n');
  write(path.join(seed, 'container/build.sh'), FAKE_BUILD, 0o755);
  write(path.join(seed, 'container/agent-runner/package.json'), '{"dependencies":{"a":"1.0.0"}}\n');
  write(path.join(seed, 'container/agent-runner/bun.lock'), 'lock v1\n');
  write(path.join(seed, '.gitignore'), 'node_modules/\ndist/\nlogs/\ndata/\n*.pre-deploy\n');
  const base = `nanoclaw-agent-v2-${createHash('sha1').update(live).digest('hex').slice(0, 8)}`;
  h = { dir, seed, live, bin, tmp, state, base, first: '', target: '' };
  h.first = commitAll('first');

  execFileSync('git', ['clone', '-q', path.join(dir, 'origin.git'), live]);
  fs.mkdirSync(path.join(live, 'node_modules'));
  fs.mkdirSync(path.join(live, 'dist'));
  write(path.join(live, 'data/upgrade-state.json'), '{"version":"1.0.0"}\n');
  setLabels(`${base}:latest`, h.first, depsHash(live));

  if (targetChangesContainer) {
    write(path.join(seed, 'container/agent-runner/package.json'), '{"dependencies":{"a":"2.0.0"}}\n');
    write(path.join(seed, 'container/agent-runner/bun.lock'), 'lock v2\n');
  } else {
    write(path.join(seed, 'README.md'), 'docs only\n');
  }
  h.target = commitAll('target');
}

function deploy(env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync('bash', ['scripts/deploy.sh'], {
    cwd: h.live,
    env: {
      ...process.env,
      PATH: `${h.bin}:${process.env.PATH}`,
      TMPDIR: h.tmp,
      NANOCLAW_DEPLOY_ROOT: h.live,
      LIVE: h.live,
      SPAWN_REF: `${h.base}:latest`,
      EVENTS: path.join(h.dir, 'events'),
      DOCKER_STATE: h.state,
      DOCKER_CALLS: path.join(h.dir, 'docker-calls'),
      BUILD_RECORD: path.join(h.dir, 'build-record'),
      ...env,
    },
    encoding: 'utf8',
  });
}

function buildRecord(): Record<string, string> | null {
  const file = path.join(h.dir, 'build-record');
  if (!fs.existsSync(file)) return null;
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

/** Each recorded step as `<step> head=<sha> latest=<sha>`, with the shas named. */
function events(): string[] {
  const file = path.join(h.dir, 'events');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replaceAll(h.first, 'FIRST').replaceAll(h.target, 'TARGET'));
}

function status(): { status?: string; step?: string; error?: string } {
  return JSON.parse(fs.readFileSync(path.join(h.live, 'logs/deploy-status.json'), 'utf-8')) as {
    status?: string;
    step?: string;
    error?: string;
  };
}

/** Every commit the live checkout's HEAD has pointed at, so a pull undone by the rollback still shows. */
function liveHeadHistory(): string[] {
  return git(h.live, 'log', '-g', '--format=%H', 'HEAD').split('\n');
}

function manifestImageBase(): string | null {
  const file = path.join(h.live, 'data/deploy-rollback.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf-8')) as { imageBase: string }).imageBase : null;
}

function expectNoBuildLeftovers(): void {
  expect(git(h.live, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  expect(fs.readdirSync(h.tmp)).toEqual([]);
  expect(label('deploy-staged')).toBeNull();
  // The links into the live checkout went away without taking their targets.
  expect(fs.existsSync(path.join(h.live, 'logs/deploy.log'))).toBe(true);
}

describe('deploy stages the agent image before the pull and promotes it at the restart', () => {
  afterEach(() => {
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('builds the target outside the live checkout before the pull, and promotes it after the host build, right before the restart', () => {
    setUp();
    const result = deploy();
    expect(result.status, result.stderr).toBe(0);

    const build = buildRecord();
    expect(build).not.toBeNull();
    expect(build!.tree_head).toBe(h.target);
    expect(build!.live_head).toBe(h.first);
    expect(path.relative(h.live, build!.root).startsWith('..')).toBe(true);
    // Same build flags and lock as a build in the live checkout, onto a staging
    // ref with a lease the storage collector honours.
    expect(build!.logs).toBe(fs.realpathSync(path.join(h.live, 'logs')));
    expect(build!.ref).toBe(`${h.base}:deploy-staged`);
    expect(build!.tag).toBe('deploy-staged');
    expect(Number(build!.lease)).toBeGreaterThan(0);
    expect(build!.install_root).toBe(h.live);

    // The host built against the old spawn image; the restart found the new one.
    expect(events()).toEqual([
      'pnpm install --frozen-lockfile head=TARGET latest=FIRST',
      'pnpm run build:dashboard head=TARGET latest=FIRST',
      'pnpm run build head=TARGET latest=FIRST',
      'pnpm exec tsx scripts/quarantine-planted-host-dirs.ts --apply head=TARGET latest=FIRST',
      'restart nanoclaw-v2 head=TARGET latest=TARGET',
    ]);
    expect(label('latest', 'nanoclaw.agentRunnerDepsHash')).toBe(depsHash(h.live));
    expect(label('pre-deploy')).toBe(h.first);
    expect(manifestImageBase()).toBe(h.base);
    expect(status()).toMatchObject({ status: 'ok' });
    expectNoBuildLeftovers();
  });

  it('a failed build leaves the live checkout unpulled and the spawn image where it was', () => {
    setUp();
    const result = deploy({ FAIL_BUILD: '1' });
    expect(result.status).toBe(1);
    expect(liveHeadHistory()).not.toContain(h.target);
    expect(git(h.live, 'rev-parse', 'HEAD')).toBe(h.first);
    expect(events()).toEqual([]);
    expect(status()).toMatchObject({ status: 'failed', step: 'container build' });
    expect(status().error).toContain('spawn image untouched');
    expect(label('latest')).toBe(h.first);
    expect(label('pre-deploy')).toBeNull();
    expect(fs.existsSync(path.join(h.live, 'node_modules'))).toBe(true);
    expect(fs.existsSync(path.join(h.live, 'dist'))).toBe(true);
    expectNoBuildLeftovers();
  });

  it('never rolls back a spawn image it did not promote, such as a watcher rebuild that landed during a failed staged build', () => {
    setUp();
    const watcherBuild = '1111111111111111111111111111111111111111';
    const result = deploy({
      FAIL_BUILD: '1',
      ON_BUILD: `echo ${watcherBuild} > "$DOCKER_STATE/$SPAWN_REF/nanoclaw.commit"`,
    });
    expect(result.status).toBe(1);
    expect(label('latest')).toBe(watcherBuild);
    expect(label('pre-deploy')).toBeNull();
  });

  it('refuses an image whose dependency label does not match the target commit, before anything is pulled', () => {
    setUp();
    const result = deploy({ WRONG_DEPS: '1' });
    expect(result.status).toBe(1);
    expect(liveHeadHistory()).not.toContain(h.target);
    expect(status()).toMatchObject({ status: 'failed', step: 'container build' });
    expect(status().error).toContain(`expected ${h.target}`);
    expect(label('latest')).toBe(h.first);
    expectNoBuildLeftovers();
  });

  it('a host build failure after the pull rolls the checkout back and never promotes the staged image', () => {
    setUp();
    const result = deploy({ FAIL_HOST_BUILD: '1' });
    expect(result.status).toBe(1);
    expect(git(h.live, 'rev-parse', 'HEAD')).toBe(h.first);
    expect(status()).toMatchObject({ status: 'failed', step: 'build' });
    expect(label('latest')).toBe(h.first);
    expect(label('pre-deploy')).toBeNull();
    expectNoBuildLeftovers();
  });

  it('a failed restart after promotion puts back the image this deploy replaced', () => {
    setUp();
    const result = deploy({ FAIL_RESTART: '1' });
    expect(result.status).toBe(1);
    expect(events().at(-1)).toBe('restart nanoclaw-v2 head=TARGET latest=TARGET');
    expect(status()).toMatchObject({ status: 'failed', step: 'restart' });
    expect(git(h.live, 'rev-parse', 'HEAD')).toBe(h.first);
    expect(label('latest')).toBe(h.first);
    expectNoBuildLeftovers();
  });

  it('moves the live checkout to the commit it built even when origin moved during the build', () => {
    setUp();
    write(path.join(h.seed, 'container/agent-runner/bun.lock'), 'lock v3\n');
    git(h.seed, 'add', '-A');
    git(h.seed, 'commit', '-q', '-m', 'landed during the build');
    const result = deploy({ ON_BUILD: `git -C "${h.seed}" push -q origin HEAD:main` });
    expect(result.status, result.stderr).toBe(0);
    expect(git(h.seed, 'ls-remote', 'origin', 'main').split(/\s/)[0]).not.toBe(h.target);
    expect(git(h.live, 'rev-parse', 'HEAD')).toBe(h.target);
    expect(label('latest')).toBe(h.target);
  });

  it('neither builds nor promotes when the target commit leaves container/ alone', () => {
    setUp(false);
    const result = deploy();
    expect(result.status, result.stderr).toBe(0);
    expect(buildRecord()).toBeNull();
    expect(git(h.live, 'rev-parse', 'HEAD')).toBe(h.target);
    expect(label('latest')).toBe(h.first);
    expect(label('pre-deploy')).toBeNull();
    expect(manifestImageBase()).toBe('');
    expectNoBuildLeftovers();
  });
});
