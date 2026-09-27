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
 * TRANSITIONAL synchronous handle on the central DB (fork-local), deleted once the last caller is async. The set of
 * importing files is pinned shrink-only by `src/db/raw-db-ratchet.test.ts`. A raw statement bypasses the driver's
 * `activeTransaction` gate, so it silently joins any driver transaction that is open.
 */
export function getRawDb(): Database.Database {
  return sqliteRaw(getDb());
}

function defaultConfig(): DbConfig {
  return { path: CENTRAL_DB_PATH };
}

/**
 * Unlike upstream, replaces an existing `_db` instead of throwing: many test hooks call `initTestDb()` without
 * closing the previous in-memory DB.
 */
export async function initDb(
  target: string | Partial<DbConfig> = CENTRAL_DB_PATH,
  options: DbInitOptions = { role: 'runtime' },
): Promise<DbDriver> {
  const config = { ...defaultConfig(), ...(typeof target === 'string' ? { path: target } : target) };
  _db = await createDbDriver(config, options);
  // `test` and `tool` roles stay silent; `path` is kept so operator greps still match.
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
 * For tests only: in-memory, no migrations (the caller runs them). Goes through `initDb` so composition and driver
 * registry match production.
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
