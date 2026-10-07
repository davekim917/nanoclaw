/**
 * Dependency gate (docs/dependency-updates.md): a runtime version change needs a behaviour-change ledger, and a change
 * on a live I/O path needs a real-library test of that path, because mocked adapter tests pass through wire changes.
 *
 *   pnpm exec tsx scripts/dependency-gate.ts check [--base <rev>]   (default base: merge-base HEAD origin/main)
 */
import fs from 'fs';
import path from 'path';

import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

import {
  DEPENDENCY_PATHS_FILE as REGISTRY_PATH,
  readDependencyPathRegistry,
  untestedLivePaths,
  type DependencyPathRegistry as Registry,
} from '../src/dependency-paths.js';
import { gitRead } from './lib/doc-citations.js';

export const LEDGER_DIR = 'docs/dependency-changes';
const LIVE_PATH_TEST = /live-path[^/]*\.test\.ts$/;
const BASE_IMAGE = 'docker:base-image';

export interface DependencyFiles {
  hostPackageJson: string | null;
  pnpmLock: string | null;
  runnerPackageJson: string | null;
  bunLock: string | null;
  remotionPackageJson: string | null;
  remotionLock: string | null;
  dockerfile: string | null;
  updateSources: string | null;
}

export const DEPENDENCY_FILE_PATHS: Record<keyof DependencyFiles, string> = {
  hostPackageJson: 'package.json',
  pnpmLock: 'pnpm-lock.yaml',
  runnerPackageJson: 'container/agent-runner/package.json',
  bunLock: 'container/agent-runner/bun.lock',
  remotionPackageJson: 'container/remotion/package.json',
  remotionLock: 'container/remotion/pnpm-lock.yaml',
  dockerfile: 'container/Dockerfile',
  updateSources: 'container/update-sources.json',
};

function add(map: Map<string, Set<string>>, name: string, value: string): void {
  let values = map.get(name);
  if (!values) {
    values = new Set();
    map.set(name, values);
  }
  values.add(value);
}

/** `@scope/name@1.2.3` → [`@scope/name`, `1.2.3`]; a git or tarball version may itself contain `@`. */
function splitSpec(spec: string): [string, string] | null {
  const at = spec.indexOf('@', 1);
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : null;
}

type ImporterDeps = Record<string, { version?: string } | string>;

interface PnpmLock {
  importers?: Record<
    string,
    { dependencies?: ImporterDeps; devDependencies?: ImporterDeps; optionalDependencies?: ImporterDeps }
  >;
  packages?: Record<string, unknown>;
  snapshots?: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
  patchedDependencies?: Record<string, string | { hash?: string }>;
}

/** Package names in a bun.lock key: `a/@s/b/c` is a → @s/b → c. */
function bunKeyNames(key: string): string[] {
  const names: string[] = [];
  const parts = key.split('/');
  for (let i = 0; i < parts.length; i++) {
    names.push(parts[i]!.startsWith('@') ? `${parts[i]}/${parts[++i]}` : parts[i]!);
  }
  return names;
}

/** The entry a dependency `dep` of the package at `key` resolves to: the nearest `<ancestors>/dep`, as Node's lookup. */
function bunResolve(entries: Record<string, unknown[]>, key: string, dep: string): string | null {
  const names = bunKeyNames(key);
  for (let i = names.length; i >= 0; i--) {
    const entry = entries[[...names.slice(0, i), dep].join('/')];
    if (entry && typeof entry[0] === 'string') return entry[0];
  }
  return null;
}

interface BunLock {
  workspaces?: Record<
    string,
    { dependencies?: object; devDependencies?: object; optionalDependencies?: object; peerDependencies?: object }
  >;
  packages?: Record<string, unknown[]>;
  patchedDependencies?: Record<string, string>;
}

/** bun.lock is JSON with trailing commas. */
function parseBunLock(text: string): BunLock {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')) as BunLock;
}

/**
 * The graph node for a project in a lockfile. It has no `@version`, so it is never a package, but its edges are
 * compared like a package's: a project moved onto a version already locked for something else is a repoint.
 */
const importerNode = (project: string): string => `importer:${project || '.'}`;

export interface TrackedTool {
  id: string;
  arg: string;
  source?: { kind?: string; package?: string };
}

export function trackedTools(updateSources: string | null): TrackedTool[] {
  return updateSources ? ((JSON.parse(updateSources) as { dockerfile?: TrackedTool[] }).dockerfile ?? []) : [];
}

/** `ARG <arg>=<value>` in any case and spacing: Docker reads instruction keywords case-insensitively. */
const argValue = (arg: string): RegExp =>
  new RegExp(`^[ \\t]*[Aa][Rr][Gg][ \\t]+${arg}[ \\t]*=[ \\t]*["']?([^"'\\s#]+)`, 'm');

function dockerPins(dockerfile: string, items: TrackedTool[]): Array<{ id: string; version: string }> {
  return items.flatMap(({ id, arg }) => {
    const match = argValue(arg).exec(dockerfile);
    return match ? [{ id, version: match[1]! }] : [];
  });
}

/** Base images named literally; a `FROM` built from an `ARG` is already a pin. */
function baseImages(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)/gim)]
    .map((m) => m[1]!)
    .filter((image) => !image.includes('$'));
}

/** Where a version is locked. Each lockfile is its own dependency tree; pooling names across trees conflates them. */
type Source = 'host' | 'runner' | 'remotion' | 'docker';

export interface Locked {
  versions: Map<Source, Map<string, Set<string>>>;
  dependsOn: Map<Source, Map<string, Set<string>>>;
  /** `name@version`, or a project's `importer:<path>`, → the exact `name@version`s it loads, per tree. */
  graph: Map<Source, Map<string, Set<string>>>;
  /** `<source>:<name>[@version]` → patch hash (pnpm) or patch file (bun), from the lockfile's patchedDependencies. */
  patches: Map<string, string>;
}

