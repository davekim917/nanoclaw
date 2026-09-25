/**
 * Session DB schemas — split into two files so each has exactly one writing
 * side. This eliminates SQLite writer contention across the host-container
 * mount boundary; multiple processes inside the owning container may still
 * serialize outbound writes through SQLite locking.
 *
 *   inbound.db  — host writes, container reads (read-only mount or open read-only)
 *   outbound.db — container writes, host reads (read-only open)
 */

/** Host-owned: inbound messages + delivery tracking + destination map. */
export const INBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
                 -- WHEN TO RUN NEXT, and nothing else. Deferral paths
                 -- (fresh-context retry backoff, stale-message backoff) rewrite
                 -- this, so it is not a stable identity for the occurrence.
  scheduled_for  TEXT,
                 -- WHICH SLOT THIS OCCURRENCE IS FOR. Stamped once at insert
                 -- from the process_after the task was created/re-armed with,
                 -- and moved only by a genuine reschedule (cron edit, resume to
                 -- the next future slot, an explicit process_after update).
                 -- A retry backoff must never touch it: the agent reasons from
                 -- this value, and anything date-windowed or idempotent keyed
                 -- off it would lose its occurrence identity across a retry.
                 -- NULL on rows written before this column existed and on
                 -- non-task rows; readers fall back to process_after.
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,
                 -- 0 = accumulated context (don't wake), 1 = wake agent
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,
  -- For agent-to-agent inbound rows: the source session that emitted the
  -- triggering outbound. Used as a return path when the target replies —
  -- the reply routes back to this exact session, not to the source agent
  -- group's "newest" session. NULL on channel-side inbound and on a2a rows
  -- written before this column existed.
  source_session_id TEXT,
  on_wake        INTEGER NOT NULL DEFAULT 0
               -- 1 = only deliver on the container's first poll (fresh start).
               -- Dying containers (past first poll) skip these rows.
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);
-- Read-path enabler for the Scheduled Tasks Board: latest-row-per-series
-- (MAX(seq)) and the drawer's ORDER BY seq DESC LIMIT 5 both materialize +
-- sort all series rows under the plain (series_id) index. The compound index
-- serves both. Read-path only; firing semantics untouched (C1). See
-- docs/specs/scheduled-tasks-board/design.md §4.8.
CREATE INDEX IF NOT EXISTS idx_messages_in_series_seq ON messages_in(series_id, seq DESC);

-- Host tracks delivery outcomes for messages_out IDs.
-- Avoids writing to outbound.db (container-owned).
-- The error column carries the adapter's error message on permanent failure
-- so the container's send_file tool can surface it to the agent (Slack
-- missing_scope, file-size rejection, etc.) instead of reporting
-- fire-and-forget success.
CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  error               TEXT,
  lifecycle_terminal_at TEXT,
  delivered_at        TEXT NOT NULL
);

-- Destination map for this session's agent.
-- Host overwrites on every container wake AND on demand (rewires, new child
-- agents, etc.). Container queries this live on every lookup, so changes
-- take effect mid-session without requiring a container restart.
CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type    TEXT,            -- for type='channel'
  platform_id     TEXT,            -- for type='channel'
  agent_group_id  TEXT             -- for type='agent'
);

-- Current chat/thread routing for this session. Single-row table (id=1).
-- Host overwrites on every container wake from the session's messaging_group
-- and thread_id. Container reads it in send_message / ask_user_question to
-- preserve the thread when an explicitly named destination is the current
-- conversation, and for interactive-question response matching.
CREATE TABLE IF NOT EXISTS session_routing (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type  TEXT,
  platform_id   TEXT,
  thread_id     TEXT,
  spawn_task_id TEXT,
  session_id    TEXT
);
`;

/** Container-owned: outbound messages + processing acknowledgments. */
export const OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_out (
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

-- Container tracks processing status here instead of updating messages_in.
-- Host reads this to know which messages have been processed.
-- On container startup, stale 'processing' entries are cleared (crash recovery).
CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);

-- Persistent key/value state owned by the container. Used (among other things)
-- to store the SDK session ID so the agent's conversation resumes across
-- container restarts. Cleared by /clear.
CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Host-visible operation state. Single-row table (id=1). Claude records Bash
-- hooks; Codex records native item lifecycle. Host reads it in the sweep to
-- extend stuck tolerance to the bounded declared timeout.
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
`;
