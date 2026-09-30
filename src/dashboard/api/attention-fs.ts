/**
 * Path containment for attention-source providers. Each rule is a specific escape in this fork's threat model.
 * No provider may make a network call or spawn a subprocess: every provider runs synchronously inside the
 * continuously polled thread-list request, so a remote call would block the host's event loop for every viewer.
 * Providers read files that background tasks regenerate; freshness is visible in each item's `asOf`.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import { workgroupSharedDir } from '../../modules/workgroup/shared-dirs.js';

/**
 * The largest declared file read into memory. The declared root is bind-mounted read-write into the workgroup's
 * containers, so an agent chooses every file's size, and the read is synchronous on the request path. 2 MiB is ~20x
 * the largest real artifact. Over the cap is a warn and no items, never a throw.
 * A caller reading many files per request passes a tighter `maxBytes`, because what blocks is count × size.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function isInside(base: string, resolved: string): boolean {
  // Prefix PLUS separator: a bare `startsWith` lets `/groups/workgroup-evil` pass for `/groups/workgroup`. Equality
  // passes because `root: "."` is legal.
  return resolved === base || resolved.startsWith(base + path.sep);
}

/**
 * The path an OPEN descriptor points at (`/proc/self/fd/<fd>`), or null where the platform cannot say.
 * This makes {@link readContainedFile} race-free: a path-based realpath can be raced by an agent swapping a directory
 * component for a symlink, and a second `stat` traverses the same swapped path. The fd link cannot change after the
 * open.
 * Null without `/proc` (macOS); the caller's realpath fallback only narrows the window and exists for developer
 * checkouts, not as a sufficient check.
 */
function fdPath(fd: number): string | null {
  try {
    const p = fs.readlinkSync(`/proc/self/fd/${fd}`);
    return path.isAbsolute(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * `p` realpath'd if still inside `base`, else null. Every path a provider reads goes through here, not just the root:
 * once the root is pinned, the same escape is one `ln -s` on a leaf away. Never throws.
 */
export function containedRealpath(base: string, p: string): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    return null;
  }
  return isInside(base, resolved) ? resolved : null;
}

/**
 * The declared root, realpath'd and proven inside the workgroup's own folder, or null.
 * `isSafeRelativeRoot` only checks the STRING; the root is bind-mounted read-write into the workgroup's containers,
 * so an agent can replace it with a symlink to a sibling workgroup's folder, a cross-workgroup read across the
 * data-pool boundary. Both sides are realpath'd. Fails CLOSED and never throws.
 */
export function resolveContainedRoot(
  label: string,
  groupsRoot: string,
  workgroupId: string,
  root: string,
  dataRoot: string = DATA_DIR,
): string | null {
  // Two bases, one boundary: a shared dir moved to `data/workgroups/<wg>/` leaves a container-absolute compat symlink
  // under `groups/` that dangles on the host, and without the second base the release board would go silently blank.
  // Containment is still checked per base, so a symlink into ANOTHER workgroup is refused.
  const bases = [path.resolve(groupsRoot, workgroupId), workgroupSharedDir(workgroupId, dataRoot)];
  for (const base of bases) {
    let baseDir: string;
    try {
      baseDir = fs.realpathSync(base);
    } catch {
      continue;
    }
    const resolved = containedRealpath(baseDir, path.join(baseDir, root));
    if (resolved !== null) return resolved;
  }
  // Never silent: an empty feed reads as "nothing is blocked on a human".
  log.warn(`${label}: declared root unreadable or escapes the workgroup`, { workgroupId, root, bases });
  return null;
}

/**
 * One contained file read as UTF-8 plus the mtime of the same open file. Null for absent, escaping, oversized and
 * unreadable alike, always logged.
 * The file is opened FIRST and every later question (containment, regular file, size, bytes, mtime) is answered from
 * that descriptor, so no second traversal can be raced; see {@link fdPath}.
 */
export function readContainedFile(
  label: string,
  rootDir: string,
  relative: string,
  workgroupId: string,
  maxBytes: number = MAX_FILE_BYTES,
): { text: string; mtimeIso: string } | null {
  const read = readContainedBytes(label, rootDir, relative, workgroupId, maxBytes);
  return read && { text: read.bytes.toString('utf8'), mtimeIso: read.mtimeIso };
}

export function readContainedBytes(
  label: string,
  rootDir: string,
  relative: string,
  workgroupId: string,
  maxBytes: number,
): { bytes: Buffer; mtimeIso: string } | null {
  const target = path.join(rootDir, relative);
  let fd: number;
  try {
    // O_NONBLOCK, ALWAYS: opening an agent-planted FIFO blocks until a writer appears, before `fstat` can reject it,
    // hanging the host's event loop forever. A no-op on regular files.
    // NOT O_NOFOLLOW, deliberately: it only refuses the final component, the fd check below already closes the race,
    // and this seam allows a leaf symlink to another file inside the same root. (`observatory.ts` needs O_NOFOLLOW
    // because it has no fd check.)
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    log.warn(`${label}: file absent or escapes the root, emitting nothing`, { workgroupId, relative });
    return null;
  }
  try {
    // `openSync` follows symlinks, so a successful open proves nothing about WHERE the file is; ask the descriptor.
    const opened = fdPath(fd) ?? fs.realpathSync(target);
    if (!isInside(rootDir, opened)) {
      log.warn(`${label}: file absent or escapes the root, emitting nothing`, { workgroupId, relative });
      return null;
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      log.warn(`${label}: not a regular file, emitting nothing`, { workgroupId, relative });
      return null;
    }
    if (st.size > maxBytes) {
      log.warn(`${label}: file is larger than the read cap, emitting nothing`, {
        workgroupId,
        relative,
        size: st.size,
        cap: maxBytes,
      });
      return null;
    }
    const buf = Buffer.allocUnsafe(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break; // Truncated under us; return what the fd held.
      read += n;
    }
    return { bytes: buf.subarray(0, read), mtimeIso: new Date(st.mtimeMs).toISOString() };
  } catch (err) {
    log.warn(`${label}: file unreadable, emitting nothing`, { workgroupId, relative, err });
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
