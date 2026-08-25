/**
 * Path containment for attention-source providers.
 *
 * Extracted verbatim from the `release-board` provider when the second and
 * third providers landed. The rules below are not general path hygiene — each
 * one is a specific escape this fork's threat model actually has, and having
 * three copies of them would mean three places to get one wrong.
 *
 * ## Why providers may not do IO beyond this
 *
 * **No provider may make a network call or spawn a subprocess.** The thread
 * list is polled continuously by SWR from every open dashboard, and every
 * provider runs synchronously inside that request. One `fetch` to GitHub — or
 * one `execFileSync('gh', …)` — would block the host's single event loop for
 * as long as the remote takes to answer, for every poll from every viewer.
 *
 * That is the entire reason these providers read FILES that background tasks
 * already regenerate rather than querying the APIs behind them: the freshness
 * cost is bounded by the generating task's cadence, which is visible in the
 * item's own `asOf`, instead of by an unbounded remote. Do not "improve" a
 * provider by having it fetch live data.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';

/**
 * The largest declared file this seam will read into memory.
 *
 * The declared root is bind-mounted READ-WRITE into that workgroup's own
 * containers, so the size of every file below is chosen by an agent, not by
 * the host — and the read is synchronous on the thread-list request path. With
 * no cap, growing one declared file is all it takes to hold the host's single
 * event loop for as long as the read takes, on every cache miss, for every
 * viewer.
 *
 * 2 MiB is ~20x the largest artifact any of these providers reads in
 * production today (a release snapshot at ~90 KB; the defect register 10 KB;
 * the open-questions document 37 KB), so it leaves room for years of ordinary
 * growth while bounding a cache miss at a few milliseconds of read plus parse.
 * Anything past it is not a hand-maintained register or a watcher snapshot.
 *
 * Over the cap is a `log.warn` and no items, never a throw: an oversized file
 * is the same answer as an absent one — read nothing, say so.
 *
 * This is the DEFAULT, not the only value. A caller that reads MANY files per
 * request multiplies the cap by its file count, so it passes a tighter one —
 * see `maxBytes` on {@link readContainedFile} and `MAX_CLAIM_BYTES` in
 * `claims-board.ts`.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** `resolved` is `base` itself or something underneath it. */
function isInside(base: string, resolved: string): boolean {
  // Prefix-PLUS-SEPARATOR, never a bare `startsWith`: a bare one lets
  // `/groups/workgroup-evil` pass a check for `/groups/workgroup`. Equality
  // passes because `root: "."` is a legal declaration.
  return resolved === base || resolved.startsWith(base + path.sep);
}

/**
 * The path an OPEN file descriptor actually points at, or `null` where the
 * platform cannot say.
 *
 * This is what makes {@link readContainedFile} race-free rather than
 * race-narrowed. `realpathSync(p)` answers a question about a path at one
 * instant; between that answer and any later `readFileSync(p)` an agent with
 * write access to the declared root can swap a directory component for a
 * symlink, and the read then follows somewhere the check never saw. Comparing
 * `fstat` against a second `stat` of the same path does NOT close that — both
 * traverse the swapped path and agree with each other.
 *
 * `/proc/self/fd/<fd>` is a kernel-maintained link to the inode the descriptor
 * already holds. Reading it cannot be raced, because the open happened first
 * and nothing about a path can change what an open descriptor refers to. So
 * containment is decided about the FILE, never about a string that may since
 * have started meaning something else.
 *
 * Returns `null` where `/proc` is absent (macOS's `/dev/fd/<fd>` is a device
 * node, not a link to the target). The caller then falls back to resolving the
 * path — which narrows the window to the gap between `open` and `realpath`
 * rather than closing it. This host runs on Linux (CLAUDE.md), where the fd
 * path is always available; the fallback exists so a developer checkout on
 * macOS keeps working, not because the weaker check is considered sufficient.
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
 * `p` realpath'd, if it is still inside `base` — otherwise `null`.
 *
 * Every path a provider reads goes through here, not just its declared root.
 * Checking only the root would be a fix that looks complete: the root is a
 * directory an agent writes into, so once the root is pinned the same escape
 * is one `ln -s` on a leaf file away. Leaves are checked against the resolved
 * ROOT rather than the workgroup dir, which is both sound (the root is already
 * proven inside the workgroup) and stricter.
 *
 * Never throws: a missing path and an escaping path are the same answer here —
 * read nothing.
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
 * The declared root, resolved through symlinks and proven to still be inside
 * the workgroup's own folder — or `null`, meaning read nothing.
 *
 * `isSafeRelativeRoot` (`attention-sources.ts`) rejects `..` and absolute
 * paths, but it is a check on the STRING. The declared root is a directory
 * `container-runner.ts` bind-mounts read-write into that workgroup's own
 * containers, so an agent can replace it with a symlink pointing at a sibling
 * workgroup's folder. A string check cannot see that, and the host reader
 * would happily follow it — a cross-workgroup read primitive out of a boundary
 * CLAUDE.md calls the data-pool boundary.
 *
 * So the check is on the RESOLVED path, with both sides realpath'd (the mount
 * root itself may legitimately be a symlink — `/tmp` on macOS is).
 *
 * Fails CLOSED and never throws into the request path: a root that does not
 * exist yet, a root that escapes, and an unreadable root all take the same
 * exit as an absent source — emit nothing, say so in the log.
 *
 * `label` names the provider in those log lines; it is the only thing that
 * differs between callers.
 */
