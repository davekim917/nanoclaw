/** Fail-closed discovery of physical Git checkouts below trusted host roots. */
import fs from 'fs';
import path from 'path';

/**
 * These are host-side provider state or nested bind-mount stubs beneath a
 * session directory. Their authoritative sources are mounted and preserved by
 * their owning subsystem; they are not agent topic checkouts. Unknown
 * top-level directories remain discoverable so `/workspace/foo` clones cannot
 * be hidden accidentally. `worktrees` is intentionally absent.
 */
export const SESSION_RUNTIME_REPOSITORY_EXCLUSIONS = new Set([
  '.cache',
  '.claude-projects',
  '.graphify-stage',
  'agent',
  'codex',
  'codex-fallbacks',
  'extra',
  'global',
  'graphify-cache',
  'inbox',
  'opencode-xdg',
  'outbox',
  'plugins',
  'project',
  'tone-profiles',
  'tone-profiles-group',
  'workgroup',
]);

function contained(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function regularFile(file: string): boolean {
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink();
}

function realDirectory(directory: string): boolean {
  const stat = fs.lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

/**
 * Empty `.git` directories are Docker bind-mount stubs, not repositories.
 * A non-empty malformed marker is a blocker instead of something discovery
 * may silently discard. Broken linked-worktree pointers remain candidates so
 * the migration's collided-admin recovery can handle them explicitly.
 */
function containsOnlyDirectories(root: string): boolean {
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `cannot prove directory-only repository skeleton ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) return false;
      stack.push(path.join(directory, entry.name));
    }
  }
  return true;
}

export function isPhysicalGitCheckout(
  directory: string,
  options: { onIgnoredDirectoryOnlySkeleton?: (directory: string) => void } = {},
): boolean {
  const marker = path.join(directory, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(
      `cannot inspect repository marker ${marker}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (stat.isSymbolicLink()) throw new Error(`repository marker is a forbidden symlink: ${marker}`);
  if (stat.isFile()) {
    const bytes = fs.readFileSync(marker);
    if (bytes.length > 4096 || !/^gitdir: [^\0\r\n]+\r?\n?$/.test(bytes.toString('utf8'))) {
      throw new Error(`linked-worktree marker is malformed: ${marker}`);
    }
    return true;
  }
  if (!stat.isDirectory()) throw new Error(`repository marker has an unsupported type: ${marker}`);
  let entries: string[];
  try {
    entries = fs.readdirSync(marker);
  } catch (error) {
    throw new Error(
      `cannot enumerate repository marker ${marker}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (entries.length === 0) return false;
  try {
    if (
      !regularFile(path.join(marker, 'HEAD')) ||
      !regularFile(path.join(marker, 'config')) ||
      !realDirectory(path.join(marker, 'objects')) ||
      !realDirectory(path.join(marker, 'refs'))
    ) {
      throw new Error('missing normal-repository admin structure');
    }
  } catch (error) {
    if (containsOnlyDirectories(directory)) {
      options.onIgnoredDirectoryOnlySkeleton?.(directory);
      return false;
    }
    throw new Error(
      `non-empty .git directory is not a provable normal repository: ${marker}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return true;
}

/** Only an immediate normal clone can be the old shared canonical. */
export function isLegacyCanonicalCheckout(checkout: string, configuredRoot: string): boolean {
  const realCheckout = fs.realpathSync(checkout);
  if (path.dirname(realCheckout) !== fs.realpathSync(configuredRoot)) return false;
  const marker = fs.lstatSync(path.join(realCheckout, '.git'));
  return marker.isDirectory() && !marker.isSymbolicLink();
}

export function discoverPhysicalGitCheckouts(
  root: string,
  allowedRoots: readonly string[],
  options: { skipRootEntries?: ReadonlySet<string> } = {},
): string[] {
  const found: string[] = [];
  const stack: Array<{ directory: string; depth: number; pruneAfterNonCheckout: boolean }> = [
    { directory: root, depth: 0, pruneAfterNonCheckout: false },
  ];
  const classified = new Set<string>();
  const expanded = new Set<string>();
  const checkoutRoots = new Set<string>();
  const allowed = allowedRoots.flatMap((entry) => {
    try {
      return [fs.realpathSync(entry)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(
        `cannot resolve configured repository root ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
  const classifyThenPrune = new Set(['target', 'dist', 'build', '.cache']);
  const generatedPrune = new Set([
    'node_modules',
    '.pnpm-store',
    '.bin',
    '.next',
    '.turbo',
    '.venv',
    'venv',
    'coverage',
  ]);
  while (stack.length > 0) {
    const { directory, depth, pruneAfterNonCheckout } = stack.pop()!;
    let real: string;
    try {
      real = fs.realpathSync(directory);
    } catch (error) {
      throw new Error(
        `repository discovery path disappeared or is unreadable ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!allowed.some((allowedRoot) => contained(real, allowedRoot))) {
      throw new Error(`repository discovery symlink escapes workgroup roots: ${directory} -> ${real}`);
    }
    let checkout = checkoutRoots.has(real);
    if (!classified.has(real)) {
      classified.add(real);
      checkout = isPhysicalGitCheckout(real, {
        onIgnoredDirectoryOnlySkeleton: (ignored) =>
          console.error(`Ignoring proven directory-only repository skeleton: ${ignored}`),
      });
      if (checkout) {
        checkoutRoots.add(real);
        found.push(real);
      }
    }
    if (pruneAfterNonCheckout && !checkout) continue;
    if (expanded.has(real)) continue;
    expanded.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `cannot enumerate repository discovery path ${real}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    for (const entry of entries) {
      // Git administration and legacy bare-store namespaces are structural,
      // not candidate working trees. Content/cache names are different: a
      // repository may legitimately be named `dist`, `build`, `target`, or
      // `.cache`, so classify that directory itself before pruning recursion.
      if (entry.name === '.git' || entry.name === '.repos' || generatedPrune.has(entry.name)) continue;
      if (entry.name === 'tmp' && (path.basename(real) === 'codex' || path.basename(real) === '.codex')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = path.join(real, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          if (!fs.statSync(child).isDirectory()) continue;
        } catch (error) {
          const target = fs.readlinkSync(child);
          if (
            path.isAbsolute(target) &&
            (target === '/app' ||
              target.startsWith('/app/') ||
              target === '/workspace' ||
              target.startsWith('/workspace/'))
          )
            continue;
          throw new Error(
            `cannot resolve repository discovery symlink ${child}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      const pruneChildAfterNonCheckout =
        classifyThenPrune.has(entry.name) || (depth === 0 && options.skipRootEntries?.has(entry.name));
      stack.push({
        directory: child,
        depth: depth + 1,
        pruneAfterNonCheckout: pruneChildAfterNonCheckout === true,
      });
    }
  }
  return found.sort();
}
