import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { readDependencyPathRegistry, untestedLivePaths } from './dependency-paths.js';

const execFileAsync = promisify(execFile);

export const CONTAINER_PLUGINS_ROOT = '/workspace/plugins';

type UpdateKind =
  | 'host-dependency'
  | 'bun-dependency'
  | 'remotion-dependency'
  | 'dockerfile-pin'
  | 'codex-sync'
  | 'plugin-version';
type UpdateSurface = 'host' | 'container' | 'bootstrap' | 'plugins';
type AuditStatus = 'current' | 'outdated' | 'unknown' | 'blocked';

export interface AuditItem {
  id: string;
  name: string;
  kind: UpdateKind;
  surface: UpdateSurface;
  current: string;
  latest: string | null;
  status: AuditStatus;
  source: 'npm' | 'pypi' | 'github' | 'github-tags';
  detail?: string;
  tag?: string;
  commit?: string;
  upstreamPin?: string;
  /** The last upstream merge kept our pin over upstream's: a standing decision, so a bump must be raised explicitly. */
  heldByMerge?: boolean;
  /** The locally-running component that must move in the SAME change (a wire contract no test can see). */
  pairedWith?: string;
  /** Live I/O paths this package is on that have no real-library test; the CI dependency gate refuses the bump. */
  untestedLivePaths?: string[];
}

/** Client halves of client/server pairs with a local component; build and tests can't catch a wire break. */
export const LOCAL_SERVICE_PAIRS: Readonly<Record<string, string>> = {
  '@onecli-sh/sdk':
    'the OneCLI gateway container — 0.5.x calls /api/*, 2.x calls /v1/*. Upgrade the gateway in the same change and verify with a real call (e.g. getGatewaySkill()), not a build.',
};

export interface UpstreamPolicy {
  upstreamPin?: string;
  keptOurs?: boolean;
}

function parseDependencyPins(manifestText: string | null): Record<string, string> {
  if (!manifestText) return {};
  try {
    const parsed = JSON.parse(manifestText) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...parsed.dependencies, ...parsed.devDependencies };
  } catch {
    return {};
  }
}

/** `keptOurs`: at merge M the dep matches M^1 while M^2 differed, i.e. a deliberate hold. */
export function deriveUpstreamPolicy(texts: {
  upstream?: string | null;
  mergeOurs?: string | null;
  mergeTheirs?: string | null;
  mergeResult?: string | null;
}): Map<string, UpstreamPolicy> {
  const upstream = parseDependencyPins(texts.upstream ?? null);
  const ours = parseDependencyPins(texts.mergeOurs ?? null);
  const theirs = parseDependencyPins(texts.mergeTheirs ?? null);
  const result = parseDependencyPins(texts.mergeResult ?? null);

  const policy = new Map<string, UpstreamPolicy>();
  const names = new Set([...Object.keys(upstream), ...Object.keys(result)]);
  for (const name of names) {
    const entry: UpstreamPolicy = {};
    if (upstream[name]) entry.upstreamPin = upstream[name];
    // A merge with no disagreement on this dep carries no decision.
    const haveMergeSides = result[name] !== undefined && ours[name] !== undefined && theirs[name] !== undefined;
    if (haveMergeSides && ours[name] !== theirs[name] && result[name] === ours[name]) {
      entry.keptOurs = true;
    }
    if (entry.upstreamPin !== undefined || entry.keptOurs) policy.set(name, entry);
  }
  return policy;
}

/** Host-computed, because the audit's consumers run in a container whose project mount has no `.git`. */
interface UpstreamPolicySnapshot {
  schemaVersion: number;
  generatedAt: string;
  manifests: Record<string, Record<string, UpstreamPolicy>>;
}

const UPSTREAM_POLICY_SCHEMA_VERSION = 1;
const UPSTREAM_POLICY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Must stay in lockstep with auditRepository's audited manifests. */
const UPSTREAM_POLICY_MANIFESTS = ['package.json', 'container/agent-runner/package.json'];

function upstreamPolicySnapshotPath(repoRoot: string): string {
  return process.env.NANOCLAW_UPSTREAM_POLICY || path.join(repoRoot, '.upstream-policy.json');
}

