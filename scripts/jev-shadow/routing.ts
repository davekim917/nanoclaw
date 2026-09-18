/**
 * Can Jev tell a hard request from an easy one well enough to route models?
 *
 * Replay cannot say whether a cheaper model would have SUCCEEDED — that needs a
 * live A/B. It can test the precondition: if Jev's difficulty rating of the
 * incoming message does not even track how much work the turn took on the SAME
 * model, it cannot route, and an A/B is not worth running. Held to one
 * model+effort (the biggest bucket, Opus-high) so the model is not the
 * confound.
 *
 * Human-triggered turns in the focus workgroups (FOCUS_WORKGROUPS, set with
 * JEV_SHADOW_FOCUS).
 *
 *   pnpm exec tsx scripts/jev-shadow/routing.ts [--since 2026-09-10]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ask, MODEL, pool } from './jev.js';
import { loadTurns } from './turns.js';

const since = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1]! : '2026-09-10';
const OUT = process.env.JEV_SHADOW_OUT ?? path.join(os.homedir(), 'jev-shadow-out');

const TIERS = ['mechanical', 'routine', 'complex', 'open_ended'] as const;
const QS = {
  tier: {
    type: 'choice' as const,
    instructions: 'What capability does answering `request` need from the agent that receives it?',
    criteria: {
      mechanical: 'A lookup, a status check, an acknowledgement, or a fixed routine with no judgment — a small fast model would do it correctly.',
      routine: 'Ordinary work with some judgment: summarize, draft a reply, triage, or make a small, well-specified change.',
      complex: 'Multi-step engineering or analysis: debugging, a change touching several parts, careful review, or reconciling conflicting sources.',
      open_ended: 'Ambiguous or strategic work where the right approach has to be worked out first.',
    },
  },
};

const { turns } = loadTurns({ since, scope: 'focus', maxChars: 3000 });
const human = turns.filter((t) => t.trigger === 'human' && t.inputs.length > 0 && t.model?.includes('opus') && t.effort === 'high');

const rows = await pool(human, 8, async (t) => {
  const r = await ask({ request: t.inputs.map((i) => i.text).join('\n---\n') }, QS);
  const a = r.answers.tier!;
  const p = a.probabilities!;
  return {
    ts: t.ts,
    folder: t.folder,
    costUsd: t.costUsd,
    steps: t.steps ?? 0,
    tier: a.choice!,
    conf: a.confidence!,
    // Expected tier position 0..3 from the distribution — finer than the argmax.
    expected: TIERS.reduce((s, k, i) => s + i * (p[k] ?? 0), 0),
    request: t.inputs[0]!.text.slice(0, 200),
    jevUsd: r.costUsd,
  };
});
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `routing-${MODEL}-${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`);
fs.writeFileSync(file, JSON.stringify(rows, null, 1));

const rank = (xs: number[]) => {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j += 1;
    for (let k = i; k <= j; k += 1) r[idx[k]![1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
};
const spearman = (a: number[], b: number[]) => {
  const ra = rank(a);
  const rb = rank(b);
  const m = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = m(ra);
  const mb = m(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i += 1) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
};

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
console.log(`${rows.length} human turns on Opus-high, $${rows.reduce((s, r) => s + r.costUsd, 0).toFixed(0)}; Jev cost $${rows.reduce((s, r) => s + r.jevUsd, 0).toFixed(4)}`);
console.log(`raw results: ${file}\n`);
console.log(`Spearman(expected tier, steps) = ${spearman(rows.map((r) => r.expected), rows.map((r) => r.steps)).toFixed(3)}`);
console.log(`Spearman(expected tier, cost)  = ${spearman(rows.map((r) => r.expected), rows.map((r) => r.costUsd)).toFixed(3)}\n`);
console.log('tier         turns   spend   median steps   median $');
for (const k of TIERS) {
  const g = rows.filter((r) => r.tier === k);
  if (!g.length) continue;
  console.log(`${k.padEnd(12)} ${String(g.length).padStart(5)}  $${g.reduce((s, r) => s + r.costUsd, 0).toFixed(0).padStart(5)}   ${String(med(g.map((r) => r.steps))).padStart(10)}   ${med(g.map((r) => r.costUsd)).toFixed(2).padStart(7)}`);
}
const cheap = rows.filter((r) => (r.tier === 'mechanical' || r.tier === 'routine') && r.conf >= 0.8);
console.log(`\nconfidently mechanical/routine (conf >= 0.8): ${cheap.length} turns, $${cheap.reduce((s, r) => s + r.costUsd, 0).toFixed(0)} — the most a correct router could move off Opus-high`);
