/**
 * The central-DB lease: driver transactions and synchronous central blocks,
 * made mutually exclusive.
 *
 * Seam 3 leaves the fork with ONE connection carrying two kinds of traffic. A
 * `DbDriver` transaction is async — it yields at every `await` inside its
 * closure — while a handful of code paths must stay synchronous forever
 * (plan §4.5 I-1): the wake/write/agent-route guards, `withQuietInvalidationSync`
 * and its write, and the agent-to-agent destination replace. A raw statement
 * from one of those paths landing in a driver transaction's suspension window
 * would execute INSIDE the open `BEGIN IMMEDIATE` — joining a transaction it
 * knows nothing about and rolling back with it — or die on "cannot start a
 * transaction within a transaction".
 *
 * The fix is a fork-level lease both sides take, so a synchronous block never
 * has to REFUSE a legitimate write or wake because a transaction happened to be
 * open: it waits its turn (microseconds — closures are DB-only, §4.4) and then
 * runs to completion with nothing interleaving.
 *
 *   centralTransaction(fn)  acquire → getDb().transaction(fn) → release
 *   withCentralSync(fn)     acquire → run the synchronous block → release
 *   withRawDb(fn)           the raw handle, usable only inside such a block
 *   evaluateGuardSync(g)    call a guard, reject a thenable result
 *
 * Non-transactional driver `get`/`all`/`run` do NOT take the lease. They never
 * open a transaction, so a sync block cannot collide with them.
 *
 * Deadlock analysis: a lease holder in a sync block cannot await, and a lease
 * holder in a transaction closure may await only driver calls (enforced by
 * `src/db/transaction-closures.test.ts`) — never a mailbox, a container, or the
 * lease itself. No wait cycle exists, and the re-entrancy guard below turns the
 * one shape that could produce one into an immediate throw.
 *
 * ZERO production callers as of seam 3 PR 6a. PR 6 wires the guards,
 * `withQuietInvalidationSync`, `write-destinations.ts` and the eleven
 * transactions onto it.
 *
 * See docs/specs/upstream-async-central-db-seam/plan.md §4.1, §4.4, §4.5.
 */
import type Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';

import { log } from '../log.js';
import { getDb, getRawDb } from './connection.js';

/** A block handed to `withCentralSync` may not be async. Compile-time half. */
export type SyncBlockOnly<T> = T extends PromiseLike<unknown> ? [blockMustNotBeAsync: never] : [];

/** A guard, or a `withCentralSync` block, returned a promise. */
export class GuardNotSynchronousError extends Error {
  constructor(what: string) {
    super(
      `${what} returned a promise. The central lease is held across the whole block, so an async body ` +
        'would keep it while suspended and resume with the connection under someone else. Read what you ' +
        'need synchronously and await outside the block.',
    );
    this.name = 'GuardNotSynchronousError';
  }
}

/** `withRawDb` was called outside a `withCentralSync` block. */
export class RawAccessOutsideSyncBlockError extends Error {
  constructor() {
    super(
      'withRawDb() is only usable inside withCentralSync(). Outside the lease a raw statement can land in ' +
        'an open driver transaction and silently join it; use getDb() and await, or take the lease.',
    );
    this.name = 'RawAccessOutsideSyncBlockError';
  }
}

/** The raw handle reported an open transaction while the lease was held. */
export class RawAccessDuringTransactionError extends Error {
  constructor() {
    super(
      'withRawDb() found the raw connection inside an open transaction while holding the central lease. ' +
        'Under the lease this is unreachable by construction, so a non-zero count means something opened a ' +
        'transaction without it — fix the bypass at that site.',
    );
    this.name = 'RawAccessDuringTransactionError';
  }
}

/** The lease was requested by code that already holds it. */
export class CentralLeaseReentrancyError extends Error {
  constructor(entry: string, holder: string) {
    super(
      `${entry}() was called while this context already holds the central lease (${holder}). The lease is ` +
        'not re-entrant: waiting for it here would wait forever. Move the nested work into the block that ' +
        'already holds it, or after it.',
    );
    this.name = 'CentralLeaseReentrancyError';
  }
}

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

const DEFAULT_LEASE_WARN_MS = 1_000;
let leaseWarnMs = DEFAULT_LEASE_WARN_MS;

/**
 * FIFO async mutex — the same shape as upstream's `drivers/shared.ts`
 * `AsyncMutex`, re-implemented here because upstream's instance is private to
 * `SqliteDriver` (it serializes the driver's own transactions, not the fork's
 * synchronous blocks). Order is submission order: each waiter awaits the tail
 * as it stood when it asked, and the tail is advanced synchronously inside
 * `acquire()`, before its first await.
 */
class CentralLease {
  private tail: Promise<void> = Promise.resolve();
  private holder: string | undefined;

  async acquire(label: string): Promise<() => void> {
    let signalDone!: () => void;
    const done = new Promise<void>((resolve) => {
      signalDone = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => done);
    const waitedFor = this.holder;
    const startedAt = Date.now();

    await previous;

    const waitedMs = Date.now() - startedAt;
    if (waitedMs > leaseWarnMs) {
      // A DB-only closure should never hold the lease this long (plan §6): the
      // WARN is the tripwire for a closure that grew a non-DB effect.
      log.warn('Central lease wait exceeded 1 s', { waitedMs, holder: waitedFor ?? 'unknown', waiter: label });
    }
    this.holder = label;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holder = undefined;
      signalDone();
    };
  }
}

