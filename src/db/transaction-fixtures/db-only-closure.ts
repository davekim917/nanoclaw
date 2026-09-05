/**
 * POSITIVE FIXTURE for src/db/transaction-closures.test.ts — a
 * `centralTransaction` closure that awaits ONLY `DbDriver` calls, which is the
 * only shape plan §4.4 allows. The resolver must find its awaits and classify
 * every one as a driver call, so a green run means "the DB-only rule holds",
 * not "the resolver saw nothing".
 */
import { centralTransaction } from '../central-lease.js';
import { getDb } from '../connection.js';

export async function dbOnlyClosureFixture(): Promise<void> {
  await centralTransaction(async () => {
    await getDb().run('INSERT INTO fixture (id) VALUES (?)', 'a');
    const row = await getDb().get('SELECT id FROM fixture WHERE id = ?', 'a');
    await getDb().run('UPDATE fixture SET id = ? WHERE id = ?', 'b', (row as { id: string }).id);
  });
}
