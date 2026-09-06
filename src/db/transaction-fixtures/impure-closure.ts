/**
 * NEGATIVE FIXTURE for src/db/transaction-closures.test.ts — a
 * `centralTransaction` closure that awaits a non-DB effect (`fetch`) and calls
 * `getDb().transaction` directly. Both are forbidden inside a central
 * transaction closure (plan §4.4): the driver yields at every await, so a
 * `fetch` inside the open BEGIN IMMEDIATE resumes after a rollback, and a
 * nested driver transaction bypasses the fork lease. The fixture proves the
 * DB-only check can SEE these shapes, so it is not vacuous.
 */
import { centralTransaction } from '../central-lease.js';
import { getDb } from '../connection.js';

declare function fetch(url: string): Promise<{ ok: boolean }>;

export async function impureClosureFixture(): Promise<void> {
  await centralTransaction(async () => {
    await getDb().run('INSERT INTO fixture (id) VALUES (?)', 'a');
    // Forbidden: a non-DB await inside the transaction.
    await fetch('https://example.invalid');
    // Forbidden: a direct driver transaction, bypassing centralTransaction.
    await getDb().transaction(async () => undefined);
  });
}