/** Any problem (missing, unparseable, wrong schema, stale) yields null: fail open. */
async function loadUpstreamPolicySnapshot(repoRoot: string): Promise<UpstreamPolicySnapshot | null> {
  try {
    const text = await readFile(upstreamPolicySnapshotPath(repoRoot), 'utf8');
    const parsed = JSON.parse(text) as Partial<UpstreamPolicySnapshot>;
    if (
      parsed.schemaVersion !== UPSTREAM_POLICY_SCHEMA_VERSION ||
      typeof parsed.generatedAt !== 'string' ||
      !parsed.manifests ||
      typeof parsed.manifests !== 'object'
    ) {
      return null;
    }
    const ageMs = Date.now() - Date.parse(parsed.generatedAt);
    if (!Number.isFinite(ageMs) || ageMs > UPSTREAM_POLICY_MAX_AGE_MS) return null;
    return parsed as UpstreamPolicySnapshot;
  } catch {
    return null;
  }
}

/**
 * Git only, no snapshot fallback, so the snapshot writer never launders a stale snapshot as fresh. Fails open.
 * Reports `upstream/main` reachability separately: a clone without the remote still finds the merge and returns
 * a non-empty but half-complete map.
 */
async function readUpstreamPolicyFromGit(
  repoRoot: string,
  relativeManifest: string,
): Promise<{ policy: Map<string, UpstreamPolicy>; upstreamReachable: boolean }> {
  const show = async (rev: string): Promise<string | null> => {
    try {
      // A wedged git (held index.lock) must not hang host boot or the /update-container ack.
      const { stdout } = await execFileAsync('git', ['show', `${rev}:${relativeManifest}`], {
        cwd: repoRoot,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10_000,
      });
      return stdout;
    } catch {
      return null;
    }
  };

  const mergeCommit = await execFileAsync(
    'git',
    ['log', '--merges', '-1', '--format=%H', '--grep=Merge remote-tracking branch .upstream/main'],
    { cwd: repoRoot, maxBuffer: 1024 * 1024, timeout: 10_000 },
  )
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);

  const [upstream, mergeOurs, mergeTheirs, mergeResult] = await Promise.all([
    show('upstream/main'),
    mergeCommit ? show(`${mergeCommit}^1`) : Promise.resolve(null),
    mergeCommit ? show(`${mergeCommit}^2`) : Promise.resolve(null),
    mergeCommit ? show(mergeCommit) : Promise.resolve(null),
  ]);

  return {
    policy: deriveUpstreamPolicy({ upstream, mergeOurs, mergeTheirs, mergeResult }),
    upstreamReachable: upstream !== null,
  };
}

/** Fails open to an empty map, unless a fresh host-computed snapshot can fill the gap. */
export async function readUpstreamPolicy(
  repoRoot: string,
  relativeManifest: string,
): Promise<Map<string, UpstreamPolicy>> {
  const { policy, upstreamReachable } = await readUpstreamPolicyFromGit(repoRoot, relativeManifest);
  if (upstreamReachable) return policy;

  const snapshot = await loadUpstreamPolicySnapshot(repoRoot);
  const fromSnapshot = snapshot?.manifests[relativeManifest];
  return fromSnapshot ? new Map(Object.entries(fromSnapshot)) : policy;
}

/**
 * Git-only, so an empty result is recorded honestly rather than re-stamping an older snapshot. Truncates in place,
 * never temp-then-rename: `outPath` is bind-mounted into running containers, which would keep the old inode.
 */
