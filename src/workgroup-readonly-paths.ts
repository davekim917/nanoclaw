/**
 * Workgroup subpaths containers may read but never write: the workgroup tree is mounted read-write into every
 * sibling, so anything the host executes from it (unit scripts, host-gated task scripts) is otherwise agent-editable.
 * Policy: data/workgroup-readonly-paths.json `{ "version": 1, "workgroups": { "<id>": ["<subpath>", ...] } }`. No
 * file protects nothing; an unparseable file throws so the spawn aborts rather than dropping a protection; a
 * declared subpath that does not exist yet is skipped.
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

export interface WorkgroupReadonlyPaths {
  protectedPaths: string[];
  /** Workgroups whose declarations could not resolve safely: every writable mount reaching into one goes read-only. */
  lockedRoots: string[];
}

/**
 * Resolve declared subpaths across ALL workgroups (another group's mount of this tree must not expose them either).
 * Anything but a missing path that stops a subpath resolving to itself (permission error, loop, symlink on the way)
 * locks that workgroup rather than throwing, which would stop every spawn on the host.
 */
export function readWorkgroupReadonlyPaths(dataDir: string = DATA_DIR): WorkgroupReadonlyPaths {
  const policyPath = path.join(dataDir, POLICY_FILE);
  const result: WorkgroupReadonlyPaths = { protectedPaths: [], lockedRoots: [] };
  let contents: string;
  try {
    contents = fs.readFileSync(policyPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  for (const [workgroupId, subpaths] of parseWorkgroupReadonlyPaths(contents)) {
    const root = workgroupSharedDir(workgroupId, dataDir);
    const lock = (reason: string, detail: Record<string, unknown>): void => {
      log.error(`Workgroup read-only path ${reason}; mounting the workgroup read-only`, { workgroupId, ...detail });
      const names = [path.resolve(root)];
      try {
        names.push(fs.realpathSync(root));
      } catch {
        // The lexical root still matches mounts that name it directly.
      }
      for (const name of names) if (!result.lockedRoots.includes(name)) result.lockedRoots.push(name);
    };
    for (const subpath of subpaths) {
      let real: string;
      let realRoot: string;
      try {
        real = fs.realpathSync(path.join(root, subpath));
        realRoot = fs.realpathSync(root);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        lock('could not be resolved', { subpath, error: code ?? String(error) });
        break;
      }
      // A symlink on the way is replaceable by whoever can write its parent, so binding its target protects nothing.
      if (real !== path.join(realRoot, subpath)) {
        lock('traverses a symlink', { subpath, real });
        break;
      }
      reportAliases(real, workgroupId, subpath);
      result.protectedPaths.push(real);
    }
  }
  return result;
}

/**
 * The read-only bind protects names, not inodes: a hard link made while the path was writable survives, as does a
 * symlink pointing out of it. Such aliases are reported, never removed: the host cannot tell the intended name.
 */
function reportAliases(root: string, workgroupId: string, subpath: string): void {
  const hardLinked: string[] = [];
  const escaping: string[] = [];
  const unreadable: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    try {
      const stat = fs.lstatSync(current);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
      } else if (stat.isFile() && stat.nlink > 1) {
        hardLinked.push(current);
      } else if (stat.isSymbolicLink()) {
        let target: string | null = null;
        try {
          target = fs.realpathSync(current);
        } catch {
          // Dangling or looping: whatever it names later is outside our view.
        }
        if (target === null || (target !== root && !isInside(target, root))) escaping.push(current);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(current);
    }
  }
  if (hardLinked.length + escaping.length + unreadable.length === 0) return;
  log.error('Workgroup read-only path holds names that may still be writable elsewhere', {
    workgroupId,
    subpath,
    hardLinked: hardLinked.slice(0, 20),
    escapingSymlinks: escaping.slice(0, 20),
    unreadable: unreadable.slice(0, 20),
  });
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // Unresolvable sources still compare by their lexical path.
    return path.resolve(p);
  }
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent + path.sep);
}

/**
 * Re-mount each protected path read-only wherever a writable mount exposes it: a mount at or under it (or into a
 * locked workgroup) becomes read-only; one containing it gains a nested read-only bind. Every directory between
 * the mount and the protected path is also bound onto itself, since a container could otherwise rename a writable
 * parent away and recreate the path.
 */
export function protectReadonlyHostPaths(
  mounts: VolumeMount[],
  { protectedPaths, lockedRoots }: WorkgroupReadonlyPaths,
): VolumeMount[] {
  if (protectedPaths.length === 0 && lockedRoots.length === 0) return mounts;
  const covered = (hostPath: string): boolean =>
    protectedPaths.some((target) => hostPath === target || isInside(hostPath, target));
  const reachesLocked = (source: string): boolean =>
    lockedRoots.some((root) => source === root || isInside(source, root) || isInside(root, source));
  const result = mounts.map((mount) => ({ ...mount }));
  for (const mount of result) {
    if (mount.readonly) continue;
    const source = realOrResolved(mount.hostPath);
    if (covered(source) || reachesLocked(source)) mount.readonly = true;
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
        // An explicit mount here shadows everything below; it is checked against the protected paths on its own.
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
