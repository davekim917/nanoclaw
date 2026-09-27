#!/usr/bin/env tsx
/**
 * Content-hash gate for the dashboard SPA bundle: hashes the SPA's inputs and restores the
 * bundle from a cache instead of rebuilding when the hash matches.
 *
 * The cache lives under `data/`, outside `dist/`, on purpose: scripts/deploy.sh does
 * `rm -rf dist` before the host `tsc`, so the bundle must be repopulated on every build, hit
 * or miss. `data/*` is gitignored, so the cache cannot trip the prebuild clean-tree guard.
 *
 * Usage:
 *   tsx scripts/build-dashboard-spa.ts            # dev/`build:spa`: build only, never seeds the cache
 *   tsx scripts/build-dashboard-spa.ts --install  # deploy/`build:dashboard`: frozen install first, may seed the cache
 *   DASHBOARD_BUILD_FORCE=1 ...                   # ignore the cache, always rebuild
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * Bump when the set of hashed inputs or the cache layout changes, so old
 * entries can never be mistaken for a match under new rules.
 */
export const CACHE_FORMAT_VERSION = 3;

export const CACHE_KEEP = 3;

export const CACHE_SUBDIR = path.join('data', 'build-cache', 'dashboard-spa');
export const BUNDLE_DIR = path.join('dist', 'dashboard-spa');
const VITE_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];
const VITE_ENV_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|([A-Za-z_][A-Za-z0-9_]*))/g;
type Environment = Record<string, string | undefined>;

/**
 * Test files are inputs too: the SPA build's `tsc` typechecks them, so excluding them would let
 * a test-file type error pass silently on a cache hit.
 */

/**
 * `.gitignore`'s `node_modules/` only matches a real directory, so a symlinked
 * `dashboard/node_modules` shows up as an untracked FILE and would land in the hash.
 */
export function isDependencyPath(relPath: string): boolean {
  return relPath.split('/').includes('node_modules');
}

/** Tracked plus untracked-but-not-ignored files, so a new component counts before it is committed. */
export function listInputFiles(repoRoot: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'dashboard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const seen = new Set<string>();
  for (const p of out.split('\0')) {
    if (!p) continue;
    if (isDependencyPath(p)) continue;
    seen.add(p);
  }
  return [...seen].sort();
}

/**
 * Repo files outside `dashboard/` that its TypeScript program compiles (relative imports into
 * `src/`): the build typechecks them, so they are inputs. Derived from the program rather than
 * a list; parse + module resolution only, with the host's `typescript` because the dashboard's
 * deps may not be installed yet.
 */
