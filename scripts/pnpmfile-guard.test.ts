import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['pnpm']);
enforceHermeticity();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pnpmfile = path.join(repoRoot, '.pnpmfile.cjs');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pnpmfile-guard-')));
  roots.push(root);
  return root;
}

function pnpm(cwd: string, args: string[], env: Record<string, string> = {}): { status: number | null; stderr: string } {
  const r = spawnSync('pnpm', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, stderr: r.stderr };
}

/** A dependency-free project carrying the shipped pnpmfile and a lockfile, so a frozen offline install can run. */
function project(): string {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'guard-fixture', version: '1.0.0', private: true }));
  fs.copyFileSync(pnpmfile, path.join(root, '.pnpmfile.cjs'));
  expect(pnpm(root, ['install', '--lockfile-only', '--offline']).status).toBe(0);
  return root;
}

const install = ['install', '--frozen-lockfile', '--offline'];

describe('.pnpmfile.cjs', () => {
  it('exports no hooks, so the lockfile carries no pnpmfileChecksum for frozen installs to enforce', () => {
    const root = project();
    expect(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')).not.toContain('pnpmfileChecksum');
  });

  it('lets a project with no node_modules, or with its own, install', () => {
    const root = project();
    expect(pnpm(root, install).status).toBe(0);
    expect(fs.lstatSync(path.join(root, 'node_modules')).isDirectory()).toBe(true);
    expect(pnpm(root, install).status).toBe(0);
  });

  it('lets a project reached through a symlinked path install into its own real node_modules', () => {
    const root = project();
    fs.mkdirSync(path.join(root, 'node_modules'));
    const alias = path.join(tempRoot(), 'alias');
    fs.symlinkSync(root, alias);
    expect(pnpm(alias, install).status).toBe(0);
  });

  it('refuses through a symlinked node_modules before pnpm touches the target, plain and under CI=true', () => {
    const root = project();
    const target = path.join(tempRoot(), 'node_modules');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'sentinel'), 'another checkout\n');
    fs.symlinkSync(target, path.join(root, 'node_modules'));

    for (const env of [{ CI: 'false' }, { CI: 'true' }]) {
      const r = pnpm(root, install, env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`it is a symlink to ${target}`);
      expect(r.stderr).toContain("run 'pnpm install --frozen-lockfile --offline' here");
      expect(fs.readdirSync(target)).toEqual(['sentinel']);
      expect(fs.lstatSync(path.join(root, 'node_modules')).isSymbolicLink()).toBe(true);
    }
  });

  it('refuses a dangling node_modules link too', () => {
    const root = project();
    fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'node_modules'));
    expect(pnpm(root, install).status).toBe(1);
  });
});
