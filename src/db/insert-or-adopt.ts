/**
 * `insertOrAdopt`: the one shape every lookup-then-insert against the central DB uses. With the async driver every
 * read yields, so two callers can both see "no row" and both INSERT; the unique index settles it, and the loser
 * should adopt the winner's row rather than fail. A tripwire test (`insert-or-adopt-tripwire.test.ts`) fails on a new bare
 * `createSession(` / `createMessagingGroup(` / `createAgentGroup(` outside it.
 * Not a retry loop (one insert, one adopt), not a transaction or lock (the unique index is the arbiter), and not a
 * swallow-all: anything but a unique violation rethrows, and a violation whose winner cannot be re-read rethrows the
 * ORIGINAL error, since the constraint that fired is not the one `reload` looks up.
 */

/**
 * `SQLITE_CONSTRAINT_PRIMARYKEY` counts too: a losing INSERT on a TEXT PRIMARY KEY natural key (e.g. `users.id`)
 * raises the PRIMARYKEY code, not UNIQUE.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/**
 * Inserts `candidate`, or returns the concurrent winner when the unique key was taken. `reload` must be the SAME
 * lookup the caller ran before inserting. `created: false` means the row is the winner's, so provisioning for a NEW
 * row (folder init, side-table stamps) must be re-decided, not repeated.
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
