import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fork-only acceptance cases for theme T2 PR 4 (generic-CRUD portability):
// natural-key NULL matching, list-filter coercion by column type, and the
// portable `listOrder`. Kept out of upstream-owned `crud.test.ts` so the
// upstream ratchet does not grow; seeded through `initMigratedTestDb()`.

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
}));

import { initMigratedTestDb, closeDb, getRawDb } from '../db/index.js';
import { registerResource } from './crud.js';
import { lookup } from './registry.js';

const hostCtx = { caller: 'host' as const };

// Synthetic resource for the generic-CRUD portability cases (theme T2 PR 4):
// a nullable natural-key column (case 15), and columns covering every
// `coerceListFilter` arm — boolean/number/json (cases 16, 17). Table created
// per-test in the describe's beforeEach, mirroring the hooktest_rows pattern in crud.test.ts.
registerResource({
  name: 'crudtest',
  plural: 'crudtests',
  table: 'crudtest_rows',
  description: 'Synthetic resource for natural-key and list-filter portability tests.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'scope', type: 'string', description: 'nullable natural-key component' },
    { name: 'name', type: 'string', description: 'required natural-key component', required: true },
    { name: 'enabled', type: 'boolean', description: 'boolean filter column' },
    { name: 'score', type: 'number', description: 'numeric filter column' },
    { name: 'payload', type: 'json', description: 'json filter column' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  naturalKey: ['scope', 'name'],
  operations: { list: 'open', create: 'open' },
});

// Synthetic resource with an explicit `listOrder`, distinct from crudtest's
// default-timestamp-DESC form (case 18's override half).
registerResource({
  name: 'ordertest',
  plural: 'ordertests',
  table: 'ordertest_rows',
  description: 'Synthetic resource for the explicit listOrder override test.',
  idColumn: 'id',
  listOrder: 'seq ASC, id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'seq', type: 'number', description: 'explicit sort key', required: true },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', create: 'open' },
});

