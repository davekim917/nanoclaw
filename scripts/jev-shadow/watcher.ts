/**
 * Replay a PR-watcher task series through Jev: would a judgment on WHAT
 * CHANGED have skipped the wake, or routed it off Opus-high?
 *
 * The series this was built for has a host script (`scriptHost`) that wakes the
 * agent whenever the fingerprint of its PR snapshot changes, plus a forced heartbeat every third idle tick, and every
 * wake runs on Opus-high (`flagIntent`). Code can see THAT the snapshot moved;
 * this asks Jev WHETHER the move matters. Code does the diff — Jev does not
 * diff reliably (docs.typesafe.ai/model-jaggedness/jev-1.13) — and Jev judges
 * the short change list.
 *
 * Two requests per fire, on separate states, so the predictor never sees the
 * outcome:
 *   input  {changes, board}  → needs_owner (Noul), tier (Choice)
 *   output {ledger_note, …}  → acted (Choice) — the label
 *
 * Reads the focus workgroups only (FOCUS_WORKGROUPS). Writes raw results to
 * $JEV_SHADOW_OUT (default ~/jev-shadow-out).
 *
 *   JEV_SHADOW_FOCUS=<workgroup> pnpm exec tsx scripts/jev-shadow/watcher.ts \
 *     --folder <group folder> --prefix '<task prompt prefix>' [--since 2026-09-10]
 *
 * It assumes the series' `scriptOutput` shape (watch_state, ready_to_merge,
 * stalled, …) and a `task_log` ledger note per fire; another series needs its
 * own `diff`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ask, MODEL, pool } from './jev.js';
import { loadTurns } from './turns.js';

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const since = arg('--since') ?? '2026-09-10';
const folder = arg('--folder');
const prefix = arg('--prefix');
if (!folder || !prefix) {
  console.error("usage: watcher.ts --folder <group folder> --prefix '<task prompt prefix>' [--since <iso date>]");
  process.exit(2);
}
const OUT = process.env.JEV_SHADOW_OUT ?? path.join(os.homedir(), 'jev-shadow-out');

type Snap = Record<string, unknown> & { watch_state?: Array<Record<string, unknown>> };

const LIST_SIGNALS = ['ready_to_merge', 'ready_low_risk', 'escalated_claims', 'hostage_branches', 'lane_missing', 'gate_stale', 'capped_prs'];
const SCALAR_SIGNALS = ['codex_approved_ready', 'develop_ci', 'merge_hold', 'smoke_hold', 'fetch_ok', 'open_prs'];

const key = (e: Record<string, unknown>) => `${e.repo}#${e.n}`;
const checks = (e: Record<string, unknown>) => {
  // `c` has drifted across the script's history (an array in current snapshots,
  // not in some older ones); read any non-array as "no checks" rather than throw.
  const c: string[] = Array.isArray(e.c) ? (e.c as string[]) : [];
  const fail = c.filter((x) => x === 'FAILURE' || x === 'ERROR' || x === 'CANCELLED' || x === 'TIMED_OUT').length;
  const pend = c.filter((x) => x === '' || x === 'PENDING' || x === 'IN_PROGRESS' || x === 'QUEUED' || x == null).length;
  return fail ? `${fail} failing` : pend ? `${pend} pending` : c.length ? 'all green' : 'no checks';
};
// Identity of a list member. Claims and stalls carry age counters (`h`, `bucket`)
// that tick every hour; keying on the whole object reported each tick as a
// gained+lost pair — the most common "change" in the first run. Key on the
// member's identity instead so a change means something happened.
const asList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => {
        if (typeof x !== 'object' || !x) return String(x);
        const o = x as Record<string, unknown>;
        return String(o.pr ?? o.slug ?? o.branch ?? JSON.stringify(x));
      })
    : [];

/** Human-readable change list between two consecutive snapshots. Deterministic. */
export function diff(prev: Snap | null, cur: Snap): string[] {
  if (!prev) return ['first fire in the window: no previous snapshot to compare'];
  const out: string[] = [];
  for (const k of LIST_SIGNALS) {
    const a = new Set(asList(prev[k]));
    const b = new Set(asList(cur[k]));
    for (const x of b) if (!a.has(x)) out.push(`${k} gained ${x}`);
    for (const x of a) if (!b.has(x)) out.push(`${k} lost ${x}`);
  }
  const stalledPrev = new Set(asList(prev.stalled));
  for (const x of asList(cur.stalled)) if (!stalledPrev.has(x)) out.push(`${x} newly stalled`);
  for (const k of SCALAR_SIGNALS)
    if (JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) out.push(`${k}: ${JSON.stringify(prev[k])} -> ${JSON.stringify(cur[k])}`);
  const qa = (s: Snap) =>
    new Map(
      (((s.qa_handoffs as { pending?: Array<Record<string, unknown>> } | undefined)?.pending ?? []) as Array<Record<string, unknown>>).map(
        (h) => [String(h.runId), `${h.status}/${h.verdict ?? ''}/${h.evidenceStatus ?? ''}`],
      ),
    );
  const qp = qa(prev);
  for (const [id, st] of qa(cur)) if (qp.get(id) !== st) out.push(`QA handoff ${id.slice(0, 40)}: ${qp.get(id) ?? 'new'} -> ${st}`);
  const pm = new Map((prev.watch_state ?? []).map((e) => [key(e), e]));
  const cm = new Map((cur.watch_state ?? []).map((e) => [key(e), e]));
  for (const [k, e] of cm) {
    const p = pm.get(k);
    if (!p) {
      out.push(`${k} newly open (lane ${e.lane}, checks ${checks(e)})`);
      continue;
    }
    if (p.o !== e.o) out.push(`${k} new commit (checks now ${checks(e)})`);
    else if (checks(p) !== checks(e)) out.push(`${k} checks ${checks(p)} -> ${checks(e)}`);
    if (p.r !== e.r) out.push(`${k} review ${JSON.stringify(p.r)} -> ${JSON.stringify(e.r)}`);
    if (p.lane !== e.lane) out.push(`${k} lane ${p.lane} -> ${e.lane}`);
    if (p.d !== e.d) out.push(`${k} draft ${p.d} -> ${e.d}`);
    if (p.shipok !== e.shipok) out.push(`${k} ship-ok ${p.shipok} -> ${e.shipok}`);
  }
  for (const k of pm.keys()) if (!cm.has(k)) out.push(`${k} closed or merged`);
  return out.length ? out : ['no change in any tracked signal (heartbeat wake)'];
}

