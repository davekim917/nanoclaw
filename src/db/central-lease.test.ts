/**
 * The central lease, against the REAL driver.
 *
 * Nothing in `src/db/` is mocked here: the whole point of the primitive is how
 * it composes with `SqliteDriver`'s own transaction machinery (`BEGIN
 * IMMEDIATE`, the `activeTransaction` gate, the `AsyncLocalStorage` scope), and
 * a mock of that is a mock of the thing under test. `initTestDb()` gives an
 * in-memory database, so the suite stays hermetic.
 *
 * See docs/specs/upstream-async-central-db-seam/plan.md §4.5 and §8.6.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import type { RawDb, RawStatement } from './central-lease.js';
import {
  CentralLeaseReentrancyError,
  GuardNotSynchronousError,
  RawAccessDuringTransactionError,
  RawAccessOutsideSyncBlockError,
  RawBlockLeftTransactionOpenError,
  _setWarnThresholdForTests,
  centralTransaction,
  evaluateGuardSync,
  withCentralSync,
  withRawDb,
} from './central-lease.js';
import { closeDb, initTestDb } from './connection.js';
import type { DbDriver } from './driver.js';
/**
 * Upstream's own escape hatch, and the only way a TEST can hold the live
 * connection now that `withRawDb` confines it. Two fixtures need it: the commit
 * spy below, and the open-transaction state the belt refuses. Not `getRawDb()`,
 * which the seam-3 ratchet pins — this is the driver's own accessor, used here
 * to CONSTRUCT the conditions the primitive is supposed to reject.
 */
import { sqliteRaw } from './drivers/sqlite.js';

type ExecFn = (sql: string) => Database.Database;

