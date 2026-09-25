/**
 * The engine's default `from-branch` remote and the shell resolver that setup
 * and the SKILL.md fences source must give one answer for one repository.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { detectRegistryRemote, resolveRegistryRemote } from './skill-apply.js';

const SCRIPT = path.resolve(__dirname, '..', 'setup', 'lib', 'channels-remote.sh');
const roots: string[] = [];
const savedEnv = { ...process.env };

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' }).trim();
}

function repo(remotes: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-remote-'));
  roots.push(dir);
  git(dir, ['init', '-q']);
  for (const [name, url] of Object.entries(remotes)) git(dir, ['remote', 'add', name, url]);
  return dir;
}

function viaShell(cwd: string): string {
  return execFileSync('/bin/bash', ['-c', 'source "$1"; resolve_channels_remote', 'test', SCRIPT], {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
  }).trim();
}

const FORK = 'https://github.com/example-user/nanoclaw.git';
const REGISTRY = 'https://github.com/nanocoai/nanoclaw.git';
const SIBLING = 'https://github.com/qwibitai/nanoclaw-discord.git';

const states: Array<{ name: string; remotes: Record<string, string>; expected: string }> = [
  { name: 'fork origin, registry upstream', remotes: { origin: FORK, upstream: REGISTRY }, expected: 'upstream' },
  { name: 'registry as origin', remotes: { origin: REGISTRY }, expected: 'origin' },
  { name: 'no registry remote', remotes: { origin: FORK, discord: SIBLING }, expected: 'upstream' },
];

afterEach(() => {
  process.env = { ...savedEnv };
});

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('registry remote resolution', () => {
  for (const state of states) {
    it(`engine and shell agree: ${state.name}`, () => {
      const engine = resolveRegistryRemote(repo(state.remotes));
      const shell = viaShell(repo(state.remotes));
      expect(engine).toBe(shell);
      expect(engine).toBe(state.expected);
    });
  }

  it('honours NANOCLAW_CHANNELS_REMOTE on both paths', () => {
    process.env.NANOCLAW_CHANNELS_REMOTE = 'mirror';
    expect(resolveRegistryRemote(repo({ origin: REGISTRY }))).toBe('mirror');
    expect(viaShell(repo({ origin: REGISTRY }))).toBe('mirror');
  });

  it('the fallback adds upstream; detection never does', () => {
    const detected = repo({ origin: FORK });
    expect(detectRegistryRemote(detected)).toBeNull();
    expect(git(detected, ['remote'])).toBe('origin');

    const resolved = repo({ origin: FORK });
    expect(resolveRegistryRemote(resolved)).toBe('upstream');
    expect(git(resolved, ['remote', 'get-url', 'upstream'])).toBe(REGISTRY);
  });

  it('ignores an inherited GIT_DIR and acts on the repository it runs in', () => {
    const elsewhere = repo({ origin: FORK });
    const target = repo({ origin: FORK });
    process.env.GIT_DIR = path.join(elsewhere, '.git');
    process.env.GIT_WORK_TREE = elsewhere;
    expect(resolveRegistryRemote(target)).toBe('upstream');
    expect(git(target, ['remote']).split('\n').sort()).toEqual(['origin', 'upstream']);
    expect(git(elsewhere, ['remote'])).toBe('origin');
  });
});