const lease = new CentralLease();

/**
 * Marker for "this async context holds the lease inside a transaction closure".
 *
 * `AsyncLocalStorage` and not a flag, because a transaction closure suspends at
 * every await and the marker has to survive those continuations — and has to
 * stay invisible to the unrelated work running while it is parked.
 */
const transactionHolder = new AsyncLocalStorage<string>();

/**
 * Marker for "a synchronous block is running right now".
 *
 * A module-level boolean and not `AsyncLocalStorage`, because the block is
 * synchronous: it runs to completion with no yield, so on a single-threaded
 * runtime nothing else can observe the flag while it is set, which makes the
 * flag exact. `AsyncLocalStorage` would be strictly worse here — its context
 * propagates into callbacks the block SCHEDULES (a `setTimeout`, a `.then`),
 * which run long after the lease is released and where a raw statement must be
 * refused. Saved and restored rather than cleared, so a nested block (which the
 * re-entrancy guard already rejects) cannot leave the flag wrong.
 */
let insideSyncBlock = false;

function assertLeaseNotHeld(entry: string): void {
  const held = transactionHolder.getStore();
  if (held !== undefined) throw new CentralLeaseReentrancyError(entry, `transaction: ${held}`);
  if (insideSyncBlock) throw new CentralLeaseReentrancyError(entry, 'synchronous block');
}

/**
 * The ONLY sanctioned caller of `DbDriver.transaction` in the fork.
 *
 * `src/db/transaction-closures.test.ts` resolves the receiver of every
 * `.transaction(` call in `src/` with the TypeScript checker and fails on a
 * `DbDriver` receiver in any other file.
 *
 * The closure must issue DB calls sequentially and contain no non-DB effect —
 * no mailbox write, no container op, no adapter call, no `fetch`. Those belong
 * after the returned promise resolves. The same test enforces it.
 */
export async function centralTransaction<T>(fn: () => Promise<T>, label = 'centralTransaction'): Promise<T> {
  assertLeaseNotHeld('centralTransaction');
  const release = await lease.acquire(label);
  try {
    return await transactionHolder.run(label, () => getDb().transaction(fn));
  } finally {
    release();
  }
}

/**
 * Run a synchronous central-DB block under the lease.
 *
 * The block sees a connection with no transaction open and nothing able to
 * interleave, which is what lets a guard and the statement it protects sit in
 * one indivisible turn. It reaches the connection through `withRawDb`, which
 * refuses to work anywhere else.
 *
 * The rest parameter rejects an async block at compile time; the runtime check
 * catches the callers the types cannot reach — plain JavaScript, an `as never`,
 * a callback whose return type widened through a generic.
 */
export async function withCentralSync<T>(
  fn: () => T,
  label = 'withCentralSync',
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- type-level only
  ..._sync: SyncBlockOnly<T>
): Promise<T> {
  assertLeaseNotHeld('withCentralSync');
  const release = await lease.acquire(label);
  const previouslyInside = insideSyncBlock;
  insideSyncBlock = true;
  try {
    const result = fn();
    if (isThenable(result)) throw new GuardNotSynchronousError('The withCentralSync block');
    return result;
  } finally {
    insideSyncBlock = previouslyInside;
    release();
  }
}

/**
 * The synchronous better-sqlite3 handle, inside a `withCentralSync` block.
 *
 * Two throws, for two different failures. Outside a block there is no lease and
 * the statement could land inside an open driver transaction, so it is refused —
 * that makes PR 6's migration of the allowlisted sites structural rather than
 * conventional. Inside a block an open transaction is unreachable by
 * construction (the lease is exclusive), so the `inTransaction` check is a belt:
 * a non-zero count in the post-restart gate means a bypass, not a race.
 *
 * `src/db/migrations/index.ts` and the storage-maintenance worker thread are
 * allowlisted raw users that do NOT come through here: they run with no
 * concurrent central-DB activity at all.
 */
export function withRawDb<T>(fn: (db: Database.Database) => T): T {
  if (!insideSyncBlock) throw new RawAccessOutsideSyncBlockError();
  const raw = getRawDb();
  if (raw.inTransaction) throw new RawAccessDuringTransactionError();
  return fn(raw);
}

/**
 * Evaluate a guard and prove it was synchronous.
 *
 * The wake/write/agent-route guards read the central DB and must never be
 * awaited: the write guard runs inside `withExistingMailboxSession`, whose
 * action type admits promises, so the mailbox funnel is NOT the enforcing
 * primitive — this is. An accidentally-async guard, or one cast into the guard
 * type, is rejected here at the evaluation site rather than silently returning
 * a truthy promise that every caller reads as "allowed".
 */
export function evaluateGuardSync<R>(guard: () => R): R {
  const decision = guard();
  if (isThenable(decision)) throw new GuardNotSynchronousError('The guard');
  return decision;
}

/** Tests only: shorten the >1 s lease-wait WARN threshold. Returns the previous value. */
export function _setWarnThresholdForTests(ms: number): number {
  const previous = leaseWarnMs;
  leaseWarnMs = ms;
  return previous;
}
