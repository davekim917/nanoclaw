#!/usr/bin/env tsx
/**
 * Content-hash gate for the dashboard SPA bundle.
 *
 * `dashboard/` is a separate Vite project outside the pnpm workspace, so every
 * host deploy used to pay a full `pnpm install --ignore-workspace
 * --frozen-lockfile` plus `vite build` — twice, in fact: once from `build:spa`
 * (reached via `pnpm run build`) and again from `build:dashboard` in
 * scripts/deploy.sh. That is the dominant cost of an under-load deploy, and it
 * is paid even when nothing under `dashboard/` changed.
 *
 * This script hashes the SPA's own inputs, keeps the last few built bundles in
 * a cache OUTSIDE `dist/`, and restores from the cache instead of rebuilding
 * when the hash matches.
 *
 * The cache lives outside `dist/` on purpose. scripts/deploy.sh does
 * `rm -rf dist` before the host `tsc` (to prune orphaned .js files), which
 * takes `dist/dashboard-spa/` with it as a side effect. A gate that only
 * skipped the rebuild would therefore serve 404s from src/dashboard/static.ts
 * until the next SPA-touching deploy. Restoring from a cache under `data/`
 * means the bundle is repopulated on every build, hit or miss.
 *
 * Cache dir is under `data/`, which .gitignore excludes (`data/*`), so it is
 * invisible to `git status --porcelain` and cannot trip the prebuild
 * tree-cleanliness guard in scripts/check-build-clean.ts.
 *
 * Usage:
 *   tsx scripts/build-dashboard-spa.ts            # dev/`build:spa`: tsc --noEmit + vite build
 *   tsx scripts/build-dashboard-spa.ts --install  # deploy/`build:dashboard`: pnpm install + vite build
 *   DASHBOARD_BUILD_FORCE=1 ...                   # ignore the cache, always rebuild
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Bump when the set of hashed inputs or the cache layout changes, so old
 * entries can never be mistaken for a match under new rules.
 */
export const CACHE_FORMAT_VERSION = 1;

/** Keep the last N distinct bundles. Each is ~750KB. */
export const CACHE_KEEP = 3;

export const CACHE_SUBDIR = path.join('data', 'build-cache', 'dashboard-spa');
export const BUNDLE_DIR = path.join('dist', 'dashboard-spa');

/**
 * Test-only inputs: they never reach the bundle, so a test-only edit should
 * not invalidate the cache. Matched against the repo-relative path.
 */
const TEST_FILE = /(^|\/)(__tests__\/|test-setup\.[cm]?tsx?$|.*\.test\.[cm]?[jt]sx?$)/;

export function isTestInput(relPath: string): boolean {
  return TEST_FILE.test(relPath);
}

/**
 * Not an input, whatever git thinks. `.gitignore`'s `node_modules/` pattern
 * only matches a real directory, so an agent worktree that symlinks
 * `dashboard/node_modules` at the live checkout gets the symlink reported as
 * an untracked FILE — and its target path would then land in the hash.
 */
export function isDependencyPath(relPath: string): boolean {
  return relPath.split('/').includes('node_modules');
}

/**
 * Every git-visible file under `dashboard/`, minus test files. Tracked files
 * plus untracked-but-not-ignored ones, so a new component counts before it is
 * committed; .gitignore keeps `node_modules/` and `tsconfig.tsbuildinfo` out.
 */
export function listInputFiles(repoRoot: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'dashboard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const seen = new Set<string>();
  for (const p of out.split('\0')) {
    if (!p) continue;
    if (isTestInput(p) || isDependencyPath(p)) continue;
    seen.add(p);
  }
  return [...seen].sort();
}

/**
 * Hash file CONTENT off disk, not the git object id: `build:spa` can be run
 * directly, without the `prebuild` clean-tree guard, and an uncommitted edit
 * must still invalidate the cache.
 */
export function hashInputs(repoRoot: string, files: string[]): string {
  const h = createHash('sha256');
  h.update(`v${CACHE_FORMAT_VERSION}\n`);
  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    let digest: string;
    try {
      digest = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    } catch {
      // Listed by git but gone from disk (staged deletion). Record the absence
      // so it still differs from the version where the file existed.
      digest = 'absent';
    }
    h.update(`${rel}\0${digest}\n`);
  }
  return h.digest('hex');
}

export function computeInputHash(repoRoot: string): string {
  return hashInputs(repoRoot, listInputFiles(repoRoot));
}

export type BuildDecision =
  | { action: 'restore'; hash: string; cacheEntry: string; reason: 'cache-hit' }
  | { action: 'build'; hash: string; cacheEntry: string; reason: 'forced' | 'cache-miss' };

