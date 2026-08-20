/**
 * scripts/prune-copied-session-transcripts.ts
 *
 * Reclaim the per-session copies of the group-shared Claude transcripts that
 * `prepareSessionClaudeDir` used to make. That migration was deleted on
 * 2026-08-20 (see the comment there); this reclaims what it already wrote.
 *
 * Background: the group-shared `.claude-shared/projects/<hash>/` dirs stopped
 * being written on 2026-04-21, but every session that spawned after kept
 * copying that whole frozen pile into its own `.claude-projects/<hash>/`.
 * First execute run on 2026-08-20 removed 138,745 files / 22.55 GiB. The source
 * files are still on disk and still readable, so the copies carry no unique
 * bytes; and no live session's resume target can be one of those April
 * filenames, because sdk_session_id is minted by the SDK at first run.
 *
 * Idempotent and re-runnable — a fresh install should find nothing.
 *
 * Deletion predicate — ALL THREE must hold, checked per file:
 *   1. The file is a `.jsonl` under a session's `.claude-projects/<hash>/`.
 *   2. It is byte-identical (size, then sha256) to the same-named file in that
 *      agent group's `.claude-shared/projects/<hash>/`. Byte-identity is the
 *      proof it is a copy — name and mtime alone prove nothing.
 *   3. The session has no live container: `.heartbeat` absent or older than
 *      5 minutes, AND the candidate file itself untouched for 5 minutes.
 *
 * Why both halves of (3): host-sweep treats heartbeat mtime as THE liveness
 * signal (`src/host-sweep.ts` header), but `spawnContainer` unlinks the
 * heartbeat right before docker starts, so a session mid-spawn looks idle by
 * heartbeat alone. During exactly that window the copy has just been written,
 * so its own mtime is fresh. The pair closes the window without shelling out
 * to docker. Both are re-stat'd immediately before each unlink — the service
 * is live and a container may start mid-run.
 *
 * Never touched: inbound.db, outbound.db, outbox/, sessions-index.json, any
 * non-`.jsonl`, any `.jsonl` that is not a proven byte-identical copy, and any
 * directory (nothing is rmdir'd).
 *
 * Usage:
 *   pnpm exec tsx scripts/prune-copied-session-transcripts.ts            # dry run
 *   pnpm exec tsx scripts/prune-copied-session-transcripts.ts --execute
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

const EXECUTE = process.argv.includes('--execute');
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const JOURNAL_PATH = path.join(DATA_DIR, 'transcript-prune-journal.jsonl');
// Every candidate that did NOT match, with the reason. These are the files a
// session actually wrote to, so this list is the audit trail proving the
// comparison discriminates instead of matching everything. Rewritten per run.
const NONMATCH_PATH = path.join(DATA_DIR, 'transcript-prune-nonmatches.jsonl');

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function mtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** Condition 3, re-evaluated from disk. Fails closed on any stat surprise. */
function sessionIsQuiet(sessionDir: string, candidate: string, now: number): boolean {
  const hb = mtimeMs(path.join(sessionDir, '.heartbeat'));
  if (hb !== null && now - hb < LIVE_WINDOW_MS) return false;
  const own = mtimeMs(candidate);
  if (own === null || now - own < LIVE_WINDOW_MS) return false;
  return true;
}