/** Drain every pending microtask, so "has it got there yet" is not a guess. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Fail loudly instead of hanging when the lease is not handed on. */
function withTimeout<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`central lease deadlock: nothing resolved within ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

let db: DbDriver;

beforeEach(async () => {
  db = await initTestDb();
  await db.exec(`CREATE TABLE lease_probe (id TEXT PRIMARY KEY)`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

describe('the central lease serializes driver transactions against synchronous blocks', () => {
  it('a sync block waits for an open transaction and never observes inTransaction', async () => {
    const calls: string[] = [];

    // A real commit marker. The driver runs COMMIT through `exec` on this exact
    // handle, so wrapping it logs the commit at the instant it happens instead
    // of inferring it from promise-resolution order. Row visibility could not
    // stand in for this: raw and driver share ONE connection, so an uncommitted
    // row would be visible too.
    const raw = sqliteRaw(db);
    const originalExec = raw.exec.bind(raw) as ExecFn;
    (raw as unknown as { exec: ExecFn }).exec = (sql: string) => {
      if (/^\s*COMMIT/i.test(sql)) calls.push('commit');
      return originalExec(sql);
    };

    try {
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });

      const transaction = centralTransaction(async () => {
        await db.run(`INSERT INTO lease_probe (id) VALUES ('A')`);
        calls.push('A');
        await gate;
        await db.run(`INSERT INTO lease_probe (id) VALUES ('B')`);
        calls.push('B');
      }, 'test-transaction');

      await settle();
      await settle();
      expect(calls, 'the transaction should be parked on the gate with A written').toEqual(['A']);

      let syncRan = false;
      let observedInTransaction: boolean | undefined;
      let observedRows: string[] = [];
      const syncBlock = withCentralSync(() => {
        syncRan = true;
        observedInTransaction = withRawDb((r) => r.inTransaction);
        observedRows = withRawDb(
          (r) => r.prepare(`SELECT id FROM lease_probe ORDER BY id`).all() as { id: string }[],
        ).map((row) => row.id);
        calls.push('sync-block');
      }, 'test-sync-block');

      await settle();
      await settle();
      expect(syncRan, 'the sync block must wait: the transaction still holds the lease').toBe(false);
      expect(calls).toEqual(['A']);

      openGate();
      await withTimeout(Promise.all([transaction, syncBlock]));

      expect(calls).toEqual(['A', 'B', 'commit', 'sync-block']);
      expect(observedInTransaction, 'the block runs with no transaction open').toBe(false);
      expect(observedRows, 'and sees the committed rows').toEqual(['A', 'B']);
    } finally {
      delete (raw as unknown as { exec?: ExecFn }).exec;
    }
  });

  it('the lease is FIFO', async () => {
    const order: string[] = [];
    let openGate!: () => void;
    let holderReady!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const held = new Promise<void>((resolve) => {
      holderReady = resolve;
    });

    const holder = centralTransaction(async () => {
      holderReady();
      await gate;
    }, 'holder');
    await withTimeout(held);

    const waiters = ['first', 'second', 'third'].map((name) =>
      withCentralSync(() => {
        order.push(name);
      }, name),
    );

    openGate();
    await withTimeout(Promise.all([holder, ...waiters]));
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('logs a WARN when a waiter waits longer than the threshold', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const previousThreshold = _setWarnThresholdForTests(1);
    try {
      let openGate!: () => void;
      let holderReady!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const held = new Promise<void>((resolve) => {
        holderReady = resolve;
      });

      const holder = centralTransaction(async () => {
        holderReady();
        await gate;
      }, 'slow-holder');
      await withTimeout(held);

      const waiter = withCentralSync(() => 'written', 'patient-writer');
      setTimeout(openGate, 20);
      await withTimeout(Promise.all([holder, waiter]));

      expect(warn).toHaveBeenCalledWith(
        'Central lease wait exceeded 1 s',
        expect.objectContaining({ holder: 'slow-holder', waiter: 'patient-writer' }),
      );
      const [, data] = warn.mock.calls[0] as unknown as [string, { waitedMs: number }];
      expect(data.waitedMs).toBeGreaterThan(1);
    } finally {
      _setWarnThresholdForTests(previousThreshold);
    }
  });

  it('does not warn when the lease is uncontended', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await withCentralSync(() => withRawDb((r) => r.prepare(`SELECT 1`).get()), 'uncontended');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('withRawDb is confined to a synchronous block', () => {
  it('throws RawAccessOutsideSyncBlockError outside a sync block', () => {
    expect(() => withRawDb((r) => r.prepare(`SELECT 1`).get())).toThrow(RawAccessOutsideSyncBlockError);
  });

  it('throws outside a sync block while a driver transaction is open, and the transaction still commits', async () => {
    let openGate!: () => void;
    let inTransaction!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      inTransaction = resolve;
    });

    const transaction = centralTransaction(async () => {
      await db.run(`INSERT INTO lease_probe (id) VALUES ('committed')`);
      inTransaction();
      await gate;
    }, 'open-transaction');
    await withTimeout(reached);

    expect(() => withRawDb((r) => r.prepare(`SELECT 1`).get())).toThrow(RawAccessOutsideSyncBlockError);

    openGate();
    await withTimeout(transaction);
    expect(await db.get(`SELECT id FROM lease_probe WHERE id = 'committed'`)).toEqual({ id: 'committed' });
  });

  it('throws RawAccessDuringTransactionError when the raw handle is in a transaction', async () => {
    // Constructed directly on the live handle: under the lease this state is
    // unreachable, which is exactly why the belt needs its own fixture rather
    // than a scenario.
    const raw = sqliteRaw(db);
    raw.exec('BEGIN');
    try {
      await withCentralSync(() => {
        expect(() => withRawDb((r) => r.prepare(`SELECT 1`).get())).toThrow(RawAccessDuringTransactionError);
      }, 'belt-fixture');
    } finally {
      raw.exec('ROLLBACK');
    }
  });

  it('refuses to hand back anything that still reaches the connection', async () => {
    await withCentralSync(() => {
      // @ts-expect-error — NoLiveSqlite refuses the facade itself
      withRawDb((r) => r);
      // @ts-expect-error — NoLiveSqlite refuses a prepared statement
      withRawDb((r) => r.prepare(`SELECT 1`));
      // @ts-expect-error — and the connection is not even reachable from the
      // statement facade, which has no `database`
      withRawDb((r) => r.prepare(`SELECT 1`).database);
      // Reading a ROW out of the block is the whole point, and still compiles.
      expect(withRawDb((r) => r.prepare(`SELECT 1 AS ok`).get())).toEqual({ ok: 1 });
    }, 'confinement');
  });

  it('a facade captured inside a block is inert once the block returns', async () => {
    let escaped: RawDb | undefined;
    await withCentralSync(() => {
      withRawDb((r) => {
        escaped = r;
      });
    }, 'capture');

    expect(() => escaped?.prepare(`SELECT 1`)).toThrow(RawAccessOutsideSyncBlockError);
    expect(() => escaped?.exec(`SELECT 1`)).toThrow(RawAccessOutsideSyncBlockError);
    expect(() => escaped?.inTransaction).toThrow(RawAccessOutsideSyncBlockError);

    // And it does not come back to life on a LATER block's lease.
    await withCentralSync(() => {
      expect(() => escaped?.prepare(`SELECT 1`)).toThrow(RawAccessOutsideSyncBlockError);
    }, 'a-different-block');
  });

  it('run/get/all still work through the statement facade inside the block', async () => {
    const rows = await withCentralSync(
      () =>
        withRawDb((r) => {
          r.prepare(`INSERT INTO lease_probe (id) VALUES (?)`).run('facade');
          expect(r.prepare(`SELECT id FROM lease_probe WHERE id = ?`).get('facade')).toEqual({ id: 'facade' });
          return r.prepare(`SELECT id FROM lease_probe ORDER BY id`).all() as { id: string }[];
        }),
      'facade-io',
    );
    expect(rows).toEqual([{ id: 'facade' }]);
  });

  it('a statement captured into an outer variable is inert once the block returns', async () => {
    // The escape `NoLiveSqlite` cannot see: the block returns nothing, and the
    // statement leaves through an assignment instead.
    let escaped: RawStatement | undefined;
    await withCentralSync(() => {
      withRawDb((r) => {
        escaped = r.prepare(`SELECT 1 AS ok`);
      });
    }, 'statement-capture');

    expect(() => escaped?.get()).toThrow(RawAccessOutsideSyncBlockError);
    expect(() => escaped?.all()).toThrow(RawAccessOutsideSyncBlockError);
    expect(() => escaped?.run()).toThrow(RawAccessOutsideSyncBlockError);

    // And it cannot ride a LATER block's lease either.
    await withCentralSync(() => {
      expect(() => escaped?.get()).toThrow(RawAccessOutsideSyncBlockError);
    }, 'a-later-block');
  });

  it('a statement returned nested inside an object is inert too', async () => {
    // `NoLiveSqlite` passes this shape — an object is not a statement — so the
    // epoch check is the only thing standing between the caller and a live
    // statement on the shared connection.
    const smuggled = await withCentralSync(
      () => withRawDb((r) => ({ statement: r.prepare(`SELECT 1 AS ok`) })),
      'nested-capture',
    );
    expect(() => smuggled.statement.get()).toThrow(RawAccessOutsideSyncBlockError);
  });

  it('neither facade exposes the live sqlite object to reflection', async () => {
    /** Anything with a `prepare` or `run` method is a live better-sqlite3 object. */
    const reachesSqlite = (value: unknown): boolean =>
      typeof value === 'object' &&
      value !== null &&
      (typeof (value as { prepare?: unknown }).prepare === 'function' ||
        typeof (value as { run?: unknown }).run === 'function');

    await withCentralSync(() => {
      withRawDb((r) => {
        const statement = r.prepare(`SELECT 1 AS ok`);
        const facades: readonly [string, RawDb | RawStatement][] = [
          ['RawDb', r],
          ['RawStatement', statement],
        ];

        for (const [name, facade] of facades) {
          const asRecord = facade as unknown as Record<string, unknown>;
          // `#private` fields are not own properties; TypeScript `private`
          // would put the live handle right here.
          expect(Object.getOwnPropertyNames(facade), `${name} has own properties`).toEqual([]);
          expect(Object.keys(facade), `${name} has enumerable keys`).toEqual([]);
          expect(JSON.stringify(facade), `${name} serializes state`).toBe('{}');

          const reachable: unknown[] = [...Object.values(asRecord), ...Object.values({ ...asRecord })];
          expect(reachable.filter(reachesSqlite), `${name} leaks a live sqlite object`).toEqual([]);
        }
      });
    }, 'reflection');
  });
});

