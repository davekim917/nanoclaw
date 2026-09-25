/**
 * Explicit, host-owned read access from one workgroup to another.
 *
 * The policy lives below DATA_DIR, outside every agent-writable group folder.
 * It names workgroup IDs from the central DB; no directory name supplied by an
 * agent or policy can be used as an arbitrary host-path segment.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getDb } from './db/connection.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

export const WORKGROUP_READ_ACCESS_POLICY_PATH = path.join(DATA_DIR, 'workgroup-read-access.json');
const WORKGROUP_READ_ACCESS_CONTAINER_ROOT = '/workspace/extra/work';
const WORKGROUP_READ_ACCESS_RELATIVE_ROOT = 'work';

type WorkgroupReadAccessMode = 'all' | 'archives';

interface WorkgroupReadAccessGrant {
  mode: WorkgroupReadAccessMode;
  sources: '*' | string[];
}

interface WorkgroupReadAccessPolicy {
  version: 1;
  recipients: Record<string, WorkgroupReadAccessGrant>;
}

interface WorkgroupReadAccessRequest {
  hostPath: string;
  containerPath: string;
  readonly: true;
}

export interface ResolvedWorkgroupReadAccess {
  recipientId: string;
  grants: Array<{ sourceId: string; mode: WorkgroupReadAccessMode }>;
  requests: WorkgroupReadAccessRequest[];
}

const WORKGROUP_ID_RE = /^[a-z][a-z0-9-]*$/;

function fail(message: string): never {
  throw new Error(`Invalid workgroup read-access policy at ${WORKGROUP_READ_ACCESS_POLICY_PATH}: ${message}`);
}

function assertWorkgroupId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !WORKGROUP_ID_RE.test(value)) {
    fail(`${label} must be a lowercase workgroup slug`);
  }
}

function parseGrant(value: unknown, recipientId: string): WorkgroupReadAccessGrant {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`recipient ${JSON.stringify(recipientId)} must be an object`);
  }
  const grant = value as Record<string, unknown>;
  if (Object.keys(grant).some((key) => key !== 'mode' && key !== 'sources')) {
    fail(`recipient ${JSON.stringify(recipientId)} may contain only mode and sources`);
  }
  if (grant.mode !== 'all' && grant.mode !== 'archives') {
    fail(`recipient ${JSON.stringify(recipientId)} mode must be "all" or "archives"`);
  }
  if (grant.sources === '*') return { mode: grant.mode, sources: '*' };
  if (!Array.isArray(grant.sources) || grant.sources.length === 0) {
    fail(`recipient ${JSON.stringify(recipientId)} sources must be "*" or a non-empty array`);
  }
  const sources: string[] = [];
  for (const source of grant.sources) {
    assertWorkgroupId(source, `recipient ${JSON.stringify(recipientId)} source`);
    if (sources.includes(source))
      fail(`recipient ${JSON.stringify(recipientId)} sources must not repeat ${JSON.stringify(source)}`);
    sources.push(source);
  }
  return { mode: grant.mode, sources };
}

function parsePolicy(contents: string): WorkgroupReadAccessPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    fail(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('top level must be an object');
  const policy = raw as Record<string, unknown>;
  if (policy.version !== 1) fail('version must be 1');
  if (policy.recipients === null || typeof policy.recipients !== 'object' || Array.isArray(policy.recipients)) {
    fail('recipients must be an object keyed by workgroup ID');
  }
  if (Object.keys(policy).some((key) => key !== 'version' && key !== 'recipients')) {
    fail('only version and recipients are allowed at the top level');
  }
  const recipients: Record<string, WorkgroupReadAccessGrant> = {};
  for (const [recipientId, grant] of Object.entries(policy.recipients as Record<string, unknown>)) {
    assertWorkgroupId(recipientId, 'recipient ID');
    recipients[recipientId] = parseGrant(grant, recipientId);
  }
  return { version: 1, recipients };
}

function registeredWorkgroups(): Promise<string[]> {
  return getDb()
    .all<{ id: string }>('SELECT id FROM workgroups ORDER BY id')
    .then((rows) => rows.map((row) => row.id));
}

function realMountSourceOrNull(hostPath: string, trustedRoot: string, directoryOnly: boolean): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(hostPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Could not inspect workgroup read-access source ${hostPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  // The mount source itself must be an actual file or directory. Deliberately do not
  // resolve or add targets of symlinks inside it: a link is data, never a
  // cross-workgroup grant to its host target.
  if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink() || (directoryOnly && !stat.isDirectory())) {
    throw new Error(
      `Workgroup read-access source must be a real ${directoryOnly ? 'directory' : 'file or directory'}: ${hostPath}`,
    );
  }
  const realPath = fs.realpathSync(hostPath);
  const realRoot = fs.realpathSync(trustedRoot);
  const relative = path.relative(realRoot, realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Workgroup read-access source escapes its fixed host root: ${hostPath}`);
  }
  return realPath;
}

function realDirectoryOrNull(hostPath: string, trustedRoot: string): string | null {
  return realMountSourceOrNull(hostPath, trustedRoot, true);
}

function addDirectoryRequest(
  requests: WorkgroupReadAccessRequest[],
  hostPath: string,
  containerPath: string,
  trustedRoot: string,
): void {
  const realPath = realDirectoryOrNull(hostPath, trustedRoot);
  if (realPath !== null) requests.push({ hostPath: realPath, containerPath, readonly: true });
}

function requestPaths(sourceId: string, mode: WorkgroupReadAccessMode): WorkgroupReadAccessRequest[] {
  const requests: WorkgroupReadAccessRequest[] = [];
  const workgroupsRoot = path.join(DATA_DIR, 'workgroups');
  const workgroupRoot = path.join(DATA_DIR, 'workgroups', sourceId);
  // validateAdditionalMounts owns the `/workspace/extra/` prefix and accepts
  // only relative paths. Keep requests in that form; validated mounts below
  // carry the final absolute container path.
  const containerRoot = `${WORKGROUP_READ_ACCESS_RELATIVE_ROOT}/${sourceId}`;
  if (mode === 'archives') {
    const realWorkgroupRoot = realDirectoryOrNull(workgroupRoot, workgroupsRoot);
    if (realWorkgroupRoot === null) return requests;
    addDirectoryRequest(requests, path.join(workgroupRoot, 'memory'), `${containerRoot}/memory`, realWorkgroupRoot);
    addDirectoryRequest(
      requests,
      path.join(workgroupRoot, 'conversations'),
      `${containerRoot}/conversations`,
      realWorkgroupRoot,
    );
    return requests;
  }

  // Keep the entire workgroup tree available as one bounded, read-only mount.
  // It lives below `files` so the separately stored project roots can sit next
  // to memory/conversations without nested mounts under a read-only parent.
  addDirectoryRequest(requests, workgroupRoot, `${containerRoot}/files`, workgroupsRoot);
  // Current project locations are separate host-owned roots, so they are not
  // silently omitted by an "all" grant. These fixed paths are never derived
  // from a policy-provided path.
  const repositoriesRoot = path.join(DATA_DIR, 'repositories');
  addDirectoryRequest(
    requests,
    path.join(repositoriesRoot, sourceId),
    `${containerRoot}/repositories`,
    repositoriesRoot,
  );
  const topicsRoot = path.join(DATA_DIR, 'v2-topics');
  addDirectoryRequest(requests, path.join(topicsRoot, sourceId), `${containerRoot}/topics`, topicsRoot);
  const legacyThreadsRoot = path.join(DATA_DIR, 'v2-threads');
  addDirectoryRequest(
    requests,
    path.join(legacyThreadsRoot, `wg-${sourceId}`),
    `${containerRoot}/legacy-threads`,
    legacyThreadsRoot,
  );
  // Preserve the historic archive paths for agent tools and existing operator
  // configuration. They intentionally duplicate directories visible below
  // `files`; both binds are read-only and neither follows source symlinks.
  const realWorkgroupRoot = realDirectoryOrNull(workgroupRoot, workgroupsRoot);
  if (realWorkgroupRoot !== null) {
    addDirectoryRequest(requests, path.join(workgroupRoot, 'memory'), `${containerRoot}/memory`, realWorkgroupRoot);
    addDirectoryRequest(
      requests,
      path.join(workgroupRoot, 'conversations'),
      `${containerRoot}/conversations`,
      realWorkgroupRoot,
    );
  }
  return requests;
}

/**
 * Load and validate the policy for a spawn-resolved recipient workgroup.
 * Missing policy is the safe default: no cross-workgroup mounts. Any present
 * but malformed policy aborts the spawn rather than retaining stale access.
 */
