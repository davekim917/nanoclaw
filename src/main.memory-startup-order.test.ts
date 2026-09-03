import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { expect, it, vi } from 'vitest';

import { isDirectExecution, runWorkgroupMemoryStartupGate } from './main.js';

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
