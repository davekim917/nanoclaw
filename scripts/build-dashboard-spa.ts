#!/usr/bin/env tsx
/**
 * Content-hash gate for the dashboard SPA bundle. The cache lives under gitignored `data/`, outside
 * `dist/`: deploy.sh does `rm -rf dist` before the host `tsc`, so the bundle is repopulated every
 * build, hit or miss.
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

/** Bump when the hashed inputs or cache layout change. */
export const CACHE_FORMAT_VERSION = 3;

export const CACHE_KEEP = 3;

export const CACHE_SUBDIR = path.join('data', 'build-cache', 'dashboard-spa');
export const BUNDLE_DIR = path.join('dist', 'dashboard-spa');
const VITE_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];
const VITE_ENV_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|([A-Za-z_][A-Za-z0-9_]*))/g;
type Environment = Record<string, string | undefined>;

/** Test files are inputs: the SPA build's `tsc` typechecks them. */

/** A symlinked `dashboard/node_modules` is an untracked FILE to git and would land in the hash. */
export function isDependencyPath(relPath: string): boolean {
  return relPath.split('/').includes('node_modules');
}

/** Untracked-but-not-ignored files count, so a new component invalidates before it is committed. */
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
 * Repo files outside `dashboard/` its TypeScript program compiles. Resolved with the host's
 * `typescript` because the dashboard's deps may not be installed yet.
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

/** CONTENT off disk, not the git object id: `build:spa` runs without the clean-tree guard. */
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
  // Vite loads these ignored env files for `vite build`, so git-visible inputs alone cannot see them.
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
 * Only `--install` may seed the cache: deploy.sh runs `build:spa` BEFORE `build:dashboard --install`,
 * so on a dependency bump the first would cache a bundle built against the old `node_modules`.
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

/** Staged in a temp dir and renamed into place, `meta.json` last, so a reader never sees a half-written entry. */
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
  // Never bare `vite build`: a restore skips the typecheck, so every cached bundle must be typechecked.
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

// Not `new URL(...).pathname`: it stays percent-encoded, so on a path with a space main() would never run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