function tree<T>(map: Map<Source, Map<string, T>>, source: Source): Map<string, T> {
  let inner = map.get(source);
  if (!inner) {
    inner = new Map();
    map.set(source, inner);
  }
  return inner;
}

/** `tools` defaults to the files' own update-sources list; the gate passes the base's and head's union. */
export function lockedVersions(
  files: DependencyFiles,
  tools: TrackedTool[] = trackedTools(files.updateSources),
): Locked {
  const locked: Locked = { versions: new Map(), dependsOn: new Map(), graph: new Map(), patches: new Map() };
  const pnpm: Array<[Source, string | null]> = [
    ['host', files.pnpmLock],
    ['remotion', files.remotionLock],
  ];
  for (const [source, text] of pnpm) {
    if (!text) continue;
    const lock = parseYaml(text) as PnpmLock;
    for (const key of Object.keys(lock.packages ?? {})) {
      const spec = splitSpec(key.replace(/\(.*$/, ''));
      if (spec) add(tree(locked.versions, source), spec[0], spec[1]);
    }
    const nodes = new Set(Object.keys(lock.snapshots ?? {}).map((key) => key.replace(/\(.*$/, '')));
    for (const [key, snapshot] of Object.entries(lock.snapshots ?? {})) {
      const node = key.replace(/\(.*$/, '');
      const spec = splitSpec(node);
      if (!spec) continue;
      tree(locked.graph, source).set(node, tree(locked.graph, source).get(node) ?? new Set());
      for (const [dep, ref] of Object.entries({ ...snapshot?.dependencies, ...snapshot?.optionalDependencies })) {
        add(tree(locked.dependsOn, source), spec[0], dep);
        const version = String(ref).replace(/\(.*$/, '');
        const target = nodes.has(`${dep}@${version}`) || !nodes.has(version) ? `${dep}@${version}` : version;
        add(tree(locked.graph, source), node, target);
      }
    }
    for (const [project, importer] of Object.entries(lock.importers ?? {})) {
      const node = importerNode(project);
      tree(locked.graph, source).set(node, tree(locked.graph, source).get(node) ?? new Set());
      for (const deps of [importer.dependencies, importer.devDependencies, importer.optionalDependencies]) {
        for (const [dep, ref] of Object.entries(deps ?? {})) {
          const version = String(typeof ref === 'string' ? ref : (ref?.version ?? '')).replace(/\(.*$/, '');
          if (version) add(tree(locked.graph, source), node, `${dep}@${version}`);
        }
      }
    }
    for (const [key, entry] of Object.entries(lock.patchedDependencies ?? {})) {
      locked.patches.set(`${source}:${key}`, typeof entry === 'string' ? entry : (entry?.hash ?? ''));
    }
  }
  if (files.bunLock) {
    const lock = parseBunLock(files.bunLock);
    const entries = lock.packages ?? {};
    for (const [project, workspace] of Object.entries(lock.workspaces ?? {})) {
      const node = importerNode(project);
      tree(locked.graph, 'runner').set(node, tree(locked.graph, 'runner').get(node) ?? new Set());
      for (const dep of Object.keys({
        ...workspace.dependencies,
        ...workspace.devDependencies,
        ...workspace.optionalDependencies,
        ...workspace.peerDependencies,
      })) {
        const target = entries[dep]?.[0];
        if (typeof target === 'string') add(tree(locked.graph, 'runner'), node, target);
      }
    }
    for (const [key, file] of Object.entries(lock.patchedDependencies ?? {})) locked.patches.set(`runner:${key}`, file);
    for (const [key, entry] of Object.entries(entries)) {
      const node = typeof entry[0] === 'string' ? entry[0] : '';
      const spec = splitSpec(node);
      if (!spec) continue;
      add(tree(locked.versions, 'runner'), spec[0], spec[1]);
      tree(locked.graph, 'runner').set(node, tree(locked.graph, 'runner').get(node) ?? new Set());
      const meta = (entry[2] ?? {}) as {
        dependencies?: object;
        optionalDependencies?: object;
        peerDependencies?: object;
      };
      for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies, ...meta.peerDependencies })) {
        add(tree(locked.dependsOn, 'runner'), spec[0], dep);
        const target = bunResolve(entries, key, dep);
        if (target) add(tree(locked.graph, 'runner'), node, target);
      }
    }
  }
  if (files.dockerfile) {
    const docker = tree(locked.versions, 'docker');
    for (const { id, version } of dockerPins(files.dockerfile, tools)) add(docker, `docker:${id}`, version);
    for (const image of baseImages(files.dockerfile)) add(docker, BASE_IMAGE, image);
  }
  return locked;
}

export function directDependencies(files: DependencyFiles): Set<string> {
  const names = new Set<string>();
  for (const manifest of [files.hostPackageJson, files.runnerPackageJson, files.remotionPackageJson]) {
    if (!manifest) continue;
    const json = JSON.parse(manifest) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(json[field] ?? {})) names.add(name);
    }
  }
  for (const { id } of trackedTools(files.updateSources)) names.add(`docker:${id}`);
  if (files.dockerfile && baseImages(files.dockerfile).length > 0) names.add(BASE_IMAGE);
  return names;
}

const PATCH_DIRS: Array<[string, Source]> = [
  ['patches/', 'host'],
  ['container/agent-runner/patches/', 'runner'],
  ['container/remotion/patches/', 'remotion'],
];

/** `patches/@scope__name@1.2.3.patch` and `patches/@scope__name.patch` both name `@scope/name`, in the tree whose patches dir holds it. */
export function patchedPackage(changedPath: string): { name: string; source: Source } | null {
  for (const [dir, source] of PATCH_DIRS) {
    if (!changedPath.startsWith(dir)) continue;
    const match = /^(.+?)(?:@[^@/]+)?\.patch$/.exec(changedPath.slice(dir.length));
    return match && !match[1]!.includes('/') ? { name: match[1]!.replace('__', '/'), source } : null;
  }
  return null;
}

