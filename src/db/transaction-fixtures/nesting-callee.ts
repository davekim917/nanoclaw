/**
 * NEGATIVE FIXTURE for src/db/transaction-closures.test.ts — the reentrancy
 * shape that shipped as a P1 on #505 and would have taken workspace-trust
 * auto-wire out entirely.
 *
 * `openItsOwnTransaction` is an ordinary exported writer: correct on its own,
 * and correct for every caller outside a transaction. Called from INSIDE a
 * `centralTransaction` closure it throws `CentralLeaseReentrancyError`, because
 * the lease is not re-entrant — and the call site reads like any other await,
 * which is why review missed it twice.
 *
 * `participatesInTheOpenTransaction` is the same work with no lease of its own:
 * the shape a caller that already holds the lease is supposed to use. The
 * resolver must flag the first and leave the second alone, so a green run means
 * the rule holds rather than that the resolver found nothing.
 */
import { centralTransaction } from '../central-lease.js';
import { getDb } from '../connection.js';

export async function participatesInTheOpenTransaction(): Promise<void> {
  await getDb().run('INSERT INTO fixture (id) VALUES (?)', 'leaf');
}

export async function opensItsOwnTransaction(): Promise<void> {
  await centralTransaction(() => participatesInTheOpenTransaction(), 'fixture-writer');
}

/** The offender: one hop from the closure to a callee that opens a lease. */
export async function nestingClosureFixture(): Promise<void> {
  await centralTransaction(async () => {
    await opensItsOwnTransaction();
  });
}

/** The same closure done right — the callee holds no lease of its own. */
export async function participatingClosureFixture(): Promise<void> {
  await centralTransaction(async () => {
    await participatesInTheOpenTransaction();
  });
}
