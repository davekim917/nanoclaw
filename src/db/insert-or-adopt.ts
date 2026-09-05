/**
 * `insertOrAdopt` — the one shape every lookup-then-insert against the central
 * DB uses.
 *
 * ## Why it exists
 *
 * Seam 3 put the central-DB leaves behind an async driver. Every read now
 * yields: between `const existing = await lookup()` and `await insert(row)`
 * the event loop can run another route, another CLI dispatch, another
 * scheduling pass. Two callers therefore both see "no row" and both INSERT.
 * The unique index is what settles it — one INSERT wins, the other throws
 * `SQLITE_CONSTRAINT_UNIQUE` — and the loser's correct behaviour is almost
 * never "abort the request" but "adopt the row the winner just wrote and
 * carry on".
 *
 * Codex found seven separate sites with that shape across three review rounds
 * on PR 411. Fixing them one at a time is how the eighth lands: the invariant
 * lives in a primitive, and a tripwire test (`insert-or-adopt.test.ts`) fails
 * if a new bare `createSession(` / `createMessagingGroup(` / `createAgentGroup(`
 * call appears outside one. See
 * `docs/specs/upstream-async-central-db-seam/plan.md` §4.5 for the rule.
 *
 * ## What it is NOT
 *
 * - **Not a retry loop.** One insert, one adopt, done. A caller that needs to
 *   pick a *different* candidate on a loss (channel-approval's folder
 *   allocator) loops around `insertOrAdopt` itself, with its own bound.
 * - **Not a transaction and not a lock.** The unique index is the arbiter.
 *   There is no BEGIN IMMEDIATE here, nothing is serialized, and two callers
 *   racing is the expected path rather than an error case.
 * - **Not a swallow-all.** Anything that is not a unique violation rethrows
 *   untouched, and a unique violation whose winner cannot be re-read rethrows
 *   the ORIGINAL error — that combination means the constraint that fired was
 *   not the one the caller's `reload` looks up, which is a bug worth seeing.
 *
 * PR 6 may move this onto the driver itself (alongside `centralTransaction`
 * in `src/db/central-lease.ts`), at which point the call sites keep this exact
 * signature.
 */

/** True for the driver error that means "another writer won this unique key". */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Insert `candidate`; if a concurrent writer won the unique key first, re-read
 * and return the winner instead.
 *
 * @param candidate the row this caller wants to create
 * @param insert    the leaf insert (`createSession`, `createMessagingGroup`, …)
 * @param reload    the SAME lookup the caller ran before deciding to insert —
 *                  it must find the winner, or the original error is rethrown
 * @returns `{ row, created }` — `created: false` means the row came from a
 *          concurrent winner, so any provisioning the caller does for a NEW
 *          row (folder init, log line, side-table stamp) must be re-decided,
 *          not blindly repeated
 */
export async function insertOrAdopt<T>(
  candidate: T,
  insert: (row: T) => Promise<void>,
  reload: () => Promise<T | undefined>,
): Promise<{ row: T; created: boolean }> {
  try {
    await insert(candidate);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await reload();
    if (winner) return { row: winner, created: false };
    throw err;
  }
  return { row: candidate, created: true };
}