/** Per tree, the packages whose patch changed: a patch file edited, or a lockfile patch entry added, removed or rehashed. */
export function repatchedPackages(
  base: Locked,
  head: Locked,
  patchedFiles: Iterable<{ name: string; source: Source }> = [],
): Map<Source, Set<string>> {
  const out = new Map<Source, Set<string>>();
  for (const { name, source } of patchedFiles) add(out as Map<string, Set<string>>, source, name);
  for (const key of new Set([...base.patches.keys(), ...head.patches.keys()])) {
    if (base.patches.get(key) === head.patches.get(key)) continue;
    const [source, spec] = [key.slice(0, key.indexOf(':')) as Source, key.slice(key.indexOf(':') + 1)];
    add(out as Map<string, Set<string>>, source, splitSpec(spec)?.[0] ?? spec);
  }
  return out;
}

export interface PackageChange {
  name: string;
  /** Every locked version before and after, across trees, comma-joined; `none` when absent. */
  from: string;
  to: string;
  /** The trees the change happened in. */
  sources: Source[];
  /** Versions present after and not before, and the reverse, each judged within its own tree. */
  added: string[];
  removed: string[];
  /** Consumers that moved to another exact version of this package, where the locked set alone does not show it. */
  repointed?: Repoint[];
}

function versionList(versions: Iterable<string>): string {
  const sorted = [...new Set(versions)].sort();
  return sorted.length > 0 ? sorted.join(',') : 'none';
}

const SOURCES: Source[] = ['host', 'runner', 'remotion', 'docker'];

export function packageChanges(
  base: Locked,
  head: Locked,
  patchedFiles: Iterable<{ name: string; source: Source }> = [],
): PackageChange[] {
  const patched = new Map<string, Set<Source>>();
  for (const [source, packages] of repatchedPackages(base, head, patchedFiles)) {
    for (const name of packages) add(patched as Map<string, Set<string>>, name, source);
  }
  const names = new Set<string>(patched.keys());
  for (const source of SOURCES) {
    for (const name of base.versions.get(source)?.keys() ?? []) names.add(name);
    for (const name of head.versions.get(source)?.keys() ?? []) names.add(name);
  }
  const changes: PackageChange[] = [];
  for (const name of [...names].sort()) {
    const sources: Source[] = [];
    const before: string[] = [];
    const after: string[] = [];
    for (const source of SOURCES) {
      const from = versionList(base.versions.get(source)?.get(name) ?? []);
      const to = versionList(head.versions.get(source)?.get(name) ?? []);
      before.push(...(base.versions.get(source)?.get(name) ?? []));
      after.push(...(head.versions.get(source)?.get(name) ?? []));
      if (from !== to || patched.get(name)?.has(source)) sources.push(source);
    }
    if (sources.length === 0) continue;
    const added = new Set<string>();
    const removed = new Set<string>();
    for (const source of sources) {
      const was = base.versions.get(source)?.get(name) ?? new Set<string>();
      const now = head.versions.get(source)?.get(name) ?? new Set<string>();
      for (const v of now) if (!was.has(v)) added.add(v);
      for (const v of was) if (!now.has(v)) removed.add(v);
    }
    changes.push({
      name,
      from: versionList(before),
      to: versionList(after),
      sources,
      added: [...added].sort(),
      removed: [...removed].sort(),
    });
  }
  return changes;
}

/** A consumer — a `name@version` node or a project's `importer:<path>` — that loads `to` where it loaded `from`. */
type Repoint = { from: string; to: string; consumer: string };

/**
 * Per tree and package, each exact version a consumer present at both ends now loads in place of what it loaded at the
 * base (`none` for a new edge). This sees a consumer moved onto a version already locked elsewhere, or a peer
 * resolution that changed, where the set of locked versions stays the same.
 */
export function consumerMoves(base: Locked, head: Locked): Map<Source, Map<string, Repoint[]>> {
  const moves = new Map<Source, Map<string, Repoint[]>>();
  const byName = (targets: Iterable<string>): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const target of targets) {
      const spec = splitSpec(target);
      if (spec) add(out, spec[0], spec[1]);
    }
    return out;
  };
  for (const source of SOURCES) {
    const before = base.graph.get(source);
    for (const [node, targets] of head.graph.get(source) ?? []) {
      const old = before?.get(node);
      if (!old) continue;
      const was = byName(old);
      for (const [name, versions] of byName(targets)) {
        const prior = was.get(name);
        for (const version of versions) {
          if (prior?.has(version)) continue;
          const list = tree(moves, source).get(name) ?? [];
          list.push({ from: prior ? versionList(prior) : 'none', to: version, consumer: node });
          tree(moves, source).set(name, list);
        }
      }
    }
  }
  return moves;
}

/**
 * Adds the moves a version-set diff cannot see: a consumer repointed onto a version already locked, and a package that
 * newly enters a live closure. A consumer's move counts among a change's added and removed versions, so an Override
 * judges every move a consumer made, not only the versions that entered or left the lockfile.
 */