const INPUT_QS = {
  needs_owner: {
    type: 'noul' as const,
    instructions:
      'At least one entry in `changes` requires the release owner to act now: merge a PR that became ready, respond to a new review verdict, handle a failing check or a red develop build, unblock a newly stalled or escalated PR, or answer a QA handoff.',
    criteria: {
      true: 'Some change asks for a decision or an action from the owner right now.',
      false:
        'Every change is progress with nothing to decide yet: checks still running, a new commit waiting for CI, a PR still waiting on review, or a heartbeat with no change.',
    },
  },
  tier: {
    type: 'choice' as const,
    instructions: 'What does handling `changes` need from the agent that wakes for it?',
    criteria: {
      bookkeeping: 'Status bookkeeping only: record what moved; nothing to judge or act on.',
      routine:
        'A routine action with a clear rule: merge a low-risk PR whose checks and review are green, re-run a flaky check, or lane a new PR.',
      judgment:
        'Careful judgment: a review verdict on a risky change, a failing gate to diagnose, a conflict between reviewers, a QA verdict, or a stall that needs a decision.',
    },
  },
};

const OUTPUT_QS = {
  acted: {
    type: 'choice' as const,
    instructions: 'What did this wake of the release-watch agent actually do, according to `ledger_note` and `decision_cards_raised`?',
    criteria: {
      merged_or_decided: 'It merged a PR, posted a review verdict, or raised a decision card for a person.',
      dispatched_or_flagged:
        'It dispatched a reviewer or worker, laned or reassigned a PR, or flagged a stall or alert — without merging or deciding.',
      observed_only: 'It only recorded status; it took no action.',
    },
  },
};

const { turns } = loadTurns({ since, scope: 'focus', folders: new Set([folder]), raw: true, maxChars: 4000 });
const fires = turns
  .filter((t) => t.trigger === 'scheduled' && t.inputs[0]?.text.startsWith(prefix))
  .sort((a, b) => a.ts.localeCompare(b.ts));

let prev: Snap | null = null;
const jobs = fires.map((t) => {
  const cur = (JSON.parse(t.inputs[0]!.raw!) as { scriptOutput?: Snap }).scriptOutput ?? {};
  const changes = diff(prev, cur);
  prev = cur;
  const board = {
    ready_to_merge: cur.ready_to_merge,
    merge_hold: cur.merge_hold,
    develop_ci: cur.develop_ci,
    stalled: asList(cur.stalled),
    open_prs: cur.open_prs,
  };
  return { t, changes, board };
});

