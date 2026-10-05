/**
 * The central-DB lease: makes driver transactions and synchronous central blocks mutually exclusive on the ONE shared
 * connection.
 * A `DbDriver` transaction yields at every await, while some paths must stay synchronous forever (the
 * wake/write/agent-route guards, `withQuietInvalidationSync`, the agent-to-agent destination replace). A raw
 * statement landing in a transaction's suspension window would silently join the open `BEGIN IMMEDIATE` and roll back
 * with it, or fail with "cannot start a transaction within a transaction". Both sides take this lease, so a sync
 * block waits its turn instead of refusing.
 * `centralTransaction(fn)`: lease around `getDb().transaction(fn)`. `withCentralSync(fn)`: lease around a synchronous
 * block. `withRawDb(fn)`: the connection, confined to such a block. `evaluateGuardSync(g)`: rejects a thenable guard
 * result. Non-transactional driver `get`/`all`/`run` do not take the lease; they never open a transaction.
 * No deadlock: a sync-block holder cannot await, and a transaction closure may await only driver calls (enforced by
 * `src/db/transaction-closures-tripwire.test.ts`); re-entry throws immediately.
 */
import type Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';

import { log } from '../log.js';
import { getDb, getRawDb } from './connection.js';

export type SyncBlockOnly<T> = T extends PromiseLike<unknown> ? [blockMustNotBeAsync: never] : [];

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

export class RawAccessOutsideSyncBlockError extends Error {
  constructor() {
    super(
      'withRawDb() is only usable inside withCentralSync(). Outside the lease a raw statement can land in ' +
        'an open driver transaction and silently join it; use getDb() and await, or take the lease.',
    );
    this.name = 'RawAccessOutsideSyncBlockError';
  }
}

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
 * Thenable as `await` sees it, including a CALLABLE thenable (`typeof` is 'function'); an object-only test would
 * treat it as a synchronous result.
 */
/**
 * The thenable is still a live promise: its rejection is consumed and logged here, or it would surface as an
 * `unhandledRejection` (a process exit) after the caller already caught the intended error.
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
 * FIFO async mutex, like upstream's private `AsyncMutex` in `drivers/shared.ts`. The tail advances synchronously
 * inside `acquire()`, before its first await, so order is submission order.
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
      // A DB-only closure should never hold the lease this long; the warn is the tripwire for a closure that grew a
      // non-DB effect.
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
 * `AsyncLocalStorage`, not a flag: a transaction closure suspends at every await, and the marker must survive its
 * continuations while staying invisible to unrelated work.
 */
const transactionHolder = new AsyncLocalStorage<string>();

/**
 * A plain boolean, not `AsyncLocalStorage`: the block is synchronous, so the flag is exact, while AsyncLocalStorage
 * would leak into callbacks the block schedules, which run after release and must be refused. Saved and restored
 * rather than cleared.
 */
let insideSyncBlock = false;

function assertLeaseNotHeld(entry: string): void {
  const held = transactionHolder.getStore();
  if (held !== undefined) throw new CentralLeaseReentrancyError(entry, `transaction: ${held}`);
  if (insideSyncBlock) throw new CentralLeaseReentrancyError(entry, 'synchronous block');
}

/**
 * The ONLY sanctioned caller of `DbDriver.transaction` (enforced by `src/db/transaction-closures-tripwire.test.ts`). The
 * closure must issue DB calls sequentially and contain no non-DB effect (mailbox write, container op, adapter call,
 * `fetch`); those belong after it resolves.
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
 * Runs a synchronous block with no transaction open and nothing able to interleave, so a guard and the statement it
 * protects are one indivisible turn. Async blocks are rejected at compile time and again at runtime.
 * The stray-transaction postcondition runs again here: a facade or statement prepared earlier in the SAME block is
 * still live after its `withRawDb` returns, so a `BEGIN` through it would otherwise outlive the lease.
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
    // Settled BEFORE the lease is handed on, but thrown after the try/finally, so a stray BEGIN neither swallows the
    // block's own error nor leaks the lease.
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
 * A statement holds its own reference to the connection, so a real one escaping the block (returned inside an object,
 * assigned to an outer variable) could run after release inside the next holder's transaction. Every method re-checks
 * the block epoch at RUNTIME; `NoLiveSqlite` only sees the top-level return type. `pluck`/`iterate`/`raw` are absent:
 * no allowlisted caller needs them and `iterate` would hand out a cursor that outlives the block.
 */
