/**
 * NEGATIVE FIXTURE for src/db/transaction-closures.test.ts — a `.transaction(`
 * call whose receiver is upstream's async `DbDriver`.
 *
 * This is the shape the test forbids everywhere in `src/` until seam-3 PR 6
 * lands the central lease: while raw and driver statements share one
 * better-sqlite3 connection, an open driver transaction yields at every
 * `await`, and a raw statement landing in that window silently joins the
 * transaction. The fixture proves the test can actually SEE that shape, so a
 * green run means "no driver transactions exist", not "the resolver found
 * nothing".
 */
import type { DbDriver } from '../driver.js';

declare const driver: DbDriver;

export async function driverTransactionFixture(): Promise<void> {
  await driver.transaction(async () => {
    await driver.run('INSERT INTO fixture (id) VALUES (?)', 'x');
  });
}
