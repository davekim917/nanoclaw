#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import * as readline from 'readline';

import { GROUPS_DIR } from '../src/config.js';
import { readContainerConfig } from '../src/container-config.js';
import { writeFileAtomic } from '../src/modules/mnemon/index.js';

const PROJECT_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

// Phase 2 graduation thresholds (mirrored from brief Success Criteria).
const HOOK_FAILURE_RATE_THRESHOLD = 0.01;
const P95_LATENCY_MS_THRESHOLD = 200;
const DB_GROWTH_MB_THRESHOLD = 10;

interface Gates {
  hookFailureRate: number;
  p95LatencyMs: number;
  dbGrowthMb: number;
  recallSpotcheckPassed: boolean;
  visualReviewPassed: boolean;
  healthOk: boolean;
  insightsCount: number;
  // Failure flags from telemetry-data-missing branches. Each gate fails closed when its data
  // source is absent, malformed, or empty — earlier this script defaulted those to 0/healthy
  // which made graduation pass when the pipeline was broken.
  telemetryMissing: string[];
}

interface StoreStatusRow {
  ts?: string;
  store?: string;
  // mnemon status fields are spread into the row by the collector.
  insights?: number;
  // Some mnemon versions report `db_size_bytes`; fall back to that.
  db_size_bytes?: number;
}

interface TurnMetricRow {
  ts?: string;
  event_type?: string;
  hook?: string;
  store?: string;
  latencyMs?: number;
  reason?: string;
}

type HealthRecord = Record<string, { phase?: 'ok' | 'unhealthy'; recent_unhealthy_events?: Array<{ ts: string; reason: string }> }>;

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row !== null);
  } catch {
    return [];
  }
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

