// Track B baseline miner — read-only.
//
// Anthropic diagnosed their overconstraint by reading their own transcripts.
// This does the equivalent: scans every session outbound.db for observable
// fingerprints of the bucket-3 directives, so "no measurable loss" can be
// checked after softening instead of asserted.
//
// Opens each DB read-only in ONE process (2,753 DBs — a process per DB is
// hopeless). Never writes.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SESS = path.join(ROOT, 'data', 'v2-sessions');

// Each probe: what directive it fingerprints, and a regex over agent output.
const PROBES = [
  // C5 / humanizer gate — is the mandated skill actually being invoked, and on what?
  { id: 'humanizer_mention', dir: 'humanizer gate', re: /\bhumaniz(e|er|ed|ing)\b/i },
  // C2 — the mandated 3-part completion recitation
  { id: 'verified_recitation', dir: 'Completion Protocol', re: /what I verified|cases checked|beyond the happy path|verification evidence/i },
  { id: 'cannot_verify_hedge', dir: 'Completion Protocol', re: /cannot verify|could not verify|unable to verify/i },
  // C3 — plan-first vs outcomes-only
  { id: 'plan_first', dir: 'plan-before-work', re: /here'?s (my|the) plan|before I (start|begin)|I'?m going to (start|begin|do)|my plan is/i },
  // C1 — overachieve vs YAGNI
  { id: 'overachieve', dir: 'Owner-mode overachieve', re: /while I was (in there|at it)|also fixed|took the opportunity|since I was already|bonus[: ]/i },
  { id: 'ponytail_restraint', dir: 'ponytail ladder', re: /\bskipped:|\bponytail:|YAGNI|over-?engineer/i },
  // meta-response garbage the system prompt explicitly forbids
  { id: 'meta_response', dir: 'meta-response ban', re: /no response (is )?requested|does not require a response|no reply needed/i },
];

const files = [];
(function walk(d, depth) {
  if (depth > 3) return;
  let entries = [];
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
    else if (e.name === 'outbound.db') files.push(path.join(d, e.name));
  }
})(SESS, 0);

const counts = Object.fromEntries(PROBES.map((p) => [p.id, 0]));
const samples = Object.fromEntries(PROBES.map((p) => [p.id, []]));
let dbs = 0, msgs = 0, chars = 0, skipped = 0;
const lengths = [];

for (const f of files) {
  let db;
  try {
    db = new Database(f, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT content FROM messages_out WHERE kind='chat'").all();
    dbs++;
    for (const r of rows) {
      let text = '';
      try { text = JSON.parse(r.content)?.text ?? ''; } catch { text = String(r.content ?? ''); }
      if (!text) continue;
      msgs++; chars += text.length; lengths.push(text.length);
      for (const p of PROBES) {
        if (p.re.test(text)) {
          counts[p.id]++;
          if (samples[p.id].length < 3) {
            samples[p.id].push(text.replace(/\s+/g, ' ').slice(0, 210));
          }
        }
      }
    }
  } catch { skipped++; } finally { try { db?.close(); } catch { /* noop */ } }
}

lengths.sort((a, b) => a - b);
const pct = (q) => lengths.length ? lengths[Math.floor(lengths.length * q)] : 0;

console.log(`corpus: ${dbs} session DBs read (${skipped} unreadable), ${msgs} agent chat messages\n`);
console.log('message length (chars): p50=%d p90=%d p99=%d mean=%d',
  pct(0.5), pct(0.9), pct(0.99), msgs ? Math.round(chars / msgs) : 0);
console.log('\n%s %s %s %s', 'probe'.padEnd(22), 'directive'.padEnd(24), 'msgs'.padEnd(8), 'rate');
for (const p of PROBES) {
  const n = counts[p.id];
  console.log('%s %s %s %s', p.id.padEnd(22), p.dir.padEnd(24), String(n).padEnd(8),
    msgs ? (100 * n / msgs).toFixed(2) + '%' : '-');
}
console.log('\n--- samples ---');
for (const p of PROBES) {
  if (!samples[p.id].length) continue;
  console.log(`\n[${p.id}]`);
  for (const s of samples[p.id]) console.log('  · ' + s);
}
