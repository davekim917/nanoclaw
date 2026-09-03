/**
 * Fork-local TYPE-ONLY shim for the upstream `DbDriver` type. Zero runtime exports —
 * a `type` alias only, nothing to import at runtime, nothing to grow.
 *
 * Upstream's ported `src/host-lifecycle.ts` (docs/specs/upstream-host-sweep-seam/plan.md
 * §4.1, S2-PR0) imports `type { DbDriver } from './db/driver.js'`. Upstream's real
 * `src/db/driver.ts` is a full async interface (`upstream/main:src/db/driver.ts:49-63`);
 * the fork has no such module — `initDb()` (src/db/connection.ts:14) returns
 * better-sqlite3's synchronous `Database.Database` handle directly, and every fork call
 * site is sync. This file stands in for upstream's async `src/db/driver.ts` ONLY so the
 * byte-identical upstream port type-checks against the fork's actual sync handle.
 *
 * `HostStartContext.db` therefore carries the fork's sync `Database.Database` — every
 * fork module using it today keeps working unchanged, and there is no async migration
 * implied by this file's existence. `src/host-lifecycle.ts` is the ONLY sanctioned
 * importer (enforced by src/host-lifecycle-seam.test.ts's "the DbDriver shim has exactly
 * one importer" case) — nobody else should depend on this alias, since it is a stand-in,
 * not a real driver abstraction.
 *
 * Fork-owned — NOT part of the upstream manifest (src/host-lifecycle-seam-manifest.ts).
 * REPLACED, not extended, by upstream's real async driver when the DbDriver seam is
 * ported later in the upstream convergence program (see
 * docs/specs/upstream-host-sweep-seam/plan.md §2, the "Depends on the async DbDriver" row).
 */
import type Database from 'better-sqlite3';

export type DbDriver = Database.Database;