export async function resolveWorkgroupReadAccess(recipientId: string): Promise<ResolvedWorkgroupReadAccess | null> {
  let contents: string;
  try {
    contents = fs.readFileSync(WORKGROUP_READ_ACCESS_POLICY_PATH, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Could not read workgroup read-access policy at ${WORKGROUP_READ_ACCESS_POLICY_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const policy = parsePolicy(contents);
  assertWorkgroupId(recipientId, 'spawn-resolved recipient ID');
  const knownIds = new Set(await registeredWorkgroups());
  for (const recipient of Object.keys(policy.recipients)) {
    if (!knownIds.has(recipient)) fail(`recipient ${JSON.stringify(recipient)} is not a registered workgroup`);
  }
  for (const [_configuredRecipient, configuredGrant] of Object.entries(policy.recipients)) {
    if (configuredGrant.sources === '*') continue;
    for (const sourceId of configuredGrant.sources) {
      if (!knownIds.has(sourceId)) fail(`source ${JSON.stringify(sourceId)} is not a registered workgroup`);
    }
  }
  for (const sourceId of knownIds) assertWorkgroupId(sourceId, 'registered workgroup ID');

  const grant = policy.recipients[recipientId];
  if (!grant) return null;
  const sourceIds = grant.sources === '*' ? [...knownIds].sort() : grant.sources;
  const requests = sourceIds.flatMap((sourceId) => requestPaths(sourceId, grant.mode));
  return {
    recipientId,
    grants: sourceIds.map((sourceId) => ({ sourceId, mode: grant.mode })),
    requests,
  };
}

/** The provider-neutral discovery text generated from the same resolved grant as the mounts. */
export function workgroupReadAccessInstructions(
  access: ResolvedWorkgroupReadAccess | null,
  mounted: readonly Pick<VolumeMount, 'containerPath' | 'readonly'>[],
): string | null {
  if (!access) return null;
  const mountedSources = new Set<string>();
  for (const mount of mounted) {
    if (!mount.readonly || !mount.containerPath.startsWith(`${WORKGROUP_READ_ACCESS_CONTAINER_ROOT}/`)) continue;
    const source = mount.containerPath.slice(`${WORKGROUP_READ_ACCESS_CONTAINER_ROOT}/`.length).split('/')[0];
    if (source) mountedSources.add(source);
  }
  if (mountedSources.size === 0) return null;
  const paths = mounted
    .filter((mount) => mount.readonly && mount.containerPath.startsWith(`${WORKGROUP_READ_ACCESS_CONTAINER_ROOT}/`))
    .map((mount) => `\`${mount.containerPath}\``)
    .sort()
    .join(', ');
  return [
    '## Cross-workgroup read access',
    '',
    `Host policy grants this workgroup read-only access under \`${WORKGROUP_READ_ACCESS_CONTAINER_ROOT}/<workgroup-id>/\`. Mounted paths: ${paths}.`,
    'Use only paths that are mounted; this grant does not make a symlink target outside those mounts accessible.',
  ].join('\n');
}

function isWithin(parent: string, child: string, separator: string): string | null {
  const relative = separator === '/' ? path.posix.relative(parent, child) : path.relative(parent, child);
  if (relative === '') return '';
  return !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
}

/**
 * A configured additional mount may use the shared namespace only when it is
 * an exact read-only overlay of an already granted source. This keeps legacy
 * archive entries harmless while making the host policy the only authority
 * capable of adding a workgroup source.
 */
export function isDuplicateWorkgroupReadAccessMount(
  candidate: Pick<VolumeMount, 'hostPath' | 'containerPath' | 'readonly'>,
  policyMounts: readonly Pick<VolumeMount, 'hostPath' | 'containerPath' | 'readonly'>[],
): boolean {
  if (!candidate.readonly) return false;
  for (const policy of policyMounts) {
    if (!policy.readonly) continue;
    const hostRelative = isWithin(policy.hostPath, candidate.hostPath, path.sep);
    const containerRelative = isWithin(
      path.posix.normalize(policy.containerPath),
      path.posix.normalize(candidate.containerPath),
      '/',
    );
    if (hostRelative === null || containerRelative === null) continue;
    if (hostRelative.split(path.sep).join('/') === containerRelative) return true;
  }
  return false;
}

export function isWorkgroupReadAccessNamespace(containerPath: string): boolean {
  const normalized = path.posix.normalize(containerPath);
  return (
    normalized === WORKGROUP_READ_ACCESS_CONTAINER_ROOT ||
    normalized.startsWith(`${WORKGROUP_READ_ACCESS_CONTAINER_ROOT}/`)
  );
}

/**
 * Last-moment pathname check before Docker receives a policy mount. Docker
 * cannot bind an opened file descriptor, so this deliberately reduces rather
 * than claims to eliminate the final kernel pathname race.
 */
export function assertWorkgroupReadAccessMountStable(mount: Pick<VolumeMount, 'hostPath'>): void {
  let stat: fs.Stats;
  let realPath: string;
  try {
    stat = fs.lstatSync(mount.hostPath);
    realPath = fs.realpathSync(mount.hostPath);
  } catch (error) {
    throw new Error(`Workgroup read-access mount source vanished before spawn: ${mount.hostPath}`, { cause: error });
  }
  if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink() || realPath !== mount.hostPath) {
    throw new Error(`Workgroup read-access mount source changed between validation and spawn: ${mount.hostPath}`);
  }
}
