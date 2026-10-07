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

function dockerPins(dockerfile: string, updateSources: string): Array<{ id: string; version: string }> {
  const items = (JSON.parse(updateSources) as { dockerfile?: Array<{ id: string; arg: string }> }).dockerfile ?? [];
  return items.flatMap(({ id, arg }) => {
    const match = new RegExp(`^ARG ${arg}=["']?([^"'\\s#]+)`, 'm').exec(dockerfile);
    return match ? [{ id, version: match[1]! }] : [];
  });
}

function baseImages(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)/gim)].map((m) => m[1]!);
}

export interface Locked {
  versions: Map<string, Set<string>>;
  /** Package name → the names it depends on, across every lockfile. */
  dependsOn: Map<string, Set<string>>;
  /** `name@version` → patch hash, from pnpm's patchedDependencies. */
  patches: Map<string, string>;
}

export function lockedVersions(files: DependencyFiles): Locked {
  const versions = new Map<string, Set<string>>();
  const dependsOn = new Map<string, Set<string>>();
  const patches = new Map<string, string>();
  for (const text of [files.pnpmLock, files.remotionLock]) {
    if (!text) continue;
    const lock = parseYaml(text) as PnpmLock;
    for (const key of Object.keys(lock.packages ?? {})) {
      const spec = splitSpec(key.replace(/\(.*$/, ''));
      if (spec) add(versions, spec[0], spec[1]);
    }
    for (const [key, snapshot] of Object.entries(lock.snapshots ?? {})) {
      const spec = splitSpec(key.replace(/\(.*$/, ''));
      if (!spec) continue;
      for (const dep of Object.keys({ ...snapshot?.dependencies, ...snapshot?.optionalDependencies })) {
        add(dependsOn, spec[0], dep);
      }
    }
    for (const [key, entry] of Object.entries(lock.patchedDependencies ?? {})) {
      patches.set(key, typeof entry === 'string' ? entry : (entry?.hash ?? ''));
    }
  }
  if (files.bunLock) {
    for (const entry of Object.values(parseBunLock(files.bunLock).packages ?? {})) {
      const spec = typeof entry[0] === 'string' ? splitSpec(entry[0]) : null;
      if (!spec) continue;
      add(versions, spec[0], spec[1]);
      const meta = (entry[2] ?? {}) as { dependencies?: object; optionalDependencies?: object };
      for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies }))
        add(dependsOn, spec[0], dep);
    }
  }
  if (files.dockerfile) {
    if (files.updateSources) {
      for (const { id, version } of dockerPins(files.dockerfile, files.updateSources)) {
        add(versions, `docker:${id}`, version);
      }
    }
    for (const image of baseImages(files.dockerfile)) add(versions, BASE_IMAGE, image);
  }
  return { versions, dependsOn, patches };
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
  if (files.updateSources) {
    const items = (JSON.parse(files.updateSources) as { dockerfile?: Array<{ id: string }> }).dockerfile ?? [];
    for (const { id } of items) names.add(`docker:${id}`);
  }
  if (files.dockerfile && baseImages(files.dockerfile).length > 0) names.add(BASE_IMAGE);
  return names;
}

/** `patches/@scope__name@1.2.3.patch` names `@scope/name`. */
export function patchedPackage(changedPath: string): string | null {
  const match = /^patches\/(.+)@[^@/]+\.patch$/.exec(changedPath);
  return match ? match[1]!.replace('__', '/') : null;
}

export interface PackageChange {
  name: string;
  from: string;
  to: string;
}

function versionList(versions: Set<string> | undefined): string {
  return versions && versions.size > 0 ? [...versions].sort().join(',') : 'none';
}

export function packageChanges(base: Locked, head: Locked, patchedFiles: Iterable<string> = []): PackageChange[] {
  const patched = new Set(patchedFiles);
  for (const key of new Set([...base.patches.keys(), ...head.patches.keys()])) {
    if (base.patches.get(key) !== head.patches.get(key)) {
      const spec = splitSpec(key);
      if (spec) patched.add(spec[0]);
    }
  }
  const names = new Set([...base.versions.keys(), ...head.versions.keys(), ...patched]);
  const changes: PackageChange[] = [];
  for (const name of [...names].sort()) {
    const from = versionList(base.versions.get(name));
    const to = versionList(head.versions.get(name));
    if (from !== to || patched.has(name)) changes.push({ name, from, to });
  }
  return changes;
}

