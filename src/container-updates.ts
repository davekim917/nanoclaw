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
  | 'remotion-dependency'
  | 'dockerfile-pin'
  | 'plugin-version';
export type UpdateSurface = 'host' | 'container' | 'plugins';
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
  /** Pin for this dependency in `upstream/main`, when it exists there. */
  upstreamPin?: string;
  /**
   * The most recent `upstream/main` merge resolved this dependency KEEP-OURS —
   * it kept our pin over a different upstream one. That is a standing decision,
   * so a bump past it must be raised explicitly rather than applied silently.
   */
  heldByMerge?: boolean;
  /**
   * This dependency is one half of a client/server pair with something running
   * locally. Names the component that must move in the SAME change. Such pairs
   * share a wire contract no type or unit test can see, so they can only be
   * validated by calling the running service.
   */
  pairedWith?: string;
}

/**
 * Dependencies that are one half of a client/server pair with a locally-running
 * component. Keyed by package name; the value names what must move with it.
 *
 * Exists because #135 bumped @onecli-sh/sdk ^0.5.0 -> ^2.8.0 and took the whole
 * fleet down for ~1h. Both majors export the same methods, only the HTTP path
 * moved (/api -> /v1), so the build and the full test suite passed on the broken
 * version — nothing but a live call could have caught it.
 */
export const LOCAL_SERVICE_PAIRS: Readonly<Record<string, string>> = {
  '@onecli-sh/sdk':
    'the OneCLI gateway container — 0.5.x calls /api/*, 2.x calls /v1/*. Upgrade the gateway in the same change and verify with a real call (e.g. getGatewaySkill()), not a build.',
};

/** Per-dependency policy derived from upstream and from merge history. */
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

/**
 * Derive per-dependency upstream policy from manifest texts. Pure on purpose —
 * the git plumbing lives in readUpstreamPolicy so this stays testable with
 * fixtures.
 *
 * `keptOurs` is the load-bearing signal: at the merge commit M, the dependency
 * resolved to OUR side (M matches M^1) while upstream's side (M^2) differed.
 * That is a deliberate hold. #135 bumped @onecli-sh/sdk five hours after merge
 * ceb3fcd1 had kept ^0.5.0 over upstream's 2.2.1, and nothing connected the two.
 */
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
    // Only claim keep-ours when all three merge sides are known for this dep and
    // the two sides genuinely disagreed. A merge with no conflict on this line
    // carries no decision.
    const haveMergeSides = result[name] !== undefined && ours[name] !== undefined && theirs[name] !== undefined;
    if (haveMergeSides && ours[name] !== theirs[name] && result[name] === ours[name]) {
      entry.keptOurs = true;
    }
    if (entry.upstreamPin !== undefined || entry.keptOurs) policy.set(name, entry);
  }
  return policy;
}

/**
 * Host-computed snapshot of readUpstreamPolicy's output, keyed by the
 * relative manifest path it was derived for. Exists because the audit's two
 * consumers (the weekly precheck and /update-container) run INSIDE the agent
 * container against /workspace/project — a selective read-only bind-mount
 * allowlist with no `.git` — so the git derivation below has never worked
 * where it actually runs. The host checkout's git is fine; only the
 * container view of it is blind. See writeUpstreamPolicySnapshot.
 */
interface UpstreamPolicySnapshot {
  schemaVersion: number;
  generatedAt: string;
  manifests: Record<string, Record<string, UpstreamPolicy>>;
}

const UPSTREAM_POLICY_SCHEMA_VERSION = 1;
const UPSTREAM_POLICY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Manifests the snapshot covers — kept in lockstep with auditRepository's audited manifests. */
const UPSTREAM_POLICY_MANIFESTS = ['package.json', 'container/agent-runner/package.json'];

function upstreamPolicySnapshotPath(repoRoot: string): string {
  return process.env.NANOCLAW_UPSTREAM_POLICY || path.join(repoRoot, '.upstream-policy.json');
}

