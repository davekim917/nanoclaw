/**
 * POSITIVE FIXTURE for src/db/transaction-closures.test.ts — a `.transaction(`
 * call whose receiver is better-sqlite3's synchronous `Database`.
 *
 * Nothing imports this at runtime and nothing calls it: the handle is `declare
 * const`, so the file exists purely to give the receiver-resolution test a
 * known-raw sample to classify. It deliberately does NOT go through
 * `getRawDb()` — the fixture must stay valid after PR 6 deletes that function.
 */
import type Database from 'better-sqlite3';

declare const rawHandle: Database.Database;

export function rawTransactionFixture(): void {
  rawHandle.transaction(() => {
    rawHandle.prepare('INSERT INTO fixture (id) VALUES (?)').run('x');
  })();
}