export async function writeUpstreamPolicySnapshot(repoRoot: string, outPath: string): Promise<void> {
  const manifests: Record<string, Record<string, UpstreamPolicy>> = {};
  for (const relativeManifest of UPSTREAM_POLICY_MANIFESTS) {
    const { policy } = await readUpstreamPolicyFromGit(repoRoot, relativeManifest);
    manifests[relativeManifest] = Object.fromEntries(policy);
  }
  const snapshot: UpstreamPolicySnapshot = {
    schemaVersion: UPSTREAM_POLICY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    manifests,
  };
  await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function describeUpstreamPolicy(
  repoRoot: string,
): Promise<{ source: 'git' | 'snapshot' | 'unavailable'; generatedAt: string | null }> {
  const gitReady = await execFileAsync('git', ['rev-parse', '--verify', 'upstream/main'], {
    cwd: repoRoot,
    timeout: 10_000,
  })
    .then(() => true)
    .catch(() => false);
  if (gitReady) return { source: 'git', generatedAt: null };
  const snapshot = await loadUpstreamPolicySnapshot(repoRoot);
  if (snapshot) return { source: 'snapshot', generatedAt: snapshot.generatedAt };
  return { source: 'unavailable', generatedAt: null };
}

interface ReleaseResolved {
  status: 'resolved';
  version: string;
  tag?: string;
  commitish?: string;
}

interface ReleaseBlocked {
  status: 'blocked';
  reason: string;
}

export type ReleaseResolution = ReleaseResolved | ReleaseBlocked;

interface DockerUpdateSource {
  id: string;
  name: string;
  arg: string;
  source:
    | { kind: 'npm'; package: string; allowPrerelease?: boolean }
    | { kind: 'pypi'; package: string }
    | { kind: 'github'; repo: string }
    | { kind: 'github-tags'; repo: string };
  /**
   * `url` returns a `.sha256` sidecar, or with `githubReleaseAsset` a GitHub release API document whose asset
   * `digest` is read instead, for projects that publish no sidecar.
   */
  checksums?: Array<{ arg: string; url: string; filename?: string; githubReleaseAsset?: string }>;
  mirrors?: Array<{ file: string; jsonPath: string[]; format: string }>;
}

interface PluginUpdateSource {
  id: string;
  name: string;
  dir: string;
  repo: string;
  manifestPath: string;
  /** `.claude-plugin`, or `.codex-plugin` for Codex-native plugins. */
  manifestDir?: string;
  ref?: string;
}

interface UpdateSourcesManifest {
  schemaVersion: 1;
  dockerfile: DockerUpdateSource[];
  codex?: {
    repo: string;
    sourcesFile: string;
  };
  plugins?: PluginUpdateSource[];
}

export type JsonFetcher = (url: string) => Promise<unknown>;
export type TextFetcher = (url: string) => Promise<string>;
export type CommandRunner = (command: string[], cwd: string) => Promise<void>;

const PRERELEASE = /(?:^|[._+-])(alpha|beta|rc|pre|preview|dev|nightly|canary|snapshot)\d*(?:$|[._+-])/i;
const COMPACT_PRERELEASE = /\d(?:a|b|rc|dev)\d*$/i;

function isStableVersion(value: string): boolean {
  const normalized = value.trim().replace(/^v(?=\d)/i, '');
  return (
    /^\d+(?:\.\d+)*(?:\.post\d+)?$/i.test(normalized) &&
    !PRERELEASE.test(normalized) &&
    !COMPACT_PRERELEASE.test(normalized)
  );
}

function normalizeVersion(value: string): string {
  const match = value.trim().match(/v?(\d+(?:\.\d+)+(?:\.post\d+)?)/i);
  return match?.[1] ?? value.trim().replace(/^v/, '');
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    normalizeVersion(value)
      .replace(/\.post/g, '.')
      .split('.')
      .map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return comparePrereleases(prereleaseIdentifiers(left), prereleaseIdentifiers(right));
}

function prereleaseIdentifiers(value: string): string[] | null {
  const match = value.trim().match(/^v?\d+\.\d+\.\d+-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/);
  return match ? match[1].split('.') : null;
}

function comparePrereleases(left: string[] | null, right: string[] | null): number {
  if (!left || !right) return left ? -1 : right ? 1 : 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const delta = Number(a) - Number(b);
      if (delta !== 0) return delta;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

export function latestStableNpmVersion(
  metadata: unknown,
  options: { allowPrerelease?: boolean } = {},
): ReleaseResolution {
  const latest = (metadata as { 'dist-tags'?: { latest?: unknown } })?.['dist-tags']?.latest;
  if (typeof latest !== 'string') return { status: 'blocked', reason: 'npm metadata has no latest tag' };
  if (options.allowPrerelease && prereleaseIdentifiers(latest)) {
    return { status: 'resolved', version: latest.trim().replace(/^v/, '') };
  }
  if (!isStableVersion(latest)) {
    return { status: 'blocked', reason: `npm latest tag is not a stable release: ${latest}` };
  }
  return { status: 'resolved', version: normalizeVersion(latest) };
}

export function latestStablePyPiVersion(metadata: unknown): ReleaseResolution {
  const releases = (metadata as { releases?: Record<string, Array<{ yanked?: boolean; packagetype?: string }>> })
    ?.releases;
  if (!releases || typeof releases !== 'object') {
    return { status: 'blocked', reason: 'PyPI metadata has no releases' };
  }
  const versions = Object.entries(releases)
    .filter(
      ([version, files]) =>
        isStableVersion(version) &&
        Array.isArray(files) &&
        files.some((file) => file.packagetype === 'bdist_wheel' && file.yanked !== true),
    )
    .map(([version]) => version)
    .sort(compareVersions);
  const latest = versions.at(-1);
  return latest
    ? { status: 'resolved', version: normalizeVersion(latest) }
    : { status: 'blocked', reason: 'PyPI has no non-yanked stable wheel release' };
}

export function latestStableGitHubRelease(metadata: unknown): ReleaseResolution {
  if (!Array.isArray(metadata)) return { status: 'blocked', reason: 'GitHub metadata is not a release list' };
  const candidates = metadata
    .flatMap((release) => {
      const item = release as {
        tag_name?: unknown;
        draft?: boolean;
        prerelease?: boolean;
        target_commitish?: unknown;
      };
      if (item.draft || item.prerelease || typeof item.tag_name !== 'string') return [];
      const version = normalizeVersion(item.tag_name);
      if (!isStableVersion(version) || PRERELEASE.test(item.tag_name)) return [];
      return [
        {
          version,
          tag: item.tag_name,
          commitish: typeof item.target_commitish === 'string' ? item.target_commitish : undefined,
        },
      ];
    })
    .sort((a, b) => compareVersions(a.version, b.version));
  const latest = candidates.at(-1);
  return latest
    ? { status: 'resolved', ...latest }
    : { status: 'blocked', reason: 'GitHub has no stable, published release' };
}

export function latestStableGitHubTag(metadata: unknown): ReleaseResolution {
  if (!Array.isArray(metadata)) return { status: 'blocked', reason: 'GitHub metadata is not a tag list' };
  const candidates = metadata
    .flatMap((tag) => {
      const item = tag as { name?: unknown; commit?: { sha?: unknown } };
      if (typeof item.name !== 'string') return [];
      const version = normalizeVersion(item.name);
      if (!isStableVersion(version) || PRERELEASE.test(item.name)) return [];
      return [
        {
          version,
          tag: item.name,
          commitish: typeof item.commit?.sha === 'string' ? item.commit.sha : undefined,
        },
      ];
    })
    .sort((a, b) => compareVersions(a.version, b.version));
  const latest = candidates.at(-1);
  return latest ? { status: 'resolved', ...latest } : { status: 'blocked', reason: 'GitHub has no stable tag' };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nanoclaw-container-updates' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'nanoclaw-container-updates' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

function dependencyVersion(specifier: string): string | null {
  const match = specifier.match(/^(?:\^|~)?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)$/);
  return match?.[1] ?? null;
}

function itemFromResolution(
  base: Omit<AuditItem, 'latest' | 'status' | 'detail' | 'tag'>,
  resolution: ReleaseResolution,
): AuditItem {
  if (resolution.status === 'blocked') {
    return { ...base, latest: null, status: 'blocked', detail: resolution.reason };
  }
  return {
    ...base,
    latest: resolution.version,
    status: compareVersions(base.current, resolution.version) < 0 ? 'outdated' : 'current',
    tag: resolution.tag,
  };
}

async function resolveSource(source: DockerUpdateSource['source'], fetchJson: JsonFetcher): Promise<ReleaseResolution> {
  if (source.kind === 'npm') {
    return latestStableNpmVersion(await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(source.package)}`), {
      allowPrerelease: source.allowPrerelease,
    });
  }
  if (source.kind === 'pypi') {
    return latestStablePyPiVersion(await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(source.package)}/json`));
  }
  if (source.kind === 'github-tags') {
    return latestStableGitHubTag(await fetchJson(`https://api.github.com/repos/${source.repo}/tags?per_page=100`));
  }
  return latestStableGitHubRelease(
    await fetchJson(`https://api.github.com/repos/${source.repo}/releases?per_page=100`),
  );
}