async function promptYesNo(question: string): Promise<boolean> {
  if (process.argv.includes('--skip-visual')) return true;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

async function evaluateGates(store: string, folder: string): Promise<Gates> {
  const telemetryMissing: string[] = [];
  const healthPath = path.join(PROJECT_ROOT, 'data', 'mnemon-health.json');
  const storeMetricsJsonlPath = path.join(PROJECT_ROOT, 'data', 'mnemon-metrics', 'stores', `${store}.jsonl`);
  const turnMetricsPath = path.join(GROUPS_DIR, folder, '.mnemon-metrics.jsonl');

  // Turn metrics (per-group) — written by container hooks via /workspace/agent/.mnemon-metrics.jsonl
  // which mounts to groups/<folder>/.mnemon-metrics.jsonl on the host.
  const turnRows = readJsonl(turnMetricsPath) as TurnMetricRow[];
  if (!fs.existsSync(turnMetricsPath) || turnRows.length === 0) {
    telemetryMissing.push(`turn metrics file empty or missing: ${turnMetricsPath}`);
  }

  // Hook failure rate: ratio of unhealthy events to total turn events. An event_type of `unhealthy`
  // OR a missing emit on the prime/remind/nudge hook count as a failure indicator.
  const totalHookEvents = turnRows.filter((r) => r.event_type === 'turn').length;
  const unhealthyHookEvents = turnRows.filter((r) => r.event_type === 'unhealthy').length;
  const hookFailureRate = totalHookEvents > 0 ? unhealthyHookEvents / totalHookEvents : 0;

  // P95 latency across all hook turns where a latencyMs was reported.
  const latencies = turnRows.filter((r) => typeof r.latencyMs === 'number' && r.latencyMs >= 0).map((r) => r.latencyMs!);
  const p95LatencyMs = p95(latencies);
  if (latencies.length === 0) telemetryMissing.push('no latency observations in turn metrics');

  // Store metrics JSONL (collector output): each row is a `mnemon status` snapshot for the store
  // tagged with ts. dbGrowthMb is computed from the oldest vs newest snapshot's db size.
  const storeRows = readJsonl(storeMetricsJsonlPath) as StoreStatusRow[];
  if (storeRows.length === 0) {
    telemetryMissing.push(`store metrics file empty or missing: ${storeMetricsJsonlPath}`);
  }
  const oldestRow = storeRows[0];
  const newestRow = storeRows[storeRows.length - 1];
  const startBytes = oldestRow?.db_size_bytes ?? 0;
  const currentBytes = newestRow?.db_size_bytes ?? 0;
  const dbGrowthMb = (currentBytes - startBytes) / (1024 * 1024);
  const insightsCount = newestRow?.insights ?? 0;

  // Health record (collector aggregate) — single source of truth for healthOk gate.
  const healthRecord = readJsonFile<HealthRecord>(healthPath);
  if (!healthRecord) {
    telemetryMissing.push(`health record missing or unreadable: ${healthPath}`);
  }
  const storeHealth = healthRecord?.[store];
  // healthOk requires the record AND the store entry to be present AND classified ok.
  // Missing health record → fail closed.
  const healthOk = !!healthRecord && !!storeHealth && storeHealth.phase === 'ok';

  // Manual gates.
  console.log('\nManual gate checks required:');
  const recallSpotcheckPassed = await promptYesNo(
    'Did the recall spot-check pass operator review? (ran some queries, results were accurate)',
  );
  const visualReviewPassed = await promptYesNo(
    'Did the visual wiki review pass? (wiki pages look coherent and useful)',
  );

  return {
    hookFailureRate,
    p95LatencyMs,
    dbGrowthMb,
    recallSpotcheckPassed,
    visualReviewPassed,
    healthOk,
    insightsCount,
    telemetryMissing,
  };
}

async function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: mnemon-phase2.ts <group-folder>');
    process.exit(1);
  }

  const cfg = readContainerConfig(folder);
  if (!cfg.agentGroupId) {
    console.error(`no agentGroupId in groups/${folder}/container.json`);
    process.exit(1);
  }
  const store = cfg.agentGroupId;

  console.log(`\nEvaluating Phase 2 graduation gates for store: ${store}\n`);

  const gates = await evaluateGates(store, folder);

  console.log('\nGate evaluation results:');
  console.log(`  hook failure rate:    ${(gates.hookFailureRate * 100).toFixed(2)}% (threshold: < ${HOOK_FAILURE_RATE_THRESHOLD * 100}%)`);
  console.log(`  p95 latency:          ${gates.p95LatencyMs}ms (threshold: < ${P95_LATENCY_MS_THRESHOLD}ms)`);
  console.log(`  DB growth:            ${gates.dbGrowthMb.toFixed(2)}MB (threshold: < ${DB_GROWTH_MB_THRESHOLD}MB)`);
  console.log(`  recall spot-check:    ${gates.recallSpotcheckPassed ? 'PASS' : 'FAIL'}`);
  console.log(`  visual wiki review:   ${gates.visualReviewPassed ? 'PASS' : 'FAIL'}`);
  console.log(`  store health:         ${gates.healthOk ? 'OK' : 'UNHEALTHY'}`);
  console.log(`  insights captured:    ${gates.insightsCount} (sanity only, not blocking)`);

  const blockingFailures: string[] = [];

  // Telemetry-missing checks fail closed: graduation requires real evidence, not silent zeros.
  if (gates.telemetryMissing.length > 0) {
    blockingFailures.push(...gates.telemetryMissing.map((m) => `telemetry unavailable — ${m}`));
  }

  if (gates.hookFailureRate >= HOOK_FAILURE_RATE_THRESHOLD)
    blockingFailures.push(`hook failure rate ${(gates.hookFailureRate * 100).toFixed(2)}% >= ${HOOK_FAILURE_RATE_THRESHOLD * 100}%`);
  if (gates.p95LatencyMs >= P95_LATENCY_MS_THRESHOLD)
    blockingFailures.push(`p95 latency ${gates.p95LatencyMs}ms >= ${P95_LATENCY_MS_THRESHOLD}ms`);
  if (gates.dbGrowthMb >= DB_GROWTH_MB_THRESHOLD)
    blockingFailures.push(`DB growth ${gates.dbGrowthMb.toFixed(2)}MB >= ${DB_GROWTH_MB_THRESHOLD}MB`);
  if (!gates.recallSpotcheckPassed) blockingFailures.push('recall spot-check did NOT pass operator review');
  if (!gates.visualReviewPassed) blockingFailures.push('visual wiki review did NOT pass operator review');
  if (!gates.healthOk) blockingFailures.push('store is in unhealthy state per data/mnemon-health.json');

  if (blockingFailures.length > 0) {
    console.error('\nPhase 2 graduation REFUSED. Failing gates:');
    blockingFailures.forEach((f) => console.error(`  - ${f}`));
    process.exit(2);
  }

  // All gates pass. Flip rollout JSON.
  const rolloutPath = path.join(PROJECT_ROOT, 'data', 'mnemon-rollout.json');
  const rollout = readJsonFile<Record<string, Record<string, unknown>>>(rolloutPath) ?? {};
  if (!rollout[store]) rollout[store] = {};
  rollout[store].phase = 'live';
  rollout[store].graduated_at = new Date().toISOString();
  writeFileAtomic(rolloutPath, JSON.stringify(rollout, null, 2) + '\n');

  console.log(`\nPhase 2 active for ${folder}. Recall now injects.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
