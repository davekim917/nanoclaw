/**
 * Fork-only session-DB schema, applied on top of upstream's baseline.
 *
 * Upstream's mailbox/sqlite/connection.ts creates the outbound baseline
 * (session_state, container_state's four tool columns) when it opens the
 * singleton. Everything this fork adds beyond that baseline lives here and is
 * applied exactly once per process, from NanoclawAgentMailbox.start().
 *
 * ⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
 * the host when the file is created). WAL's `-shm` is memory-mapped and
 * VirtioFS does not propagate mmap coherency from host to guest, so a
 * WAL-mode inbound.db would leave this reader frozen on an early snapshot
 * and it would silently never see new host messages. See
 * src/session-manager.ts for the full set of cross-mount invariants and
 * scripts/sanity-live-poll.ts for the empirical validation.
 *
 * The container is the sole writer of outbound.db across the host/container
 * boundary, but the runner and provider-spawned MCP subprocesses hold separate
 * connections and may write concurrently. `prepareOutboundFile` installs the
 * busy handler BEFORE journal-mode so first-use initialization waits out a
 * sibling write instead of failing immediately — upstream's opener sets
 * journal_mode first, and journal_mode is a persistent database property, so
 * pre-setting it here turns upstream's PRAGMA into a lock-free no-op read.
 */
import { Database } from 'bun:sqlite';

export const OUTBOUND_DB_PATH = '/workspace/outbound.db';

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
export const RATE_LIMIT_SAMPLES_DDL = `
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
 * Open the outbound file just long enough to install the busy handler and
 * pin journal_mode=DELETE, then close it.
 *
 * Upstream's getOutboundDb() runs `PRAGMA journal_mode = DELETE` BEFORE
 * `PRAGMA busy_timeout`, and switching journal mode needs an exclusive lock —
 * so with a sibling MCP subprocess mid-write, that first PRAGMA would fail
 * immediately instead of waiting. journal_mode is persistent in the file
 * header, so setting it here (behind a busy handler) makes upstream's PRAGMA a
 * no-op read that never takes the lock. Regression covered by
 * modules/mailbox/mailbox.test.ts's concurrent-writer case.
 */
export function prepareOutboundFile(create: () => Database = () => new Database(OUTBOUND_DB_PATH)): void {
  const db = create();
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = DELETE');
  } finally {
    db.close();
  }
}

/**
 * Every fork-only outbound table/column, applied idempotently on top of
 * upstream's baseline. Safe to call on an already-migrated DB.
 */
export function ensureNanoclawOutboundSchema(outbound: Database): void {
  // container_state: tracks the current host-visible long operation. Claude
  // publishes declared Bash timeouts; Codex publishes a bounded deadline
  // while native items are in flight. Upstream creates the table with only
  // the four tool columns; everything below is the fork's.
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

/**
 * The fork's inbound additions, for in-memory test DBs only.
 *
 * Production inbound.db is host-owned and opened read-only here — the host's
 * migrateMessagesInTable creates these. The test harness builds its inbound
 * schema from upstream's baseline, so the fork columns the runner reads
 * (repository fence, recall pairing) have to be added on top.
 */
export function ensureNanoclawInboundTestSchema(inbound: Database): void {
  const cols = new Set(
    (inbound.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, type] of [
    ['repo_fence_epoch', 'TEXT'],
    ['repo_fence_original_trigger', 'INTEGER'],
    ['source_session_id', 'TEXT'],
    // Which scheduled slot a task occurrence is FOR, as distinct from
    // process_after's "when to run next". The HOST owns inbound.db and adds
    // this in its own migrateMessagesInTable; the container only reads it, so
    // this entry exists for the in-memory test pair built from upstream's
    // baseline CREATE TABLE.
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
