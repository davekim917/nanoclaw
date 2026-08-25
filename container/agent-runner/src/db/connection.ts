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
 * Account-level rate-limit utilization samples.
 *
 * Separate from `turn_usage` on purpose: utilization is a property of the
 * ACCOUNT (an OAuth ring slot), not of a turn. Stamping it onto every
 * turn_usage row would repeat one reading across every turn in the same
 * minute, and turn_usage has room for exactly ONE window while the plan
 * exposes up to four. One row per (sample, window) instead.
 *
 * `available = 0` means plan limits do not apply to this session at all
 * (API key, Bedrock, Vertex, missing profile scope) — a normal answer, not a
 * failure. NO ROW means we never sampled. Those are different states and the
 * table keeps them apart.
 *
 * Claude-only. Codex and OpenCode expose nothing equivalent, so a read
 * surface over this table must never imply fleet-wide coverage.
 *
 * TWO WAYS THESE ROWS ARE NOT COMPARABLE. Both have already fooled a reader.
 *
 * 1. ACROSS CREDENTIAL SETS. A group with per-group tokens
 *    (`CLAUDE_CODE_OAUTH_TOKEN_<FOLDER>` in the host's .env) runs on an
 *    entirely separate set of Anthropic accounts, and the host forwards those
 *    under the SAME unscoped `_N` names as the global pool. So `account` alone
 *    is ambiguous: `credential_set` is what makes it an identity. Two rows are
 *    the same account series only if BOTH `credential_set` AND `account`
 *    match. Comparing a scoped group's utilization against a global-pool
 *    group's is comparing two different accounts, not two burn rates.
 *
 * 2. ACROSS LANES WITHIN THE GLOBAL POOL. Which global slots are reserved for
 *    agents and which are shared with a human's interactive login is INSTALL
 *    POLICY, not a property of this code — so it is deliberately not encoded
 *    here. `lane` carries whatever the operator declared for that slot in
 *    `CLAUDE_CODE_OAUTH_LANES` (e.g. `1:agentic-primary,3:shared-dev`), and is
 *    NULL when they declared nothing. A slot shared with an interactive
 *    login legitimately shows utilization that no agent caused. That is
 *    correct behaviour and must not be "fixed" by excluding the slot: primary
 *    assignment is not a partition, and failover onto a shared slot is
 *    deliberate resilience — restricting it turns a soft delay into a hard
 *    stall until the window resets.
 */
const RATE_LIMIT_SAMPLES_DDL = `
  CREATE TABLE IF NOT EXISTS rate_limit_samples (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                TEXT NOT NULL,
    -- 'usage_pull' (the /usage control request — fires regardless of
    -- utilization) or 'rate_limit_event' (SDK telemetry — only fires once
    -- the account is already in warning/blocked territory).
    source            TEXT NOT NULL,
    -- OAuth ring slot name (CLAUDE_CODE_OAUTH_TOKEN, _2, ...). NULL for
    -- API-key sessions. Without it, samples from four rotating accounts mix
    -- into one meaningless series.
    account           TEXT,
    -- Which credential set the account column names: 'global' or 'group:<folder>'.
    -- NULL means the host did not say (older host, newer container).
    -- Identity is the PAIR (credential_set, account) — see caveat 1 above.
    credential_set    TEXT,
    -- Operator-declared lane for this slot, e.g. 'agentic-primary' or
    -- 'shared-dev'. NULL = undeclared, which is NOT the same as 'agentic'.
    lane              TEXT,
    subscription_type TEXT,
    available         INTEGER NOT NULL,
    -- Window: five_hour | seven_day | seven_day_oauth_apps | seven_day_opus.
    -- NULL when available = 0, or when the plan reported no windows — read
    -- 'status' for which.
    limit_type        TEXT,
    -- 0-1 FRACTION, matching turn_usage.rate_limit_utilization. The pull
    -- reports 0-100 and is divided at the capture seam; rate_limit_event
    -- already reports a fraction.
    utilization       REAL,
    resets_at         TEXT,
    -- Why this row looks the way it does. For rate_limit_event: the SDK's own
    -- status (allowed_warning / rejected). For usage_pull: NULL when the row
    -- carries a real reading, else the reason it does not —
    --   'not_applicable' = plan limits do not apply to this session at all
    --                      (API key / Bedrock / Vertex, or the CLI was not
    --                      told the token carries 'user:profile'),
    --   'no_window'      = the pull answered but named no usable window.
    -- A NULL utilization with NO row at all is the third state: not sampled.
    -- Without this column all three read as "the number is missing".
    status            TEXT
  );
`;

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
        memory_max_events        INTEGER,
        memory_telemetry_at      TEXT,
        updated_at               TEXT NOT NULL
      );
    `);
  const containerCols = new Set(
    (outbound.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const forwardColumns: Array<[string, string]> = [
    // The tool-in-flight columns were RENAMED in the CREATE TABLE
    // (last_tool/last_tool_at/last_tool_timeout_ms -> these) without a
    // migration, so pre-rename DBs lack them; the stale last_* columns
    // stay behind as harmless dead weight.
    ['current_tool', 'TEXT'],
    ['tool_declared_timeout_ms', 'INTEGER'],
    ['tool_started_at', 'TEXT'],
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
    ['memory_max_events', 'INTEGER'],
    ['memory_telemetry_at', 'TEXT'],
    // Added to CREATE TABLE without a backfill entry — any outbound.db older
    // than the column made every INSERT throw at boot, so the session
    // crash-looped on each sweep wake and never answered again (observed
    // live: a channel-root session silent for 3+ weeks).
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, type] of forwardColumns) {
    if (!containerCols.has(name)) outbound.exec(`ALTER TABLE container_state ADD COLUMN ${name} ${type}`);
  }
  // turn_usage: added after the initial v2 schema (Fleet Hardening Phase
  // 0.1), so older outbound.db files don't have it. CREATE IF NOT EXISTS
  // backfills it on the next connect — same forward-compat pattern as
  // session_state/container_state above. Column names/types are a fixed
  // contract with the host-side usage_daily rollup — do not rename.
  outbound.exec(`
      CREATE TABLE IF NOT EXISTS turn_usage (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                 TEXT NOT NULL,
        provider           TEXT NOT NULL,
        model              TEXT,
        input_tokens       INTEGER,
        output_tokens      INTEGER,
        cache_read_tokens  INTEGER,
        cache_write_tokens INTEGER,
        cost_usd           REAL
      );
    `);
  // steps/duration_ms/trigger: added after the table above (Fleet Hardening
  // Phase 0.1 follow-up — per-turn cost attribution). Additive ALTER, same
  // forward-compat pattern as container_state's forwardColumns loop, so an
  // outbound.db that already has turn_usage without these columns keeps
  // working instead of throwing on every INSERT.
  const turnUsageCols = new Set(
    (outbound.prepare("PRAGMA table_info('turn_usage')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, type] of [
    ['steps', 'INTEGER'],
    ['duration_ms', 'INTEGER'],
    ['trigger', 'TEXT'],
    // rate_limit_*: added after the columns above (per-turn cost attribution
    // follow-up — persist the SDK's weekly-allowance utilization instead of
    // discarding it). Claude-only; always NULL for the other two providers.
    ['rate_limit_type', 'TEXT'],
    ['rate_limit_utilization', 'REAL'],
    ['rate_limit_resets_at', 'TEXT'],
    // turn_id: added after the columns above — correlates the N rows one
    // multi-model turn writes (see poll-loop.ts's per-model recordTurnUsage
    // loop), so COUNT(DISTINCT turn_id) is the honest turn count instead of
    // usage_daily's row-count-based `turns` (which over-counts a split turn).
    ['turn_id', 'TEXT'],
  ] as const) {
    if (!turnUsageCols.has(name)) outbound.exec(`ALTER TABLE turn_usage ADD COLUMN ${name} ${type}`);
  }
  // rate_limit_samples: added after turn_usage — same forward-compat pattern.
  outbound.exec(RATE_LIMIT_SAMPLES_DDL);
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
      on_wake        INTEGER NOT NULL DEFAULT 0,
      repo_fence_epoch TEXT,
      repo_fence_original_trigger INTEGER
    );
    CREATE TABLE repo_ingress_fence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch TEXT NOT NULL,
      generation TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'released'))
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
      memory_max_events        INTEGER,
      memory_telemetry_at      TEXT,
      updated_at               TEXT NOT NULL
    );
    CREATE TABLE turn_usage (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                 TEXT NOT NULL,
      provider           TEXT NOT NULL,
      model              TEXT,
      turn_id            TEXT,
      steps              INTEGER,
      duration_ms        INTEGER,
      trigger            TEXT,
      rate_limit_type          TEXT,
      rate_limit_utilization   REAL,
      rate_limit_resets_at     TEXT,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cache_read_tokens  INTEGER,
      cache_write_tokens INTEGER,
      cost_usd           REAL
    );
  `);
  _outbound.exec(RATE_LIMIT_SAMPLES_DDL);

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
