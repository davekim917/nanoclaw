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
const ENGINE_CONTRACT_PATH = path.join(ROOT, 'container/tests/graphify_engine_contract.py');
const ENABLED_EXTRAS = ['pdf', 'office', 'sql', 'terraform'] as const;

function graphifyRequirement(version: string): string {
  return `graphifyy[${ENABLED_EXTRAS.join(',')}]==${version}`;
}

interface CompatibilityPatch {
  path: string;
  sha256: string;
  reason: string;
  removeWhen: string;
}

interface IntegrationManifest {
  schemaVersion: 2;
  package: { name: string; version: string; extras: string[] };
  upstream: { repo: string; tag: string; commit: string };
  compatibilityPatch?: CompatibilityPatch;
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

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const stderr = 'stderr' in error ? String(error.stderr).trim() : '';
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

async function runEngineContract(pythonPath: string): Promise<string | null> {
  try {
    await execFileAsync(pythonPath, [ENGINE_CONTRACT_PATH], {
      cwd: ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    return null;
  } catch (error) {
    return errorText(error);
  }
}

async function verifyEngineCompatibility(
  packageName: string,
  version: string,
  workRoot: string,
  compatibilityPatch: CompatibilityPatch | undefined,
): Promise<CompatibilityPatch | undefined> {
  const uvPath = process.env.GRAPHIFY_UV_BIN ?? 'uv';
  const venvPath = path.join(workRoot, 'contract-venv');
  const pythonPath = path.join(venvPath, 'bin', 'python');
  const cachePath = path.join(workRoot, 'contract-uv-cache');
  await execFileAsync(uvPath, ['venv', '--python', 'python3', '--seed', '--cache-dir', cachePath, venvPath], {
    cwd: workRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  await execFileAsync(
    uvPath,
    [
      'pip',
      'install',
      '--python',
      pythonPath,
      '--prerelease',
      'disallow',
      '--only-binary=:all:',
      '--cache-dir',
      cachePath,
      `${packageName}==${version}`,
    ],
    { cwd: workRoot, maxBuffer: 16 * 1024 * 1024 },
  );

  const unmodifiedFailure = await runEngineContract(pythonPath);
  if (unmodifiedFailure === null) return undefined;
  if (!compatibilityPatch) {
    throw new Error(`Graphify ${version} fails the engine behavior contract:\n${unmodifiedFailure}`);
  }

  const patchPath = path.join(ROOT, compatibilityPatch.path);
  const patchSha = sha256(await readFile(patchPath));
  if (patchSha !== compatibilityPatch.sha256) {
    throw new Error(`Graphify compatibility patch hash mismatch (${compatibilityPatch.sha256} -> ${patchSha})`);
  }
  const { stdout: sitePackagesOutput } = await execFileAsync(
    pythonPath,
    ['-c', 'import site; print(site.getsitepackages()[0])'],
    { cwd: workRoot },
  );
  const sitePackages = sitePackagesOutput.trim();
  try {
    await execFileAsync('git', ['apply', '--check', patchPath], { cwd: sitePackages });
    await execFileAsync('git', ['apply', patchPath], { cwd: sitePackages });
  } catch (error) {
    throw new Error(
      `Graphify ${version} fails the engine behavior contract and the compatibility patch no longer applies:\n` +
        `${unmodifiedFailure}\n${errorText(error)}`,
    );
  }
  const patchedFailure = await runEngineContract(pythonPath);
  if (patchedFailure !== null) {
    throw new Error(
      `Graphify ${version} still fails the engine behavior contract after the compatibility patch:\n${patchedFailure}`,
    );
  }
  return compatibilityPatch;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const requested = valueAfter(args, '--version');
  if (!requested || !isStableVersion(requested)) {
    throw new Error('usage: bun scripts/update-graphify.ts --version <stable-version>');
  }
  const current = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as IntegrationManifest;
  if (current.schemaVersion !== 2) throw new Error('unsupported Graphify integration manifest schema');
  if (current.package.name !== 'graphifyy') throw new Error('unexpected Graphify package name');
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
  const wheels = await resolveWheels(requested, workRoot);
  const compatibilityPatch = await verifyEngineCompatibility(
    current.package.name,
    requested,
    workRoot,
    current.compatibilityPatch,
  );
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
    },
    ...(compatibilityPatch ? { compatibilityPatch } : { compatibilityPatch: undefined }),
  };
  validateCapabilities(next);
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
  const compatibility = compatibilityPatch ? 'compatibility patch remains active' : 'unmodified upstream passed';
  process.stdout.write(`Graphify ${requested} locked at ${latestRelease.tag} (${commit}); ${compatibility}.\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
