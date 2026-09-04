import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it, vi } from 'vitest';

import { isDirectExecution, resolveChannelMetadataUpdates, runWorkgroupMemoryStartupGate } from './main.js';

// Codex review (PR #251): reportChannelMetadata's one-shot legacy channel-
// metadata lookup (chat-sdk-bridge.ts) races the unwired-channel approval
// flow's own, richer name classification (channel-approval.ts) on the same
// first inbound event, with no ordering guarantee between the two writers.
// This callback fires at most once per channel per process, so "never
// overwrite an existing name" loses that race safely — but only while the
// channel is unwired, which is the only state requestChannelApproval (the
// gate that runs channel-approval.ts's classifier) ever fires for. Once
// wired, that second writer is gone, so a rename must still propagate on
// each host restart's one-shot re-fetch — round 5 finding on this file.
describe('resolveChannelMetadataUpdates', () => {
  it('sets the name only when the messaging group has none yet (unwired)', () => {
    expect(resolveChannelMetadataUpdates({ name: null, is_group: 0 }, 'General', undefined, false)).toEqual({
      name: 'General',
    });
  });

  it('never overwrites an already-set name while unwired, even a differing one', () => {
    expect(
      resolveChannelMetadataUpdates(
        { name: 'Group DM: Alice and Bob', is_group: 1 },
        'mpdm-alice--bob-1',
        undefined,
        false,
      ),
    ).toEqual({});
  });

  it('refreshes a differing name once the channel is wired — no race left to protect', () => {
    expect(
      resolveChannelMetadataUpdates({ name: 'old-channel-name', is_group: 0 }, 'renamed-channel', undefined, true),
    ).toEqual({ name: 'renamed-channel' });
  });

  it('leaves a matching wired name alone', () => {
    expect(resolveChannelMetadataUpdates({ name: 'Existing', is_group: 0 }, 'Existing', undefined, true)).toEqual({});
  });

  it('still updates is_group independently of the name decision', () => {
    expect(resolveChannelMetadataUpdates({ name: 'Existing', is_group: 0 }, 'Existing', true, true)).toEqual({
      is_group: 1,
    });
  });

  it('returns an empty object when nothing changed', () => {
    expect(resolveChannelMetadataUpdates({ name: 'Existing', is_group: 1 }, 'Existing', true, true)).toEqual({});
    expect(resolveChannelMetadataUpdates({ name: 'Existing', is_group: 1 }, undefined, undefined, true)).toEqual({});
  });
});

it('uses exact main-module identity instead of NODE_ENV to decide startup', () => {
  const entry = path.resolve(`${uniqueTmpRoot('index-entry')}.ts`);
  const moduleUrl = pathToFileURL(entry).href;

  expect(isDirectExecution(moduleUrl, entry)).toBe(true);
  expect(isDirectExecution(moduleUrl, `${entry}.test`)).toBe(false);
  expect(isDirectExecution(moduleUrl, undefined)).toBe(false);
});

it('test_startup_runs_strict_quiescence_before_any_memory_cutover', () => {
  const db = new Database(':memory:');
  const calls: string[] = [];
  const ensureRuntime = vi.fn(() => calls.push('runtime'));
  const cleanupStrict = vi.fn(() => {
    calls.push('quiescence');
    throw new Error('listing unavailable');
  });
  const reconcile = vi.fn(() => {
    calls.push('reconcile');
    return [];
  });

  expect(() =>
    runWorkgroupMemoryStartupGate(db, {
      ensureRuntime,
      cleanupStrict,
      reconcile,
    }),
  ).toThrow('listing unavailable');
  expect(calls).toEqual(['runtime', 'quiescence']);
  expect(reconcile).not.toHaveBeenCalled();
  db.close();
});

it('runs reconciliation only after runtime and strict absence proof succeed', () => {
  const db = new Database(':memory:');
  const calls: string[] = [];

  runWorkgroupMemoryStartupGate(db, {
    ensureRuntime: () => {
      calls.push('runtime');
    },
    cleanupStrict: () => {
      calls.push('quiescence');
      return [];
    },
    reconcile: () => {
      calls.push('reconcile');
      return [];
    },
  });

  expect(calls).toEqual(['runtime', 'quiescence', 'reconcile']);
  db.close();
});

it('admits pending upgrade contexts after memory cutover and before any runtime can wake', () => {
  const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
  const memoryCutover = source.indexOf('const memoryReports = runWorkgroupMemoryStartupGate(db);');
  const pendingUpgrade = source.indexOf('const pendingUpgrade = reconcilePendingUpgradeContexts(');
  const dashboard = source.indexOf('startDashboard();');
  const channels = source.indexOf('await initChannelAdapters(');

  expect(memoryCutover).toBeGreaterThanOrEqual(0);
  expect(pendingUpgrade).toBeGreaterThan(memoryCutover);
  expect(dashboard).toBeGreaterThan(pendingUpgrade);
  expect(channels).toBeGreaterThan(pendingUpgrade);
});
