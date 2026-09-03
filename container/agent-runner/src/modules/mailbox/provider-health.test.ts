import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { clearProviderHealthState, setProviderHealthState } from './container-state.js';
let outbound: Database;

beforeEach(() => {
  outbound = new Database(':memory:');
  outbound.exec(`
    CREATE TABLE container_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at TEXT,
      provider_status TEXT,
      provider_last_event_at TEXT,
      provider_last_probe_at TEXT,
      provider_probe_failures INTEGER,
      provider_recovery_attempts INTEGER,
      provider_failure_reason TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO container_state (
      id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at
    ) VALUES (1, 'CodexItem', 3600000, '2026-07-15T11:22:53.000Z', '2026-07-15T11:22:53.000Z');
  `);
});

afterEach(() => {
  outbound.close();
});

describe('provider health state', () => {
  it('persists health diagnostics without clearing the active tool deadline', () => {
    setProviderHealthState(
      {
        status: 'suspect',
        lastEventAt: '2026-07-15T11:34:02.000Z',
        lastProbeAt: '2026-07-15T11:35:02.000Z',
        probeFailures: 2,
        recoveryAttempts: 0,
        failureReason: 'probe timeout',
      },
      outbound,
    );

    const row = outbound.prepare('SELECT * FROM container_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      current_tool: 'CodexItem',
      tool_declared_timeout_ms: 3_600_000,
      provider_status: 'suspect',
      provider_probe_failures: 2,
      provider_failure_reason: 'probe timeout',
    });
  });

  it('clears provider diagnostics without mutating the independent tool state', () => {
    setProviderHealthState(
      {
        status: 'failed',
        lastEventAt: '2026-07-15T11:34:02.000Z',
        lastProbeAt: '2026-07-15T12:34:02.000Z',
        probeFailures: 3,
        recoveryAttempts: 1,
        failureReason: 'unresponsive',
      },
      outbound,
    );

    clearProviderHealthState(outbound);

    const row = outbound.prepare('SELECT * FROM container_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      current_tool: 'CodexItem',
      provider_status: 'idle',
      provider_probe_failures: 0,
      provider_recovery_attempts: 0,
      provider_failure_reason: null,
    });
  });
});
