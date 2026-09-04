/**
 * Fork-only container_state writes: provider health, the provider_executing
 * busy flag, memory telemetry, and the wider startup reset. Everything except
 * the busy flag moved verbatim from db/connection.ts.
 *
 * The four tool-in-flight columns and their UPSERT are upstream's
 * (mailbox/sqlite/connection.ts) and are NOT re-implemented here — the fork's
 * SQL for those was already byte-equivalent.
 */
import type { Database } from 'bun:sqlite';

import { getOutboundDb, sqliteClearContainerToolInFlight } from '../../mailbox/sqlite/connection.js';

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

/* ─── provider_executing ───────────────────────────────────────────────────── */

/**
 * Publish "this container is doing work right now" for the host's idle
 * reapers (`shouldReapIdleTaskContainer` in src/host-sweep.ts).
 *
 * The reapers otherwise infer busy-ness from state the HOST can see: a due
 * inbound row, a `processing` claim in processing_ack, a work_continuation
 * record. All three are absent during work the runner drives on its own
 * behalf — a pre-task script batch (up to NANOCLAW_TASK_SCRIPT_TIMEOUT_MS,
 * 120s by default) runs before the batch is claimed; a pushed follow-up turn
 * and a durable-continuation turn both run after the initial batch was
 * completed at the previous `result`, so they hold no claim at all. In those
 * windows every term the task reaper looks at reads "idle" and the container
 * is killed mid-work.
 *
 * TWO busy scopes share the one published bit, and they are tracked
 * separately because they overlap and have different shapes:
 *
 *   - **the provider turn** — a LEVEL, not a nesting scope. It is raised by
 *     the prompt that starts a turn (the initial one, every pushToQuery) and
 *     lowered by the `result` that ends one, which are not balanced: two
 *     nudges can be pushed before a single result. The flag tracks turns and
 *     NOT stream lifetime, because a multi-turn stream stays open after
 *     `result` to accept pushes — holding the bit for the whole stream would
 *     pin it through the container's entire idle stretch and defeat the
 *     reaper.
 *   - **bracketed windows outside a turn** — the pre-task script batch, the
 *     turn-end git checkpoint. These nest, so they are counted.
 *
 * The active poll callback runs pre-task scripts CONCURRENTLY with a provider
 * turn, so one boolean cannot serve both: the script's exit would clear the
 * running turn's bit, and a `result` landing mid-script would clear the
 * script's. Publishing `turn || scopes > 0` is what makes either scope safe to
 * end while the other is still live.
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

/** Leave a bracketed busy window. */
export function endProviderBusyScope(outbound: Database = getOutboundDb()): void {
  if (busyScopeDepth > 0) busyScopeDepth -= 1;
  publishProviderExecuting(outbound);
}

/**
 * Zero both scopes without touching the DB. The test harness calls this so
 * module-level scope state cannot leak between tests; production always goes
 * through `resetProviderExecuting`, which also publishes.
 */
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
 * Clear stale processing state on container startup. If the previous
 * container crashed, processing acks and its host-visible in-flight operation
 * are leftover. Clearing both lets the new container start with a clean SLA.
 */
export function clearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
  sqliteClearContainerToolInFlight();
  clearProviderHealthState();
  // A container killed mid-work cannot run its own `finally`, so the flag can
  // survive in outbound.db. Clearing it here — the fresh container's startup,
  // before its first poll — means a leaked 1 can never make the NEXT container
  // unreapable.
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
