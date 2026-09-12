/**
 * The two session-DB failure classes, in a module that imports nothing.
 *
 * They lived in `openers.ts` until #761's fix round. `host-inbound.ts` has to
 * raise `SessionDbMissingError` when a session is deleted out from under its
 * migration, and `openers.ts` already imports `sessionDirForInboundDbPath`
 * FROM `host-inbound.ts` — so importing the class back out of `openers.ts`
 * would close a static import cycle, the shape the host's ESM rules warn about
 * and the one `host-inbound.ts` already inlines `replayHotJournal` to avoid.
 *
 * A leaf module with no imports of its own cannot participate in a cycle, so
 * both sides depend on this instead of on each other. `openers.ts` re-exports
 * both names, so every existing `from './openers.js'` import site is unchanged
 * — and because a re-export is the SAME class object, every `instanceof` check
 * callers already branch on keeps working.
 */

/**
 * A host open found no database file where a provisioned session must have one.
 *
 * Every host-side open funnel refuses to create the file, so callers get this
 * instead of an empty stub. `ensureSchema` is the only host-side creator; a
 * caller that legitimately provisions a session goes through
 * `initSessionFolder`/`initStubSessionFolder`, never through an open.
 */
export class SessionDbMissingError extends Error {
  constructor(readonly dbPath: string) {
    super(`session database does not exist: ${dbPath}`);
    this.name = 'SessionDbMissingError';
  }
}

/**
 * A host open found the database file PRESENT but could not open it.
 *
 * The counterpart to `SessionDbMissingError`, and the reason it exists as a
 * type: "the mailbox would not open" and "a caller's own work threw" are
 * different failures with different recoveries, and once the outbound handle
 * opens LAZILY — partway through a caller's action — position in the code can
 * no longer tell them apart. Only the funnel knows, so the funnel says so.
 *
 * Callers that already branch on `SessionDbMissingError` are unaffected: this
 * is a distinct class, and a vanished file still reports as missing.
 */
export class SessionDbUnopenableError extends Error {
  /**
   * The driver's own error code, carried up from the cause.
   *
   * `src/db/session-db.test.ts` pins `code === 'SQLITE_CANTOPEN'` on a
   * present-but-unreadable open, and callers may branch on it. Adding a
   * classification must not cost an observable that already had a contract, so
   * the wrapper keeps it (and the original error stays reachable as `cause`).
   */
  readonly code?: string;

  constructor(
    readonly dbPath: string,
    cause: unknown,
  ) {
    super(
      `session database exists but could not be opened: ${dbPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'SessionDbUnopenableError';
    const code = (cause as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string') this.code = code;
  }
}