/** Load + validate the snapshot. Any problem (missing, unparseable, wrong schema, stale) yields null — fail open. */
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
 * Read the manifest at several revisions and derive policy via git alone —
 * no snapshot fallback. Fails OPEN: any git problem (no upstream remote,
 * shallow clone, never merged) yields an empty map. Kept separate from
 * readUpstreamPolicy so writeUpstreamPolicySnapshot never launders a stale
 * snapshot back into "fresh" output by reading its own fallback.
 *
 * Also reports whether `upstream/main` itself was reachable. That is NOT the
 * same question as "is the returned map non-empty": a plain `git clone` of
 * this repo carries the FULL commit history (including the upstream-merge
 * commit) but no `upstream` remote, so `git log --merges --grep=...` still
 * finds the merge and yields `heldByMerge` entries even though `upstream/main`
 * can't resolve — a non-empty map with every `upstreamPin` missing. Gating
 * the snapshot fallback on map emptiness alone would keep that half-signal
 * instead of the complete host-computed one.
 */
async function readUpstreamPolicyFromGit(
  repoRoot: string,
  relativeManifest: string,
): Promise<{ policy: Map<string, UpstreamPolicy>; upstreamReachable: boolean }> {
  const show = async (rev: string): Promise<string | null> => {
    try {
      // timeout: a wedged git (e.g. a held .git/index.lock from concurrent
      // activity, which this repo sees a lot of) must not hang host boot or
      // the /update-container interaction ack forever. Rejection lands in
      // this catch and fails open exactly like any other git error.
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

  // timeout: same wedged-git concern as `show` above.
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

/**
 * Read the manifest at several revisions and derive policy. Fails OPEN: any git
 * problem (no upstream remote, shallow clone, never merged) yields an empty map
 * so the audit still runs — UNLESS a fresh host-computed snapshot is available,
 * in which case that fills the gap instead of surfacing as "signal unavailable".
 */
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
 * Compute the GIT-ONLY derivation for every audited manifest and write the
 * result to `outPath`. Run once at host startup (git works on the host) and
 * again before each interactive /update-container invocation, so containers
 * — which never have `.git` — read a recent answer instead of going dark.
 * Deliberately bypasses readUpstreamPolicy's snapshot fallback: if git yields
 * nothing this round, the snapshot must say so (empty map, honest
 * provenance), never re-stamp a prior snapshot's data as newly generated.
 *
 * Writes with fs.writeFile (truncate in place), NOT write-to-temp-then-rename:
 * outPath is bind-mounted read-only into already-running containers, and a
 * rename swaps the inode backing the mount, so a container that already has
 * the file open (or whose bind mount resolved the old inode) would keep
 * seeing stale content indefinitely. Truncating in place mutates the same
 * inode the mount points at.
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

/**
 * Cheap provenance check for what readUpstreamPolicy would answer with, for
 * reporting in the audit envelope — never re-runs the heavy git derivation.
 */
export async function describeUpstreamPolicy(
  repoRoot: string,
): Promise<{ source: 'git' | 'snapshot' | 'unavailable'; generatedAt: string | null }> {
  // timeout: same wedged-git concern as readUpstreamPolicyFromGit — this runs
  // on the interactive /update-container path and must not stall the ack.
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
  plugins?: PluginUpdateSource[];
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

async function resolveSource(source: DockerUpdateSource['source'], fetchJson: JsonFetcher): Promise<ReleaseResolution> {
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

/** id prefix per dependency manifest — every manifest the audit scans needs one. */
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
  const [host, bun, remotion, sourceText, dockerfile] = await Promise.all([
    auditDependencies(repoRoot, 'package.json', 'host-dependency', 'host', fetchJson),
    auditDependencies(repoRoot, 'container/agent-runner/package.json', 'bun-dependency', 'container', fetchJson),
    // Remotion video runtime baked at /opt/remotion. A third dependency
    // manifest that the audit would otherwise never see — an unaudited
    // manifest rots silently, which is the whole failure this tool exists to
    // prevent.
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

  const plugins = await auditPluginVersions(manifest, fetchJson);
  return [...host, ...bun, ...remotion, ...docker, ...plugins].sort((a, b) => a.id.localeCompare(b.id));
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

  // Constraints that must be READ, not inferred. These exist because #135 passed
  // every gate — build green, tests green, identical method names — and still
  // took the fleet down. Surface them next to the versions so an approval can't
  // be given without seeing them.
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
    // --ignore-workspace is REQUIRED: the repo root's pnpm-workspace.yaml
    // otherwise makes pnpm resolve against the host workspace and refuse to
    // write a nested lockfile, leaving package.json bumped against a stale
    // lock and the Dockerfile's --frozen-lockfile install failing at build.
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
}
