/**
 * Fork-local type shim for the upstream `DbDriver` type.
 *
 * Upstream's ported `src/host-lifecycle.ts` (docs/specs/upstream-host-sweep-seam/plan.md
 * §4.1, S2-PR0) imports `type { DbDriver } from './db/driver.js'`. Upstream's DbDriver is
 * a real async interface (`upstream/main:src/db/driver.ts:49-63`); the fork has no such
 * type — `initDb()` (src/db/connection.ts:14) returns better-sqlite3's synchronous
 * `Database.Database` handle directly, and every fork call site is sync.
 *
 * This file exists ONLY so the byte-identical upstream port type-checks: `DbDriver` here
 * is an alias for the fork's actual sync handle, not upstream's async contract.
 * `HostStartContext.db` therefore carries the fork's sync `Database.Database` — every
 * fork module using it today keeps working unchanged, and there is no async migration
 * implied by this file's existence.
 *
 * Fork-owned — NOT part of the upstream manifest (src/host-lifecycle-seam-manifest.ts).
 * Replaced by upstream's real async driver in the async-DB seam, scheduled later in the
 * upstream convergence program (see docs/specs/upstream-host-sweep-seam/plan.md §2, the
 * "Depends on the async DbDriver" row).
 */
import type Database from 'better-sqlite3';

export type DbDriver = Database.Database;
