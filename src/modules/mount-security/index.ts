/**
 * Mount Security Module for NanoClaw
 *
 * Validates additional mounts against an allowlist stored OUTSIDE the project root.
 * This prevents container agents from modifying security configuration.
 *
 * Allowlist location: ~/.config/nanoclaw/mount-allowlist.json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DATA_DIR, MOUNT_ALLOWLIST_PATH } from '../../config.js';
import { log } from '../../log.js';

export interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;
}

export interface MountAllowlist {
  allowedRoots: AllowedRoot[];
  blockedPatterns: string[];
}

export interface AllowedRoot {
  path: string;
  allowReadWrite: boolean;
  description?: string;
}

// Cache the last successfully-parsed allowlist, keyed on the file's path +
// mtime. A changed or fixed file is picked up on the next call (no restart),
// and a parse error is never cached permanently — one bad edit blocks mounts
// only until the file is fixed.
let cache: { path: string; mtimeMs: number; allowlist: MountAllowlist } | null = null;

/**
 * Default blocked patterns - paths that should never be mounted
 */
const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  'credentials',
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'private_key',
  // The HYPHENATED spelling too. `private_key` alone missed the file this
  // install actually has — a GitHub App key is conventionally
  // `<app>.<date>.private-key.pem`, and the underscore pattern does not match
  // it. Same credential class, one character apart.
  'private-key',
  // `data/mcp-oauth/` — the host-side OAuth bundles (`src/modules/mcp-oauth/store.ts`).
  // Each holds a REFRESH token and a client secret: the means to mint a working
  // bearer for a remote MCP server for as long as the grant lives. `DATA_DIR`
  // is never bind-mounted and the spawn path mounts only named subpaths under
  // it, so nothing reaches these today — this closes the one way an operator
  // could hand them to a container by hand, an `additionalMounts` entry
  // pointing at `data/` or at the bundle directory itself.
  'mcp-oauth',
  '.secret',
];

/**
 * Normalize a raw allowed-root entry into an {@link AllowedRoot}.
 *
 * The read-only decision is per-root. Historically this validator only read
 * `allowReadWrite`, but the /manage-mounts skill and setup write `readOnly`
 * instead — so a `readOnly: false` grant was silently forced read-only.
 * Translate `readOnly` → `allowReadWrite = !readOnly` (with a warning) unless an
 * explicit `allowReadWrite` is already present. With neither key, default to
 * read-only (fail safe).
 */
function normalizeRoot(root: Record<string, unknown>): AllowedRoot {
  const rootPath = typeof root.path === 'string' ? root.path : '';
  const description = typeof root.description === 'string' ? root.description : undefined;

  let allowReadWrite: boolean;
  if (typeof root.allowReadWrite === 'boolean') {
    allowReadWrite = root.allowReadWrite;
  } else if (typeof root.readOnly === 'boolean') {
    allowReadWrite = !root.readOnly;
    log.warn('Mount allowlist root uses "readOnly" — translating to allowReadWrite', {
      root: rootPath,
      readOnly: root.readOnly,
    });
  } else {
    allowReadWrite = false;
  }

  return { path: rootPath, allowReadWrite, description };
}

/**
 * Load the mount allowlist from the external config location.
 * Returns null if the file doesn't exist or is invalid.
 * Re-reads on every call, but serves from an in-memory cache while the file's
 * mtime is unchanged. A parse error is never cached — fix the file and the next
 * call recovers without a service restart.
 */