export function resolveContainedRoot(
  label: string,
  groupsRoot: string,
  workgroupId: string,
  root: string,
): string | null {
  let workgroupDir: string;
  try {
    workgroupDir = fs.realpathSync(path.resolve(groupsRoot, workgroupId));
  } catch (err) {
    // Not-yet-existing is the common case (a declaration written before the
    // source generates) and is not an error — but it is never silent, because
    // an empty feed reads as "nothing is blocked on a human".
    log.warn(`${label}: workgroup dir unreadable, emitting nothing`, { workgroupId, root, err });
    return null;
  }
  const resolved = containedRealpath(workgroupDir, path.join(workgroupDir, root));
  if (resolved === null) log.warn(`${label}: declared root unreadable or escapes the workgroup`, { workgroupId, root });
  return resolved;
}

/**
 * One contained file under an already-resolved root, read as UTF-8, together
 * with the mtime of the very same open file.
 *
 * Returns `null` for absent, escaping, oversized and unreadable alike — all
 * four mean "emit nothing", and all four log, because an empty feed reads as
 * "nothing is blocked on a human".
 *
 * ## One open, then everything is decided about the descriptor
 *
 * The file is opened FIRST and every subsequent question — is it contained, is
 * it a regular file, how big is it, what does it contain, when was it written
 * — is answered from that one descriptor. Nothing re-resolves the path, so
 * there is no second traversal for a swapped symlink to catch. See
 * {@link fdPath} for why a path-based re-check cannot achieve this.
 *
 * The mtime rides along for the same reason: a separate `statSync` would be a
 * second traversal of the same path, i.e. the identical race reopened for a
 * timestamp.
 *
 * `maxBytes` defaults to {@link MAX_FILE_BYTES}; a caller reading many files
 * inside one request passes a tighter bound, because what blocks the event
 * loop is count × size, not size.
 */
export function readContainedFile(
  label: string,
  rootDir: string,
  relative: string,
  workgroupId: string,
  maxBytes: number = MAX_FILE_BYTES,
): { text: string; mtimeIso: string } | null {
  const target = path.join(rootDir, relative);
  let fd: number;
  try {
    // O_NONBLOCK, ALWAYS. Opening a FIFO for reading BLOCKS until a writer
    // shows up, and that open happens before the `fstat` below can reject it —
    // so a plain `openSync(target, 'r')` on an agent-planted `mkfifo` does not
    // return an error, it hangs the host's single event loop FOREVER: every
    // dashboard poll, every channel adapter, every sweep tick, for every
    // viewer. The declared root is bind-mounted read-write into that
    // workgroup's own containers, so planting one is one command. On a regular
    // file the flag is a no-op (Linux ignores O_NONBLOCK for reads on regular
    // files), so it costs nothing. Same flag, same reason, as
    // `readContainedState` in `observatory.ts`.
    //
    // NOT O_NOFOLLOW, and that is a decision rather than an omission.
    // O_NOFOLLOW only ever refuses the FINAL path component (verified: a
    // symlinked DIRECTORY component still opens fine with it), so it would not
    // close any hole the fd check below does not already close — and it WOULD
    // refuse a leaf that is legitimately a symlink to another file inside the
    // same root, which this seam is deliberately built to allow. The
    // containment decision here is race-free without it: `fdPath` asks the
    // kernel where the ALREADY-OPEN descriptor points, and every later question
    // (containment, regular-file, size, bytes, mtime) is answered from that one
    // descriptor. Nothing re-traverses the path, so there is no second lookup a
    // swapped symlink could win. `observatory.ts` needs O_NOFOLLOW precisely
    // because it has no such fd check — it proves the PARENT chain and then
    // opens — which is the difference between the two call sites, not an
    // inconsistency between them.
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    log.warn(`${label}: file absent or escapes the root, emitting nothing`, { workgroupId, relative });
    return null;
  }
  try {
    // `openSync` follows symlinks, so a successful open proves nothing about
    // WHERE the file is. That is what this check is for, and it asks the
    // descriptor rather than the path.
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
      if (n === 0) break; // truncated under us — return what the fd actually held
      read += n;
    }
    return { text: buf.subarray(0, read).toString('utf8'), mtimeIso: new Date(st.mtimeMs).toISOString() };
  } catch (err) {
    log.warn(`${label}: file unreadable, emitting nothing`, { workgroupId, relative, err });
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
