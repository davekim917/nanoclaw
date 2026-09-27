/** Fork-only container_state writes. The four tool-in-flight columns and their UPSERT are upstream's (mailbox/sqlite/connection.ts). */
import type { Database } from 'bun:sqlite';

import { getOutboundDb, sqliteClearContainerToolInFlight } from '../../mailbox/sqlite/connection.js';

type ProviderHealthStatus = 'active' | 'healthy' | 'suspect' | 'recovering' | 'failed' | 'idle';

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
 * Publish "busy right now" for the host's idle reapers, which otherwise see nothing during runner-driven work
 * (pre-task scripts, pushed follow-up and continuation turns hold no claim) and kill the container mid-work.
 *
 * Two scopes share the bit: the provider turn is a LEVEL (raised by each prompt, lowered by `result`, NOT held
 * for the stream's lifetime, except while the provider reports background work); bracketed windows outside a
 * turn nest and are counted. Pre-task scripts run concurrently with a turn, so the bit is `turn || scopes > 0`.
 */
let turnExecuting = false;
let busyScopeDepth = 0;

function publishProviderExecuting(outbound: Database): void {
  const now = new Date().toISOString();
  outbound
    .prepare(
      `INSERT INTO container_state (id, provider_executing, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider_executing = excluded.provider_executing,
         updated_at = excluded.updated_at`,
    )
    .run(turnExecuting || busyScopeDepth > 0 ? 1 : 0, now);
}

/** Raise/lower the provider-turn level. Idempotent — repeats are not counted. */
export function setProviderTurnExecuting(executing: boolean, outbound: Database = getOutboundDb()): void {
  turnExecuting = executing;
  publishProviderExecuting(outbound);
}

/**
 * Enter a bracketed busy window outside a provider turn. ALWAYS pair with
 * `endProviderBusyScope` in a `finally`, and keep the window bounded: one
 * entered and never left holds the container past the reaper until the
 * 30-minute heartbeat ceiling.
 */
export function beginProviderBusyScope(outbound: Database = getOutboundDb()): void {
  busyScopeDepth += 1;
  publishProviderExecuting(outbound);
}

export function endProviderBusyScope(outbound: Database = getOutboundDb()): void {
  if (busyScopeDepth > 0) busyScopeDepth -= 1;
  publishProviderExecuting(outbound);
}

/** Zero both scopes without a DB write (test harness); production uses `resetProviderExecuting`. */
export function resetProviderExecutingScopes(): void {
  turnExecuting = false;
  busyScopeDepth = 0;
}

/** Drop both scopes and publish idle. Container startup, and tests. */
export function resetProviderExecuting(outbound: Database = getOutboundDb()): void {
  resetProviderExecutingScopes();
  publishProviderExecuting(outbound);
}

/**
 * When the current query first emitted a provider event (NULL until then and between queries). The host tells a
 * quiet-but-alive turn from one hung at the gate with it; only the latter may be killed for an aged claim (the
 * absolute ceiling still applies to both). At most two writes per query.
 */
let queryEventStamped = false;

function writeProviderQueryEventAt(value: string | null, outbound: Database): void {
  outbound
    .prepare(
      `INSERT INTO container_state (id, provider_query_event_at, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider_query_event_at = excluded.provider_query_event_at,
         updated_at = excluded.updated_at`,
    )
    .run(value, new Date().toISOString());
}

/** A query is starting, or has ended: it has emitted nothing (yet). */
export function resetProviderQueryEvent(outbound: Database = getOutboundDb()): void {
  queryEventStamped = false;
  writeProviderQueryEventAt(null, outbound);
}

/** The current query's provider emitted an event. Writes only the first time per query. */
export function markProviderQueryEvent(outbound: Database = getOutboundDb()): void {
  if (queryEventStamped) return;
  writeProviderQueryEventAt(new Date().toISOString(), outbound);
  queryEventStamped = true;
}

/** Clear the previous container's leftover processing acks and in-flight operation on startup. */
export function clearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
  sqliteClearContainerToolInFlight();
  clearProviderHealthState();
  // A dead container's query stamp would read as "alive" to the host's claim rule.
  resetProviderQueryEvent();
  // A killed container can't run its `finally`: clear a leaked busy flag before the first poll so the next
  // container stays reapable.
  resetProviderExecuting();
}

export interface ResourceTelemetryRecord {
  currentBytes: number;
  peakBytes: number | null;
  maxBytes: number | null;
  oomEvents: number;
  oomKillEvents: number;
  maxEvents: number;
}

/** cgroup v2 memory telemetry — read by the host sweep for OOM accountability. */
export function writeResourceTelemetry(snapshot: ResourceTelemetryRecord, outbound: Database = getOutboundDb()): void {
  const now = new Date().toISOString();
  outbound
    .prepare(
      `INSERT INTO container_state (
         id, memory_current_bytes, memory_peak_bytes, memory_max_bytes,
         memory_oom_events, memory_oom_kill_events, memory_max_events,
         memory_telemetry_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         memory_current_bytes = excluded.memory_current_bytes,
         memory_peak_bytes = excluded.memory_peak_bytes,
         memory_max_bytes = excluded.memory_max_bytes,
         memory_oom_events = excluded.memory_oom_events,
         memory_oom_kill_events = excluded.memory_oom_kill_events,
         memory_max_events = excluded.memory_max_events,
         memory_telemetry_at = excluded.memory_telemetry_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      snapshot.currentBytes,
      snapshot.peakBytes,
      snapshot.maxBytes,
      snapshot.oomEvents,
      snapshot.oomKillEvents,
      snapshot.maxEvents,
      now,
      now,
    );
}
