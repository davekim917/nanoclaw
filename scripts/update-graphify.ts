#!/usr/bin/env bun
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isStableVersion, latestStableGitHubRelease, latestStablePyPiVersion } from '../src/container-updates.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'container/graphify-integration.json');
const LOCK_PATH = path.join(ROOT, 'container/graphify-requirements.lock');
const AUDIT_PATH = path.join(ROOT, 'container/graphify-wheel-audit.json');
const ENABLED_EXTRAS = ['pdf', 'office', 'sql', 'terraform'] as const;
const SEMANTIC_SURFACE_PATHS = {
  'codex-extraction-spec': 'graphify/skills/codex/references/extraction-spec.md',
  detector: 'graphify/detect.py',
  extractor: 'graphify/extract.py',
  'codex-watch': 'graphify/skills/codex/references/add-watch.md',
  watcher: 'graphify/watch.py',
  'codex-transcribe': 'graphify/skills/codex/references/transcribe.md',
  transcriber: 'graphify/transcribe.py',
  'inert-wrapper': 'graphify/llm.py',
} as const;

function graphifyRequirement(version: string): string {
  return `graphifyy[${ENABLED_EXTRAS.join(',')}]==${version}`;
}

interface SemanticSurface {
  path: string;
  sha256: string;
}

interface IntegrationManifest {
  schemaVersion: 1;
  package: { name: string; version: string; extras: string[] };
  upstream: {
    repo: string;
    tag: string;
    commit: string;
    skillPath: string;
    skillSha256: string;
    semanticSurfaces: Record<string, SemanticSurface>;
  };
  patch: { path: string; sha256: string };
  sourceSha256: Record<string, string>;
  commands: string[];
  upstreamCapabilities: string[];
  capabilities: Array<{ id: string; status: string; note: string }>;
}

interface WheelAudit {
  package: string;
  version: string;
  filename: string;
  sha256: string;
  uploaded_at: string;
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nanoclaw-graphify-updater' },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function validateCapabilities(manifest: IntegrationManifest): void {
  const allowed = new Set(['adopted', 'implemented-differently', 'deferred', 'rejected']);
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw new Error('Graphify capability ledger is empty');
  }
  const ids = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (!capability.id || ids.has(capability.id)) throw new Error(`invalid duplicate capability: ${capability.id}`);
    if (!allowed.has(capability.status)) throw new Error(`unclassified Graphify capability: ${capability.id}`);
    if (!capability.note) throw new Error(`Graphify capability has no review note: ${capability.id}`);
    ids.add(capability.id);
  }
  for (const command of manifest.commands) {
    if (!ids.has(command)) throw new Error(`Graphify command is missing from capability ledger: ${command}`);
  }
  const inventory = new Set(manifest.upstreamCapabilities);
  if (inventory.size !== manifest.upstreamCapabilities.length) {
    throw new Error('Graphify upstream capability inventory contains duplicates');
  }
  for (const capability of inventory) {
    if (!ids.has(capability)) throw new Error(`unclassified Graphify capability: ${capability}`);
  }
  for (const capability of ids) {
    if (!inventory.has(capability)) {
      throw new Error(`Graphify capability is absent from upstream inventory: ${capability}`);
    }
  }
}

