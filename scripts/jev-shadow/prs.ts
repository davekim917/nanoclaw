/**
 * Replay merged fork PRs through ~14 typed Jev checks on the diff — the shape
 * @redp314 posted (one request, typed checks, code turns them into a verdict,
 * the unsure band escalates) — tuned to this repo's own recurring review
 * classes from docs/review-notes.md.
 *
 * Label: did Codex's review of the PR raise a P1? Only PRs with a review from
 * the Codex connector carry a label. That undercounts review: a PR reviewed by
 * a substitute reviewer (a receipt, not a connector review) lands in the
 * "not reviewed" bucket even when it was risk:high and reviewed. Treat "unreviewed but flagged" as a lead to check
 * against the PR's risk labels and receipts, never as a review-scope gap.
 *
 * Result on 2026-09-18 (232 PRs, 53 labelled): worst-critical-check AUC 0.547.
 * Our P1s are multi-hop (a race across an await, a fail-open through a helper,
 * a control bound on one provider only), which is Jev 1.13's documented weak
 * spot; these checks do not predict them.
 *
 * Repo content only.
 *
 *   pnpm exec tsx scripts/jev-shadow/prs.ts [--since 2026-09-08]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ask, MODEL, pool } from './jev.js';

const REPO = 'davekim917/nanoclaw';
const since = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1]! : '2026-09-08';
const OUT = process.env.JEV_SHADOW_OUT ?? path.join(os.homedir(), 'jev-shadow-out');
const MAX_DIFF_CHARS = 60_000; // ~15k tokens: the state budget is 32k tokens incl. the longest question

const gh = (args: string[]) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

interface Pr {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  files: Array<{ path: string }>;
}
// No --limit cap silently truncating the window: page until the window is covered.
const prs: Pr[] = [];
for (let page = 1; ; page += 1) {
  const batch = JSON.parse(
    gh(['api', `repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`]),
  ) as Array<{ number: number; title: string; body: string | null; merged_at: string | null; updated_at: string }>;
  for (const p of batch) if (p.merged_at && p.merged_at >= since) prs.push({ number: p.number, title: p.title, body: p.body ?? '', mergedAt: p.merged_at, files: [] });
  if (batch.length < 100 || batch.at(-1)!.updated_at < since) break;
}

/** Codex's verdict on one PR: reviewed at all, and the worst severity it raised. */
function codexFindings(n: number): { reviewed: boolean; p1: number; p2: number } {
  const q = `query { repository(owner:"davekim917", name:"nanoclaw") { pullRequest(number:${n}) {
    reviews(first:50) { nodes { author { login } } }
    reviewThreads(first:100) { nodes { comments(first:1) { nodes { author { login } body } } } } } } }`;
  const d = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`])) as {
    data: { repository: { pullRequest: { reviews: { nodes: Array<{ author: { login: string } | null }> }; reviewThreads: { nodes: Array<{ comments: { nodes: Array<{ author: { login: string } | null; body: string }> } }> } } } };
  };
  const pr = d.data.repository.pullRequest;
  const isCodex = (a: { login: string } | null) => !!a && a.login.toLowerCase().includes('codex');
  let p1 = 0;
  let p2 = 0;
  for (const t of pr.reviewThreads.nodes) {
    const c = t.comments.nodes[0];
    if (!c || !isCodex(c.author)) continue;
    if (c.body.includes('badge/P1-')) p1 += 1;
    else if (c.body.includes('badge/P2-')) p2 += 1;
  }
  return { reviewed: pr.reviews.nodes.some((r) => isCodex(r.author)), p1, p2 };
}

function diffOf(n: number): { files: string[]; diff: string; truncated: boolean } {
  const full = gh(['pr', 'diff', String(n), '--repo', REPO]);
  const files = [...full.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]!);
  return { files, diff: full.slice(0, MAX_DIFF_CHARS), truncated: full.length > MAX_DIFF_CHARS };
}

// Critical checks: a confident yes on any of these is a P1-shaped defect.
const CRITICAL = {
  fail_open: 'The change reads a missing, null, empty or invalid input as a default that turns a protection OFF (allows, skips a check, or treats unknown as safe) instead of failing closed.',
  enforcement_gap: 'The change adds or edits a safety control that only binds on one path — one hook, one provider, one entry point — while another path that reaches the same action skips it.',
  race: 'The change checks a condition (uniqueness, ownership, existence, a lock) and then acts on it with an await, a subprocess or a file operation in between, so two concurrent callers could both pass the check.',
  secret_exposure: 'The change could put a credential, token or secret into a log line, an error message, a command-line argument, a file, or a chat message.',
  privilege: 'The change widens who or what may perform a privileged action: approvals, roles, credential scoping, mounts, container config, or which commands an agent may run.',
  test_weakened: 'The change deletes, skips or loosens a test assertion, or edits a test so it would still pass if the behavior it names were broken.',
  destructive_path: 'The change adds or edits code that deletes, overwrites, resets or kills something (files, branches, containers, DB rows) without a guard that confirms the target first.',
};
const OTHER = {
  over_broad: 'The change adds a fail-closed guard that would also refuse a legitimate, ordinary state, blocking all the work instead of the one bad input.',
  description_mismatch: 'The code in `diff` does something materially different from, or more than, what `title` and `body` describe.',
  migration: 'The change alters a database schema, a persisted file format, or a config shape that existing data or installs must be migrated from.',
  debug_leftovers: 'The change leaves debug output, commented-out code, a TODO standing in for required logic, or a hard-coded test value in production code.',
};
const QS = {
  ...Object.fromEntries(Object.entries({ ...CRITICAL, ...OTHER }).map(([k, v]) => [k, { type: 'noul' as const, instructions: v }])),
  blast_radius: {
    type: 'score' as const,
    instructions: 'If this change has a defect, how far does it reach at runtime?',
    criteria: ['One script, test or doc; nothing running depends on it.', 'One feature or one agent group.', 'Every session of one provider, or one whole subsystem.', 'Every agent session on the host, or the security boundary itself.'],
  },
};

const rows = await pool(prs, 4, async (p) => {
  const [f, d] = [codexFindings(p.number), diffOf(p.number)];
  const r = await ask({ title: p.title, body: p.body.slice(0, 3000), files: d.files, diff: d.diff, diff_truncated: d.truncated }, QS);
  const probs = Object.fromEntries(Object.keys({ ...CRITICAL, ...OTHER }).map((k) => [k, r.answers[k]!.noul!]));
  const crit = Math.max(...Object.keys(CRITICAL).map((k) => probs[k]!));
  const verdict = crit >= 0.65 ? 'block-or-review' : crit >= 0.35 ? 'escalate' : 'merge';
  return { number: p.number, title: p.title, files: d.files.length, truncated: d.truncated, ...f, probs, blast: r.answers.blast_radius!.score!, crit, verdict, jevUsd: r.costUsd, inTok: r.usage.input_tokens };
});

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `prs-${MODEL}-${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`);
fs.writeFileSync(file, JSON.stringify(rows, null, 1));

const reviewed = rows.filter((r) => r.reviewed);
const pos = reviewed.filter((r) => r.p1 > 0);
const neg = reviewed.filter((r) => r.p1 === 0);
const auc = (k: (r: (typeof rows)[number]) => number) => {
  let s = 0;
  for (const a of pos) for (const b of neg) s += k(a) > k(b) ? 1 : k(a) === k(b) ? 0.5 : 0;
  return pos.length && neg.length ? (s / (pos.length * neg.length)).toFixed(3) : 'n/a';
};
console.log(`${rows.length} merged PRs since ${since}; Jev cost $${rows.reduce((a, r) => a + r.jevUsd, 0).toFixed(4)}, mean ${Math.round(rows.reduce((a, r) => a + r.inTok, 0) / rows.length)} input tokens`);
console.log(`raw results: ${file}\n`);
console.log(`Codex-reviewed: ${reviewed.length} (with a P1: ${pos.length}, without: ${neg.length}); not reviewed: ${rows.length - reviewed.length}`);
console.log(`AUC for "Codex raised a P1": max-critical ${auc((r) => r.crit)}   blast ${auc((r) => r.blast)}`);
for (const k of Object.keys(CRITICAL)) console.log(`   ${k.padEnd(16)} AUC ${auc((r) => r.probs[k]!)}`);
const tab = (set: typeof rows, v: string) => set.filter((r) => r.verdict === v).length;
console.log(`\nverdict      P1-PRs  clean-reviewed  unreviewed`);
for (const v of ['block-or-review', 'escalate', 'merge'])
  console.log(`${v.padEnd(16)} ${String(tab(pos, v)).padStart(3)}  ${String(tab(neg, v)).padStart(10)}  ${String(tab(rows.filter((r) => !r.reviewed), v)).padStart(10)}`);
console.log('\nunreviewed PRs Jev would have pulled into review (block-or-review):');
for (const r of rows.filter((x) => !x.reviewed && x.verdict === 'block-or-review').slice(0, 10)) {
  const top = Object.entries(r.probs).filter(([k]) => k in CRITICAL).sort((a, b) => b[1] - a[1])[0]!;
  console.log(`   #${r.number} ${r.title.slice(0, 60)}  (${top[0]} ${top[1].toFixed(2)})`);
}