export function withRepoints(
  changes: PackageChange[],
  repoints: Map<Source, Map<string, Repoint[]>>,
  moves: Map<Source, Map<string, Set<string>>>,
  head: Locked,
): PackageChange[] {
  const byName = new Map(changes.map((change) => [change.name, change]));
  const out = [...changes];
  for (const source of SOURCES) {
    const names = new Set([...(repoints.get(source)?.keys() ?? []), ...(moves.get(source)?.keys() ?? [])]);
    for (const name of names) {
      const own = repoints.get(source)?.get(name) ?? [];
      const existing = byName.get(name);
      if (existing) {
        existing.repointed = [...(existing.repointed ?? []), ...own];
        if (!existing.sources.includes(source)) existing.sources.push(source);
        existing.added = [...new Set([...existing.added, ...own.map((move) => move.to)])].sort();
        existing.removed = [
          ...new Set([
            ...existing.removed,
            ...own.flatMap((move) => (move.from === 'none' ? [] : move.from.split(','))),
          ]),
        ].sort();
        continue;
      }
      const into =
        own.length > 0
          ? own
          : [...(head.versions.get(source)?.get(name) ?? [])].map((to) => ({ from: 'none', to, consumer: '' }));
      const change: PackageChange = {
        name,
        from: versionList(into.flatMap((move) => (move.from === 'none' ? [] : move.from.split(',')))),
        to: versionList(into.map((move) => move.to)),
        sources: [source],
        added: [...new Set(into.map((move) => move.to))].sort(),
        removed: [...new Set(into.flatMap((move) => (move.from === 'none' ? [] : move.from.split(','))))].sort(),
        repointed: into,
      };
      byName.set(name, change);
      out.push(change);
    }
  }
  return out;
}

/**
 * Per tree, every package a runtime code path can load: the registry's non-dev packages and whatever they depend on
 * within that lockfile, by name. Reach decides only whether a change needs a ledger section, so over-counting costs a
 * ledger line; blocking follows exact versions (`liveMoves`). Type-only packages carry no behaviour.
 */
export function runtimeReach(
  registry: Registry,
  dependsOn: Map<Source, Map<string, Set<string>>>,
): Map<Source, Set<string>> {
  const roots = Object.entries(registry.packages)
    .filter(([, cls]) => cls.kind !== 'dev')
    .map(([name]) => name);
  const reach = new Map<Source, Set<string>>();
  for (const source of SOURCES) {
    const graph = dependsOn.get(source) ?? new Map<string, Set<string>>();
    const seen = new Set(roots);
    const queue = [...roots];
    while (queue.length > 0) {
      for (const dep of graph.get(queue.shift()!) ?? []) {
        if (!seen.has(dep) && !dep.startsWith('@types/')) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    reach.set(source, seen);
  }
  return reach;
}

const names = (spec: string, packages: string[]): boolean =>
  packages.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));

const MOCKS = /^(?:vi|jest)\.(?:mock|doMock|unstable_mockModule)$/;

/**
 * What a test file loads at runtime and what it mocks, from the TypeScript parser, so an import inside a comment or a
 * string does not count. A type-only import loads nothing. A mock whose target is not a plain string cannot be
 * judged, so it is recorded as `null` and treated as mocking everything.
 */
function moduleUse(file: string, text: string): { imports: string[]; mocks: Array<string | null> } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: string[] = [];
  const mocks: Array<string | null> = [];
  const literal = (node: ts.Node | undefined): string | null =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const spec = literal(node.moduleSpecifier);
      if (spec) imports.push(spec);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      const spec = literal(node.moduleSpecifier);
      if (spec) imports.push(spec);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = literal(node.arguments[0]);
        if (spec) imports.push(spec);
      } else if (MOCKS.test(callee)) {
        mocks.push(literal(node.arguments[0]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, mocks };
}

/** The setup files vitest loads before every test file, which can mock a module for all of them. */
function vitestSetupFiles(read: (file: string) => string | null): string[] {
  const config = read('vitest.config.ts');
  const list = config ? /setupFiles:\s*\[([^\]]*)\]/.exec(config)?.[1] : undefined;
  return list ? [...list.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!) : [];
}

/**
 * Whether a test loads one of `packages` without mocking it. A mock in any repo module the test reaches through
 * relative imports, or in vitest's setup files, applies to the test, so every one is read; a module mocked anywhere
 * does not count as loading what it imports. A name-only check would accept a placeholder test; this cheap floor
 * refuses one that never touches the libraries on its path.
 */
function testLoads(test: string, packages: string[], read: (file: string) => string | null): boolean {
  if (read(test) === null) return false;
  const local = (from: string, spec: string): string =>
    path.posix.join(path.posix.dirname(from), spec).replace(/\.js$/, '.ts');
  const walk = (skip: Set<string>, visit: (file: string, use: ReturnType<typeof moduleUse>) => void): void => {
    const seen = new Set<string>();
    const queue = [...vitestSetupFiles(read), test];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file) || skip.has(file)) continue;
      seen.add(file);
      const text = read(file);
      if (text === null) continue;
      const use = moduleUse(file, text);
      visit(file, use);
      for (const spec of use.imports) if (spec.startsWith('.')) queue.push(local(file, spec));
    }
  };
  const mocked = new Set<string>();
  let mocksPath = false;
  walk(new Set(), (file, { mocks }) => {
    for (const spec of mocks) {
      if (spec === null || names(spec, packages)) mocksPath = true;
      else if (spec.startsWith('.')) mocked.add(local(file, spec));
    }
  });
  if (mocksPath) return false;
  let loads = false;
  walk(mocked, (_file, { imports }) => {
    if (imports.some((spec) => names(spec, packages))) loads = true;
  });
  return loads;
}

function closure(locked: Locked, source: Source, root: string): Set<string> {
  return reachable(
    locked,
    source,
    [...(locked.versions.get(source)?.get(root) ?? [])].map((version) => `${root}@${version}`),
  );
}

