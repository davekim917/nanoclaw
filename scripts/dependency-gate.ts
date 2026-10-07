/**
 * Dependency gate (docs/dependency-updates.md): a runtime version change needs a behaviour-change ledger, and a change
 * on a live I/O path needs a real-library test of that path, because mocked adapter tests pass through wire changes.
 *
 *   pnpm exec tsx scripts/dependency-gate.ts check [--base <rev>]   (default base: merge-base HEAD origin/main)
 */
import fs from 'fs';
import path from 'path';

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

interface PnpmLock {
  packages?: Record<string, unknown>;
  snapshots?: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
  patchedDependencies?: Record<string, string | { hash?: string }>;
}

/** bun.lock is JSON with trailing commas. */
function parseBunLock(text: string): { packages?: Record<string, unknown[]> } {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')) as { packages?: Record<string, unknown[]> };
}

export interface TrackedTool {
  id: string;
  arg: string;
  source?: { kind?: string; package?: string };
}

export function trackedTools(updateSources: string | null): TrackedTool[] {
  return updateSources ? ((JSON.parse(updateSources) as { dockerfile?: TrackedTool[] }).dockerfile ?? []) : [];
}

function dockerPins(dockerfile: string, items: TrackedTool[]): Array<{ id: string; version: string }> {
  return items.flatMap(({ id, arg }) => {
    const match = new RegExp(`^ARG ${arg}=["']?([^"'\\s#]+)`, 'm').exec(dockerfile);
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
  /** `<source>:<name>[@version]` → patch hash, from pnpm's patchedDependencies. */
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
  const locked: Locked = { versions: new Map(), dependsOn: new Map(), patches: new Map() };
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
    for (const [key, snapshot] of Object.entries(lock.snapshots ?? {})) {
      const spec = splitSpec(key.replace(/\(.*$/, ''));
      if (!spec) continue;
      for (const dep of Object.keys({ ...snapshot?.dependencies, ...snapshot?.optionalDependencies })) {
        add(tree(locked.dependsOn, source), spec[0], dep);
      }
    }
    for (const [key, entry] of Object.entries(lock.patchedDependencies ?? {})) {
      locked.patches.set(`${source}:${key}`, typeof entry === 'string' ? entry : (entry?.hash ?? ''));
    }
  }
  if (files.bunLock) {
    for (const entry of Object.values(parseBunLock(files.bunLock).packages ?? {})) {
      const spec = typeof entry[0] === 'string' ? splitSpec(entry[0]) : null;
      if (!spec) continue;
      add(tree(locked.versions, 'runner'), spec[0], spec[1]);
      const meta = (entry[2] ?? {}) as { dependencies?: object; optionalDependencies?: object };
      for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) {
        add(tree(locked.dependsOn, 'runner'), spec[0], dep);
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

/** `patches/@scope__name@1.2.3.patch` and `patches/@scope__name.patch` both name `@scope/name`. */
export function patchedPackage(changedPath: string): string | null {
  const match = /^patches\/(.+?)(?:@[^@/]+)?\.patch$/.exec(changedPath);
  return match ? match[1]!.replace('__', '/') : null;
}

export interface PackageChange {
  name: string;
  /** Every locked version before and after, across trees, comma-joined; `none` when absent. */
  from: string;
  to: string;
  /** The trees the change happened in. */
  sources: Source[];
  /** Versions present after and not before, and the reverse, across those trees. */
  added: string[];
  removed: string[];
}

function versionList(versions: Iterable<string>): string {
  const sorted = [...new Set(versions)].sort();
  return sorted.length > 0 ? sorted.join(',') : 'none';
}

const SOURCES: Source[] = ['host', 'runner', 'remotion', 'docker'];

export function packageChanges(base: Locked, head: Locked, patchedFiles: Iterable<string> = []): PackageChange[] {
  const patched = new Map<string, Set<Source>>();
  for (const name of patchedFiles) add(patched as Map<string, Set<string>>, name, 'host');
  for (const key of new Set([...base.patches.keys(), ...head.patches.keys()])) {
    if (base.patches.get(key) === head.patches.get(key)) continue;
    const [source, spec] = [key.slice(0, key.indexOf(':')) as Source, key.slice(key.indexOf(':') + 1)];
    add(patched as Map<string, Set<string>>, splitSpec(spec)?.[0] ?? spec, source);
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
    const scoped = (locked: Locked) => sources.flatMap((source) => [...(locked.versions.get(source)?.get(name) ?? [])]);
    const was = new Set(scoped(base));
    const now = new Set(scoped(head));
    changes.push({
      name,
      from: versionList(before),
      to: versionList(after),
      sources,
      added: [...now].filter((v) => !was.has(v)).sort(),
      removed: [...was].filter((v) => !now.has(v)).sort(),
    });
  }
  return changes;
}

/**
 * Per tree, every package a runtime code path can load: the registry's non-dev packages and whatever they depend on
 * within that lockfile. Reach decides only whether a change needs a ledger section, so over-counting costs a ledger
 * line; blocking stays with the packages the registry names as live. Type-only packages carry no behaviour.
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

const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;

function importsOf(text: string): string[] {
  return [...text.matchAll(IMPORT)].map((m) => m[1]!);
}

/**
 * Whether a test loads one of `packages`, itself or through one host module it imports. A name-only check would accept
 * a placeholder test; this cheap floor refuses one that never touches the libraries on its path.
 */
function testLoads(test: string, packages: string[], read: (file: string) => string | null): boolean {
  const hits = (text: string): boolean =>
    importsOf(text).some((spec) => packages.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`)));
  const text = read(test);
  if (text === null) return false;
  if (hits(text)) return true;
  return importsOf(text)
    .filter((spec) => spec.startsWith('.'))
    .some((spec) => {
      const module = read(path.posix.join(path.posix.dirname(test), spec).replace(/\.js$/, '.ts'));
      return module !== null && hits(module);
    });
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
            `live path ${id} lists ${test}, which loads none of the packages on that path (${packages.join(', ')}), directly or through a module it imports`,
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
 * Sections: `## <name> <from> → <to>`, a `Source:` line, an optional `Override:` line, then one bullet per behaviour
 * change ending in `· test: <path>` or `· not covered: <reason>`. Fenced code is skipped.
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
      const heading = /^## (\S+) (\S+) → (\S+)\s*$/.exec(line);
      if (heading) {
        const name = heading[1]!;
        const previous = ledger.sections.get(name);
        if (previous) ledger.problems.push(`${name} has a ledger section in both ${previous.file} and ${file}`);
        current = { from: heading[2]!, to: heading[3]!, source: '', override: '', entries: [], file };
        ledger.sections.set(name, current);
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
): GateResult {
  const result: GateResult = { problems: [...ledger.problems], warnings: [] };
  for (const change of changes) {
    const explicit = registry.packages[change.name];
    const reached = change.sources.some((source) => reach.get(source)?.has(change.name));
    if (!reached && explicit?.kind !== 'live') continue;
    const label = `${change.name} ${change.from} → ${change.to}`;
    const section = ledger.sections.get(change.name);

    const untested = change.to === 'none' ? [] : untestedLivePaths(registry, change.name);
    if (untested.length > 0) {
      const message = `${label} is on live I/O path(s) with no real-library test: ${untested.map((id) => `${id} (${registry.livePaths[id]!.description})`).join('; ')}`;
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

/**
 * A tracked tool must install from its ARG pin, or the gate cannot see its version: the ARG's references may not drop
 * while the ARG is still defined, and an npm-sourced tool may not appear with a literal version.
 */
export function dockerfileProblems(base: string | null, head: string | null, tools: TrackedTool[]): string[] {
  if (!head) return [];
  const problems: string[] = [];
  const references = (text: string, arg: string): number =>
    [...text.matchAll(new RegExp(`\\$\\{${arg}\\}|\\$${arg}\\b`, 'g'))].length;
  for (const tool of tools) {
    const defined = new RegExp(`^ARG ${tool.arg}=`, 'm').test(head);
    if (defined && base && references(head, tool.arg) < references(base, tool.arg)) {
      problems.push(
        `container/Dockerfile references \${${tool.arg}} fewer times than the base; ${tool.id} must install from its ARG pin`,
      );
    }
    const pkg = tool.source?.kind === 'npm' ? tool.source.package : undefined;
    if (pkg && new RegExp(`${pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@\\d`).test(head)) {
      problems.push(`container/Dockerfile installs ${pkg} at a literal version; install it from \${${tool.arg}}`);
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
  const changes = packageChanges(
    lockedVersions(baseFiles, tools),
    head,
    changedFiles.map(patchedPackage).filter((name): name is string => name !== null),
  );
  const result = changeProblems(registry, runtimeReach(registry, head.dependsOn), changes, ledger, exists);
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
