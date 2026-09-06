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
 *   withRawDb(fn)           the connection, confined to such a block
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
 * Production callers since seam 3 PR 6: the wake/write/agent-route guards and
 * the `guard()` consult sites, `withQuietInvalidationSync` and its callers,
 * `write-destinations.ts`, and every central transaction in the fork.
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

/** A raw block returned with a transaction still open on the shared connection. */
export class RawBlockLeftTransactionOpenError extends Error {
  constructor(site: string) {
    super(
      `${site} returned with a transaction still open on the central connection. The lease is released at the ` +
        'end of the block, so the transaction would outlive it: the next centralTransaction() would die on ' +
        'BEGIN IMMEDIATE and unrelated raw statements would silently join it. It has been rolled back — issue ' +
        'BEGIN/COMMIT as a matched pair inside one block, or use centralTransaction().',
    );
    this.name = 'RawBlockLeftTransactionOpenError';
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

/**
 * Thenable in the sense `await` uses, which includes a CALLABLE thenable.
 *
 * `typeof` a function object carrying a `then` method is `'function'`, not
 * `'object'` — but `await` still adopts it, and the compile-time
 * `PromiseLike` check classifies it as async. An object-only test therefore
 * disagreed with both: `evaluateGuardSync` handed the function back as a
 * truthy synchronous decision, and `withCentralSync` released the lease around
 * a result that was still going to resolve later.
 */
/**
 * A thenable that reached a synchronous seam is a contract violation, and the
 * violation is what gets thrown — but the thenable itself is still a live
 * promise that may reject later. Abandoning it would surface that rejection as
 * an `unhandledRejection` (which log.ts turns into a process exit) even though
 * the caller caught the intended error, so its rejection is consumed here and
 * logged as the evidence it is.
 */
function disownThenable(value: unknown, site: string): void {
  void Promise.resolve(value).then(
    () => undefined,
    (err: unknown) => log.warn(`${site} returned a thenable that later rejected`, { err }),
  );
}

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return typeof (value as { then?: unknown }).then === 'function';
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
 *
 * The same stray-transaction postcondition `withRawDb` applies runs again here.
 * A facade or statement prepared earlier in the SAME block is still live after
 * its `withRawDb` call returns (the epoch matches), so a `BEGIN` issued through
 * it would otherwise escape the per-callback check and outlive the lease.
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
  const previousRawHandle = blockRawHandle;
  insideSyncBlock = true;
  blockRawHandle = undefined;
  blockEpoch += 1;
  let blockThrew = true;
  let stray: RawBlockLeftTransactionOpenError | undefined;
  let result!: T;
  try {
    result = fn();
    if (isThenable(result)) {
      disownThenable(result, 'The withCentralSync block');
      throw new GuardNotSynchronousError('The withCentralSync block');
    }
    blockThrew = false;
  } finally {
    // The postcondition is settled BEFORE the lease is handed on, so the next
    // holder never sees the abandoned transaction — but it is THROWN after the
    // try/finally, so a stray BEGIN cannot swallow the block's own error and
    // cannot leak the lease.
    stray = blockRawHandle
      ? settleStrayTransaction(blockRawHandle, 'The withCentralSync() block', blockThrew)
      : undefined;
    insideSyncBlock = previouslyInside;
    blockRawHandle = previousRawHandle;
    release();
  }
  if (stray) throw stray;
  return result;
}

/**
 * A prepared statement as a synchronous block may hold it.
 *
 * `RawDb.prepare` hands back one of these rather than the better-sqlite3
 * `Statement`, because a statement holds its own reference to the connection:
 * `{ statement: r.prepare(...) }`, or an assignment to a variable declared
 * outside the block, puts a live executable on the shared handle into the
 * caller's hands, and a `run`/`get`/`all` on it after the lease is released
 * lands in whatever transaction the next holder has open — the exact race this
 * primitive exists to prevent. `NoLiveSqlite` only constrains the block's
 * top-level return type, so it cannot see either shape.
 *
 * Every method therefore re-checks the same epoch predicate as the db facade:
 * nothing live leaves the block AT RUNTIME, and the type constraint is the
 * compile-time hint that catches the direct form early. `pluck`/`iterate`/
 * `raw` are deliberately absent — no allowlisted caller (§4.5) needs them, and
 * `iterate` in particular would hand out a cursor that outlives the block.
 */
export interface RawStatement {
  run(...params: unknown[]): Database.RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * The connection as a synchronous block may hold it: statements, and nothing
 * that outlives the block.
 *
 * `withRawDb` hands over one of these rather than the better-sqlite3 handle
 * itself, so that a callback cannot stash the live connection somewhere and run
 * statements on it after the lease is released. Every method re-checks that its
 * own block is still running, so a captured facade is inert the moment the
 * block returns, and does not come back to life on a later block's lease.
 */
export interface RawDb {
  prepare(source: string): RawStatement;
  exec(source: string): void;
  readonly inTransaction: boolean;
}

/**
 * The connection as a leaf that takes it AS A PARAMETER may require: prepared
 * statements and nothing else. Satisfied by the `withRawDb` facade (the host,
 * under the lease) and by the raw better-sqlite3 handle where that handle is
 * legitimately bare — the boot reconcilers in `main.ts`, and the storage
 * maintenance worker thread on its own connection. A leaf typed against this
 * cannot reach `transaction`/`exec`/`pragma`, so it cannot open a transaction
 * the lease does not know about.
 */
export interface RawStatements {
  prepare(source: string): RawStatement;
}

/**
 * A `withCentralSync` block may not hand back anything that still reaches the
 * connection: the handle, a statement (real or block-scoped), an open
 * `iterate()` cursor, a better-sqlite3 transaction function, or the facade
 * itself. Compile-time half of the confinement; `BlockScopedRawDb` and
 * `BlockScopedRawStatement` are the runtime half, and the runtime half is the
 * load-bearing one — a statement nested inside a returned object passes this
 * type and is still inert.
 */
export type NoLiveSqlite<T> = T extends
  | Database.Database
  | Database.Statement
  | Database.Transaction
  | IterableIterator<unknown>
  | RawDb
  | RawStatement
  ? [resultMustNotOutliveTheBlock: never]
  : [];

/**
 * The `withRawDb` callback contract, both halves at once (#408): it may not be
 * async — a promise-returning callback passes `NoLiveSqlite` (a promise is not
 * a live object) and leaves the lease released with raw work still pending —
 * and it may not hand back anything live. Checked in that order so the more
 * specific message wins for an `async` callback.
 */
export type RawCallbackOnly<T> = T extends PromiseLike<unknown> ? [callbackMustNotBeAsync: never] : NoLiveSqlite<T>;

/**
 * Bumped when a synchronous block starts, so a facade can tell "my block is
 * still running" from "a LATER block is running" — `insideSyncBlock` alone
 * would let a stale facade ride a subsequent block's lease.
 */
let blockEpoch = 0;

/** Shared by both facades: this object's block must still be the running one. */
function assertBlockStillRunning(epoch: number): void {
  if (!insideSyncBlock || epoch !== blockEpoch) throw new RawAccessOutsideSyncBlockError();
}

/**
 * ECMAScript `#private` and not TypeScript `private`, on both facades below.
 *
 * TypeScript's `private` is a compile-time annotation over an ordinary
 * enumerable own property, so `Object.values(facade)[0]`, `{ ...facade }`,
 * `Object.getOwnPropertyNames(facade)` and `JSON.stringify(facade)` all hand
 * back the live `Database`/`Statement` — reflection walks straight past every
 * epoch check the methods perform. `#` fields are a runtime brand: they are not
 * own properties, so none of those paths can see them, and the ONLY way to the
 * connection is through a method that checks the epoch first. `#live()` is
 * private the same way, so the check cannot be skipped by calling the helper
 * off the prototype either.
 */
class BlockScopedRawStatement implements RawStatement {
  readonly #statement: Database.Statement<unknown[]>;
  readonly #epoch: number;

