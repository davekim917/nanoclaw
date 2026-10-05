/**
 * Fork-only session-DB schema on top of upstream's baseline, applied once per process from
 * NanoclawAgentMailbox.start().
 *
 * inbound.db MUST be journal_mode=DELETE: VirtioFS does not propagate WAL's mmapped `-shm` from host to guest,
 * so a WAL inbound.db leaves this reader frozen on an old snapshot.
 */
import type { Database } from 'bun:sqlite';

export const OUTBOUND_DB_PATH = '/workspace/outbound.db';

/**
 * Account-level rate-limit samples, one row per (sample, window); separate from turn_usage because utilization
 * belongs to the account, not the turn. `available = 0` means plan limits don't apply; no row means never
 * sampled. Claude and Codex only (OpenCode exposes nothing), so never imply fleet-wide coverage.
 *
 * Rows are the same account series only if BOTH `credential_set` AND `account` match: per-group tokens reuse
 * the global pool's `_N` names. `lane` is operator-declared install policy; a slot shared with an interactive
 * login legitimately shows utilization no agent caused, and must not be excluded.
 */
const RATE_LIMIT_SAMPLES_DDL = `
  CREATE TABLE IF NOT EXISTS rate_limit_samples (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                TEXT NOT NULL,
    -- 'rate_limit_event' (the event's top-level reading — utilization only
    -- once the account is in warning/blocked territory), 'rate_limit_headers'
    -- (Claude: one row per window from the event's unifiedWindows, read from
    -- the response headers, every utilization level) or 'usage_pull' (Codex's
    -- account/rateLimits/read; Claude rows of this source predate its removal).
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
    -- Window: five_hour | seven_day | seven_day_overage_included | seven_day_opus | …
    -- NULL when available = 0, or when the plan reported no windows — read
    -- 'status' for which.
    limit_type        TEXT,
    -- 0-1 FRACTION, matching turn_usage.rate_limit_utilization. The Codex
    -- pull reports 0-100 and is divided at the capture seam; rate_limit_event
    -- and rate_limit_headers already report a fraction. A header reading can
    -- exceed 1 when usage legitimately runs past a window's cap.
    utilization       REAL,
    resets_at         TEXT,
    -- Why this row looks the way it does. For rate_limit_event: the SDK's own
    -- status (allowed_warning / rejected). For rate_limit_headers: always
    -- NULL (the row carries a reading). For usage_pull: NULL when the row
    -- carries a real reading, else the reason it does not —
    --   'not_applicable' = plan limits do not apply to this session at all
    --                      (API key / Bedrock / Vertex),
    --   'no_window'      = the pull answered but named no usable window.
    -- A NULL utilization with NO row at all is the third state: not sampled.
    -- Without this column all three read as "the number is missing".
    status            TEXT
  );
`;

/**
 * Every fork-only outbound table/column, applied idempotently on top of
 * upstream's baseline. Safe to call on an already-migrated DB.
 */
export function ensureNanoclawOutboundSchema(outbound: Database): void {
  // Upstream creates container_state with only the four tool columns; everything below is the fork's.
  outbound.exec(`
      CREATE TABLE IF NOT EXISTS container_state (
        id                       INTEGER PRIMARY KEY CHECK (id = 1),
        current_tool             TEXT,
        tool_declared_timeout_ms INTEGER,
        tool_started_at          TEXT,
        provider_status          TEXT,
        provider_executing       INTEGER NOT NULL DEFAULT 0,
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
        provider_query_event_at  TEXT,
        updated_at               TEXT NOT NULL
      );
    `);
  const containerCols = new Set(
    (outbound.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const forwardColumns: Array<[string, string]> = [
    // Renamed in CREATE TABLE without a migration, so pre-rename DBs need these backfills.
    ['current_tool', 'TEXT'],
    ['tool_declared_timeout_ms', 'INTEGER'],
    ['tool_started_at', 'TEXT'],
    ['provider_status', 'TEXT'],
    // The host's idle reaper reads this; older outbound.db files predate it.
    ['provider_executing', 'INTEGER NOT NULL DEFAULT 0'],
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
    // The host reads this through a column tier, so DBs without it are safe before and after the backfill.
    ['provider_query_event_at', 'TEXT'],
    // Every CREATE TABLE column needs a backfill entry: a missing one made every INSERT throw at boot on older DBs.
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, type] of forwardColumns) {
    if (!containerCols.has(name)) outbound.exec(`ALTER TABLE container_state ADD COLUMN ${name} ${type}`);
  }
  // Column names/types are a fixed contract with the host's usage_daily rollup: do not rename.
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
  // Additive ALTERs so older turn_usage tables keep accepting INSERTs.
  const turnUsageCols = new Set(
    (outbound.prepare("PRAGMA table_info('turn_usage')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, type] of [
    ['steps', 'INTEGER'],
    ['duration_ms', 'INTEGER'],
    ['trigger', 'TEXT'],
    // Claude and Codex; always NULL for OpenCode.
    ['rate_limit_type', 'TEXT'],
    ['rate_limit_utilization', 'REAL'],
    ['rate_limit_resets_at', 'TEXT'],
    ['turn_id', 'TEXT'],
    // NULL means not recorded (rows before 2026-09-07), never "ran at no effort"; no backfill is possible.
    ['effort', 'TEXT'],
    ['effort_requested', 'TEXT'],
  ] as const) {
    if (!turnUsageCols.has(name)) outbound.exec(`ALTER TABLE turn_usage ADD COLUMN ${name} ${type}`);
  }
  outbound.exec(RATE_LIMIT_SAMPLES_DDL);
}

/** Fork inbound columns for in-memory test DBs only: production inbound.db is host-owned and read-only here. */
export function ensureNanoclawInboundTestSchema(inbound: Database): void {
  const cols = new Set(
    (inbound.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, type] of [
    ['repo_fence_epoch', 'TEXT'],
    ['repo_fence_original_trigger', 'INTEGER'],
    ['source_session_id', 'TEXT'],
    // The scheduled slot an occurrence is FOR, distinct from process_after ("when to run next").
    ['scheduled_for', 'TEXT'],
  ] as const) {
    if (!cols.has(name)) inbound.exec(`ALTER TABLE messages_in ADD COLUMN ${name} ${type}`);
  }
  inbound.exec(`
    CREATE TABLE IF NOT EXISTS repo_ingress_fence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch TEXT NOT NULL,
      generation TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'released'))
    );
  `);
  const deliveredCols = new Set(
    (inbound.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!deliveredCols.has('error')) inbound.exec('ALTER TABLE delivered ADD COLUMN error TEXT');
}