/**
 * Live paths per package, explicit or inherited: whatever a live package depends on, transitively, carries its live
 * paths, because a transitive move changes the same wire behaviour. A dev or runtime package reached that way
 * becomes live too; pnpm dedupes one copy for the test and the production path.
 */
export function effectiveLivePaths(registry: Registry, dependsOn: Map<string, Set<string>>): Map<string, Set<string>> {
  const live = new Map<string, Set<string>>();
  for (const [name, cls] of Object.entries(registry.packages)) {
    if (cls.kind !== 'live') continue;
    const queue = [name];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const id of cls.paths) add(live, current, id);
      for (const dep of dependsOn.get(current) ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
  }
  return live;
}

export function registryProblems(registry: Registry, direct: Set<string>, exists: (file: string) => boolean): string[] {
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
      } else if (!exists(test)) {
        problems.push(`live path ${id} lists ${test}, which does not exist`);
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

function newestVersion(list: string): number[] | null {
  if (list === 'none') return null;
  const parsed = list.split(',').map((v) => (/^\d+(\.\d+)*/.exec(v)?.[0] ?? '').split('.').map(Number));
  return parsed.sort(compareVersions).at(-1) ?? null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** A hotfix patch on the shipped version, or a rollback: the cases an incident cannot wait a test for. */
function overridable(change: PackageChange): boolean {
  if (change.from === change.to) return true;
  const from = newestVersion(change.from);
  const to = newestVersion(change.to);
  return from !== null && to !== null && compareVersions(to, from) < 0;
}

export interface GateResult {
  problems: string[];
  warnings: string[];
}

export function changeProblems(
  registry: Registry,
  livePaths: Map<string, Set<string>>,
  changes: PackageChange[],
  ledger: Ledger,
  exists: (file: string) => boolean,
): GateResult {
  const result: GateResult = { problems: [...ledger.problems], warnings: [] };
  for (const change of changes) {
    const explicit = registry.packages[change.name];
    const paths = [...(livePaths.get(change.name) ?? [])];
    if (paths.length === 0 && (!explicit || explicit.kind === 'dev')) continue;
    const label = `${change.name} ${change.from} → ${change.to}`;
    const section = ledger.sections.get(change.name);

    const untested = change.to === 'none' ? [] : paths.filter((id) => registry.livePaths[id]?.tests.length === 0);
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

/** A weaker registry than the base's, unless a ledger names the package or path in a `Reclassified:` line. */
export function weakenedRegistryProblems(base: Registry | null, head: Registry, ledger: Ledger): string[] {
  if (!base) return [];
  const problems: string[] = [];
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
  const exists = (file: string): boolean => fs.existsSync(path.join(root, file));
  const registry = readDependencyPathRegistry(root);
  if (!registry) throw new Error(`dependency-gate: ${REGISTRY_PATH} is missing`);
  const baseRegistryText = gitRead(root, ['show', `${base}:${REGISTRY_PATH}`]);
  const baseRegistry = baseRegistryText ? (JSON.parse(baseRegistryText) as Registry) : null;
  const headFiles = filesAt(root, null);

  const diff = gitRead(root, ['diff', '--name-only', '--no-renames', base]);
  const untracked = gitRead(root, ['ls-files', '--others', '--exclude-standard']);
  if (diff === null || untracked === null) throw new Error(`dependency-gate: cannot diff against ${base}`);
  const changedFiles = [...diff.split('\n'), ...untracked.split('\n')].filter(Boolean);
  const ledger = parseLedgers(
    changedFiles
      .filter((file) => file.startsWith(`${LEDGER_DIR}/`) && file.endsWith('.md') && exists(file))
      .map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') })),
  );

  const head = lockedVersions(headFiles);
  const changes = packageChanges(
    lockedVersions(filesAt(root, base)),
    head,
    changedFiles.map(patchedPackage).filter((name): name is string => name !== null),
  );
  const result = changeProblems(registry, effectiveLivePaths(registry, head.dependsOn), changes, ledger, exists);
  return {
    problems: [
      ...registryProblems(registry, directDependencies(headFiles), exists),
      ...weakenedRegistryProblems(baseRegistry, registry, ledger),
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
