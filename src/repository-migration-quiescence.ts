import fs from 'fs';
import path from 'path';

const MAX_U64 = (1n << 64n) - 1n;

function contained(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function inodeKey(device: bigint, inode: bigint): bigint {
  if (device < 0n || device > MAX_U64 || inode < 0n || inode > MAX_U64) {
    throw new Error(`filesystem identity exceeds unsigned 64-bit bounds: ${device}:${inode}`);
  }
  return (device << 64n) | inode;
}

export interface ProtectedInodeInventory {
  inodes: Set<bigint>;
  coveredRoots: Set<string>;
}

function plannedRootAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function extendProtectedInodeInventory(
  roots: readonly string[],
  inventory: ProtectedInodeInventory = { inodes: new Set(), coveredRoots: new Set() },
  options: { refresh?: boolean } = {},
): ProtectedInodeInventory {
  const visitedDirectories = new Set<bigint>();
  for (const lexicalRoot of [...new Set(roots.map((root) => path.resolve(root)))]) {
    if (!options.refresh && [...inventory.coveredRoots].some((covered) => contained(lexicalRoot, covered))) continue;
    let physicalRoot: string;
    try {
      fs.lstatSync(lexicalRoot, { bigint: true });
      physicalRoot = fs.realpathSync.native(lexicalRoot);
    } catch (error) {
      if (plannedRootAbsent(error)) continue;
      throw new Error(
        `cannot resolve protected migration root ${lexicalRoot}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!options.refresh && [...inventory.coveredRoots].some((covered) => contained(physicalRoot, covered))) {
      inventory.coveredRoots.add(lexicalRoot);
      continue;
    }
    const stack: Array<{ path: Buffer; stat?: fs.BigIntStats }> = [{ path: Buffer.from(physicalRoot) }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let stat: fs.BigIntStats;
      try {
        stat = current.stat ?? fs.lstatSync(current.path, { bigint: true });
      } catch (error) {
        const display = current.path.toString('base64');
        throw new Error(
          `cannot inventory protected migration path (base64 ${display}): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const identity = inodeKey(stat.dev, stat.ino);
      inventory.inodes.add(identity);
      if (!stat.isDirectory() || visitedDirectories.has(identity)) continue;
      visitedDirectories.add(identity);
      let children: Buffer[];
      try {
        children = fs.readdirSync(current.path, { encoding: 'buffer' });
      } catch (error) {
        const display = current.path.toString('base64');
        throw new Error(
          `cannot enumerate protected migration directory (base64 ${display}): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      for (const child of children) {
        stack.push({ path: Buffer.concat([current.path, Buffer.from(path.sep), child]) });
      }
    }
    for (const covered of [...inventory.coveredRoots]) {
      if (contained(covered, lexicalRoot) || contained(covered, physicalRoot)) inventory.coveredRoots.delete(covered);
    }
    inventory.coveredRoots.add(lexicalRoot);
    inventory.coveredRoots.add(physicalRoot);
  }
  return inventory;
}

export function pidsWithOpenFilesBelow(
  roots: readonly string[],
  snapshot: Buffer,
  ownPid: number,
  protectedInodes: ReadonlySet<bigint> = new Set(),
): string[] {
  const protectedRoots = [
    ...new Set(
      roots.flatMap((root) => {
        const resolved = path.resolve(root);
        try {
          return [resolved, fs.realpathSync.native(resolved)];
        } catch {
          return [resolved];
        }
      }),
    ),
  ];
  const foreign = new Set<string>();
  let pid: string | undefined;
  let device: bigint | undefined;
  let inode: bigint | undefined;
  for (const rawField of snapshot.toString('utf8').split('\0')) {
    const field = rawField.startsWith('\n') ? rawField.slice(1) : rawField;
    if (field.startsWith('p') && /^\d+$/.test(field.slice(1))) {
      pid = field.slice(1);
      device = undefined;
      inode = undefined;
      continue;
    }
    if (field.startsWith('D')) {
      try {
        device = BigInt(field.slice(1));
      } catch {
        device = undefined;
      }
      inode = undefined;
      continue;
    }
    if (field.startsWith('i')) {
      try {
        inode = BigInt(field.slice(1));
      } catch {
        inode = undefined;
      }
      continue;
    }
    if (!pid || Number(pid) === ownPid || !field.startsWith('n')) continue;
    const observed = field.slice(1).replace(/ \(deleted\)$/, '');
    if (!path.isAbsolute(observed)) continue;
    const candidates = [path.resolve(observed)];
    try {
      candidates.push(fs.realpathSync.native(observed));
    } catch {
      // Deleted open files cannot be realpathed; their reported absolute path
      // still proves containment and is checked above.
    }
    const protectedIdentity =
      device !== undefined && inode !== undefined && protectedInodes.has(inodeKey(device, inode));
    if (
      protectedIdentity ||
      candidates.some((candidate) => protectedRoots.some((root) => contained(candidate, root)))
    ) {
      foreign.add(pid);
    }
  }
  return [...foreign].sort((left, right) => Number(left) - Number(right));
}