export function loadMountAllowlist(): MountAllowlist | null {
  // Missing-file behavior: warn and block additional mounts, but do NOT cache
  // the miss — the file may be created later without a restart.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(MOUNT_ALLOWLIST_PATH);
  } catch {
    log.warn(
      'Mount allowlist not found - additional mounts will be BLOCKED. Create the file to enable additional mounts.',
      { path: MOUNT_ALLOWLIST_PATH },
    );
    return null;
  }

  // Serve from cache only while the same file is unchanged since the last
  // successful load. Any edit (including fixing a previously broken file) bumps
  // the mtime and is picked up on the next call.
  if (cache !== null && cache.path === MOUNT_ALLOWLIST_PATH && cache.mtimeMs === stat.mtimeMs) {
    return cache.allowlist;
  }

  try {
    const content = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8');
    const raw = JSON.parse(content) as Record<string, unknown>;

    // Validate structure
    if (!Array.isArray(raw.allowedRoots)) {
      throw new Error('allowedRoots must be an array');
    }

    if (!Array.isArray(raw.blockedPatterns)) {
      throw new Error('blockedPatterns must be an array');
    }

    // Warn-and-ignore the top-level `nonMainReadOnly` key. Setup writes it into
    // every fresh install, but this validator has no concept of a "main" agent —
    // read-only is decided per-root. Do NOT throw: a hard reject would fail
    // closed and brick all mounts on a standard install.
    if ('nonMainReadOnly' in raw) {
      log.warn('Mount allowlist has unsupported top-level "nonMainReadOnly" key — ignoring (read-only is per-root)', {
        path: MOUNT_ALLOWLIST_PATH,
      });
    }

    const allowedRoots = (raw.allowedRoots as Array<Record<string, unknown>>).map(normalizeRoot);

    // Merge with default blocked patterns
    const blockedPatterns = [...new Set([...DEFAULT_BLOCKED_PATTERNS, ...(raw.blockedPatterns as string[])])];

    const allowlist: MountAllowlist = { allowedRoots, blockedPatterns };

    cache = { path: MOUNT_ALLOWLIST_PATH, mtimeMs: stat.mtimeMs, allowlist };
    log.info('Mount allowlist loaded successfully', {
      path: MOUNT_ALLOWLIST_PATH,
      allowedRoots: allowlist.allowedRoots.length,
      blockedPatterns: allowlist.blockedPatterns.length,
    });

    return allowlist;
  } catch (err) {
    // Do NOT poison the cache — a corrupt edit blocks mounts only until it's
    // fixed, then the next call re-reads and recovers.
    cache = null;
    log.error('Failed to load mount allowlist - additional mounts will be BLOCKED', {
      path: MOUNT_ALLOWLIST_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Expand ~ to home directory and resolve to absolute path
 */
function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) {
    return path.join(homeDir, p.slice(2));
  }
  if (p === '~') {
    return homeDir;
  }
  return path.resolve(p);
}

/**
 * Get the real path, resolving symlinks.
 * Returns null if the path doesn't exist.
 */
function getRealPath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * True when `realPath` touches the host-managed git-hooks tree
 * (data/managed-git-hooks/ — src/managed-git-hooks.ts) in either direction
 * (#666 review B9: "equals or contains data/managed-git-hooks (DATA_DIR or
 * any ancestor)"):
 *   - realPath EQUALS the tree root, or is a DESCENDANT of it (mounting
 *     into scan/ or refuse/ directly — a container could overwrite the
 *     hook or pattern lib);
 *   - realPath is an ANCESTOR of the tree root — DATA_DIR itself, or
 *     anything above it — because a read-write mount of a broader
 *     directory reaches the managed tree through the parent just as surely
 *     as mounting it directly.
 * Compares REALPATHS both ways (#666 review B11), not the raw strings, so a
 * symlink that only resolves into (or over) the tree is caught the same as
 * a direct path. Returns false (never blocks) if the tree doesn't exist yet
 * on this host — nothing to protect before the first boot that creates it,
 * and a mount request for a non-existent host path is already refused
 * earlier in validateMount regardless.
 */
/** True when `candidate` equals, is a descendant of, or is an ancestor of `root` (both directions "touch" it — see touchesManagedGitHooksRoot's own doc comment for why both matter). */
function isPathContainedOrContains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const asDescendant = path.relative(root, candidate);
  if (!asDescendant.startsWith('..') && !path.isAbsolute(asDescendant)) return true;
  const asAncestor = path.relative(candidate, root);
  return !asAncestor.startsWith('..') && !path.isAbsolute(asAncestor);
}

function touchesManagedGitHooksRoot(realPath: string): boolean {
  // Lexical comparison first (#666 review P3-6/"nudge" follow-up): this
  // never requires data/managed-git-hooks/ to exist on disk at all, so it
  // still refuses a mount aimed there even before the very first host
  // restart that creates the directory (realpathSync on a not-yet-existing
  // path throws, which the realpath-based check below has to route
  // around; the lexical check has no such gap in the first place).
  const managedRootLiteral = path.join(DATA_DIR, 'managed-git-hooks');
  if (isPathContainedOrContains(managedRootLiteral, realPath)) return true;

  // Realpath comparison, rooted at DATA_DIR's OWN realpath rather than
  // managed-git-hooks/'s (#666 review P3-6: "DATA_DIR always exists, even
  // when the leaf doesn't") — this is what a purely lexical check alone
  // would miss: a read-write mount through a symlinked ALIAS of DATA_DIR
  // (or of managed-git-hooks itself) resolves to the same real target
  // without matching the literal string.
  const dataDirReal = getRealPath(DATA_DIR);
  if (dataDirReal === null) return true; // DATA_DIR itself unreadable — cannot verify, fail closed
  const managedRootReal = path.join(dataDirReal, 'managed-git-hooks');
  return isPathContainedOrContains(managedRootReal, realPath);
}

/**
 * Check if a path matches any blocked pattern
 */
function matchesBlockedPattern(realPath: string, blockedPatterns: string[]): string | null {
  const pathParts = realPath.split(path.sep);

  for (const pattern of blockedPatterns) {
    // Check if any path component matches the pattern
    for (const part of pathParts) {
      if (part === pattern || part.includes(pattern)) {
        return pattern;
      }
    }

    // Also check if the full path contains the pattern
    if (realPath.includes(pattern)) {
      return pattern;
    }
  }

  return null;
}

/**
 * Check if a real path is under an allowed root
 */
function findAllowedRoot(realPath: string, allowedRoots: AllowedRoot[]): AllowedRoot | null {
  for (const root of allowedRoots) {
    const expandedRoot = expandPath(root.path);
    const realRoot = getRealPath(expandedRoot);

    if (realRoot === null) {
      // Allowed root doesn't exist, skip it
      continue;
    }

    // Check if realPath is under realRoot
    const relative = path.relative(realRoot, realPath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return root;
    }
  }

  return null;
}

/**
 * Validate the container path to prevent escaping /workspace/extra/
 */
function isValidContainerPath(containerPath: string): boolean {
  // Must not contain .. to prevent path traversal
  if (containerPath.includes('..')) {
    return false;
  }

  // Must not be absolute (it will be prefixed with /workspace/extra/)
  if (containerPath.startsWith('/')) {
    return false;
  }

  // Must not be empty
  if (!containerPath || containerPath.trim() === '') {
    return false;
  }

  // Must not contain colons — prevents Docker -v option injection (e.g., "repo:rw")
  if (containerPath.includes(':')) {
    return false;
  }

  return true;
}

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}

