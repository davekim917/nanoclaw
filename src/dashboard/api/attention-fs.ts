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
  // Prefix-PLUS-SEPARATOR, never a bare `startsWith`: a bare one lets
  // `/groups/workgroup-evil` pass a check for `/groups/workgroup`. Equality
  // passes because `root: "."` is a legal declaration.
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
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
 * One contained file under an already-resolved root, read as UTF-8.
 *
 * Returns `null` for absent, escaping and unreadable alike — all three mean
 * "emit nothing", and all three log, because an empty feed reads as "nothing
 * is blocked on a human".
 */
export function readContainedFile(
  label: string,
  rootDir: string,
  relative: string,
  workgroupId: string,
): string | null {
  const resolved = containedRealpath(rootDir, path.join(rootDir, relative));
  if (resolved === null) {
    log.warn(`${label}: file absent or escapes the root, emitting nothing`, { workgroupId, relative });
    return null;
  }
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    log.warn(`${label}: file unreadable, emitting nothing`, { workgroupId, relative, err });
    return null;
  }
}

/**
 * A contained file's mtime as ISO-8601 UTC, or `null`.
 *
 * Only legitimate for a source a HUMAN edits, where the file's own mtime IS
 * the freshness fact. A GENERATED file must take its `asOf` from its own
 * generated header instead — mtime on a generated file is a claim about the
 * writer, not the content, so a hand-edited one would report itself fresh.
 */
export function containedMtimeIso(rootDir: string, relative: string): string | null {
  const resolved = containedRealpath(rootDir, path.join(rootDir, relative));
  if (resolved === null) return null;
  try {
    return new Date(fs.statSync(resolved).mtimeMs).toISOString();
  } catch {
    return null;
  }
}