async function audited<T>(name: string, action: () => Promise<T>): Promise<T | Error> {
  try {
    return await action();
  } catch (error) {
    return new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readArg(dockerfile: string, name: string): string | null {
  const match = dockerfile.match(new RegExp(`^ARG\\s+${name}=([^\\s#]+)`, 'm'));
  return match?.[1] ?? null;
}

/** Every manifest the audit scans needs one. */
const DEPENDENCY_ID_PREFIX: Record<'host-dependency' | 'bun-dependency' | 'remotion-dependency', string> = {
  'host-dependency': 'host',
  'bun-dependency': 'bun',
  'remotion-dependency': 'remotion',
};

async function auditDependencies(
  repoRoot: string,
  relativePackageJson: string,
  kind: 'host-dependency' | 'bun-dependency' | 'remotion-dependency',
  surface: UpdateSurface,
  fetchJson: JsonFetcher,
): Promise<AuditItem[]> {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, relativePackageJson), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const policy = await readUpstreamPolicy(repoRoot, relativePackageJson);
  return Promise.all(
    Object.entries(dependencies).map(async ([name, specifier]) => {
      const current = dependencyVersion(specifier);
      const entry = policy.get(name);
      const base: Omit<AuditItem, 'latest' | 'status' | 'detail' | 'tag'> = {
        id: `${DEPENDENCY_ID_PREFIX[kind]}:${name}`,
        name,
        kind,
        surface,
        current: current ?? specifier,
        source: 'npm',
        ...(entry?.upstreamPin ? { upstreamPin: entry.upstreamPin } : {}),
        ...(entry?.keptOurs ? { heldByMerge: true } : {}),
        ...(LOCAL_SERVICE_PAIRS[name] ? { pairedWith: LOCAL_SERVICE_PAIRS[name] } : {}),
      };
      if (!current) return { ...base, latest: null, status: 'blocked', detail: `unsupported specifier: ${specifier}` };
      const result = await audited(name, () => resolveSource({ kind: 'npm', package: name }, fetchJson));
      return result instanceof Error
        ? { ...base, latest: null, status: 'unknown', detail: result.message }
        : itemFromResolution(base, result);
    }),
  );
}

async function firstReadable(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next explicit host/container location.
    }
  }
  return null;
}

