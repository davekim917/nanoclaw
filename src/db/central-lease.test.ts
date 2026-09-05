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
import {
  CentralLeaseReentrancyError,
  GuardNotSynchronousError,
  RawAccessDuringTransactionError,
  RawAccessOutsideSyncBlockError,
  _setWarnThresholdForTests,
  centralTransaction,
  evaluateGuardSync,
  withCentralSync,
  withRawDb,
} from './central-lease.js';
import { closeDb, initTestDb } from './connection.js';
import type { DbDriver } from './driver.js';

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
    const raw = await withCentralSync(() => withRawDb((r) => r));
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
    await withCentralSync(() => {
      // Constructed directly: under the lease this state is unreachable, which
      // is exactly why the belt needs its own fixture rather than a scenario.
      const raw = withRawDb((r) => r);
      raw.exec('BEGIN');
      try {
        expect(() => withRawDb((r) => r.prepare(`SELECT 1`).get())).toThrow(RawAccessDuringTransactionError);
      } finally {
        raw.exec('ROLLBACK');
      }
    }, 'belt-fixture');
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