beforeEach(async () => {
  await initMigratedTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe('genericCreate natural-key lookup — NULL matching (case 15)', () => {
  beforeEach(() => {
    getRawDb().exec(
      `CREATE TABLE crudtest_rows (
         id TEXT PRIMARY KEY, scope TEXT, name TEXT NOT NULL,
         enabled INTEGER, score INTEGER, payload TEXT, created_at TEXT NOT NULL
       )`,
    );
  });

  it('idempotent create matches on a NULL natural-key column', async () => {
    // `scope` is left unset (no default), so it lands as NULL in the row.
    const first = (await lookup('crudtests-create')!.handler({ name: 'alpha' }, hostCtx)) as { id: string };
    const second = (await lookup('crudtests-create')!.handler({ name: 'alpha' }, hostCtx)) as { id: string };
    expect(second.id).toBe(first.id);
    const count = getRawDb().prepare('SELECT COUNT(*) AS n FROM crudtest_rows').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('a non-NULL natural key still matches normally', async () => {
    const first = (await lookup('crudtests-create')!.handler({ name: 'beta', scope: 'x' }, hostCtx)) as {
      id: string;
    };
    const second = (await lookup('crudtests-create')!.handler({ name: 'beta', scope: 'x' }, hostCtx)) as {
      id: string;
    };
    expect(second.id).toBe(first.id);
  });

  it('a different scope value with the same name is a distinct row', async () => {
    const a = (await lookup('crudtests-create')!.handler({ name: 'gamma', scope: 'x' }, hostCtx)) as { id: string };
    const b = (await lookup('crudtests-create')!.handler({ name: 'gamma', scope: 'y' }, hostCtx)) as { id: string };
    expect(b.id).not.toBe(a.id);
  });
});

describe('genericList coerceListFilter (cases 16, 17)', () => {
  beforeEach(() => {
    getRawDb().exec(
      `CREATE TABLE crudtest_rows (
         id TEXT PRIMARY KEY, scope TEXT, name TEXT NOT NULL,
         enabled INTEGER, score INTEGER, payload TEXT, created_at TEXT NOT NULL
       )`,
    );
  });

  it('a boolean list filter matches integer storage (case 16)', async () => {
    // Values arrive as strings from argv, same as any other CLI flag — the
    // boolean coercion genericCreate does on write is unchanged by this PR;
    // seed the rows directly so this test isolates `list`'s read-side
    // coercion (case 16).
    getRawDb()
      .prepare('INSERT INTO crudtest_rows (id, name, enabled, created_at) VALUES (?, ?, ?, ?)')
      .run('row-a', 'a', 1, new Date().toISOString());
    getRawDb()
      .prepare('INSERT INTO crudtest_rows (id, name, enabled, created_at) VALUES (?, ?, ?, ?)')
      .run('row-b', 'b', 0, new Date().toISOString());
    const rows = (await lookup('crudtests-list')!.handler({ enabled: 'true' }, hostCtx)) as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['a']);
  });

  it('a numeric list filter rejects a non-number (case 17)', async () => {
    await lookup('crudtests-create')!.handler({ name: 'a', score: 5 }, hostCtx);
    await expect(lookup('crudtests-list')!.handler({ score: 'not-a-number' }, hostCtx)).rejects.toThrow(
      'must be a number',
    );
  });

  it('a numeric list filter matches on the coerced number (case 17)', async () => {
    await lookup('crudtests-create')!.handler({ name: 'a', score: 5 }, hostCtx);
    await lookup('crudtests-create')!.handler({ name: 'b', score: 9 }, hostCtx);
    const rows = (await lookup('crudtests-list')!.handler({ score: '5' }, hostCtx)) as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['a']);
  });

  it('a json list filter serializes the filter value (case 17)', async () => {
    await lookup('crudtests-create')!.handler({ name: 'a', payload: '{"k":1}' }, hostCtx);
    const rows = (await lookup('crudtests-list')!.handler({ payload: '{"k":1}' }, hostCtx)) as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['a']);
  });
});

describe('genericList listOrder (cases 18, 19)', () => {
  beforeEach(() => {
    getRawDb().exec(
      `CREATE TABLE crudtest_rows (
         id TEXT PRIMARY KEY, scope TEXT, name TEXT NOT NULL,
         enabled INTEGER, score INTEGER, payload TEXT, created_at TEXT NOT NULL
       )`,
    );
    getRawDb().exec(
      `CREATE TABLE ordertest_rows (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, created_at TEXT NOT NULL)`,
    );
  });

  it('generic list orders by the resource timestamp column, newest first (case 18)', async () => {
    const a = (await lookup('crudtests-create')!.handler({ name: 'a' }, hostCtx)) as {
      id: string;
      created_at: string;
    };
    await new Promise((r) => setTimeout(r, 2));
    const b = (await lookup('crudtests-create')!.handler({ name: 'b' }, hostCtx)) as {
      id: string;
      created_at: string;
    };
    const rows = (await lookup('crudtests-list')!.handler({}, hostCtx)) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('a resource with an explicit listOrder uses it instead of the default (case 18)', async () => {
    // Insertion order is REVERSE of `seq` — if the default timestamp order
    // were used instead of the declared `listOrder: 'seq ASC, id'`, this
    // would come back newest-created-first (3, 2, 1), not seq-ascending.
    await lookup('ordertests-create')!.handler({ seq: 3 }, hostCtx);
    await lookup('ordertests-create')!.handler({ seq: 1 }, hostCtx);
    await lookup('ordertests-create')!.handler({ seq: 2 }, hostCtx);
    const rows = (await lookup('ordertests-list')!.handler({}, hostCtx)) as { seq: number }[];
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('a LIMIT still cannot hide the newest rows under the timestamp form (case 19)', async () => {
    // Same regression `ORDER BY rowid DESC` was introduced to fix
    // (crud.ts:189-191), re-pinned against the `listOrder(def)` timestamp
    // form: insert several rows and confirm a small `--limit` still returns
    // the newest one, not an arbitrary storage-order slice.
    let last: { id: string } | undefined;
    for (let i = 0; i < 5; i++) {
      last = (await lookup('crudtests-create')!.handler({ name: `row-${i}` }, hostCtx)) as { id: string };
      // Distinct millisecond timestamps so `created_at DESC` orders
      // deterministically instead of falling through to the random-UUID
      // `id` tiebreak on a timestamp tie.
      await new Promise((r) => setTimeout(r, 2));
    }
    const rows = (await lookup('crudtests-list')!.handler({ limit: 1 }, hostCtx)) as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(last!.id);
  });
});