async function auditCodexSources(manifest: UpdateSourcesManifest, fetchJson: JsonFetcher): Promise<AuditItem[]> {
  if (!manifest.codex) return [];
  const configured = process.env.NANOCLAW_CODEX_SOURCES;
  const hostFallback = manifest.codex.sourcesFile.replace(
    `${CONTAINER_PLUGINS_ROOT}/`,
    `${path.join(homedir(), 'plugins')}/`,
  );
  const sourcePath = await firstReadable([
    ...(configured ? [configured] : []),
    manifest.codex.sourcesFile,
    hostFallback,
  ]);
  if (!sourcePath) {
    return [
      {
        id: 'codex-sync:sources',
        name: 'Codex synced sources',
        kind: 'codex-sync',
        surface: 'bootstrap',
        current: 'unavailable',
        latest: null,
        status: 'unknown',
        source: 'github',
        detail: `CODEX-SOURCES.md not found at ${manifest.codex.sourcesFile}`,
      },
    ];
  }
  const text = await readFile(sourcePath, 'utf8');
  const rows = [...text.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{7,40})`\s*\|/gm)];
  if (rows.length === 0) {
    return [
      {
        id: 'codex-sync:sources',
        name: 'Codex synced sources',
        kind: 'codex-sync',
        surface: 'bootstrap',
        current: 'invalid',
        latest: null,
        status: 'blocked',
        source: 'github',
        detail: `no pinned source rows found in ${sourcePath}`,
      },
    ];
  }
  return Promise.all(
    rows.map(async ([, local, upstream, current]): Promise<AuditItem> => {
      const base = {
        id: `codex-sync:${local}`,
        name: local,
        kind: 'codex-sync' as const,
        surface: 'bootstrap' as const,
        current,
        source: 'github' as const,
      };
      const result = await audited(local, async () => {
        const payload = await fetchJson(
          `https://api.github.com/repos/${manifest.codex!.repo}/commits?path=${encodeURIComponent(upstream)}&per_page=1`,
        );
        const sha = Array.isArray(payload) && typeof payload[0]?.sha === 'string' ? payload[0].sha : null;
        if (!sha) throw new Error('GitHub returned no commit SHA');
        return sha.slice(0, current.length);
      });
      if (result instanceof Error) {
        return { ...base, latest: null, status: 'unknown', detail: result.message };
      }
      return { ...base, latest: result, status: result === current ? 'current' : 'outdated' };
    }),
  );
}

/** Per-plugin manifest version, not repo HEAD: a monorepo commit to a sibling plugin is not an update to ours. */
async function auditPluginVersions(manifest: UpdateSourcesManifest, fetchJson: JsonFetcher): Promise<AuditItem[]> {
  if (!manifest.plugins?.length) return [];
  return Promise.all(
    manifest.plugins.map(async (entry): Promise<AuditItem> => {
      const base = {
        id: `plugin:${entry.id}`,
        name: entry.name,
        kind: 'plugin-version' as const,
        surface: 'plugins' as const,
        source: 'github' as const,
      };
      const localManifest = await firstReadable(
        [CONTAINER_PLUGINS_ROOT, path.join(homedir(), 'plugins')].map((root) =>
          path.join(root, entry.dir, entry.manifestDir ?? '.claude-plugin', 'plugin.json'),
        ),
      );
      if (!localManifest) {
        return {
          ...base,
          current: 'unavailable',
          latest: null,
          status: 'unknown',
          detail: `plugin manifest not found for ${entry.dir} under ${CONTAINER_PLUGINS_ROOT} or ~/plugins`,
        };
      }
      const current = await audited(entry.name, async () => {
        const parsed = JSON.parse(await readFile(localManifest, 'utf8')) as { version?: unknown };
        if (typeof parsed.version !== 'string') throw new Error(`no version field in ${localManifest}`);
        return parsed.version;
      });
      if (current instanceof Error) {
        return { ...base, current: 'invalid', latest: null, status: 'blocked', detail: current.message };
      }
      const result = await audited(entry.name, async (): Promise<ReleaseResolution> => {
        const payload = (await fetchJson(
          `https://raw.githubusercontent.com/${entry.repo}/${entry.ref ?? 'main'}/${entry.manifestPath}`,
        )) as { version?: unknown } | null;
        const version = payload?.version;
        if (typeof version !== 'string') throw new Error('upstream plugin manifest has no version field');
        return isStableVersion(version)
          ? { status: 'resolved', version }
          : { status: 'blocked', reason: `upstream version is not stable: ${version}` };
      });
      return result instanceof Error
        ? { ...base, current, latest: null, status: 'unknown', detail: result.message }
        : itemFromResolution({ ...base, current }, result);
    }),
  );
}

