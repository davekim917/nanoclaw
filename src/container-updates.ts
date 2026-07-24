import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Where ~/plugins is mounted inside agent containers (see container-runner.ts). */
export const CONTAINER_PLUGINS_ROOT = '/workspace/plugins';

export type UpdateKind =
  | 'host-dependency'
  | 'bun-dependency'
  | 'dockerfile-pin'
  | 'graphify'
  | 'codex-sync'
  | 'plugin-version';
export type UpdateSurface = 'host' | 'container' | 'bootstrap' | 'plugins';
export type AuditStatus = 'current' | 'outdated' | 'unknown' | 'blocked';

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
}

export interface ReleaseResolved {
  status: 'resolved';
  version: string;
  tag?: string;
  commitish?: string;
}

export interface ReleaseBlocked {
  status: 'blocked';
  reason: string;
}

export type ReleaseResolution = ReleaseResolved | ReleaseBlocked;

interface DockerUpdateSource {
  id: string;
  name: string;
  arg: string;
  source:
    | { kind: 'npm'; package: string }
    | { kind: 'pypi'; package: string }
    | { kind: 'github'; repo: string }
    | { kind: 'github-tags'; repo: string };
  checksums?: Array<{ arg: string; url: string; filename?: string }>;
  mirrors?: Array<{ file: string; jsonPath: string[]; format: string }>;
}

interface PluginUpdateSource {
  id: string;
  name: string;
  /** Plugin dir relative to the plugins root, e.g. `knowledge-work-plugins/data`. */
  dir: string;
  repo: string;
  /** Path to that plugin's manifest inside the upstream repo. */
  manifestPath: string;
  /**
   * Manifest dir inside the local clone. Claude plugins use `.claude-plugin`;
   * Codex-native plugins (openai/role-specific-plugins) use `.codex-plugin`.
   */
  manifestDir?: string;
  /** Upstream branch to compare against (default `main`). */
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

interface GraphifyIntegrationManifest {
  schemaVersion: 2;
  package: { name: string; version: string };
  upstream: { repo: string; tag: string; commit: string };
}

export type JsonFetcher = (url: string) => Promise<unknown>;
export type TextFetcher = (url: string) => Promise<string>;
export type CommandRunner = (command: string[], cwd: string) => Promise<void>;

const PRERELEASE = /(?:^|[._+-])(alpha|beta|rc|pre|preview|dev|nightly|canary|snapshot)\d*(?:$|[._+-])/i;
const COMPACT_PRERELEASE = /\d(?:a|b|rc|dev)\d*$/i;

export function isStableVersion(value: string): boolean {
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
  return 0;
}

export function latestStableNpmVersion(metadata: unknown): ReleaseResolution {
  const latest = (metadata as { 'dist-tags'?: { latest?: unknown } })?.['dist-tags']?.latest;
  if (typeof latest !== 'string') return { status: 'blocked', reason: 'npm metadata has no latest tag' };
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

async function resolveSource(
  source: DockerUpdateSource['source'] | { kind: 'pypi'; package: string },
  fetchJson: JsonFetcher,
): Promise<ReleaseResolution> {
  if (source.kind === 'npm') {
    return latestStableNpmVersion(await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(source.package)}`));
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

async function auditDependencies(
  repoRoot: string,
  relativePackageJson: string,
  kind: 'host-dependency' | 'bun-dependency',
  surface: UpdateSurface,
  fetchJson: JsonFetcher,
): Promise<AuditItem[]> {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, relativePackageJson), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  return Promise.all(
    Object.entries(dependencies).map(async ([name, specifier]) => {
      const current = dependencyVersion(specifier);
      const base: Omit<AuditItem, 'latest' | 'status' | 'detail' | 'tag'> = {
        id: `${kind === 'host-dependency' ? 'host' : 'bun'}:${name}`,
        name,
        kind,
        surface,
        current: current ?? specifier,
        source: 'npm',
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

/**
 * Plugin clones under `~/plugins` are versioned by their `.claude-plugin/plugin.json`
 * `version` field, not by a package registry — so compare the local clone against the
 * same manifest upstream. A bump means `git pull` in the clone.
 *
 * Deliberately per-plugin rather than repo-HEAD: marketplace monorepos
 * (anthropics/knowledge-work-plugins) carry many unrelated plugins, and a commit
 * touching a sibling plugin is not an update to ours.
 */
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
      // Container mount first, then the host clone location.
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
  const [host, bun, sourceText, dockerfile, graphifyText] = await Promise.all([
    auditDependencies(repoRoot, 'package.json', 'host-dependency', 'host', fetchJson),
    auditDependencies(repoRoot, 'container/agent-runner/package.json', 'bun-dependency', 'container', fetchJson),
    readFile(path.join(repoRoot, 'container/update-sources.json'), 'utf8'),
    readFile(path.join(repoRoot, 'container/Dockerfile'), 'utf8'),
    readFile(path.join(repoRoot, 'container/graphify-integration.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(sourceText) as UpdateSourcesManifest;
  if (manifest.schemaVersion !== 1) throw new Error('unsupported container/update-sources.json schema');
  const graphify = JSON.parse(graphifyText) as GraphifyIntegrationManifest;
  if (graphify.schemaVersion !== 2) throw new Error('unsupported Graphify integration manifest schema');

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

  const graphifyBase: Omit<AuditItem, 'latest' | 'status' | 'detail' | 'tag'> = {
    id: 'graphify:graphifyy',
    name: 'graphifyy',
    kind: 'graphify',
    surface: 'container',
    current: graphify.package.version,
    source: 'pypi',
  };
  const graphifyResult = await audited('graphifyy', () =>
    resolveSource({ kind: 'pypi', package: graphify.package.name }, fetchJson),
  );
  const graphifyItem =
    graphifyResult instanceof Error
      ? { ...graphifyBase, latest: null, status: 'unknown' as const, detail: graphifyResult.message }
      : itemFromResolution(graphifyBase, graphifyResult);
  const [codex, plugins] = await Promise.all([
    auditCodexSources(manifest, fetchJson),
    auditPluginVersions(manifest, fetchJson),
  ]);
  return [...host, ...bun, ...docker, graphifyItem, ...codex, ...plugins].sort((a, b) => a.id.localeCompare(b.id));
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
  return lines.join('\n');
}

export function buildScheduledAuditGate(items: AuditItem[]): { wakeAgent: boolean; data: unknown } {
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
  const docker = selected.filter((item) => item.kind === 'dockerfile-pin');
  const graphify = selected.filter((item) => item.kind === 'graphify');

  if (host.length > 0) {
    await updatePackageJson(path.join(repoRoot, 'package.json'), host);
    await run(['pnpm', 'install', '--lockfile-only'], repoRoot);
  }
  if (bun.length > 0) {
    const runnerRoot = path.join(repoRoot, 'container/agent-runner');
    await updatePackageJson(path.join(runnerRoot, 'package.json'), bun);
    await run(['bun', 'install', '--lockfile-only'], runnerRoot);
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
          return { arg: checksum.arg, digest: checksumFromText(content, filename) };
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
  if (graphify.length > 0) {
    await run(['bun', 'scripts/update-graphify.ts', '--version', graphify[0].latest!], repoRoot);
  }
}