/**
 * Validate a single additional mount against the allowlist.
 * Returns validation result with reason.
 */
export function validateMount(mount: AdditionalMount): MountValidationResult {
  const allowlist = loadMountAllowlist();

  // If no allowlist, block all additional mounts
  if (allowlist === null) {
    return {
      allowed: false,
      reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}`,
    };
  }

  // Derive containerPath from hostPath basename if not specified
  const containerPath = mount.containerPath || path.basename(mount.hostPath);

  // Validate container path (cheap check)
  if (!isValidContainerPath(containerPath)) {
    return {
      allowed: false,
      reason: `Invalid container path: "${containerPath}" - must be relative, non-empty, and not contain ".."`,
    };
  }

  // Expand and resolve the host path
  const expandedPath = expandPath(mount.hostPath);
  const realPath = getRealPath(expandedPath);

  if (realPath === null) {
    return {
      allowed: false,
      reason: `Host path does not exist: "${mount.hostPath}" (expanded: "${expandedPath}")`,
    };
  }

  // Check against blocked patterns
  const blockedMatch = matchesBlockedPattern(realPath, allowlist.blockedPatterns);
  if (blockedMatch !== null) {
    return {
      allowed: false,
      reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"`,
    };
  }

  // Refuse a read-write mount into the host-managed git-hooks tree
  // unconditionally (#666 review B9) — a container that could write there
  // could overwrite the boot-snapshotted hook or pattern lib every
  // scan-policy repo's push depends on, regardless of what the allowlist
  // otherwise permits. Read-only mounts of the same tree are unaffected —
  // the allowlist's normal root/pattern checks still apply to those.
  if (mount.readonly === false && touchesManagedGitHooksRoot(realPath)) {
    return {
      allowed: false,
      reason: `Path "${realPath}" is read-write inside the host-managed git-hooks tree — refused unconditionally`,
    };
  }

  // Check if under an allowed root
  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (allowedRoot === null) {
    return {
      allowed: false,
      reason: `Path "${realPath}" is not under any allowed root. Allowed roots: ${allowlist.allowedRoots
        .map((r) => expandPath(r.path))
        .join(', ')}`,
    };
  }

  // Determine effective readonly status.
  // RW is only granted if the mount explicitly requests it AND the allowed
  // root permits it. Otherwise it's forced read-only.
  const requestedReadWrite = mount.readonly === false;
  let effectiveReadonly = true;

  if (requestedReadWrite) {
    if (!allowedRoot.allowReadWrite) {
      log.info('Mount forced to read-only - root does not allow read-write', {
        mount: mount.hostPath,
        root: allowedRoot.path,
      });
    } else {
      effectiveReadonly = false;
    }
  }

  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"${allowedRoot.description ? ` (${allowedRoot.description})` : ''}`,
    realHostPath: realPath,
    resolvedContainerPath: containerPath,
    effectiveReadonly,
  };
}