describe('a raw block may not leave a transaction open', () => {
  it('rolls back and throws when the callback opens a transaction and returns', async () => {
    await expect(
      withTimeout(
        withCentralSync(() => {
          withRawDb((r) => {
            r.exec('BEGIN');
          });
        }, 'stray-begin'),
      ),
    ).rejects.toBeInstanceOf(RawBlockLeftTransactionOpenError);

    expect(sqliteRaw(db).inTransaction, 'the abandoned transaction is rolled back').toBe(false);

    // And the connection is usable: without the rollback this would die on
    // "cannot start a transaction within a transaction".
    await withTimeout(
      centralTransaction(async () => {
        await db.run(`INSERT INTO lease_probe (id) VALUES ('after-stray')`);
      }, 'after-stray'),
    );
    expect(await db.get(`SELECT id FROM lease_probe WHERE id = 'after-stray'`)).toEqual({ id: 'after-stray' });
  });

  it("rethrows the callback's own error, unmasked, when it throws after opening one", async () => {
    class CallbackBoom extends Error {}

    await expect(
      withTimeout(
        withCentralSync(() => {
          // Explicit `void`: a callback that only throws infers `never`, and
          // `NoLiveSqlite<never>` distributes to `never` for the rest parameter.
          withRawDb<void>((r) => {
            r.exec('BEGIN');
            throw new CallbackBoom('the callback failed mid-transaction');
          });
        }, 'stray-begin-then-throw'),
      ),
    ).rejects.toBeInstanceOf(CallbackBoom);

    expect(sqliteRaw(db).inTransaction, 'rolled back on the way out all the same').toBe(false);
  });

  it('catches a BEGIN issued through a facade after its withRawDb call returned', async () => {
    // Same block, so the epoch still matches and the facade is still live: the
    // per-callback postcondition cannot see this one, the block-level one can.
    await expect(
      withTimeout(
        withCentralSync(() => {
          let stillLive!: RawDb;
          withRawDb((r) => {
            stillLive = r;
          });
          stillLive.exec('BEGIN');
        }, 'same-block-begin'),
      ),
    ).rejects.toBeInstanceOf(RawBlockLeftTransactionOpenError);

    expect(sqliteRaw(db).inTransaction).toBe(false);
  });
});

