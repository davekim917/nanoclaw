/**
 * Pin: every write that puts a session row into `closed` (#520).
 *
 * `closed` is terminal — `findSessionForAgent` matches active rows only, and
 * the sole transition back to `active` is from `archiving`
 * (`releaseArchivingRow`). So anything still `pending` or `processing` in a
 * session's inbound at the moment it closes can never be consumed, and it
 * pins the session directory against reclaim forever through
 * `sessionHasOpenWork`. The fix expires those rows at the close; this test is
 * what stops a LATER close path from silently reintroducing the leak, since a
 * new site would be caught here rather than discovered 43 days later as
 * stranded rows.
 *
 * Add a site only together with the reason it is safe.
 *
 * ## Why only one site calls the expiry
 *
 * `src/storage-manager.ts` holds four `archiving -> closed` writes and none of
 * them can strand a row:
 *
 *  - the two in the archival path and the one in the startup finisher are each
 *    immediately followed by `fs.rmSync(sessPath)`, or reached only when the
 *    directory is already gone — the inbound file, and every row in it, goes
 *    with it;
 *  - `releaseArchivingRow`'s constraint branch keeps the directory, but a row
 *    only reaches `archiving` through `createArchiveSessionAction`, which
 *    refuses unless `sessionHasOpenWork(...) === false`, and no inbound can
 *    arrive while it sits there (again: `findSessionForAgent` is active-only).
 *    There is nothing pending left to expire.
 *
 * They are also unreachable from the mailbox seam: those writes run in the
 * storage maintenance worker thread over an INJECTED sessions root, which is
 * exactly the documented read-only exemption in `src/mailbox/RATCHET.json`.
 * Wiring an expiry write into them would break that exemption's premise to
 * cover a case that cannot happen.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src');

/** SQL that closes a session row, and the `updateSession` object form. */
const SQL_CLOSE = /sessions\s+SET\s+status\s*=\s*'closed'/;
const OBJECT_CLOSE = /status:\s*'closed'/;

/**
 * file -> how many closing writes it holds, and why that is safe.
 *
 * The count is part of the pin: adding a fifth write to `storage-manager.ts`
 * fails here even though the file is already listed.
 */
const SESSION_CLOSE_SITES: ReadonlyMap<string, { writes: number; why: string }> = new Map([
  [
    'src/modules/sweep-scheduling/index.ts',
    {
      writes: 1,
      why: 'S19 spent-task-session GC — the only active->closed transition on the host. Expires the session’s remaining inbound rows through expireClosedSessionWork immediately after the close.',
    },
  ],
  [
    'src/storage-manager.ts',
    {
      writes: 4,
      why: 'archiving->closed only. Three are followed by (or reached after) the removal of the session directory; the fourth is guarded upstream by sessionHasOpenWork === false. Nothing pending can survive any of them.',
    },
  ],
]);

function listRuntimeTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listRuntimeTs(full, out);
    else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    )
      out.push(full);
  }
  return out.sort();
}

function closeWriteCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of listRuntimeTs(SRC)) {
    const rel = path.relative(REPO_ROOT, file);
    let n = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (SQL_CLOSE.test(line) || OBJECT_CLOSE.test(line)) n += 1;
    }
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

describe('session close sites', () => {
  it('the set of writes that close a session row is exactly the pinned one', () => {
    const found = closeWriteCounts();
    const expected = new Map([...SESSION_CLOSE_SITES].map(([file, entry]) => [file, entry.writes]));
    expect(
      Object.fromEntries([...found].sort()),
      'A write that puts a session into `closed` was added, moved or removed. A closing write must leave no ' +
        '`pending`/`processing` row behind: either the session directory goes with it, or it calls ' +
        '`expireClosedSessionWork` (src/session-close-expiry.ts). Update this pin with the reason once that holds. ' +
        'See #520.',
    ).toEqual(Object.fromEntries([...expected].sort()));
  });

  it('the active->closed site expires the rows it would otherwise strand', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/modules/sweep-scheduling/index.ts'), 'utf8');
    // Assert the CALL, not the mention. `toContain('expireClosedSessionWork')`
    // against the whole file passes on the import line alone, so deleting the
    // call at the close site left this green — caught by mutation, not review.
    const body = source
      .split('\n')
      .filter((line) => !/^\s*(import\b|\s*\*|\/\/)/.test(line))
      .join('\n');
    expect(
      /expireClosedSessionWork\s*\(/.test(body),
      'S19 closes a session without expiring its remaining inbound rows, which strands them where no sweep ' +
        'can reach them (getActiveSessions filters to status=active) and pins the directory forever via ' +
        'sessionHasOpenWork. See #520.',
    ).toBe(true);
  });

  it('the expiry helper is the only caller of the unguarded mailbox op', () => {
    const callers = listRuntimeTs(SRC)
      .filter((file) => /\bexpireClosedSessionPending\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO_ROOT, file))
      .sort();
    expect(
      callers,
      '`expireClosedSessionPending` drops the age, recurrence and fence guards that are load-bearing for a LIVE ' +
        'session. It may only be reached through `expireClosedSessionWork`, which callers use once the session ' +
        'row is closed.',
    ).toEqual([
      'src/modules/mailbox/index.ts', // the op definition and its one binding
      'src/modules/mailbox/ops/sweep.ts',
      'src/session-close-expiry.ts',
    ]);
  });
});
