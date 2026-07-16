/**
 * Two-DB connection layer.
 *
 * The session uses two SQLite files to eliminate write contention across
 * the host-container mount boundary:
 *
 *   inbound.db  — host writes new messages here; container opens READ-ONLY
 *   outbound.db — container writes responses + acks here; host opens read-only
 *
 * Each file has exactly one writer across the host/container boundary, so no
 * cross-mount writer contention. Inside the container, the runner and
 * provider-spawned MCP subprocesses use separate outbound connections; their
 * short writes rely on SQLite locking + busy_timeout for serialization.
 *
 * ⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
 * the host when the file is created). WAL's `-shm` is memory-mapped and
 * VirtioFS does not propagate mmap coherency from host to guest, so a
 * WAL-mode inbound.db would leave this reader frozen on an early snapshot
 * and it would silently never see new host messages. See
 * src/session-manager.ts for the full set of cross-mount invariants and
 * scripts/sanity-live-poll.ts for the empirical validation.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';

const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';

let _inbound: Database | null = null;
let _outbound: Database | null = null;
let _heartbeatPath: string = DEFAULT_HEARTBEAT_PATH;
let _testMode = false;

/**
 * Avoid all cached db reads; open inbound.db read-only with mmap and page cache disabled.
 *
 * Use this (not getInboundDb) for readers that need to see host-written rows
 * promptly — e.g. messages_in polling. Caller must .close() the returned
 * connection (try/finally).
 *
 * Needed for mounts where host writes don't reliably invalidate
 * SQLite's caches: virtiofs (Colima, Lima, Podman Machine, Apple
 * Container), NFS.
 *
 * Cost is microseconds per query, so safe for universal use.
 */
export function openInboundDb(): Database {
  // In test mode return a thin wrapper over the in-memory singleton.
  // Callers do try/finally { db.close() } — the wrapper no-ops close()
  // so the singleton survives for the rest of the test.
  if (_testMode && _inbound) {
    const db = _inbound;
    return {
      prepare: (sql: string) => db.prepare(sql),
      exec: (sql: string) => db.exec(sql),
      close: () => {},
    } as unknown as Database;
  }
  const db = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  return db;
}

/**
 * Inbound DB — long-lived singleton, OK for tables the host writes once
 * at spawn and never again (destinations, session_routing). For
 * messages_in polling — where the host writes continuously and a stale
 * view causes the pollHandle hang — use `openInboundDb()` instead.
 */
export function getInboundDb(): Database {
  if (!_inbound) {
    _inbound = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
    _inbound.exec('PRAGMA busy_timeout = 5000');
    _inbound.exec('PRAGMA mmap_size = 0');
  }
  return _inbound;
}

/**
 * Configure a newly opened outbound connection.
 *
 * The container is the sole writer across the host/container boundary, but
 * the runner and provider-spawned MCP subprocesses hold separate connections
 * and may write concurrently. Install the busy handler before journal-mode or
 * schema pragmas so first-use initialization waits out a sibling write instead
 * of failing immediately.
 */
