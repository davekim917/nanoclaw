/**
 * Workgroup subpaths that containers may read but never write.
 *
 * The workgroup tree is bind-mounted read-write into every sibling container
 * (buildMounts, src/container-runner.ts). Anything the host itself executes
 * from inside that tree — a systemd unit's script, a host-gated task script —
 * is therefore editable by every agent in the workgroup. A subpath declared
 * here is bound read-only on top of every writable mount that exposes it, so
 * agents can still read and run it but only an operator on the host can
 * change it.
 *
 * Policy file: data/workgroup-readonly-paths.json
 *   { "version": 1, "workgroups": { "<workgroup id>": ["<relative subpath>", ...] } }
 *
 * No file means nothing is protected. A file that exists but does not parse
 * throws, like data/workgroup-read-access.json and data/plugin-scopes.json:
 * the spawn aborts rather than silently dropping a protection. A declared
 * subpath that does not exist yet is skipped.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';
import { workgroupSharedDir } from './modules/workgroup/shared-dirs.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

const POLICY_FILE = 'workgroup-readonly-paths.json';

// Same slug rule as WORKGROUP_ID_RE in src/workgroup-read-access.ts.
const WORKGROUP_ID_RE = /^[a-z][a-z0-9-]*$/;
// One path segment: no separators, NUL, "." or "..".
const SEGMENT_RE = /^(?!\.\.?$)[^/\\\0]+$/;

function fail(message: string): never {
  throw new Error(`Invalid workgroup read-only path policy (data/${POLICY_FILE}): ${message}`);
}

export function parseWorkgroupReadonlyPaths(contents: string): ReadonlyMap<string, readonly string[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    fail(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('top level must be an object');
  const policy = raw as Record<string, unknown>;
  if (Object.keys(policy).some((key) => key !== 'version' && key !== 'workgroups')) {
    fail('only version and workgroups are allowed at the top level');
  }
  if (policy.version !== 1) fail('version must be 1');
  if (policy.workgroups === null || typeof policy.workgroups !== 'object' || Array.isArray(policy.workgroups)) {
    fail('workgroups must be an object keyed by workgroup ID');
  }
  const declared = new Map<string, readonly string[]>();
  for (const [workgroupId, subpaths] of Object.entries(policy.workgroups as Record<string, unknown>)) {
    if (!WORKGROUP_ID_RE.test(workgroupId)) fail(`${JSON.stringify(workgroupId)} is not a workgroup slug`);
    if (!Array.isArray(subpaths)) fail(`workgroup ${JSON.stringify(workgroupId)} must map to an array of subpaths`);
    const valid: string[] = [];
    for (const subpath of subpaths) {
      if (typeof subpath !== 'string' || subpath.length === 0 || !subpath.split('/').every((s) => SEGMENT_RE.test(s))) {
        fail(
          `workgroup ${JSON.stringify(workgroupId)} lists ${JSON.stringify(subpath)}, which is not a relative path inside the workgroup`,
        );
      }
      valid.push(subpath);
    }
    declared.set(workgroupId, valid);
  }
  return declared;
}

/**
 * Real host paths of every declared subpath that exists, across all
 * workgroups: a mount of one workgroup's tree into another group's container
 * must not expose it writable either.
 */
export function readWorkgroupReadonlyPaths(dataDir: string = DATA_DIR): string[] {
  const policyPath = path.join(dataDir, POLICY_FILE);
  let contents: string;
  try {
    contents = fs.readFileSync(policyPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const resolved: string[] = [];
  for (const [workgroupId, subpaths] of parseWorkgroupReadonlyPaths(contents)) {
    const root = workgroupSharedDir(workgroupId, dataDir);
    for (const subpath of subpaths) {
      let real: string;
      let realRoot: string;
      try {
        real = fs.realpathSync(path.join(root, subpath));
        realRoot = fs.realpathSync(root);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw error;
      }
      // A symlink anywhere on the way is replaceable by whoever can write its
      // parent, so a bind of its current target would protect a path the host
      // may no longer be reading.
      if (real !== path.join(realRoot, subpath)) {
        log.warn('Workgroup read-only path traverses a symlink; not protected', { workgroupId, subpath, real });
        continue;
      }
      resolved.push(real);
    }
  }
  return resolved;
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return path.resolve(p);
    throw error;
  }
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent + path.sep);
}

/**
 * Re-mount each protected path read-only wherever a writable mount exposes it.
 * A writable mount whose source sits at or under a protected path becomes
 * read-only itself; one whose source contains a protected path gains a nested
 * read-only bind after it.
 *
 * A nested read-only bind is not enough on its own: from inside the container
 * the writable parent directory can be renamed away and the path recreated,
 * and the host then runs whatever is in the new directory. Every directory
 * between the writable mount and the protected path is therefore bound onto
 * itself, read-write, which makes it a mount point the container can neither
 * rename nor remove.
 */
export function protectReadonlyHostPaths(mounts: VolumeMount[], protectedPaths: readonly string[]): VolumeMount[] {
  if (protectedPaths.length === 0) return mounts;
  const covered = (hostPath: string): boolean =>
    protectedPaths.some((target) => hostPath === target || isInside(hostPath, target));
  const result = mounts.map((mount) => ({ ...mount }));
  for (const mount of result) {
    if (!mount.readonly && covered(realOrResolved(mount.hostPath))) mount.readonly = true;
  }
  const existing = new Set(result.map((mount) => mount.containerPath));
  const nested = new Map<string, VolumeMount>();
  for (const mount of result) {
    if (mount.readonly) continue;
    const source = realOrResolved(mount.hostPath);
    for (const target of protectedPaths) {
      if (!isInside(target, source)) continue;
      const segments = path.relative(source, target).split(path.sep);
      for (let depth = 1; depth <= segments.length; depth++) {
        const hostPath = path.join(source, ...segments.slice(0, depth));
        const containerPath = path.posix.join(mount.containerPath, ...segments.slice(0, depth));
        // An explicit mount already sits here and shadows everything below it;
        // that mount is checked against the protected paths on its own.
        if (existing.has(containerPath)) break;
        nested.set(containerPath, {
          hostPath,
          containerPath,
          readonly: covered(hostPath) || nested.get(containerPath)?.readonly === true,
          overlayAllowedRoots: [source],
        });
      }
    }
  }
  return [...result, ...nested.values()];
}