function appendJournal(entry: Record<string, unknown>): void {
  const fd = fs.openSync(JOURNAL_PATH, 'a');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
const runId = new Date().toISOString();

let examined = 0;
let matched = 0;
let deleted = 0;
let bytesMatched = 0;
let bytesDeleted = 0;
let skippedLive = 0;
const perGroup = new Map<string, { files: number; bytes: number }>();
const nonMatchReasons = new Map<string, number>();

fs.writeFileSync(NONMATCH_PATH, '');
function recordNonMatch(file: string, reason: string, extra: Record<string, unknown> = {}): void {
  nonMatchReasons.set(reason, (nonMatchReasons.get(reason) ?? 0) + 1);
  fs.appendFileSync(NONMATCH_PATH, `${JSON.stringify({ run_id: runId, path: file, reason, ...extra })}\n`);
}

for (const agentGroupId of listDir(sessionsRoot).sort()) {
  const groupDir = path.join(sessionsRoot, agentGroupId);
  const sharedRoot = path.join(groupDir, '.claude-shared', 'projects');
  if (!fs.existsSync(sharedRoot)) continue;

  // hash -> (filename -> {size, path}) for this group's frozen shared pile.
  const shared = new Map<string, Map<string, { size: number; file: string }>>();
  for (const hash of listDir(sharedRoot)) {
    const entries = new Map<string, { size: number; file: string }>();
    for (const name of listDir(path.join(sharedRoot, hash))) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(sharedRoot, hash, name);
      try {
        entries.set(name, { size: fs.statSync(file).size, file });
      } catch {
        /* vanished — not a deletion authority for anything */
      }
    }
    if (entries.size > 0) shared.set(hash, entries);
  }
  if (shared.size === 0) continue;

  // sha256 of shared files, computed once per group and only on demand.
  const sharedHash = new Map<string, string>();
  const hashOf = (file: string): string => {
    let h = sharedHash.get(file);
    if (h === undefined) {
      h = sha256(file);
      sharedHash.set(file, h);
    }
    return h;
  };

  for (const sessionId of listDir(groupDir)) {
    if (sessionId.startsWith('.')) continue;
    const sessionDir = path.join(groupDir, sessionId);
    const projectsRoot = path.join(sessionDir, '.claude-projects');
    if (!fs.existsSync(projectsRoot)) continue;

    for (const hash of listDir(projectsRoot)) {
      const sharedForHash = shared.get(hash);
      if (!sharedForHash) continue;
      for (const name of listDir(path.join(projectsRoot, hash))) {
        if (!name.endsWith('.jsonl')) continue;
        const candidate = path.join(projectsRoot, hash, name);
        examined += 1;

        const src = sharedForHash.get(name);
        if (!src) {
          recordNonMatch(candidate, 'no-shared-counterpart');
          continue;
        }
        let size: number;
        try {
          const st = fs.statSync(candidate);
          if (!st.isFile()) continue;
          size = st.size;
        } catch {
          recordNonMatch(candidate, 'stat-failed');
          continue;
        }
        if (size !== src.size) {
          recordNonMatch(candidate, 'size-mismatch', { bytes: size, shared_bytes: src.size, source: src.file });
          continue;
        }
        let identical: boolean;
        try {
          identical = sha256(candidate) === hashOf(src.file);
        } catch {
          recordNonMatch(candidate, 'hash-failed');
          continue;
        }
        if (!identical) {
          recordNonMatch(candidate, 'hash-mismatch', { bytes: size, source: src.file });
          continue;
        }

        matched += 1;
        bytesMatched += size;
        const g = perGroup.get(agentGroupId) ?? { files: 0, bytes: 0 };
        g.files += 1;
        g.bytes += size;
        perGroup.set(agentGroupId, g);

        if (!EXECUTE) continue;
        // Re-check liveness right here, not once at the top of the run.
        if (!sessionIsQuiet(sessionDir, candidate, Date.now())) {
          skippedLive += 1;
          continue;
        }
        try {
          fs.unlinkSync(candidate);
        } catch (err) {
          appendJournal({
            ts: new Date().toISOString(),
            run_id: runId,
            action: 'unlink_failed',
            path: candidate,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        deleted += 1;
        bytesDeleted += size;
        appendJournal({
          ts: new Date().toISOString(),
          run_id: runId,
          action: 'deleted_copied_transcript',
          agent_group_id: agentGroupId,
          session_id: sessionId,
          projects_hash: hash,
          path: candidate,
          source: src.file,
          bytes: size,
        });
      }
    }
  }
}

// GiB, matching what `df -h` reports, so the two are directly comparable.
const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(2)} GiB`;

console.log(EXECUTE ? '=== EXECUTE ===' : '=== DRY RUN (pass --execute to act) ===');
console.log(`files examined:            ${examined}`);
console.log(`byte-identical copies:     ${matched}`);
console.log(`reclaimable:               ${gb(bytesMatched)} (${bytesMatched} bytes)`);
if (EXECUTE) {
  console.log(`deleted:                   ${deleted}`);
  console.log(`reclaimed:                 ${gb(bytesDeleted)} (${bytesDeleted} bytes)`);
  console.log(`skipped (live container):  ${skippedLive}`);
  console.log(`journal:                   ${JOURNAL_PATH}`);
}
console.log(`\nkept (not byte-identical):   ${examined - matched}  -> ${NONMATCH_PATH}`);
for (const [reason, n] of [...nonMatchReasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(24)} ${n}`);
}
console.log('\nper agent group:');
for (const [group, g] of [...perGroup.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${group.padEnd(40)} ${String(g.files).padStart(7)} files  ${gb(g.bytes).padStart(10)}`);
}