describe('a synchronous contract that a cast cannot escape', () => {
  it('rejects a thenable withCentralSync block at runtime', async () => {
    await expect(withCentralSync((() => Promise.resolve('nope')) as unknown as () => string)).rejects.toBeInstanceOf(
      GuardNotSynchronousError,
    );
  });

  it('rejects an async withCentralSync block at compile time', async () => {
    // @ts-expect-error — SyncBlockOnly<Promise<number>> demands an argument no caller can produce
    const rejected = withCentralSync(async () => 1);
    await expect(rejected).rejects.toBeInstanceOf(GuardNotSynchronousError);
  });

  /**
   * `await` adopts a function object carrying a `then`, and the compile-time
   * `PromiseLike` check calls it async — so an object-only runtime test
   * (`typeof value === 'object'`) disagrees with both: it hands the value back
   * as a truthy SYNCHRONOUS decision and releases the lease around a result
   * still due to resolve. Two cases, so each entry point fails on its own.
   */
  const callableThenable = (): unknown => Object.assign(() => true, { then: () => undefined });

  it('rejects a CALLABLE thenable guard, which `typeof value === "object"` alone misses', () => {
    expect(() => evaluateGuardSync(callableThenable)).toThrow(GuardNotSynchronousError);
  });

  it('rejects a withCentralSync block returning a CALLABLE thenable', async () => {
    await expect(
      withTimeout(withCentralSync(callableThenable as unknown as () => string, 'callable-thenable-block')),
    ).rejects.toBeInstanceOf(GuardNotSynchronousError);
  });

  it('rejects a cast async guard in evaluateGuardSync', () => {
    type WriteGuard = () => 'allow' | 'refuse';
    const castAsyncGuard = (async () => 'allow') as unknown as WriteGuard;
    expect(() => evaluateGuardSync(castAsyncGuard)).toThrow(GuardNotSynchronousError);
    expect(evaluateGuardSync<'allow' | 'refuse'>(() => 'allow')).toBe('allow');
  });
});

describe('the lease is not re-entrant', () => {
  it('throws CentralLeaseReentrancyError for a transaction inside a transaction, without deadlocking', async () => {
    await expect(
      withTimeout(
        centralTransaction(async () => {
          await centralTransaction(async () => undefined, 'inner');
        }, 'outer'),
      ),
    ).rejects.toBeInstanceOf(CentralLeaseReentrancyError);
  });

  it('throws for a sync block opened inside a transaction closure', async () => {
    await expect(
      withTimeout(
        centralTransaction(async () => {
          await withCentralSync(() => 1, 'inner-sync');
        }, 'outer'),
      ),
    ).rejects.toBeInstanceOf(CentralLeaseReentrancyError);
  });

  it('refuses a transaction opened inside a synchronous block, on both halves', async () => {
    // A synchronous block cannot await, so the nested call fails twice over:
    // the block hands back a promise (GuardNotSynchronousError), and the nested
    // call itself sees the sync-block marker and rejects rather than queueing
    // behind a lease its own caller is holding.
    let inner: Promise<unknown> | undefined;
    const block = (() => {
      inner = centralTransaction(async () => undefined, 'inner');
      return inner;
    }) as unknown as () => void;

    await expect(withTimeout(withCentralSync(block, 'outer-sync'))).rejects.toBeInstanceOf(GuardNotSynchronousError);
    await expect(inner).rejects.toBeInstanceOf(CentralLeaseReentrancyError);
  });

  it('leaves the lease free after a re-entrancy rejection', async () => {
    await expect(
      withTimeout(
        centralTransaction(async () => {
          await centralTransaction(async () => undefined, 'inner');
        }, 'outer'),
      ),
    ).rejects.toBeInstanceOf(CentralLeaseReentrancyError);
    await expect(withTimeout(withCentralSync(() => 'free', 'after'))).resolves.toBe('free');
  });
});