export function configureOutboundDb(outbound: Database): void {
  outbound.exec('PRAGMA busy_timeout = 5000');
  outbound.exec('PRAGMA journal_mode = DELETE');
  outbound.exec('PRAGMA foreign_keys = ON');
  // Lightweight forward-compat: session_state was added after the initial
  // v2 schema, so older session DBs don't have it. Create it on demand
  // instead of requiring a formal migration pass. Also handle the case
  // where an earlier revision of this table existed without updated_at —
  // ALTER TABLE to add any missing columns.
  outbound.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  const cols = new Set(
    (outbound.prepare("PRAGMA table_info('session_state')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('updated_at')) {
    outbound.exec(`ALTER TABLE session_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
  }
  // container_state: tracks the current host-visible long operation. Claude
  // publishes declared Bash timeouts; Codex publishes a bounded deadline
  // while native items are in flight. Forward-compat for older outbound.db.
  outbound.exec(`
      CREATE TABLE IF NOT EXISTS container_state (
        id                       INTEGER PRIMARY KEY CHECK (id = 1),
        current_tool             TEXT,
        tool_declared_timeout_ms INTEGER,
        tool_started_at          TEXT,
        provider_status          TEXT,
        provider_last_event_at   TEXT,
        provider_last_probe_at   TEXT,
        provider_probe_failures  INTEGER,
        provider_recovery_attempts INTEGER,
        provider_failure_reason  TEXT,
        memory_current_bytes     INTEGER,
        memory_peak_bytes        INTEGER,
        memory_max_bytes         INTEGER,
        memory_oom_events        INTEGER,
        memory_oom_kill_events   INTEGER,
        memory_telemetry_at      TEXT,
        updated_at               TEXT NOT NULL
      );
    `);
  const containerCols = new Set(
    (outbound.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const forwardColumns: Array<[string, string]> = [
    ['provider_status', 'TEXT'],
    ['provider_last_event_at', 'TEXT'],
    ['provider_last_probe_at', 'TEXT'],
    ['provider_probe_failures', 'INTEGER'],
    ['provider_recovery_attempts', 'INTEGER'],
    ['provider_failure_reason', 'TEXT'],
    ['memory_current_bytes', 'INTEGER'],
    ['memory_peak_bytes', 'INTEGER'],
    ['memory_max_bytes', 'INTEGER'],
    ['memory_oom_events', 'INTEGER'],
    ['memory_oom_kill_events', 'INTEGER'],
    ['memory_telemetry_at', 'TEXT'],
  ];
  for (const [name, type] of forwardColumns) {
    if (!containerCols.has(name)) outbound.exec(`ALTER TABLE container_state ADD COLUMN ${name} ${type}`);
  }
}

/** Open and fully configure one outbound connection, closing it on failure. */
export function openOutboundDb(create: () => Database = () => new Database(DEFAULT_OUTBOUND_PATH)): Database {
  const candidate = create();
  try {
    configureOutboundDb(candidate);
    return candidate;
  } catch (error) {
    candidate.close();
    throw error;
  }
}

/** Outbound DB singleton for this process. */
export function getOutboundDb(): Database {
  if (!_outbound) {
    // Publish only a fully initialized connection. If initialization fails,
    // openOutboundDb closes the candidate and the next call starts clean.
    _outbound = openOutboundDb();
  }
  return _outbound;
}

/**
 * Record that a host-visible operation is starting. `declaredTimeoutMs` is
 * either the operation's own timeout hint (Bash) or a provider-owned bound
 * (native Codex items); omit for operations with no declared timeout.
 */
export function setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = excluded.current_tool,
         tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
         tool_started_at = excluded.tool_started_at,
         updated_at = excluded.updated_at`,
    )
    .run(tool, declaredTimeoutMs, now, now);
}

/** Clear the host-visible in-flight operation. */
export function clearContainerToolInFlight(): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = NULL,
         tool_declared_timeout_ms = NULL,
         tool_started_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(now);
}

export type ProviderHealthStatus = 'active' | 'healthy' | 'suspect' | 'recovering' | 'failed' | 'idle';

export interface ProviderHealthState {
  status: ProviderHealthStatus;
  lastEventAt: string | null;
  lastProbeAt: string | null;
  probeFailures: number;
  recoveryAttempts: number;
  failureReason: string | null;
}

/** Persist low-frequency provider health transitions for host diagnostics. */
export function setProviderHealthState(state: ProviderHealthState, outbound: Database = getOutboundDb()): void {
  const now = new Date().toISOString();
  outbound
    .prepare(
      `INSERT INTO container_state (
         id, provider_status, provider_last_event_at, provider_last_probe_at,
         provider_probe_failures, provider_recovery_attempts, provider_failure_reason, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider_status = excluded.provider_status,
         provider_last_event_at = excluded.provider_last_event_at,
         provider_last_probe_at = excluded.provider_last_probe_at,
         provider_probe_failures = excluded.provider_probe_failures,
         provider_recovery_attempts = excluded.provider_recovery_attempts,
         provider_failure_reason = excluded.provider_failure_reason,
         updated_at = excluded.updated_at`,
    )
    .run(
      state.status,
      state.lastEventAt,
      state.lastProbeAt,
      state.probeFailures,
      state.recoveryAttempts,
      state.failureReason,
      now,
    );
}

export function clearProviderHealthState(outbound: Database = getOutboundDb()): void {
  setProviderHealthState(
    {
      status: 'idle',
      lastEventAt: null,
      lastProbeAt: null,
      probeFailures: 0,
      recoveryAttempts: 0,
      failureReason: null,
    },
    outbound,
  );
}

/**
 * Touch the heartbeat file — replaces the old touchProcessing() DB writes.
 * The host checks this file's mtime for stale container detection.
 * A file touch is cheaper and avoids cross-boundary DB write contention.
 */
export function touchHeartbeat(): void {
  const p = _heartbeatPath;
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch {
    try {
      fs.writeFileSync(p, '');
    } catch {
      // Silently ignore — parent dir may not exist (e.g., in-memory test DBs)
    }
  }
}

/**
 * Clear stale processing state on container startup. If the previous
 * container crashed, processing acks and its host-visible in-flight operation
 * are leftover. Clearing both lets the new container start with a clean SLA.
 */
export function clearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
  clearContainerToolInFlight();
  clearProviderHealthState();
}

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
  _testMode = true;
  _inbound = new Database(':memory:');
  _inbound.exec('PRAGMA foreign_keys = ON');
  _inbound.exec(`
    CREATE TABLE messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      process_after  TEXT,
      recurrence     TEXT,
      series_id      TEXT,
      tries          INTEGER DEFAULT 0,
      trigger        INTEGER NOT NULL DEFAULT 1,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL,
      on_wake        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE delivered (
      message_out_id      TEXT PRIMARY KEY,
      platform_message_id TEXT,
      status              TEXT NOT NULL DEFAULT 'delivered',
      error               TEXT,
      delivered_at        TEXT NOT NULL
    );
    CREATE TABLE destinations (
      name            TEXT PRIMARY KEY,
      display_name    TEXT,
      type            TEXT NOT NULL,
      channel_type    TEXT,
      platform_id     TEXT,
      agent_group_id  TEXT
    );
  `);

  _outbound = new Database(':memory:');
  _outbound.exec('PRAGMA foreign_keys = ON');
  _outbound.exec(`
    CREATE TABLE messages_out (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      provider_status          TEXT,
      provider_last_event_at   TEXT,
      provider_last_probe_at   TEXT,
      provider_probe_failures  INTEGER,
      provider_recovery_attempts INTEGER,
      provider_failure_reason  TEXT,
      memory_current_bytes     INTEGER,
      memory_peak_bytes        INTEGER,
      memory_max_bytes         INTEGER,
      memory_oom_events        INTEGER,
      memory_oom_kill_events   INTEGER,
      memory_telemetry_at      TEXT,
      updated_at               TEXT NOT NULL
    );
  `);

  return { inbound: _inbound, outbound: _outbound };
}

export function closeSessionDb(): void {
  _inbound?.close();
  _inbound = null;
  _testMode = false;
  _outbound?.close();
  _outbound = null;
}

/** Central DB — read-only from the container. Mounted at /workspace/central.db. */
let _central: Database | null = null;
const CENTRAL_DB_PATH = '/workspace/central.db';

export function getCentralDb(): Database | null {
  if (_central) return _central;
  try {
    _central = new Database(CENTRAL_DB_PATH, { readonly: true });
    return _central;
  } catch {
    return null;
  }
}
