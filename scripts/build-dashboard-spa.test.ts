import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  CACHE_KEEP,
  computeInputHash,
  decideBuild,
  isDependencyPath,
  isTestInput,
  isUsableCacheEntry,
  listInputFiles,
  pruneCache,
  restoreFromCache,
  storeInCache,
} from './build-dashboard-spa.js';

/**
 * The gate that stops every host deploy from paying a full
 * `pnpm install --ignore-workspace --frozen-lockfile` + `vite build` for the
 * dashboard SPA. What matters is the decision (hit / miss / force / no cache
 * dir), that the hash actually tracks the SPA's inputs, and that a restore
 * reproduces the bundle — because scripts/deploy.sh's `rm -rf dist` deletes
 * dist/dashboard-spa/ on every deploy.
 */

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** A throwaway repo shaped like the real one's dashboard/ subtree. */
function makeRepo(root: string): void {
  fs.mkdirSync(path.join(root, 'dashboard', 'src', 'views'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\ndata/\n');
  fs.writeFileSync(path.join(root, 'dashboard', 'index.html'), '<div id=root></div>');
  fs.writeFileSync(path.join(root, 'dashboard', 'package.json'), '{"name":"spa"}');
  fs.writeFileSync(path.join(root, 'dashboard', 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  fs.writeFileSync(path.join(root, 'dashboard', 'vite.config.ts'), 'export default {}');
  fs.writeFileSync(path.join(root, 'dashboard', 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, 'dashboard', 'src', 'main.tsx'), 'export const a = 1;');
  fs.writeFileSync(path.join(root, 'dashboard', 'src', 'main.test.tsx'), 'it("x", () => {});');
  fs.writeFileSync(path.join(root, 'dashboard', 'src', 'test-setup.ts'), 'export {};');
  fs.mkdirSync(path.join(root, 'dashboard', 'node_modules', 'react'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'node_modules', 'react', 'index.js'), 'x');

  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
}

/** A built bundle, as vite would leave it in dist/dashboard-spa/. */
function makeBundle(dir: string, marker: string): void {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<script src="/assets/${marker}.js">`);
  fs.writeFileSync(path.join(dir, 'assets', `${marker}.js`), `console.log("${marker}")`);
}

describe('scripts/build-dashboard-spa.ts', () => {
  let root: string;
  let cacheRoot: string;
  let bundleDir: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spa-gate-')));
    cacheRoot = path.join(root, 'data', 'build-cache', 'dashboard-spa');
    bundleDir = path.join(root, 'dist', 'dashboard-spa');
    makeRepo(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('input set', () => {
    it('classifies test files so a test-only edit cannot invalidate the cache', () => {
      expect(isTestInput('dashboard/src/main.test.tsx')).toBe(true);
      expect(isTestInput('dashboard/src/lib/derive.test.ts')).toBe(true);
      expect(isTestInput('dashboard/src/test-setup.ts')).toBe(true);
      expect(isTestInput('dashboard/src/__tests__/helper.ts')).toBe(true);
      // Names that merely contain "test" are inputs, not tests.
      expect(isTestInput('dashboard/src/views/LatestRuns.tsx')).toBe(false);
      expect(isTestInput('dashboard/src/lib/protest.ts')).toBe(false);
    });

    it('treats a node_modules symlink as a dependency, not an input', () => {
      // .gitignore's `node_modules/` only matches a real directory, so an
      // agent worktree that symlinks the live checkout's deps gets the
      // symlink reported by `git ls-files --others` as an untracked file.
      expect(isDependencyPath('dashboard/node_modules')).toBe(true);
      expect(isDependencyPath('dashboard/node_modules/react/index.js')).toBe(true);
      expect(isDependencyPath('dashboard/src/node_modules_shim.ts')).toBe(false);
    });

    it('excludes a symlinked dashboard/node_modules from the hash', () => {
      const before = computeInputHash(root);
      const real = path.join(root, 'elsewhere-deps');
      fs.mkdirSync(real, { recursive: true });
      fs.rmSync(path.join(root, 'dashboard', 'node_modules'), { recursive: true, force: true });
      fs.symlinkSync(real, path.join(root, 'dashboard', 'node_modules'));
      expect(listInputFiles(root).some((f) => f.split('/').includes('node_modules'))).toBe(false);
      expect(computeInputHash(root)).toBe(before);
    });

    it('lists the SPA sources and excludes tests and ignored files', () => {
      const files = listInputFiles(root);
      expect(files).toContain('dashboard/src/main.tsx');
      expect(files).toContain('dashboard/pnpm-lock.yaml');
      expect(files).toContain('dashboard/vite.config.ts');
      expect(files).not.toContain('dashboard/src/main.test.tsx');
      expect(files).not.toContain('dashboard/src/test-setup.ts');
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    });
  });

  describe('hash', () => {
    it('is stable when nothing changed', () => {
      expect(computeInputHash(root)).toBe(computeInputHash(root));
    });

    it('changes when a source file changes', () => {
      const before = computeInputHash(root);
      fs.writeFileSync(path.join(root, 'dashboard', 'src', 'main.tsx'), 'export const a = 2;');
      expect(computeInputHash(root)).not.toBe(before);
    });

    it('changes when the lockfile changes', () => {
      const before = computeInputHash(root);
      fs.writeFileSync(path.join(root, 'dashboard', 'pnpm-lock.yaml'), 'lockfileVersion: 10');
      expect(computeInputHash(root)).not.toBe(before);
    });

    it('counts an uncommitted new component, since build:spa can run without the clean-tree guard', () => {
      const before = computeInputHash(root);
      fs.writeFileSync(path.join(root, 'dashboard', 'src', 'views', 'New.tsx'), 'export {};');
      expect(computeInputHash(root)).not.toBe(before);
    });

    it('ignores a test-only edit', () => {
      const before = computeInputHash(root);
      fs.writeFileSync(path.join(root, 'dashboard', 'src', 'main.test.tsx'), 'it("y", () => {});');
      expect(computeInputHash(root)).toBe(before);
    });

    it('ignores host source changes outside dashboard/', () => {
      const before = computeInputHash(root);
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const host = 1;');
      expect(computeInputHash(root)).toBe(before);
    });

    it('changes when a tracked file is deleted from disk', () => {
      const before = computeInputHash(root);
      fs.rmSync(path.join(root, 'dashboard', 'src', 'main.tsx'));
      expect(computeInputHash(root)).not.toBe(before);
    });
  });

  describe('decision', () => {
    it('misses when the cache dir does not exist at all', () => {
      const d = decideBuild({ hash: 'h1', cacheRoot, force: false });
      expect(fs.existsSync(cacheRoot)).toBe(false);
      expect(d).toMatchObject({ action: 'build', reason: 'cache-miss' });
    });

    it('misses on an unseen hash when other entries exist', () => {
      makeBundle(bundleDir, 'a');
      storeInCache(bundleDir, path.join(cacheRoot, 'h1'), 'h1');
      expect(decideBuild({ hash: 'h2', cacheRoot, force: false })).toMatchObject({
        action: 'build',
        reason: 'cache-miss',
      });
    });

    it('hits on a stored hash', () => {
      makeBundle(bundleDir, 'a');
      storeInCache(bundleDir, path.join(cacheRoot, 'h1'), 'h1');
      expect(decideBuild({ hash: 'h1', cacheRoot, force: false })).toMatchObject({
        action: 'restore',
        reason: 'cache-hit',
      });
    });

    it('builds anyway under DASHBOARD_BUILD_FORCE', () => {
      makeBundle(bundleDir, 'a');
      storeInCache(bundleDir, path.join(cacheRoot, 'h1'), 'h1');
      expect(decideBuild({ hash: 'h1', cacheRoot, force: true })).toMatchObject({
        action: 'build',
        reason: 'forced',
      });
    });

    it('misses on an entry whose copy was interrupted before the marker landed', () => {
      const entry = path.join(cacheRoot, 'h1');
      fs.mkdirSync(path.join(entry, 'bundle'), { recursive: true });
      fs.writeFileSync(path.join(entry, 'bundle', 'index.html'), '<html>');
      expect(isUsableCacheEntry(entry)).toBe(false);
      expect(decideBuild({ hash: 'h1', cacheRoot, force: false })).toMatchObject({
        action: 'build',
        reason: 'cache-miss',
      });
    });

    it('misses on an entry with a marker but no bundle', () => {
      const entry = path.join(cacheRoot, 'h1');
      fs.mkdirSync(entry, { recursive: true });
      fs.writeFileSync(path.join(entry, 'meta.json'), '{}');
      expect(decideBuild({ hash: 'h1', cacheRoot, force: false })).toMatchObject({
        action: 'build',
        reason: 'cache-miss',
      });
    });
  });

  describe('restore', () => {
    it('reproduces the bundle after deploy.sh has done rm -rf dist', () => {
      makeBundle(bundleDir, 'abc123');
      storeInCache(bundleDir, path.join(cacheRoot, 'h1'), 'h1');

      fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
      expect(fs.existsSync(bundleDir)).toBe(false);

      restoreFromCache(path.join(cacheRoot, 'h1'), bundleDir);

      expect(fs.readFileSync(path.join(bundleDir, 'index.html'), 'utf8')).toContain('abc123');
      expect(fs.readFileSync(path.join(bundleDir, 'assets', 'abc123.js'), 'utf8')).toContain('abc123');
    });

    it('replaces a stale bundle rather than merging into it', () => {
      makeBundle(bundleDir, 'new');
      storeInCache(bundleDir, path.join(cacheRoot, 'h1'), 'h1');

      fs.rmSync(bundleDir, { recursive: true, force: true });
      makeBundle(bundleDir, 'old');
      restoreFromCache(path.join(cacheRoot, 'h1'), bundleDir);

      expect(fs.existsSync(path.join(bundleDir, 'assets', 'old.js'))).toBe(false);
      expect(fs.existsSync(path.join(bundleDir, 'assets', 'new.js'))).toBe(true);
    });

    it('survives a store/restore round trip through the real hash', () => {
      const hash = computeInputHash(root);
      makeBundle(bundleDir, 'roundtrip');
      const d1 = decideBuild({ hash, cacheRoot, force: false });
      expect(d1.action).toBe('build');
      storeInCache(bundleDir, d1.cacheEntry, hash);

      fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

      const d2 = decideBuild({ hash: computeInputHash(root), cacheRoot, force: false });
      expect(d2.action).toBe('restore');
      restoreFromCache(d2.cacheEntry, bundleDir);
      expect(fs.existsSync(path.join(bundleDir, 'assets', 'roundtrip.js'))).toBe(true);
    });
  });

  describe('pruning', () => {
    it('keeps the newest CACHE_KEEP entries and drops the rest', () => {
      makeBundle(bundleDir, 'a');
      const hashes = ['h1', 'h2', 'h3', 'h4', 'h5'];
      hashes.forEach((h, i) => {
        const entry = path.join(cacheRoot, h);
        storeInCache(bundleDir, entry, h);
        // Deterministic recency: storeInCache writes meta.json last.
        const t = new Date(Date.now() + i * 60_000);
        fs.utimesSync(path.join(entry, 'meta.json'), t, t);
      });

      pruneCache(cacheRoot);

      const left = fs.readdirSync(cacheRoot).sort();
      expect(left).toEqual(['h3', 'h4', 'h5']);
      expect(left.length).toBe(CACHE_KEEP);
    });

    it('sweeps abandoned staging dirs and incomplete entries', () => {
      makeBundle(bundleDir, 'a');
      storeInCache(bundleDir, path.join(cacheRoot, 'h1'), 'h1');
      fs.mkdirSync(path.join(cacheRoot, 'h9.tmp-123', 'bundle'), { recursive: true });
      fs.mkdirSync(path.join(cacheRoot, 'h8'), { recursive: true });

      pruneCache(cacheRoot);

      expect(fs.readdirSync(cacheRoot)).toEqual(['h1']);
    });

    it('is a no-op when the cache dir is absent', () => {
      expect(pruneCache(path.join(root, 'nope'))).toEqual([]);
    });
  });
});
