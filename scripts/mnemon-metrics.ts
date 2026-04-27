#!/usr/bin/env tsx
/**
 * Ad-hoc operator CLI for mnemon metrics.
 * Reads from data/mnemon-metrics/ and data/mnemon-health.json.
 *
 * Usage:
 *   pnpm exec tsx scripts/mnemon-metrics.ts [--store <id>] [--since <duration>] [--summary]
 *
 * Flags:
 *   --store <id>      Filter to a specific store ID
 *   --since <dur>     Time window, e.g. 1h, 24h, 7d (default: 24h)
 *   --summary         One-line per store instead of full table
 *   --json            Emit raw JSON instead of tabular output
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

const STORES_DIR = path.join(DATA_DIR, 'mnemon-metrics', 'stores');
const HEALTH_FILE = path.join(DATA_DIR, 'mnemon-health.json');

function parseDuration(d: string): number {
  const m = /^(\d+)(h|d|m)$/.exec(d);
  if (!m) return 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    case 'm': return n * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let store: string | null = null;
  let since = '24h';
  let summary = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--store' && args[i + 1]) { store = args[++i]; continue; }
    if (args[i] === '--since' && args[i + 1]) { since = args[++i]; continue; }
    if (args[i] === '--summary') { summary = true; continue; }
    if (args[i] === '--json') { json = true; continue; }
  }
  return { store, since, summary, json };
}

interface StoreRow {
  ts: string;
  store: string;
  [key: string]: unknown;
}

function readStoreRows(storeId: string, cutoff: number): StoreRow[] {
  const file = path.join(STORES_DIR, `${storeId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StoreRow)
      .filter((r) => Date.parse(r.ts) >= cutoff);
  } catch {
    return [];
  }
}

function readHealth(): Record<string, { phase: string; recent_unhealthy_events: unknown[] }> {
  if (!fs.existsSync(HEALTH_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) as Record<string, { phase: string; recent_unhealthy_events: unknown[] }>;
  } catch {
    return {};
  }
}

function listStoreIds(): string[] {
  if (!fs.existsSync(STORES_DIR)) return [];
  try {
    return fs.readdirSync(STORES_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''));
  } catch {
    return [];
  }
}

function main() {
  const { store, since, summary, json } = parseArgs();
  const cutoff = Date.now() - parseDuration(since);
  const health = readHealth();

  const storeIds = store ? [store] : listStoreIds();

  if (storeIds.length === 0) {
    console.log('No mnemon store metrics found. Run mnemon-metrics-collector.ts first.');
    return;
  }

  const results: Array<{
    store: string;
    phase: string;
    rows: number;
    latest_ts: string | null;
    latest_status: Record<string, unknown> | null;
    unhealthy_events: number;
  }> = [];

  for (const id of storeIds) {
    const rows = readStoreRows(id, cutoff);
    const h = health[id];
    const latest = rows.length > 0 ? rows[rows.length - 1] : null;
    const { ts: _ts, store: _store, ...latestStatus } = latest ?? {};
    results.push({
      store: id,
      phase: h?.phase ?? 'unknown',
      rows: rows.length,
      latest_ts: latest?.ts ?? null,
      latest_status: latest ? latestStatus as Record<string, unknown> : null,
      unhealthy_events: h?.recent_unhealthy_events?.length ?? 0,
    });
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (summary) {
    for (const r of results) {
      const status = r.phase === 'unhealthy' ? 'UNHEALTHY' : 'ok';
      console.log(`${r.store}  ${status}  rows=${r.rows}  last=${r.latest_ts ?? 'none'}`);
    }
    return;
  }

  // Full tabular output
  for (const r of results) {
    console.log(`\n=== Store: ${r.store} ===`);
    console.log(`  Phase:            ${r.phase}`);
    console.log(`  Rows in window:   ${r.rows} (since ${since})`);
    console.log(`  Latest sample:    ${r.latest_ts ?? 'none'}`);
    console.log(`  Unhealthy events: ${r.unhealthy_events} (last hour)`);
    if (r.latest_status && Object.keys(r.latest_status).length > 0) {
      console.log('  Latest status:');
      for (const [k, v] of Object.entries(r.latest_status)) {
        console.log(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
  }
}

main();