async function resolveWheels(version: string, workRoot: string): Promise<WheelAudit[]> {
  const uvPath = process.env.GRAPHIFY_UV_BIN ?? 'uv';
  const inputPath = path.join(workRoot, 'requirements.in');
  const compiledPath = path.join(workRoot, 'requirements.txt');
  const requirement = graphifyRequirement(version);
  await writeFile(inputPath, `${requirement}\n`);
  await execFileAsync(
    uvPath,
    [
      'pip',
      'compile',
      '--python-version',
      '3.11',
      '--python-platform',
      'aarch64-manylinux2014',
      '--only-binary=:all:',
      '--prerelease',
      'disallow',
      '--resolution',
      'highest',
      '--generate-hashes',
      '--no-annotate',
      '--no-header',
      '--cache-dir',
      path.join(workRoot, 'uv-cache'),
      '--output-file',
      compiledPath,
      inputPath,
    ],
    { cwd: workRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const wheelhouse = path.join(workRoot, 'wheelhouse');
  await execFileAsync('mkdir', ['-p', wheelhouse]);
  await execFileAsync(
    'python3',
    [
      '-m',
      'pip',
      'download',
      '--disable-pip-version-check',
      '--no-cache-dir',
      '--only-binary=:all:',
      '--platform',
      'manylinux2014_aarch64',
      '--python-version',
      '3.11',
      '--implementation',
      'cp',
      '--abi',
      'cp311',
      '--abi',
      'abi3',
      '--abi',
      'none',
      '--dest',
      wheelhouse,
      requirement,
    ],
    { cwd: workRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const filenames = (await readdir(wheelhouse)).sort();
  if (filenames.length === 0 || filenames.some((filename) => !filename.endsWith('.whl'))) {
    throw new Error('Graphify closure is not wheel-only for CPython 3.11 ARM64');
  }
  const wheels: WheelAudit[] = [];
  for (const filename of filenames) {
    const match = filename.match(/^(.+?)-([0-9][^-]*)-/);
    if (!match) throw new Error(`cannot parse wheel filename: ${filename}`);
    const packageName = match[1].replaceAll('_', '-');
    const packageVersion = match[2];
    if (!isStableVersion(packageVersion)) throw new Error(`prerelease wheel selected: ${filename}`);
    const metadata = await fetchJson(
      `https://pypi.org/pypi/${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}/json`,
    );
    const file = metadata.urls?.find((candidate: any) => candidate.filename === filename);
    if (!file) throw new Error(`PyPI metadata does not contain selected wheel: ${filename}`);
    if (file.yanked) throw new Error(`selected wheel is yanked: ${filename}`);
    const content = await readFile(path.join(wheelhouse, filename));
    const digest = sha256(content);
    if (file.digests?.sha256 !== digest) throw new Error(`wheel hash mismatch: ${filename}`);
    wheels.push({
      package: packageName,
      version: packageVersion,
      filename,
      sha256: digest,
      uploaded_at: file.upload_time_iso_8601,
    });
  }
  wheels.sort((left, right) => left.package.localeCompare(right.package));
  const compiled = await readFile(compiledPath, 'utf8');
  const compiledVersions = new Map(
    [...compiled.matchAll(/^([A-Za-z0-9_.-]+)==([^\s\\]+).*$/gm)].map((match) => [
      match[1].replaceAll('_', '-').toLowerCase(),
      match[2],
    ]),
  );
  const selectedVersions = new Map(wheels.map((wheel) => [wheel.package.toLowerCase(), wheel.version]));
  if (JSON.stringify([...compiledVersions].sort()) !== JSON.stringify([...selectedVersions].sort())) {
    throw new Error('uv resolution and downloaded ARM64 wheel closure disagree');
  }
  return wheels;
}

function renderLock(wheels: WheelAudit[], uvVersion: string): string {
  return [
    `# Generated by ${uvVersion} for CPython 3.11 on manylinux2014 aarch64.`,
    `# Latest-stable, wheel-only graphifyy dependency set. Enabled extras: ${ENABLED_EXTRAS.join(', ')}.`,
    ...wheels.map((wheel) => `${wheel.package}==${wheel.version} --hash=sha256:${wheel.sha256} # ${wheel.filename}`),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const requested = valueAfter(args, '--version');
  if (!requested || !isStableVersion(requested)) {
    throw new Error(
      'usage: bun scripts/update-graphify.ts --version <stable-version> ' +
        '[--reviewed-skill-sha <sha> --reviewed-surface-sha <id=sha> --capability-review <json>]',
    );
  }
  const current = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as IntegrationManifest;
  if (JSON.stringify(current.package.extras) !== JSON.stringify([...ENABLED_EXTRAS])) {
    throw new Error(`Graphify manifest extras must be exactly: ${ENABLED_EXTRAS.join(', ')}`);
  }
  validateCapabilities(current);

  const pypi = await fetchJson(`https://pypi.org/pypi/${current.package.name}/json`);
  const latestPyPi = latestStablePyPiVersion(pypi);
  if (latestPyPi.status !== 'resolved' || latestPyPi.version !== requested) {
    throw new Error(`requested Graphify ${requested} is not the latest stable wheel release`);
  }
  const releases = await fetchJson(`https://api.github.com/repos/${current.upstream.repo}/releases?per_page=100`);
  const latestRelease = latestStableGitHubRelease(releases);
  if (latestRelease.status !== 'resolved' || latestRelease.version !== requested || !latestRelease.tag) {
    throw new Error(`GitHub latest stable release does not match graphifyy ${requested}`);
  }

  const workRoot = await mkdtemp(path.join(tmpdir(), 'nanoclaw-graphify-update-'));
  const upstreamRoot = path.join(workRoot, 'upstream');
  await execFileAsync('git', [
    'clone',
    '--quiet',
    '--depth',
    '1',
    '--branch',
    latestRelease.tag,
    `https://github.com/${current.upstream.repo}.git`,
    upstreamRoot,
  ]);
  const { stdout: commitOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: upstreamRoot });
  const commit = commitOutput.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Graphify tag did not resolve to an exact commit');

  const skill = await readFile(path.join(upstreamRoot, current.upstream.skillPath));
  const skillSha = sha256(skill);
  const reviewedSkillSha = valueAfter(args, '--reviewed-skill-sha');
  if (skillSha !== current.upstream.skillSha256 && reviewedSkillSha !== skillSha) {
    throw new Error(
      `Graphify upstream skill drift (${current.upstream.skillSha256} -> ${skillSha}); ` +
        'route this bump to a Graphify-review change with an updated capability ledger',
    );
  }

  const semanticSurfaces: Record<string, SemanticSurface> = {};
  const surfaceDrift: string[] = [];
  for (const [id, relative] of Object.entries(SEMANTIC_SURFACE_PATHS)) {
    const digest = sha256(await readFile(path.join(upstreamRoot, relative)));
    semanticSurfaces[id] = { path: relative, sha256: digest };
    const pinned = current.upstream.semanticSurfaces?.[id];
    if (!pinned || pinned.path !== relative || pinned.sha256 !== digest) surfaceDrift.push(id);
  }
  const reviewedSurfaces = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--reviewed-surface-sha' && args[index + 1]) reviewedSurfaces.add(args[index + 1]);
  }
  const unreviewedSurfaceDrift = surfaceDrift.filter(
    (id) => !reviewedSurfaces.has(`${id}=${semanticSurfaces[id].sha256}`),
  );
  if (unreviewedSurfaceDrift.length > 0) {
    throw new Error(
      `Graphify upstream semantic surface drift (${unreviewedSurfaceDrift.join(', ')}); ` +
        'review each surface and pass --reviewed-surface-sha <id=sha>',
    );
  }

  let upstreamCapabilities = current.upstreamCapabilities;
  let capabilities = current.capabilities;
  const capabilityReviewPath = valueAfter(args, '--capability-review');
  if (skillSha !== current.upstream.skillSha256 || surfaceDrift.length > 0) {
    if (!capabilityReviewPath) throw new Error('changed upstream semantic contract requires --capability-review');
    const review = JSON.parse(await readFile(path.resolve(capabilityReviewPath), 'utf8'));
    if (Array.isArray(review)) {
      capabilities = review;
    } else {
      upstreamCapabilities = review.upstreamCapabilities;
      capabilities = review.capabilities;
    }
  }
  const candidate = { ...current, upstreamCapabilities, capabilities } as IntegrationManifest;
  validateCapabilities(candidate);

  const patchPath = path.join(ROOT, current.patch.path);
  await execFileAsync('git', ['apply', '--check', patchPath], { cwd: upstreamRoot });
  const patchSha = sha256(await readFile(patchPath));
  const sourceSha256: Record<string, string> = {};
  for (const relative of Object.keys(current.sourceSha256).sort()) {
    sourceSha256[relative] = sha256(await readFile(path.join(upstreamRoot, relative)));
  }
  const wheels = await resolveWheels(requested, workRoot);
  const uvPath = process.env.GRAPHIFY_UV_BIN ?? 'uv';
  const { stdout: uvVersionOutput } = await execFileAsync(uvPath, ['--version']);
  const uvVersion = uvVersionOutput.trim();
  const next: IntegrationManifest = {
    ...current,
    package: { ...current.package, version: requested },
    upstream: {
      ...current.upstream,
      tag: latestRelease.tag,
      commit,
      skillSha256: skillSha,
      semanticSurfaces,
    },
    patch: { ...current.patch, sha256: patchSha },
    sourceSha256,
    upstreamCapabilities,
    capabilities,
  };
  const audit = {
    schemaVersion: 1,
    releasePolicy: 'latest-stable',
    uv_version: uvVersion,
    python_version: '3.11',
    platform: 'manylinux2014_aarch64',
    requirement: graphifyRequirement(requested),
    extras: [...ENABLED_EXTRAS],
    generated_at: new Date().toISOString(),
    wheels,
  };

  // All network, compatibility, patch, hash, and capability checks complete
  // before any tracked file is mutated.
  await writeFile(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`);
  await writeFile(LOCK_PATH, renderLock(wheels, uvVersion));
  await writeFile(AUDIT_PATH, `${JSON.stringify(audit, null, 2)}\n`);
  process.stdout.write(`Graphify ${requested} locked at ${latestRelease.tag} (${commit}).\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