/**
 * Validate all additional mounts for a group.
 * Returns array of validated mounts (only those that passed validation).
 * Logs warnings for rejected mounts.
 */
export function validateAdditionalMounts(
  mounts: AdditionalMount[],
  groupName: string,
): Array<{
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}> {
  const validatedMounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }> = [];

  for (const mount of mounts) {
    const result = validateMount(mount);

    if (result.allowed) {
      validatedMounts.push({
        hostPath: result.realHostPath!,
        containerPath: `/workspace/extra/${result.resolvedContainerPath}`,
        readonly: result.effectiveReadonly!,
      });

      log.debug('Mount validated successfully', {
        group: groupName,
        hostPath: result.realHostPath,
        containerPath: result.resolvedContainerPath,
        readonly: result.effectiveReadonly,
        reason: result.reason,
      });
    } else {
      log.warn('Additional mount REJECTED', {
        group: groupName,
        requestedPath: mount.hostPath,
        containerPath: mount.containerPath,
        reason: result.reason,
      });
    }
  }

  return validatedMounts;
}

/**
 * Generate a template allowlist file for users to customize
 */
export function generateAllowlistTemplate(): string {
  const template: MountAllowlist = {
    allowedRoots: [
      {
        path: '~/projects',
        allowReadWrite: true,
        description: 'Development projects',
      },
      {
        path: '~/repos',
        allowReadWrite: true,
        description: 'Git repositories',
      },
      {
        path: '~/Documents/work',
        allowReadWrite: false,
        description: 'Work documents (read-only)',
      },
    ],
    blockedPatterns: [
      // Additional patterns beyond defaults
      'password',
      'secret',
      'token',
    ],
  };

  return JSON.stringify(template, null, 2);
}
