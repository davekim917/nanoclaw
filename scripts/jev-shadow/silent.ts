/**
 * Scheduled turns that delivered no chat reply, grouped by what woke them.
 * Local only: reads every group, sends nothing, prints only the first 70
 * characters of each task prompt (text we author, shown on this host).
 *
 *   pnpm exec tsx scripts/jev-shadow/silent.ts [--since 2026-09-10]
 */
import { loadTurns } from './turns.js';

const since = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1]! : '2026-09-10';
const { turns } = loadTurns({ since, scope: 'all', maxChars: 200 });

type S = { turns: number; silent: number; usd: number; silentUsd: number; steps: number[]; writes: Record<string, number> };
const groups = new Map<string, S>();
let silentUsd = 0;
let scheduledUsd = 0;
for (const t of turns.filter((x) => x.trigger === 'scheduled')) {
  const first = t.inputs[0];
  const label = first
    ? `${t.folder} | ${first.seriesId ? 'series' : 'one-shot'} ${first.kind} | ${first.text.replace(/\s+/g, ' ').slice(0, 70)}`
    : `${t.folder} | (no inbound trigger row: continuation or wait wake)`;
  const s: S = groups.get(label) ?? { turns: 0, silent: 0, usd: 0, silentUsd: 0, steps: [], writes: {} };
  const silent = t.outputs.length === 0;
  s.turns += 1;
  s.usd += t.costUsd;
  scheduledUsd += t.costUsd;
  if (silent) {
    s.silent += 1;
    s.silentUsd += t.costUsd;
    silentUsd += t.costUsd;
    s.steps.push(t.steps ?? 0);
    for (const [k, n] of Object.entries(t.otherWrites)) s.writes[k] = (s.writes[k] ?? 0) + n;
  }
  groups.set(label, s);
}

console.log(`scheduled since ${since}: $${scheduledUsd.toFixed(0)}, of which $${silentUsd.toFixed(0)} delivered no chat reply\n`);
for (const [label, s] of [...groups].sort((a, b) => b[1].silentUsd - a[1].silentUsd).slice(0, 15)) {
  const med = [...s.steps].sort((a, b) => a - b)[Math.floor(s.steps.length / 2)] ?? 0;
  const writes = Object.entries(s.writes).map(([k, n]) => `${k}:${n}`).join(' ') || 'nothing written';
  console.log(`$${s.silentUsd.toFixed(0).padStart(5)} silent ${String(s.silent).padStart(3)}/${String(s.turns).padEnd(3)} median steps ${String(med).padStart(3)}  wrote ${writes}`);
  console.log(`        ${label}`);
}