function reachable(locked: Locked, source: Source, seeds: string[]): Set<string> {
  const graph = locked.graph.get(source);
  const seen = new Set(seeds);
  const queue = [...seen];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of graph?.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Per tree and moved package, the live packages whose exact-version closure it moved: a version a live package loads
 * at the head and did not at the base, or a re-patched package it loads. Exact versions, so a copy only something else
 * loads never blocks a live path, and a version swap beneath a live package always does. A consumer moved onto a
 * version already in the closure leaves the closure's set unchanged, so each repoint is also judged on its own: a
 * consumer under a live package, or a project loading the live package itself, that now loads what it did not.
 */
export function liveMoves(
  registry: Registry,
  base: Locked,
  head: Locked,
  repatched: Map<Source, Set<string>>,
  repoints: Map<Source, Map<string, Repoint[]>> = new Map(),
): Map<Source, Map<string, Set<string>>> {
  const moves = new Map<Source, Map<string, Set<string>>>();
  const live = Object.entries(registry.packages)
    .filter(([, cls]) => cls.kind === 'live')
    .map(([name]) => name);
  for (const source of SOURCES) {
    for (const root of live) {
      const before = closure(base, source, root);
      for (const node of closure(head, source, root)) {
        const name = splitSpec(node)?.[0];
        if (!name || name.startsWith('@types/')) continue;
        if (!before.has(node) || repatched.get(source)?.has(name)) add(tree(moves, source), name, root);
      }
      const within = closure(head, source, root);
      for (const [name, list] of repoints.get(source) ?? []) {
        if (name.startsWith('@types/')) continue;
        for (const move of list) {
          const under = move.consumer.startsWith('importer:') ? name === root : within.has(move.consumer);
          if (!under) continue;
          add(tree(moves, source), name, root);
          const was = reachable(
            base,
            source,
            move.from === 'none' ? [] : move.from.split(',').map((version) => `${name}@${version}`),
          );
          for (const node of reachable(head, source, [`${name}@${move.to}`])) {
            const moved = splitSpec(node)?.[0];
            if (moved && !moved.startsWith('@types/') && !was.has(node)) add(tree(moves, source), moved, root);
          }
        }
      }
    }
  }
  return moves;
}

/** Live at the base or the head: a change that reclassifies a live package must not hide the moves beneath it. */
export function liveAtEitherEnd(base: Registry | null, head: Registry): Registry {
  const packages: Registry['packages'] = { ...head.packages };
  for (const [name, cls] of Object.entries(base?.packages ?? {})) {
    if (cls.kind !== 'live') continue;
    const now = packages[name];
    packages[name] = { kind: 'live', paths: [...new Set([...cls.paths, ...(now?.kind === 'live' ? now.paths : [])])] };
  }
  return { livePaths: { ...(base?.livePaths ?? {}), ...head.livePaths }, packages };
}

export function registryProblems(
  registry: Registry,
  direct: Set<string>,
  read: (file: string) => string | null,
): string[] {
  const problems: string[] = [];
  for (const name of [...direct].sort()) {
    if (!registry.packages[name]) {
      problems.push(
        `${name} is a direct dependency with no entry in ${REGISTRY_PATH}; classify it as dev, runtime, or live with the live paths it is on`,
      );
    }
  }
  for (const [name, cls] of Object.entries(registry.packages)) {
    if (cls.kind !== 'live') continue;
    if (cls.paths.length === 0) problems.push(`${name} is classified live but names no live path`);
    for (const id of cls.paths) {
      if (!registry.livePaths[id])
        problems.push(`${name} names live path ${id}, which ${REGISTRY_PATH} does not define`);
    }
  }
  for (const [id, livePath] of Object.entries(registry.livePaths)) {
    for (const test of livePath.tests) {
      if (!LIVE_PATH_TEST.test(test)) {
        problems.push(
          `live path ${id} lists ${test}; a live-path test's file name must contain "live-path" so CI runs it`,
        );
      } else if (read(test) === null) {
        problems.push(`live path ${id} lists ${test}, which does not exist`);
      } else {
        const packages = Object.entries(registry.packages)
          .filter(([name, cls]) => cls.kind === 'live' && cls.paths.includes(id) && !name.startsWith('docker:'))
          .map(([name]) => name);
        if (packages.length > 0 && !testLoads(test, packages, read)) {
          problems.push(
            `live path ${id} lists ${test}, which loads none of the packages on that path (${packages.join(', ')}) at runtime, directly or through a module it imports, or mocks one of them`,
          );
        }
      }
    }
  }
  return problems;
}

type Coverage = { kind: 'test'; path: string } | { kind: 'uncovered'; reason: string } | null;

export interface LedgerSection {
  from: string;
  to: string;
  source: string;
  override: string;
  entries: Array<{ text: string; coverage: Coverage }>;
  file: string;
}

export interface Ledger {
  sections: Map<string, LedgerSection>;
  /** Package or live-path names a ledger explains weakening in the registry: `Reclassified: <name> · <reason>`. */
  reclassified: Map<string, string>;
  problems: string[];
}

/**
 * Sections: `## <name>[, <name>…] <from> → <to>` (packages that moved between the same versions), a `Source:` line,
 * an optional `Override:` line, then one bullet per behaviour change ending in `· test: <path>` or
 * `· not covered: <reason>`. Fenced code is skipped.
 */
export function parseLedgers(files: Array<{ file: string; text: string }>): Ledger {
  const ledger: Ledger = { sections: new Map(), reclassified: new Map(), problems: [] };
  for (const { file, text } of files) {
    let current: LedgerSection | null = null;
    let fenced = false;
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const reclassified = /^Reclassified:\s*(\S+)\s+·\s+(\S.*)$/.exec(line);
      if (reclassified) {
        ledger.reclassified.set(reclassified[1]!, reclassified[2]!.trim());
        continue;
      }
      const heading = /^## (\S+(?:, \S+)*) (\S+) → (\S+)\s*$/.exec(line);
      if (heading) {
        current = { from: heading[2]!, to: heading[3]!, source: '', override: '', entries: [], file };
        for (const name of heading[1]!.split(', ')) {
          const previous = ledger.sections.get(name);
          if (previous) ledger.problems.push(`${name} has a ledger section in both ${previous.file} and ${file}`);
          ledger.sections.set(name, current);
        }
        continue;
      }
      if (/^#{1,2} /.test(line)) {
        current = null;
        continue;
      }
      if (!current) continue;
      const field = /^(Source|Override):\s*(\S.*)$/.exec(line);
      if (field) {
        if (field[1] === 'Source') current.source = field[2]!.trim();
        else current.override = field[2]!.trim();
        continue;
      }
      const bullet = /^- (.+)$/.exec(line);
      if (!bullet) continue;
      const test = /^(.*\S)\s+· test: (\S+)\s*$/.exec(bullet[1]!);
      const uncovered = /^(.*\S)\s+· not covered: (\S.*)$/.exec(bullet[1]!);
      current.entries.push(
        test
          ? { text: test[1]!, coverage: { kind: 'test', path: test[2]! } }
          : uncovered
            ? { text: uncovered[1]!, coverage: { kind: 'uncovered', reason: uncovered[2]!.trim() } }
            : { text: bullet[1]!, coverage: null },
      );
    }
  }
  return ledger;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const PLAIN_VERSION = /^\d+(\.\d+)*$/;

/**
 * The cases an incident cannot wait a test for: a patch at the shipped versions, or a rollback in which every version
 * added is a plain release older than every version removed. Dropping one of several versions moves its consumers up,
 * so it is an upgrade; a git, tarball or prerelease version never qualifies.
 */
function overridable(change: PackageChange): boolean {
  if (change.added.length === 0 && change.removed.length === 0) return true;
  if (change.added.length === 0 || change.removed.length === 0) return false;
  if (![...change.added, ...change.removed].every((v) => PLAIN_VERSION.test(v))) return false;
  const parse = (v: string) => v.split('.').map(Number);
  const oldestRemoved = change.removed.map(parse).sort(compareVersions)[0]!;
  return change.added.every((v) => compareVersions(parse(v), oldestRemoved) < 0);
}

/** The release line a version belongs to under semver: its major, or `0.<minor>` before 1.0. */
function releaseLine(version: string): string {
  if (!PLAIN_VERSION.test(version)) return version;
  const [major, minor] = version.split('.');
  return major === '0' ? `0.${minor ?? '0'}` : major!;
}

/**
 * A transitive move that leaves its semver-compatible range: a version on a release line the package was not on. A
 * direct dependency needs a ledger for any change; a transitive one inside its range rides on its parent's ledger,
 * and a live path's real-library test covers it on the wire.
 */
function breakingMove(change: PackageChange): boolean {
  const before = new Set(change.removed.map(releaseLine));
  const kept = change.from
    .split(',')
    .filter((v) => !change.removed.includes(v))
    .map(releaseLine);
  const repointBreaks = (change.repointed ?? []).some(
    (move) => move.from !== 'none' && !move.from.split(',').map(releaseLine).includes(releaseLine(move.to)),
  );
  return repointBreaks || change.added.some((v) => !before.has(releaseLine(v)) && !kept.includes(releaseLine(v)));
}

export interface GateResult {
  problems: string[];
  warnings: string[];
}

export function changeProblems(
  registry: Registry,
  reach: Map<Source, Set<string>>,
  changes: PackageChange[],
  ledger: Ledger,
  exists: (file: string) => boolean,
  moves: Map<Source, Map<string, Set<string>>>,
  baseRegistry: Registry | null = null,
): GateResult {
  const tests = baseRegistry ?? registry;
  const untestedVia = (root: string): string[] => [
    ...new Set([
      ...untestedLivePaths(registry, root, tests),
      ...(baseRegistry ? untestedLivePaths(baseRegistry, root) : []),
    ]),
  ];
  const result: GateResult = { problems: [...ledger.problems], warnings: [] };
  for (const change of changes) {
    const explicit = registry.packages[change.name];
    const reached = change.sources.some((source) => reach.get(source)?.has(change.name));
    const moved = change.sources.some((source) => moves.get(source)?.has(change.name));
    if (!reached && !moved && explicit?.kind !== 'live') continue;
    const label = `${change.name} ${change.from} → ${change.to}`;
    const section = ledger.sections.get(change.name);

    const roots = [...new Set(change.sources.flatMap((source) => [...(moves.get(source)?.get(change.name) ?? [])]))];
    const untested = change.to === 'none' ? [] : [...new Set(roots.flatMap(untestedVia))];
    if (untested.length > 0) {
      const via = roots.filter((root) => root !== change.name);
      const message = `${label}${via.length > 0 ? ` (loaded by ${via.join(', ')})` : ''} is on live I/O path(s) with no real-library test: ${untested.map((id) => `${id} (${(registry.livePaths[id] ?? tests.livePaths[id])?.description ?? id})`).join('; ')}`;
      if (section?.override && overridable(change)) {
        result.warnings.push(`${message}. Allowed by the ledger's Override: ${section.override}`);
      } else {
        result.problems.push(
          `${message}. Add a test for each and list it in ${REGISTRY_PATH} before this change can merge` +
            (overridable(change) ? '; an incident hotfix or rollback may instead carry an "Override:" line' : ''),
        );
      }
    }

    if (!section) {
      if (explicit?.kind !== 'runtime' && explicit?.kind !== 'live' && !breakingMove(change)) continue;
      result.problems.push(
        `${label} changes runtime behaviour but no ${LEDGER_DIR}/ file this change adds or edits has a "## ${label}" section`,
      );
      continue;
    }
    const where = `${section.file}, ${change.name}`;
    if (section.from !== change.from || section.to !== change.to) {
      result.problems.push(
        `${where}: the heading says ${section.from} → ${section.to}, the lockfiles say ${change.from} → ${change.to}`,
      );
    }
    if (!section.source) {
      result.problems.push(`${where}: no "Source:" line naming the changelog or release notes read`);
    }
    if (section.entries.length === 0) {
      result.problems.push(
        `${where}: no entries; list each behaviour change, or one entry saying the changelog lists none, each ending in "· test: <path>" or "· not covered: <reason>"`,
      );
    }
    for (const entry of section.entries) {
      if (!entry.coverage) {
        result.problems.push(
          `${where}: "${entry.text}" ends in neither "· test: <path>" nor "· not covered: <reason>"`,
        );
      } else if (entry.coverage.kind === 'test') {
        if (!/\.test\.ts$/.test(entry.coverage.path)) {
          result.problems.push(`${where}: "${entry.text}" cites ${entry.coverage.path}, which is not a test file`);
        } else if (!exists(entry.coverage.path)) {
          result.problems.push(`${where}: "${entry.text}" cites ${entry.coverage.path}, which does not exist`);
        }
      }
    }
  }
  return result;
}

const RANK = { dev: 0, runtime: 1, live: 2 } as const;

/**
 * A weaker registry than the base's needs a `Reclassified:` line in a ledger, and can never ride along with a version
 * change of a package it weakens: the reclassification has to merge, and be reviewed, on its own first.
 */
export function weakenedRegistryProblems(
  base: Registry | null,
  head: Registry,
  ledger: Ledger,
  changes: PackageChange[] = [],
): string[] {
  if (!base) return [];
  const problems: string[] = [];
  const changed = new Set(changes.map((change) => change.name));
  const weakenedPaths = new Set(
    Object.entries(base.livePaths)
      .filter(([id, livePath]) => livePath.tests.some((test) => !(head.livePaths[id]?.tests ?? []).includes(test)))
      .map(([id]) => id),
  );
  for (const [name, cls] of Object.entries(base.packages)) {
    if (!changed.has(name)) continue;
    const now = head.packages[name];
    const lostPath = cls.kind === 'live' && cls.paths.some((id) => now?.kind !== 'live' || !now.paths.includes(id));
    const onWeakenedPath = cls.kind === 'live' && cls.paths.some((id) => weakenedPaths.has(id));
    if (!now || RANK[now.kind] < RANK[cls.kind] || lostPath || onWeakenedPath) {
      problems.push(
        `${name} changes version in the same change that weakens its classification or a live path it is on; merge the reclassification on its own first`,
      );
    }
  }
  for (const [name, cls] of Object.entries(base.packages)) {
    if (cls.kind !== 'live' || ledger.reclassified.has(name)) continue;
    const now = head.packages[name];
    const kept = now?.kind === 'live' ? new Set(now.paths) : new Set<string>();
    const dropped = cls.paths.filter((id) => !kept.has(id));
    if (dropped.length > 0) {
      problems.push(
        `${name} no longer carries live path(s) ${dropped.join(', ')}; a ledger must say why with "Reclassified: ${name} · <reason>"`,
      );
    }
  }
  for (const [id, livePath] of Object.entries(base.livePaths)) {
    if (ledger.reclassified.has(id)) continue;
    const kept = new Set(head.livePaths[id]?.tests ?? []);
    const dropped = livePath.tests.filter((test) => !kept.has(test));
    if (dropped.length > 0) {
      problems.push(
        `live path ${id} no longer lists ${dropped.join(', ')}; a ledger must say why with "Reclassified: ${id} · <reason>"`,
      );
    }
  }
  return problems;
}

/** Dockerfile instructions with continuations joined, comments and blank lines dropped. */
function dockerInstructions(dockerfile: string): string[] {
  return dockerfile
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * A tracked tool must install from its ARG pin, or the gate cannot see its version: the ARG's references outside
 * comments may not drop while the ARG is defined, and every npm or PyPI install token for the tool must read exactly
 * `pkg@${ARG}` or `pkg==${ARG}` — no literal, tag, other ARG, or missing version.
 */
export function dockerfileProblems(base: string | null, head: string | null, tools: TrackedTool[]): string[] {
  if (!head) return [];
  const problems: string[] = [];
  const headLines = dockerInstructions(head);
  const references = (lines: string[], arg: string): number =>
    lines
      .filter((line) => !argValue(arg).test(line))
      .reduce((count, line) => count + [...line.matchAll(new RegExp(`\\$\\{${arg}\\}|\\$${arg}\\b`, 'g'))].length, 0);
  for (const tool of tools) {
    const defined = headLines.some((line) => argValue(tool.arg).test(line));
    if (!defined && references(headLines, tool.arg) > 0) {
      problems.push(
        `container/Dockerfile uses \${${tool.arg}} but the gate reads no ARG value for it; ${tool.id} must have one "ARG ${tool.arg}=<version>"`,
      );
    }
    if (defined && base && references(headLines, tool.arg) < references(dockerInstructions(base), tool.arg)) {
      problems.push(
        `container/Dockerfile references \${${tool.arg}} fewer times than the base, comments aside; ${tool.id} must install from its ARG pin`,
      );
    }
    const valued = headLines.filter((line) => argValue(tool.arg).test(line)).length;
    const shadowed = headLines.some((line) => new RegExp(`^ENV\\b.*(?:^|\\s)${tool.arg}(?:=|\\s)`, 'i').test(line));
    const assigned = headLines.some(
      (line) =>
        /^RUN\b/i.test(line) &&
        new RegExp(`(?:^|[\\s;&|(\`])(?:(?:export|readonly|local|declare(?:\\s+-\\S+)*)\\s+)?${tool.arg}=`).test(line),
    );
    if (valued > 1 || shadowed || assigned) {
      problems.push(
        `container/Dockerfile ${shadowed ? `sets ${tool.arg} with ENV` : assigned ? `assigns ${tool.arg} in a RUN` : `gives ARG ${tool.arg} a value ${valued} times`}; the gate reads only its first ARG value, so ${tool.id} must have exactly one`,
      );
    }
    const kind = tool.source?.kind;
    const pkg = tool.source?.package;
    if (!pkg || (kind !== 'npm' && kind !== 'pypi')) continue;
    const ref = `(?:\\$\\{${tool.arg}\\}|\\$${tool.arg}\\b)`;
    const commands = headLines.flatMap((line) => line.split(/&&|\|\||;|\|/));
    if (kind === 'npm') {
      const pinned = new RegExp(`^["']?${ref}["']?(?=[\\s"']|$)`);
      const token = new RegExp(`(?:^|[\\s"'=])${escapeRegExp(pkg)}(@\\S*|(?=[\\s"']|$))`, 'g');
      for (const command of commands) {
        const verb = /\b(?:install|i|add|update|up|upgrade|dlx|npx|bunx)\b/.exec(command);
        for (const match of command.matchAll(token)) {
          const rest = match[1] ?? '';
          const versioned = rest.startsWith('@');
          if (!versioned && (!verb || match.index < verb.index)) continue;
          if (!versioned || !pinned.test(rest.slice(1))) {
            problems.push(
              `container/Dockerfile installs ${pkg} as ${pkg}${rest.replace(/["']+$/, '')}; install it as ${pkg}@\${${tool.arg}}`,
            );
          }
        }
      }
      continue;
    }
    const normalize = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');
    const pinned = new RegExp(`^(?:\\[[^\\]]*\\])?==${ref}$`);
    for (const command of commands) {
      const verb = /\b(?:install|upgrade|add|sync)\b/.exec(command);
      if (!verb) continue;
      for (const raw of command.slice(verb.index).split(/\s+/)) {
        const token = raw.replace(/^["']+|["']+$/g, '');
        const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(token)?.[0];
        if (!name || normalize(name) !== normalize(pkg)) continue;
        if (!pinned.test(token.slice(name.length))) {
          problems.push(`container/Dockerfile installs ${pkg} as ${token}; install it as ${pkg}==\${${tool.arg}}`);
        }
      }
    }
  }
  return problems;
}

function filesAt(root: string, rev: string | null): DependencyFiles {
  const read = (file: string): string | null => {
    if (rev !== null) return gitRead(root, ['show', `${rev}:${file}`]);
    const full = path.join(root, file);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  };
  return Object.fromEntries(
    Object.entries(DEPENDENCY_FILE_PATHS).map(([key, file]) => [key, read(file)]),
  ) as unknown as DependencyFiles;
}

export function runCheck(root: string, base: string): GateResult {
  const read = (file: string): string | null => {
    const full = path.join(root, file);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  };
  const exists = (file: string): boolean => read(file) !== null;
  const registry = readDependencyPathRegistry(root);
  if (!registry) throw new Error(`dependency-gate: ${REGISTRY_PATH} is missing`);
  const baseRegistryText = gitRead(root, ['show', `${base}:${REGISTRY_PATH}`]);
  const baseRegistry = baseRegistryText ? (JSON.parse(baseRegistryText) as Registry) : null;
  const baseHasGate = gitRead(root, ['cat-file', '-e', `${base}:scripts/dependency-gate.ts`]) !== null;
  const movedRegistry =
    baseHasGate && !baseRegistry
      ? [`${REGISTRY_PATH} is not at the base, which has the gate; a moved registry cannot be checked for weakening`]
      : [];
  const baseFiles = filesAt(root, base);
  const headFiles = filesAt(root, null);
  const tools = [...trackedTools(baseFiles.updateSources), ...trackedTools(headFiles.updateSources)].filter(
    (tool, index, all) => all.findIndex((other) => other.id === tool.id) === index,
  );

  const diff = gitRead(root, ['diff', '--name-only', '--no-renames', base]);
  const untracked = gitRead(root, ['ls-files', '--others', '--exclude-standard']);
  if (diff === null || untracked === null) throw new Error(`dependency-gate: cannot diff against ${base}`);
  const changedFiles = [...diff.split('\n'), ...untracked.split('\n')].filter(Boolean);
  const ledger = parseLedgers(
    changedFiles
      .filter((file) => file.startsWith(`${LEDGER_DIR}/`) && file.endsWith('.md') && exists(file))
      .map((file) => ({ file, text: read(file)! })),
  );

  const head = lockedVersions(headFiles, tools);
  const baseLocked = lockedVersions(baseFiles, tools);
  const patchedFiles = changedFiles
    .map(patchedPackage)
    .filter((patch): patch is { name: string; source: Source } => patch !== null);
  const changes = packageChanges(baseLocked, head, patchedFiles);
  const repoints = consumerMoves(baseLocked, head);
  const moves = liveMoves(
    liveAtEitherEnd(baseRegistry, registry),
    baseLocked,
    head,
    repatchedPackages(baseLocked, head, patchedFiles),
    repoints,
  );
  const result = changeProblems(
    registry,
    runtimeReach(registry, head.dependsOn),
    withRepoints(changes, repoints, moves, head),
    ledger,
    exists,
    moves,
    baseRegistry,
  );
  return {
    problems: [
      ...registryProblems(registry, directDependencies(headFiles), read),
      ...movedRegistry,
      ...weakenedRegistryProblems(baseRegistry, registry, ledger, changes),
      ...dockerfileProblems(baseFiles.dockerfile, headFiles.dockerfile, tools),
      ...result.problems,
    ],
    warnings: result.warnings,
  };
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command !== 'check') {
    console.error('usage: tsx scripts/dependency-gate.ts check [--base <rev>]');
    return 2;
  }
  const root = process.cwd();
  const baseFlag = rest.indexOf('--base');
  const base = (baseFlag >= 0 ? rest[baseFlag + 1] : gitRead(root, ['merge-base', 'HEAD', 'origin/main']))?.trim();
  if (!base) {
    console.error('dependency-gate: no base: pass --base, or fetch origin/main with history');
    return 1;
  }
  const { problems, warnings } = runCheck(root, base);
  for (const warning of warnings) console.error(`dependency-gate: WARNING ${warning}`);
  for (const problem of problems) console.error(`dependency-gate: ${problem}`);
  console.log(
    `dependency-gate: ${problems.length} problem(s), ${warnings.length} override(s) against ${base.slice(0, 12)}`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main(process.argv.slice(2));
}