  constructor(statement: Database.Statement<unknown[]>, epoch: number) {
    this.#statement = statement;
    this.#epoch = epoch;
  }

  #live(): Database.Statement<unknown[]> {
    assertBlockStillRunning(this.#epoch);
    return this.#statement;
  }

  run(...params: unknown[]): Database.RunResult {
    return this.#live().run(...params);
  }

  get(...params: unknown[]): unknown {
    return this.#live().get(...params);
  }

  all(...params: unknown[]): unknown[] {
    return this.#live().all(...params);
  }
}

class BlockScopedRawDb implements RawDb {
  readonly #raw: Database.Database;
  readonly #epoch: number;

  constructor(raw: Database.Database, epoch: number) {
    this.#raw = raw;
    this.#epoch = epoch;
  }

  #live(): Database.Database {
    assertBlockStillRunning(this.#epoch);
    return this.#raw;
  }

  prepare(source: string): RawStatement {
    return new BlockScopedRawStatement(this.#live().prepare(source), this.#epoch);
  }

  exec(source: string): void {
    this.#live().exec(source);
  }

  get inTransaction(): boolean {
    return this.#live().inTransaction;
  }
}

/**
 * The handle a raw block reached, remembered for the duration of the enclosing
 * synchronous block.
 *
 * Set only once `withRawDb`'s two checks have passed, which means it is set
 * only when the connection was verifiably NOT in a transaction at that moment.
 * A transaction observed on it at the end of the block was therefore opened BY
 * the block, which is what makes the `withCentralSync` postcondition below able
 * to distinguish "this block left one open" from "one was already open"
 * (the fixture `RawAccessDuringTransactionError` refuses, and never sets this).
 */
let blockRawHandle: Database.Database | undefined;

/**
 * Postcondition for a raw block: the shared connection must be out of any
 * transaction the block opened.
 *
 * A `BEGIN` with no matching `COMMIT`/`ROLLBACK` outlives the lease, so the
 * next `centralTransaction` dies on `BEGIN IMMEDIATE` and unrelated raw
 * statements silently join the abandoned transaction. Rolls back either way;
 * returns the error to throw, or `undefined` when the block already threw —
 * the block's own error is the diagnosis and must not be masked.
 */
function settleStrayTransaction(
  raw: Database.Database,
  site: string,
  blockThrew: boolean,
): RawBlockLeftTransactionOpenError | undefined {
  if (!raw.inTransaction) return undefined;
  try {
    raw.exec('ROLLBACK');
  } catch (error) {
    log.warn('Rolling back a transaction left open by a raw central block failed', {
      site,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (blockThrew) {
    log.warn('A raw central block left a transaction open and then threw; rolled it back', { site });
    return undefined;
  }
  return new RawBlockLeftTransactionOpenError(site);
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
 * The callback gets a `RawDb` facade, not the connection, and every statement
 * it prepares is a `RawStatement` facade over the same epoch check, so nothing
 * that still reaches the connection is live once the block returns —
 * `NoLiveSqlite` is the compile-time hint on top of that runtime guarantee.
 *
 * The third throw is a postcondition rather than a precondition: a callback
 * that issues `BEGIN` (directly, or in a multi-statement `exec`) passes the
 * check above and would leave the transaction open past the lease. It is rolled
 * back on the way out, and reported as `RawBlockLeftTransactionOpenError`
 * unless the callback threw first, in which case the callback's own error wins.
 *
 * `src/db/migrations/index.ts` and the storage-maintenance worker thread are
 * allowlisted raw users that do NOT come through here: they run with no
 * concurrent central-DB activity at all.
 */
export function withRawDb<T>(
  fn: (db: RawDb) => T,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- type-level only
  ..._confined: RawCallbackOnly<T>
): T {
  if (!insideSyncBlock) throw new RawAccessOutsideSyncBlockError();
  const raw = getRawDb();
  if (raw.inTransaction) throw new RawAccessDuringTransactionError();
  blockRawHandle = raw;
  let callbackThrew = true;
  let stray: RawBlockLeftTransactionOpenError | undefined;
  let result!: T;
  try {
    result = fn(new BlockScopedRawDb(raw, blockEpoch));
    if (isThenable(result)) {
      // An `async` callback (#408): its first statement may already have run,
      // but everything after its first await would land outside the lease.
      // The facades refuse that work at runtime; this refuses the shape.
      disownThenable(result, 'The withRawDb callback');
      throw new GuardNotSynchronousError('The withRawDb callback');
    }
    callbackThrew = false;
  } finally {
    stray = settleStrayTransaction(raw, 'The withRawDb() callback', callbackThrew);
  }
  if (stray) throw stray;
  return result;
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
  if (isThenable(decision)) {
    disownThenable(decision, 'The guard');
    throw new GuardNotSynchronousError('The guard');
  }
  return decision;
}

/** Tests only: shorten the >1 s lease-wait WARN threshold. Returns the previous value. */
export function _setWarnThresholdForTests(ms: number): number {
  const previous = leaseWarnMs;
  leaseWarnMs = ms;
  return previous;
}
