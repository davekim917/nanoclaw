import Database from 'better-sqlite3';

import { CENTRAL_DB_PATH } from '../config.js';
import { log } from '../log.js';
import type { DbConfig, DbDriver, DbInitOptions } from './driver.js';
import { createDbDriver } from './driver-registry.js';
import { sqliteRaw } from './drivers/sqlite.js';

import './compose.js';

let _db: DbDriver | null = null;

export function getDb(): DbDriver {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

/**
 * TRANSITIONAL synchronous handle on the central DB — fork-local, not upstream.
 *
 * `sqliteRaw` is upstream's own escape hatch (`drivers/sqlite.ts`, used by its
 * migration runner for `sqliteOnly` migrations), so this is upstream-sanctioned
 * rather than a bypass. It exists because the fork's call sites are all
 * synchronous today and convert leaf-by-leaf across seam 3 (PRs 3-5); it is
 * DELETED in PR 6 once the last one is async.
 *
 * The set of files importing it is pinned by `src/db/raw-db-ratchet.test.ts`:
 * entries may be removed, never added. A raw statement bypasses the driver's
 * `activeTransaction` gate, so it is only safe while the fork opens ZERO driver
 * transactions — which is why every fork transaction stays a raw synchronous
 * `db.transaction(() => …)()` closure until PR 6 lands the central lease
 * (docs/specs/upstream-async-central-db-seam/plan.md §4.1).
 */
export function getRawDb(): Database.Database {
  return sqliteRaw(getDb());
}

function defaultConfig(): DbConfig {
  return { path: CENTRAL_DB_PATH };
}

/**
 * Fork delta vs upstream: upstream throws when `_db` is already set. The fork
 * keeps the pre-seam behavior of replacing it, because ~150 test sites call
 * `initTestDb()` in a `beforeEach` without closing the previous in-memory
 * database first; throwing there would be a semantic change, and this PR makes
 * none. The previous handle is left to the garbage collector exactly as before.
 */
export async function initDb(
  target: string | Partial<DbConfig> = CENTRAL_DB_PATH,
  options: DbInitOptions = { role: 'runtime' },
): Promise<DbDriver> {
  const config = { ...defaultConfig(), ...(typeof target === 'string' ? { path: target } : target) };
  _db = await createDbDriver(config, options);
  // `role: 'test'` stays silent (and `'tool'` as upstream has it): the fork's
  // pre-seam `initTestDb()` logged nothing, and the host suite runs it in
  // roughly 150 hooks. The `path` key is kept from the fork's line so an
  // operator grep for it still matches; `dialect`/`role` are upstream's.
  if (options.role !== 'tool' && options.role !== 'test') {
    log.info('Central DB initialized', {
      path: config.url ? 'configured remote target' : config.path,
      dialect: _db.dialect,
      role: options.role,
    });
  }
  return _db;
}

/**
 * For tests only — in-memory database, no migrations (the caller runs them).
 *
 * Goes through `initDb` so the composition and the driver registry are the same
 * code path production uses. Against the SQLite driver this is behaviorally
 * identical to the pre-seam body (`new Database(':memory:')` +
 * `foreign_keys = ON`): `compose.ts` additionally sets `journal_mode = WAL`,
 * which SQLite ignores for an in-memory database. Upstream's
 * `prepareTestSchema` branch is omitted — `SqliteDriver` does not implement that
 * hook, so it is dead code here, and the fork's `runMigrations` is still
 * synchronous until PR 2.
 */
export async function initTestDb(): Promise<DbDriver> {
  return initDb(':memory:', { role: 'test' });
}

export async function closeDb(): Promise<void> {
  const current = _db;
  _db = null;
  await current?.close();
}

/**
 * Check whether a table exists. Used by core code that touches
 * module-owned tables so that an uninstalled module degrades silently
 * instead of raising SQLite errors. Each driver owns the dialect-specific
 * lookup and a positive-only cache; creating a fresh test driver or closing
 * the current driver resets it.
 */
export async function hasTable(db: DbDriver, name: string): Promise<boolean> {
  return db.hasTable(name);
}

/**
 * TRANSITIONAL synchronous `hasTable` — the fork's pre-seam body, renamed.
 *
 * The async `hasTable` above cannot be dropped into the fork's call sites: they
 * are all `if (!hasTable(...))` truthiness guards, and `!promise` is always
 * `false`, so every module-degradation guard would invert silently. The sites
 * convert with their owning leaf in PR 4; this function goes with the last one.
 *
 * Cheap: a single indexed lookup on sqlite_master. Results are not cached — a
 * module install adds the table at runtime (next service start), and callers may
 * run before or after that boundary.
 */
export function hasTableRaw(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`).get(name) as
    | { '1': number }
    | undefined;
  return row !== undefined;
}
