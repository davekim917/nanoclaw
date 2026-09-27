/**
 * Session-DB failure classes in a module that imports nothing, so openers.ts
 * and host-inbound.ts can both use them without an import cycle. openers.ts
 * re-exports them (same class objects, so `instanceof` still works).
 */

/**
 * A host open found no database file where a provisioned session must have
 * one. Host open funnels never create the file; only `ensureSchema` does.
 */
export class SessionDbMissingError extends Error {
  constructor(readonly dbPath: string) {
    super(`session database does not exist: ${dbPath}`);
    this.name = 'SessionDbMissingError';
  }
}

/**
 * `<session>/.host/inbound.db` exists, but this host never recorded creating it.
 * A container can create that path itself under an older mount set, and
 * adopting it would replace the session's authoritative database. Provenance
 * lives in the central DB (never mounted); no record means refuse.
 */
export class HostInboundProvenanceError extends Error {
  constructor(
    readonly sessionId: string,
    readonly dbPath: string,
  ) {
    super(
      `Session ${sessionId}: ${dbPath} exists but this host has no provenance record for it; refusing to spawn. ` +
        `A container can create that path itself, and adopting it would replace the session's authoritative ` +
        `database. If this host legitimately lost its record — a restore from a rescue archive, or a rebuilt ` +
        `central DB — adopt the existing files deliberately with ` +
        `\`pnpm exec tsx scripts/adopt-host-inbound-provenance.ts --all --apply\` (omit --apply to see the plan ` +
        `first). If this is unexpected, quarantine the ` +
        `directory with \`pnpm exec tsx scripts/quarantine-planted-host-dirs.ts\`. ` +
        `See docs/db-session.md, "Provenance, and the override".`,
    );
    this.name = 'HostInboundProvenanceError';
  }
}

/**
 * The database file is PRESENT but could not be opened. Distinct from missing
 * and from a caller's own error: with a lazily-opened outbound handle, only the
 * funnel can tell them apart.
 */
export class SessionDbUnopenableError extends Error {
  /** The driver's error code (e.g. `SQLITE_CANTOPEN`), which callers may branch on; the original stays as `cause`. */
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