/**
 * An entry counts as usable only when its completion marker AND an
 * `index.html` are both present, so a copy interrupted midway is a miss.
 */
export function isUsableCacheEntry(cacheEntry: string): boolean {
  return (
    fs.existsSync(path.join(cacheEntry, 'meta.json')) && fs.existsSync(path.join(cacheEntry, 'bundle', 'index.html'))
  );
}

export function decideBuild(opts: { hash: string; cacheRoot: string; force: boolean }): BuildDecision {
  const cacheEntry = path.join(opts.cacheRoot, opts.hash);
  if (opts.force) return { action: 'build', hash: opts.hash, cacheEntry, reason: 'forced' };
  if (isUsableCacheEntry(cacheEntry)) return { action: 'restore', hash: opts.hash, cacheEntry, reason: 'cache-hit' };
  return { action: 'build', hash: opts.hash, cacheEntry, reason: 'cache-miss' };
}

export function restoreFromCache(cacheEntry: string, bundleDir: string): void {
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bundleDir), { recursive: true });
  fs.cpSync(path.join(cacheEntry, 'bundle'), bundleDir, { recursive: true });
}

/**
 * Stage into a temp dir and rename into place, so a concurrent reader never
 * sees a half-written entry. `meta.json` is written last for the same reason.
 */
export function storeInCache(bundleDir: string, cacheEntry: string, hash: string): void {
  const cacheRoot = path.dirname(cacheEntry);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const staging = `${cacheEntry}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(staging, { recursive: true });
    fs.cpSync(bundleDir, path.join(staging, 'bundle'), { recursive: true });
    fs.writeFileSync(
      path.join(staging, 'meta.json'),
      JSON.stringify({ hash, builtAt: new Date().toISOString() }, null, 2) + '\n',
    );
    fs.rmSync(cacheEntry, { recursive: true, force: true });
    fs.renameSync(staging, cacheEntry);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function pruneCache(cacheRoot: string, keep = CACHE_KEEP): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed: string[] = [];
  const complete: { name: string; at: number }[] = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const abs = path.join(cacheRoot, e.name);
    // Abandoned staging dirs from an interrupted build.
    if (e.name.includes('.tmp-')) {
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(e.name);
      continue;
    }
    if (!isUsableCacheEntry(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(e.name);
      continue;
    }
    complete.push({ name: e.name, at: fs.statSync(path.join(abs, 'meta.json')).mtimeMs });
  }

  complete.sort((a, b) => b.at - a.at);
  for (const stale of complete.slice(keep)) {
    fs.rmSync(path.join(cacheRoot, stale.name), { recursive: true, force: true });
    removed.push(stale.name);
  }
  return removed;
}

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function main(): void {
  const withInstall = process.argv.includes('--install');
  const force = process.env['DASHBOARD_BUILD_FORCE'] === '1';
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();

  const cacheRoot = path.join(repoRoot, CACHE_SUBDIR);
  const bundleDir = path.join(repoRoot, BUNDLE_DIR);
  const decision = decideBuild({ hash: computeInputHash(repoRoot), cacheRoot, force });

  if (decision.action === 'restore') {
    restoreFromCache(decision.cacheEntry, bundleDir);
    console.log(`dashboard SPA: cache hit ${decision.hash.slice(0, 12)} — restored ${BUNDLE_DIR}`);
    return;
  }

  const dashboardDir = path.join(repoRoot, 'dashboard');
  if (withInstall) {
    run('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile'], dashboardDir);
  } else if (!fs.existsSync(path.join(dashboardDir, 'node_modules'))) {
    // Pre-existing `build:spa` behavior: a contributor who has never installed
    // the SPA's deps still gets a working host build, just without a bundle.
    console.warn('WARN: dashboard deps not installed — SPA not rebuilt; run: pnpm --dir dashboard install');
    return;
  }

  console.log(`dashboard SPA: ${decision.reason} ${decision.hash.slice(0, 12)} — building`);
  // Deploy (`--install`) skips `tsc --noEmit`; the dev path keeps it. Both
  // emit the same bundle, so their cache entries are interchangeable.
  if (withInstall) run('pnpm', ['exec', 'vite', 'build'], dashboardDir);
  else run('pnpm', ['run', 'build'], dashboardDir);

  storeInCache(bundleDir, decision.cacheEntry, decision.hash);
  pruneCache(cacheRoot);
  console.log(`dashboard SPA: cached ${decision.hash.slice(0, 12)}`);
}

// `tsx scripts/build-dashboard-spa.ts` runs main; importing it for tests does not.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