export function listProgramExternalFiles(repoRoot: string): string[] {
  const configPath = path.join(repoRoot, 'dashboard', 'tsconfig.json');
  const fail = (d: ts.Diagnostic): never => {
    throw new Error(
      `dashboard SPA: cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
    );
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: fail },
  );
  if (!parsed) throw new Error(`dashboard SPA: cannot read ${configPath}`);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
  });
  const seen = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    const rel = path.relative(repoRoot, sf.fileName).split(path.sep).join('/');
    if (rel.startsWith('../') || path.isAbsolute(rel)) continue;
    if (rel === 'dashboard' || rel.startsWith('dashboard/')) continue;
    if (isDependencyPath(rel)) continue;
    seen.add(rel);
  }
  return [...seen].sort();
}

/**
 * Hash file CONTENT off disk, not the git object id: `build:spa` can be run
 * directly, without the `prebuild` clean-tree guard, and an uncommitted edit
 * must still invalidate the cache.
 */
export function hashInputs(repoRoot: string, files: string[], env: Environment = process.env): string {
  const h = createHash('sha256');
  h.update(`v${CACHE_FORMAT_VERSION}\n`);
  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    let digest: string;
    try {
      digest = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    } catch {
      // Staged deletion: record the absence so it still differs from the version with the file.
      digest = 'absent';
    }
    h.update(`${rel}\0${digest}\n`);
  }
  // Vite loads these files from its project root for `vite build`'s production
  // mode, then gives any existing VITE_* process setting precedence. They are
  // ignored locally, so git-visible dashboard inputs alone cannot see them.
  const referencedEnvironment = new Set(Object.keys(env).filter((key) => key.startsWith('VITE_')));
  for (const name of VITE_ENV_FILES) {
    const abs = path.join(repoRoot, 'dashboard', name);
    let contents: Buffer;
    try {
      contents = fs.readFileSync(abs);
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        h.update(`vite-env-file:${name}\0absent\n`);
        continue;
      }
      throw err;
    }
    h.update(`vite-env-file:${name}\0${createHash('sha256').update(contents).digest('hex')}\n`);
    for (const match of contents.toString('utf8').matchAll(VITE_ENV_REFERENCE)) {
      referencedEnvironment.add(match[1] ?? match[2]!);
    }
  }
  for (const key of [...referencedEnvironment].sort()) {
    h.update(`vite-env:${key}\0${env[key] ?? ''}\n`);
  }
  return h.digest('hex');
}

export function computeInputHash(repoRoot: string, env: Environment = process.env): string {
  const files = new Set([...listInputFiles(repoRoot), ...listProgramExternalFiles(repoRoot)]);
  return hashInputs(repoRoot, [...files].sort(), env);
}

export type BuildDecision =
  | { action: 'restore'; hash: string; cacheEntry: string; reason: 'cache-hit' }
  | { action: 'build'; hash: string; cacheEntry: string; reason: 'forced' | 'cache-miss'; cacheable: boolean };

/** Usable only with both the completion marker and `index.html`, so an interrupted copy is a miss. */
export function isUsableCacheEntry(cacheEntry: string): boolean {
  return (
    fs.existsSync(path.join(cacheEntry, 'meta.json')) && fs.existsSync(path.join(cacheEntry, 'bundle', 'index.html'))
  );
}

/**
 * Only the `--install` path may seed the cache. deploy.sh runs `build:spa` (no install) BEFORE
 * `build:dashboard --install`; on a dependency bump the first call would cache a bundle built
 * against the previous `node_modules` under the new hash, and the second would restore it.
 */
export function decideBuild(opts: {
  hash: string;
  cacheRoot: string;
  force: boolean;
  depsVerified: boolean;
}): BuildDecision {
  const cacheEntry = path.join(opts.cacheRoot, opts.hash);
  const cacheable = opts.depsVerified;
  if (opts.force) return { action: 'build', hash: opts.hash, cacheEntry, reason: 'forced', cacheable };
  if (isUsableCacheEntry(cacheEntry)) return { action: 'restore', hash: opts.hash, cacheEntry, reason: 'cache-hit' };
  return { action: 'build', hash: opts.hash, cacheEntry, reason: 'cache-miss', cacheable };
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
  const decision = decideBuild({
    hash: computeInputHash(repoRoot),
    cacheRoot,
    force,
    depsVerified: withInstall,
  });

  if (decision.action === 'restore') {
    restoreFromCache(decision.cacheEntry, bundleDir);
    console.log(`dashboard SPA: cache hit ${decision.hash.slice(0, 12)} — restored ${BUNDLE_DIR}`);
    return;
  }

  const dashboardDir = path.join(repoRoot, 'dashboard');
  if (withInstall) {
    run('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile'], dashboardDir);
  } else if (!fs.existsSync(path.join(dashboardDir, 'node_modules'))) {
    // A contributor who never installed the SPA's deps still gets a working host build, without a bundle.
    console.warn('WARN: dashboard deps not installed — SPA not rebuilt; run: pnpm --dir dashboard install');
    return;
  }

  console.log(`dashboard SPA: ${decision.reason} ${decision.hash.slice(0, 12)} — building`);
  // Always `dashboard`'s own `build` (`tsc --noEmit && vite build`), never bare `vite build`:
  // a restore skips the typecheck, so every cached bundle must already be typechecked.
  run('pnpm', ['run', 'build'], dashboardDir);

  if (!decision.cacheable) {
    console.log(
      `dashboard SPA: built ${decision.hash.slice(0, 12)} — not cached (dependencies not installed from the lockfile)`,
    );
    return;
  }

  storeInCache(bundleDir, decision.cacheEntry, decision.hash);
  pruneCache(cacheRoot);
  console.log(`dashboard SPA: cached ${decision.hash.slice(0, 12)}`);
}

// fileURLToPath, not `new URL(...).pathname`: the latter stays percent-encoded, so on a path with
// a space main() would silently never run, after deploy.sh has already removed dist.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