export async function auditRepository(
  repoRoot: string,
  fetchJson: JsonFetcher = defaultFetchJson,
): Promise<AuditItem[]> {
  const [host, bun, remotion, sourceText, dockerfile] = await Promise.all([
    auditDependencies(repoRoot, 'package.json', 'host-dependency', 'host', fetchJson),
    auditDependencies(repoRoot, 'container/agent-runner/package.json', 'bun-dependency', 'container', fetchJson),
    // Remotion runtime at /opt/remotion: an unaudited manifest rots silently.
    auditDependencies(repoRoot, 'container/remotion/package.json', 'remotion-dependency', 'container', fetchJson),
    readFile(path.join(repoRoot, 'container/update-sources.json'), 'utf8'),
    readFile(path.join(repoRoot, 'container/Dockerfile'), 'utf8'),
  ]);
  const manifest = JSON.parse(sourceText) as UpdateSourcesManifest;
  if (manifest.schemaVersion !== 1) throw new Error('unsupported container/update-sources.json schema');

  const docker = await Promise.all(
    manifest.dockerfile.map(async (entry): Promise<AuditItem> => {
      const current = readArg(dockerfile, entry.arg);
      const base: Omit<AuditItem, 'latest' | 'status' | 'detail' | 'tag'> = {
        id: `docker:${entry.id}`,
        name: entry.name,
        kind: 'dockerfile-pin',
        surface: 'container',
        current: current ?? 'missing',
        source: entry.source.kind,
      };
      if (!current) return { ...base, latest: null, status: 'blocked', detail: `missing Docker ARG ${entry.arg}` };
      const result = await audited(entry.name, () => resolveSource(entry.source, fetchJson));
      return result instanceof Error
        ? { ...base, latest: null, status: 'unknown', detail: result.message }
        : itemFromResolution(base, result);
    }),
  );

  const [codex, plugins] = await Promise.all([
    auditCodexSources(manifest, fetchJson),
    auditPluginVersions(manifest, fetchJson),
  ]);
  const registry = readDependencyPathRegistry(repoRoot);
  return [...host, ...bun, ...remotion, ...docker, ...codex, ...plugins]
    .map((item) => {
      const untested = registry
        ? untestedLivePaths(registry, item.kind === 'dockerfile-pin' ? item.id : item.name)
        : [];
      return untested.length > 0 ? { ...item, untestedLivePaths: untested } : item;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function statusLabel(status: AuditStatus): string {
  return status === 'current' ? 'current' : status;
}

export function renderAuditMarkdown(items: AuditItem[]): string {
  const lines = [
    '| Item | Kind | Current | Latest | Status |',
    '|---|---|---:|---:|---|',
    ...items.map(
      (item) =>
        `| ${item.name} | ${item.kind} | ${item.current} | ${item.latest ?? 'unknown'} | ${statusLabel(item.status)} |`,
    ),
  ];
  const actionable = items.filter((item) => item.status === 'outdated');
  const blocked = items.filter((item) => item.status === 'blocked' || item.status === 'unknown');
  lines.push('', `${actionable.length} outdated; ${blocked.length} blocked or unknown.`);
  for (const item of blocked) lines.push(`- ${item.id}: ${item.detail ?? item.status}`);

  // Surfaced next to the versions so an approval can't be given without seeing them.
  const held = actionable.filter((item) => item.heldByMerge);
  if (held.length > 0) {
    lines.push('', '**HELD by the last upstream merge — do not bump without raising it explicitly:**');
    for (const item of held) {
      lines.push(
        `- ${item.id}: merge kept ours (\`${item.current}\`)${
          item.upstreamPin ? ` over upstream \`${item.upstreamPin}\`` : ''
        }. That is a standing decision; ask before superseding it.`,
      );
    }
  }

  const drifted = actionable.filter(
    (item) => item.upstreamPin && item.upstreamPin !== item.current && !item.heldByMerge,
  );
  if (drifted.length > 0) {
    lines.push('', '**Upstream pins differ from ours** (upstream parity is usually the safer target than latest):');
    for (const item of drifted) lines.push(`- ${item.id}: ours \`${item.current}\`, upstream \`${item.upstreamPin}\``);
  }

  const untested = actionable.filter((item) => item.untestedLivePaths);
  if (untested.length > 0) {
    lines.push('', '**BLOCKED by the dependency gate — a live I/O path with no real-library test:**');
    for (const item of untested) lines.push(`- ${item.id}: ${item.untestedLivePaths!.join(', ')}`);
  }

  const paired = actionable.filter((item) => item.pairedWith);
  if (paired.length > 0) {
    lines.push('', '**Client/server pairs — CANNOT be validated by building. Approve or skip as one unit:**');
    for (const item of paired) lines.push(`- ${item.id}: moves with ${item.pairedWith}`);
  }
  return lines.join('\n');
}

export function buildScheduledAuditGate(
  items: AuditItem[],
  upstreamPolicy?: { source: 'git' | 'snapshot' | 'unavailable'; generatedAt: string | null },
): { wakeAgent: boolean; data: unknown } {
  const outdated = items.filter((item) => item.status === 'outdated');
  const unresolved = items.filter((item) => item.status === 'blocked' || item.status === 'unknown');
  return {
    wakeAgent: outdated.length > 0 || unresolved.length > 0,
    data: {
      schemaVersion: 1,
      summary: {
        outdated: outdated.length,
        unresolved: unresolved.length,
        current: items.filter((item) => item.status === 'current').length,
      },
      items: [...outdated, ...unresolved],
      ...(upstreamPolicy ? { upstreamPolicy } : {}),
    },
  };
}

function nextSpecifier(current: string, version: string): string {
  if (current.startsWith('^')) return `^${version}`;
  if (current.startsWith('~')) return `~${version}`;
  return version;
}

async function defaultRun(command: string[], cwd: string): Promise<void> {
  const [file, ...args] = command;
  await execFileAsync(file, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
}

async function updatePackageJson(packagePath: string, selected: AuditItem[]): Promise<void> {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const item of selected) {
    if (!item.latest) throw new Error(`update item has no resolved version: ${item.id}`);
    const section = Object.hasOwn(packageJson.dependencies ?? {}, item.name)
      ? packageJson.dependencies
      : packageJson.devDependencies;
    if (!section || !Object.hasOwn(section, item.name)) throw new Error(`dependency not found: ${item.name}`);
    section[item.name] = nextSpecifier(section[item.name], item.latest);
  }
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function substitute(template: string, version: string): string {
  return template.replaceAll('{version}', version);
}

function checksumFromText(text: string, filename?: string): string {
  const lines = text.trim().split(/\r?\n/);
  const line = filename ? lines.find((candidate) => candidate.includes(filename)) : lines[0];
  const digest = line?.match(/\b([0-9a-f]{64})\b/i)?.[1]?.toLowerCase();
  if (!digest) throw new Error(`could not resolve SHA256${filename ? ` for ${filename}` : ''}`);
  return digest;
}

function checksumFromGitHubRelease(text: string, asset: string): string {
  const release = JSON.parse(text) as { assets?: Array<{ name?: unknown; digest?: unknown }> };
  const digest = release.assets?.find((candidate) => candidate.name === asset)?.digest;
  const match = typeof digest === 'string' ? digest.match(/^sha256:([0-9a-f]{64})$/i) : null;
  if (!match) throw new Error(`could not resolve SHA256 for release asset ${asset}`);
  return match[1].toLowerCase();
}

function setJsonPath(target: Record<string, unknown>, parts: string[], value: string): void {
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next))
      throw new Error(`invalid JSON mirror path: ${parts.join('.')}`);
    cursor = next as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

export async function applySelectedUpdates(options: {
  repoRoot: string;
  items: AuditItem[];
  selectedIds: string[];
  run?: CommandRunner;
  fetchText?: TextFetcher;
}): Promise<void> {
  const { repoRoot, items, selectedIds } = options;
  if (selectedIds.length === 0) throw new Error('apply requires at least one update item');
  const indexed = new Map(items.map((item) => [item.id, item]));
  const selected = selectedIds.map((id) => {
    const item = indexed.get(id);
    if (!item) throw new Error(`unknown update item: ${id}`);
    if (item.status !== 'outdated' || !item.latest) throw new Error(`update item is not actionable: ${id}`);
    return item;
  });
  const run = options.run ?? defaultRun;
  const fetchText = options.fetchText ?? defaultFetchText;
  if (selected.some((item) => item.kind === 'codex-sync')) {
    throw new Error('Codex sync updates target the bootstrap repository and must be applied there');
  }
  if (selected.some((item) => item.kind === 'plugin-version')) {
    throw new Error('Plugin updates are applied with `git pull` in the plugin clone under ~/plugins');
  }
  const host = selected.filter((item) => item.kind === 'host-dependency');
  const bun = selected.filter((item) => item.kind === 'bun-dependency');
  const remotion = selected.filter((item) => item.kind === 'remotion-dependency');
  const docker = selected.filter((item) => item.kind === 'dockerfile-pin');

  if (host.length > 0) {
    await updatePackageJson(path.join(repoRoot, 'package.json'), host);
    await run(['pnpm', 'install', '--lockfile-only'], repoRoot);
  }
  if (bun.length > 0) {
    const runnerRoot = path.join(repoRoot, 'container/agent-runner');
    await updatePackageJson(path.join(runnerRoot, 'package.json'), bun);
    await run(['bun', 'install', '--lockfile-only'], runnerRoot);
  }
  if (remotion.length > 0) {
    const remotionRoot = path.join(repoRoot, 'container/remotion');
    await updatePackageJson(path.join(remotionRoot, 'package.json'), remotion);
    // --ignore-workspace is required: otherwise pnpm won't write the nested lockfile and the frozen install fails.
    await run(['pnpm', 'install', '--lockfile-only', '--ignore-workspace'], remotionRoot);
  }
  if (docker.length > 0) {
    const sources = JSON.parse(
      await readFile(path.join(repoRoot, 'container/update-sources.json'), 'utf8'),
    ) as UpdateSourcesManifest;
    const byId = new Map(sources.dockerfile.map((entry) => [`docker:${entry.id}`, entry]));
    const dockerfilePath = path.join(repoRoot, 'container/Dockerfile');
    let dockerfile = await readFile(dockerfilePath, 'utf8');
    const prepared: Array<{
      item: AuditItem;
      entry: DockerUpdateSource;
      checksums: Array<{ arg: string; digest: string }>;
    }> = [];
    for (const item of docker) {
      const entry = byId.get(item.id);
      if (!entry) throw new Error(`Docker update source not found: ${item.id}`);
      const pattern = new RegExp(`^(ARG\\s+${entry.arg}=)[^\\s#]+`, 'm');
      if (!pattern.test(dockerfile)) throw new Error(`Docker ARG not found: ${entry.arg}`);
      const checksums = await Promise.all(
        (entry.checksums ?? []).map(async (checksum) => {
          const filename = checksum.filename ? substitute(checksum.filename, item.latest!) : undefined;
          const content = await fetchText(substitute(checksum.url, item.latest!));
          const digest = checksum.githubReleaseAsset
            ? checksumFromGitHubRelease(content, substitute(checksum.githubReleaseAsset, item.latest!))
            : checksumFromText(content, filename);
          return { arg: checksum.arg, digest };
        }),
      );
      for (const checksum of checksums) {
        if (!new RegExp(`^ARG\\s+${checksum.arg}=[0-9a-f]{64}`, 'm').test(dockerfile)) {
          throw new Error(`Docker checksum ARG not found: ${checksum.arg}`);
        }
      }
      prepared.push({ item, entry, checksums });
    }
    for (const { item, entry, checksums } of prepared) {
      const pattern = new RegExp(`^(ARG\\s+${entry.arg}=)[^\\s#]+`, 'm');
      dockerfile = dockerfile.replace(pattern, `$1${item.latest}`);
      for (const checksum of checksums) {
        dockerfile = dockerfile.replace(
          new RegExp(`^(ARG\\s+${checksum.arg}=)[0-9a-f]{64}`, 'm'),
          `$1${checksum.digest}`,
        );
      }
      for (const mirror of entry.mirrors ?? []) {
        const mirrorPath = path.join(repoRoot, mirror.file);
        const payload = JSON.parse(await readFile(mirrorPath, 'utf8')) as Record<string, unknown>;
        setJsonPath(payload, mirror.jsonPath, substitute(mirror.format, item.latest!));
        await writeFile(mirrorPath, `${JSON.stringify(payload, null, 2)}\n`);
      }
    }
    await writeFile(dockerfilePath, dockerfile);
  }
}
