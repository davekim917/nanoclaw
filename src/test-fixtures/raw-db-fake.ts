/**
 * Shared test fake for the transitional synchronous central-DB handle.
 *
 * Seam 3 §4.5 I-1 keeps the guard path SYNCHRONOUS forever: `guard()`'s grant
 * liveness check, the CLI guard's `cliScopeOf`, the agent-to-agent guard and
 * the wake guard's `sessionStillActive` all run the leaves' own exported SQL
 * on the raw handle rather than awaiting the (now async) leaf functions. A
 * test that stubs those leaf modules but opens no central DB therefore reaches
 * a handle that does not exist — the symptom is `Database not initialized`, or
 * a guard that silently fails closed.
 *
 * This file answers those reads from whatever the test already mocks. Routing
 * is by table name, matching the leaf constants the guard path executes:
 *   `SESSION_BY_ID_SQL`            (src/db/sessions.ts)         → `sessions`
 *   `PENDING_APPROVAL_BY_ID_SQL`   (src/db/sessions.ts)         → `pendingApprovals`
 *   `CONTAINER_CONFIG_BY_GROUP_SQL`(src/db/container-configs.ts)→ `containerConfigs`
 * Table names, not the constants themselves: this module must stay importable
 * from inside a `vi.mock` factory, so it pulls in NOTHING at runtime — no leaf,
 * no connection module, and above all no logger (src/log-mock-tripwire.test.ts
 * is the other half of that rule).
 *
 * An unrouted statement reads as empty (`get` → undefined, `all` → []) unless
 * a `fallback` is given; empty is what the hand-rolled fakes this replaces did.
 * `all` is always empty: no guard-path read is list-shaped.
 *
 * This is the ONE file in the fork that names the raw handle for test purposes
 * (src/db/raw-db-ratchet.test.ts pins that); PR 6 deletes the seam and this
 * file with it.
 */
import type Database from 'better-sqlite3';

/** Row lookups a test wants the fake to answer, keyed by table. */
export interface RawDbRoutes {
  /** `SESSION_BY_ID_SQL` — `SELECT * FROM sessions WHERE id = ?` */
  sessions?: (id: string) => unknown;
  /** `CONTAINER_CONFIG_BY_GROUP_SQL` — `SELECT * FROM container_configs WHERE agent_group_id = ?` */
  containerConfigs?: (agentGroupId: string) => unknown;
  /** `PENDING_APPROVAL_BY_ID_SQL` — `SELECT * FROM pending_approvals WHERE approval_id = ?` */
  pendingApprovals?: (approvalId: string) => unknown;
  /**
   * Answers a statement no route above matched. Without one an unrouted `get`
   * reads as empty, which is what the hand-rolled fakes this replaces did; set
   * it to fail loudly instead, or to answer a fourth table this file has no
   * named route for.
   */
  fallback?: (sql: string, ...args: unknown[]) => unknown;
}

function route(routes: RawDbRoutes, sql: string): ((key: string) => unknown) | undefined {
  if (/\bFROM\s+sessions\b/i.test(sql)) return routes.sessions;
  if (/\bFROM\s+container_configs\b/i.test(sql)) return routes.containerConfigs;
  if (/\bFROM\s+pending_approvals\b/i.test(sql)) return routes.pendingApprovals;
  return undefined;
}

/**
 * A stand-in for the raw handle, typed as one so it drops straight into a
 * mocked `getRawDb`. Only the statement surface the guard path uses is real.
 */
export function rawDbFake(routes: RawDbRoutes = {}): Database.Database {
  return {
    prepare: (sql: string) => ({
      run: () => undefined,
      get: (...args: unknown[]) => {
        const matched = route(routes, sql);
        return matched ? matched(args[0] as string) : routes.fallback?.(sql, ...args);
      },
      all: () => [],
    }),
  } as unknown as Database.Database;
}

/** Options for {@link rawDbConnectionMock}. */
export interface RawDbConnectionMockOptions {
  /**
   * When true, a central DB that IS initialized wins and the fake is only the
   * fallback. For files that open a real in-memory DB for some cases and none
   * for others — the fake would otherwise shadow rows those cases seeded.
   */
  preferRealDb?: boolean;
}

/**
 * The whole `db/connection.js` module mock, so a test file never names the raw
 * handle itself:
 *
 * ```ts
 * vi.mock('../db/connection.js', async (importOriginal) =>
 *   rawDbConnectionMock(await importOriginal(), { sessions: (id) => mockGetSession(id) }),
 * );
 * ```
 */
export function rawDbConnectionMock<T extends object>(
  original: T,
  routes: RawDbRoutes = {},
  options: RawDbConnectionMockOptions = {},
): T {
  const real = original as T & { getRawDb: () => Database.Database };
  const fake = rawDbFake(routes);
  return {
    ...original,
    getRawDb: (): Database.Database => {
      if (!options.preferRealDb) return fake;
      try {
        return real.getRawDb();
        // eslint-disable-next-line no-catch-all/no-catch-all -- "no DB is open" is the only signal the accessor gives
      } catch {
        return fake;
      }
    },
  };
}
