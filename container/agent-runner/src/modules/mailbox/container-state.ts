/**
 * Fork-only container_state writes: provider health, memory telemetry, and the
 * wider startup reset. Moved verbatim from db/connection.ts.
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

/**
 * Clear stale processing state on container startup. If the previous
 * container crashed, processing acks and its host-visible in-flight operation
 * are leftover. Clearing both lets the new container start with a clean SLA.
 */
export function clearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
  sqliteClearContainerToolInFlight();
  clearProviderHealthState();
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
