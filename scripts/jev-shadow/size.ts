/**
 * Metadata-only sizing: how much turn spend produced no delivered reply, or a
 * trivially short one. Reads every group (lengths and counts only), sends
 * NOTHING to TypeSafe, prints no message content.
 *
 *   pnpm exec tsx scripts/jev-shadow/size.ts [--since 2026-09-10]
 */
import { loadTurns } from './turns.js';

const since = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1]! : '2026-09-10';
const { turns, missingSession } = loadTurns({ since, scope: 'all' });

const SHORT = 280; // one short sentence or two: "nothing new since the last check"
type Bucket = { turns: number; usd: number };
const add = (m: Map<string, Bucket>, k: string, usd: number) => {
  const b = m.get(k) ?? { turns: 0, usd: 0 };
  b.turns += 1;
  b.usd += usd;
  m.set(k, b);
};

const byTriggerOutcome = new Map<string, Bucket>();
const byModel = new Map<string, Bucket>();
let total = 0;
for (const t of turns) {
  total += t.costUsd;
  const chars = t.outputs.reduce((n, o) => n + o.length, 0);
  const outcome = t.outputs.length === 0 ? 'silent (no chat reply)' : chars <= SHORT ? `short reply (<=${SHORT} chars)` : 'substantive reply';
  add(byTriggerOutcome, `${t.trigger.padEnd(16)} ${outcome}`, t.costUsd);
  add(byModel, `${(t.model ?? '?').padEnd(28)} ${(t.effort ?? '-').padEnd(7)}`, t.costUsd);
}

const print = (title: string, m: Map<string, Bucket>) => {
  console.log(`\n${title}`);
  for (const [k, b] of [...m].sort((a, z) => z[1].usd - a[1].usd))
    console.log(`  ${k}  turns=${String(b.turns).padStart(5)}  $${b.usd.toFixed(0).padStart(6)}  (${((b.usd / total) * 100).toFixed(1)}%)`);
};

console.log(`since ${since}: ${turns.length} turns, $${total.toFixed(0)} total; ${missingSession} turns had no session dir on disk`);
print('by trigger x outcome', byTriggerOutcome);
print('by model x effort', byModel);