fs.mkdirSync(OUT, { recursive: true });
const results = await pool(jobs, 8, async ({ t, changes, board }) => {
  const [inp, outp] = await Promise.all([
    ask({ changes, board }, INPUT_QS),
    ask(
      {
        ledger_note: t.logs.join('\n') || '(no ledger note written)',
        decision_cards_raised: t.otherWrites.system ?? 0,
      },
      OUTPUT_QS,
    ),
  ]);
  return {
    ts: t.ts,
    costUsd: t.costUsd,
    steps: t.steps,
    changes,
    needsOwner: inp.answers.needs_owner!.noul!,
    tier: inp.answers.tier!.choice!,
    tierConf: inp.answers.tier!.confidence!,
    acted: outp.answers.acted!.choice!,
    actedConf: outp.answers.acted!.confidence!,
    ledger: t.logs.join(' ').slice(0, 600),
    jevUsd: inp.costUsd + outp.costUsd,
  };
});
const file = path.join(OUT, `watcher-${MODEL}-${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 1));

// ---- report ----
const tot = results.reduce((a, r) => a + r.costUsd, 0);
const acted = (r: (typeof results)[number]) => r.acted !== 'observed_only';
console.log(`${results.length} fires, $${tot.toFixed(0)} agent spend; Jev cost $${results.reduce((a, r) => a + r.jevUsd, 0).toFixed(4)}`);
console.log(`raw results: ${file}\n`);
const by = (f: (r: (typeof results)[number]) => string) => {
  const m = new Map<string, { n: number; usd: number; acted: number }>();
  for (const r of results) {
    const k = f(r);
    const b = m.get(k) ?? { n: 0, usd: 0, acted: 0 };
    b.n += 1;
    b.usd += r.costUsd;
    b.acted += acted(r) ? 1 : 0;
    m.set(k, b);
  }
  return [...m].sort((a, b) => b[1].usd - a[1].usd);
};
console.log('outcome label (Jev on the ledger note):');
for (const [k, b] of by((r) => r.acted)) console.log(`  ${k.padEnd(22)} ${String(b.n).padStart(3)} fires  $${b.usd.toFixed(0).padStart(4)}`);
console.log('\ninput tier (Jev on the change list) -> share that acted:');
for (const [k, b] of by((r) => r.tier)) console.log(`  ${k.padEnd(12)} ${String(b.n).padStart(3)} fires  $${b.usd.toFixed(0).padStart(4)}  acted ${((b.acted / b.n) * 100).toFixed(0)}%`);
const hb = results.filter((r) => r.changes[0]!.startsWith('no change'));
console.log(`\nheartbeat wakes (no tracked change): ${hb.length} fires, $${hb.reduce((a, r) => a + r.costUsd, 0).toFixed(0)}, acted ${hb.filter(acted).length}`);
// AUC of needs_owner for acted
const pos = results.filter(acted).map((r) => r.needsOwner);
const neg = results.filter((r) => !acted(r)).map((r) => r.needsOwner);
let s = 0;
for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
console.log(`\nneeds_owner AUC for "acted": ${pos.length && neg.length ? (s / (pos.length * neg.length)).toFixed(3) : 'n/a'}  (acted n=${pos.length}, observed-only n=${neg.length})`);
{
  const hc = results.filter((r) => r.actedConf >= 0.8);
  const hp = hc.filter(acted).map((r) => r.needsOwner);
  const hn = hc.filter((r) => !acted(r)).map((r) => r.needsOwner);
  let hs = 0;
  for (const p of hp) for (const n of hn) hs += p > n ? 1 : p === n ? 0.5 : 0;
  console.log(`  on labels with confidence >= 0.8 only: AUC ${hp.length && hn.length ? (hs / (hp.length * hn.length)).toFixed(3) : 'n/a'} (acted n=${hp.length}, observed-only n=${hn.length})`);
}
for (const th of [0.2, 0.3, 0.4, 0.5]) {
  const skip = results.filter((r) => r.needsOwner < th);
  console.log(
    `  skip when needs_owner < ${th}: skips ${skip.length} fires ($${skip.reduce((a, r) => a + r.costUsd, 0).toFixed(0)}), of which ${skip.filter(acted).length} had acted`,
  );
}