export interface RawStatement {
  run(...params: unknown[]): Database.RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * A facade rather than the handle, so a stashed reference is inert once the block returns and never revives on a
 * later block's lease.
 */
export interface RawDb {
  prepare(source: string): RawStatement;
  exec(source: string): void;
  readonly inTransaction: boolean;
}

/**
 * For leaves that take the connection AS A PARAMETER: prepared statements only, so they cannot open a transaction the
 * lease does not know about. Satisfied by the facade and by legitimately bare handles (boot reconcilers, the storage
 * maintenance worker's own connection).
 */
export interface RawStatements {
  prepare(source: string): RawStatement;
}

/**
 * Compile-time half of the confinement; the runtime facades are the load-bearing half (a statement nested in a
 * returned object passes this type and is still inert).
 */
type NoLiveSqlite<T> = T extends
  | Database.Database
  | Database.Statement
  | Database.Transaction
  | IterableIterator<unknown>
  | RawDb
  | RawStatement
  ? [resultMustNotOutliveTheBlock: never]
  : [];

/**
 * Rejects an async callback first (a promise passes `NoLiveSqlite` but leaves raw work pending after release), then
 * anything live.
 */
export type RawCallbackOnly<T> = T extends PromiseLike<unknown> ? [callbackMustNotBeAsync: never] : NoLiveSqlite<T>;

/**
 * Lets a facade tell its own block from a LATER one; `insideSyncBlock` alone would let a stale facade ride a later
 * lease.
 */
let blockEpoch = 0;

function assertBlockStillRunning(epoch: number): void {
  if (!insideSyncBlock || epoch !== blockEpoch) throw new RawAccessOutsideSyncBlockError();
}

/**
 * ECMAScript `#private`, not TypeScript `private`: TS `private` is an ordinary own property, so `Object.values`,
 * spread, `getOwnPropertyNames` and `JSON.stringify` would hand out the live `Database`/`Statement` past every epoch
 * check.
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
 * Set only after `withRawDb`'s checks prove no transaction was open, so a transaction seen at block end was opened BY
 * the block.
 */
let blockRawHandle: Database.Database | undefined;

/**
 * A `BEGIN` left open outlives the lease: the next `centralTransaction` dies on `BEGIN IMMEDIATE` and unrelated raw
 * statements join the abandoned transaction. Rolls back either way; returns the error to throw, or undefined when the
 * block already threw (its error wins).
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
 * The synchronous handle, inside a `withCentralSync` block only: outside one the statement could land inside an open
 * driver transaction. Inside, an open transaction is unreachable by construction, so the `inTransaction` check is a
 * belt. The callback gets facades that are inert once the block returns. A callback that issues `BEGIN` is rolled
 * back on the way out and reported, unless it threw first.
 * `src/db/migrations/index.ts` and the storage-maintenance worker are allowlisted raw users that bypass this: they
 * run with no concurrent central-DB activity.
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
      // Everything after an async callback's first await would land outside the lease.
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
 * The guards read the central DB and must never be awaited. The write guard runs inside `withExistingMailboxSession`,
 * whose action type admits promises, so THIS is the enforcing check: an async guard would otherwise return a truthy
 * promise read as "allowed".
 */
export function evaluateGuardSync<R>(guard: () => R): R {
  const decision = guard();
  if (isThenable(decision)) {
    disownThenable(decision, 'The guard');
    throw new GuardNotSynchronousError('The guard');
  }
  return decision;
}

export function _setWarnThresholdForTests(ms: number): number {
  const previous = leaseWarnMs;
  leaseWarnMs = ms;
  return previous;
}
