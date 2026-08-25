/**
 * "Who's on what right now" — work claims rendered as a board section.
 *
 * Claims are files a sibling agent writes before starting work and deletes on
 * completion (`container/skills/work-claims/`). They already answer the one
 * question a human keeps asking — *is anyone on this, and is that still true?*
 * — but only to whoever reads the directory, which is nobody.
 *
 * This is the read side. It deliberately owns no I/O beyond the directory scan
 * and no staleness rule of its own: `isStalePastGrace` and
 * `ESCALATION_GRACE_MS` come from `modules/claims/escalation.ts`, so the board
 * and the dashboard's `escalated` badge (`dashboard/api/workgroups.ts`) can
 * never disagree about what "stale" means. A third definition living here is
 * exactly how a board starts lying.
 *
 * Rendered into the existing channel canvas rather than a canvas of its own.
 * The board answers "what work exists"; claims answer "who has it". Those are
 * one status board, and a second canvas would be one more place to look — the
 * thing that made the standalone dashboard go unread.
 */

import fs from 'fs';
import path from 'path';

import { TIMEZONE } from './config.js';
// The one contained-read seam this fork has, reused rather than re-derived.
// It lives under `dashboard/api/` because that is where the first caller was;
// it depends on nothing but `fs`, `path` and `log`, so there is no cycle with
// the dashboard modules that import THIS file.
import { containedRealpath, readContainedFile } from './dashboard/api/attention-fs.js';
import { log } from './log.js';
import {
  claimsBaseDir,
  declaresItselfFinished,
  ESCALATION_GRACE_MS,
  isStalePastGrace,
  noteHeadline,
} from './modules/claims/escalation.js';
import { formatLocalTime } from './timezone.js';

/** Past its TTL but inside the grace window — not yet an alert, already worth seeing. */
export type ClaimState = 'live' | 'expiring' | 'stale' | 'parked';

export interface BoardClaim {
  slug: string;
  owner: string;
  note: string;
  threadId: string | null;
  state: ClaimState;
  /** ms past expiry; negative while still live. */
  staleMs: number;
  escalated: boolean;
}

function classify(claimedAt: string, ttlHours: number, now: number): { state: ClaimState; staleMs: number } {
  const { staleMs } = isStalePastGrace(claimedAt, ttlHours, now);
  if (staleMs > ESCALATION_GRACE_MS) return { state: 'stale', staleMs };
  if (staleMs > 0) return { state: 'expiring', staleMs };
  return { state: 'live', staleMs };
}

/**
 * The largest number of claim files one read will open.
 *
 * {@link MAX_CLAIM_BYTES} bounds how big each file may be; nothing bounded how
 * MANY there are. `data/workgroups/<id>/claims/` is bind-mounted READ-WRITE at
 * `/workspace/workgroup/claims` into that workgroup's own containers
 * (`container-runner.ts`; `container/skills/work-claims/claim.sh` writes
 * straight into it), so the file COUNT is chosen by an agent — and this whole
 * loop runs synchronously inside the thread-list request
 * (`board-attention.ts` calls `readClaims` on every memo miss), which the
 * dashboard polls continuously from every open viewer. A directory grown to
 * thousands of entries is that many blocking opens and `JSON.parse`s on the
 * host's single event loop, per poll, per viewer.
 *
 * Across this install the busiest claims directory holds 38 files and the next
 * busiest 8. 500 is over thirteen times the busiest, so the cap cannot bite on
 * organic growth — not even on the known pathology of finished claims left
 * undeleted, which is what accumulates here. It bites only on a directory
 * somebody filled, which is exactly when a human should hear about it.
 * Together with the per-file cap it bounds one read at 500 × 64 KiB.
 */
const MAX_CLAIM_FILES = 500;

/**
 * The largest claim file this read will open.
 *
 * Deliberately far tighter than `attention-fs.ts`'s 2 MiB default, because
 * that seam reads a handful of declared files per request and this one reads
 * every file in a directory: what blocks the event loop is count × size. At
 * the default, one directory of 500 files could be a gigabyte of blocking read
 * and parse per poll.
 *
 * A claim is a small JSON record — owner, two timestamps, a TTL, a note. The
 * largest live claim on disk is 2.2 KB, so 64 KiB is ~30x the biggest real one
 * and still leaves room for the paragraphs of handoff detail notes routinely
 * carry. Anything past it is not a claim.
 */
const MAX_CLAIM_BYTES = 64 * 1024;

/**
 * `entries` least-recently-touched first.
 *
 * Only called when the count cap bites, and the order matters precisely then:
 * `readdirSync` hands back whatever the filesystem stored, so slicing it
 * unordered would drop an ARBITRARY set. The board exists to surface work
 * nobody is coming back for, so the entries it must never drop are the ones
 * least recently written — an alphabetical or as-listed cut would throw away
 * abandoned claims and keep healthy ones about half the time, which is the
 * absence-as-fact bug this seam keeps eliminating.
 *
 * ponytail: one `lstat` per entry, on the already-paid enumeration and only
 * past the cap. If a directory ever gets large enough that the stat loop
 * itself is the cost, the fix is an mtime-ordered index, not a cheaper sort.
 */
function oldestFirst(dir: string, entries: string[]): string[] {
  const mtime = new Map<string, number>();
  for (const entry of entries) {
    // `lstat`, never `stat`: it never traverses a symlink (so it cannot be
    // pointed at something expensive) and never blocks — only `open` blocks on
    // a FIFO. An entry that vanished between `readdir` and here sorts last; it
    // would fail the open anyway.
    const st = fs.lstatSync(path.join(dir, entry), { throwIfNoEntry: false });
    mtime.set(entry, st ? st.mtimeMs : Infinity);
  }
  return [...entries].sort((a, b) => mtime.get(a)! - mtime.get(b)!);
}

/**
 * Every claim in a workgroup, classified. Unparseable files are skipped with a
 * warning rather than throwing — one bad file must not blank the whole board.
 * A claim missing `claimed_at`/`ttl_hours` counts as stale for the same reason
 * `claim.sh` does: it must never read as an indefinite hold on the work.
 *
 * Every entry is read through `readContainedFile`, so a FIFO, a directory, a
 * device node, an oversized file and one symlinked out of the claims directory
 * are all skipped with a log — the same treatment malformed JSON already got,
 * for the same reason: one bad entry must not blank the board. That seam, not
 * a `readFileSync`, is what keeps a `mkfifo` in an agent-writable directory
 * from hanging the host's event loop on the open.
 */
export function readClaims(workgroupId: string, now: number, root: string = claimsBaseDir()): BoardClaim[] {
  // Containment on the DIRECTORY, resolved once. `claims/` is agent-writable,
  // so it can be replaced with a symlink at a sibling workgroup's folder — a
  // cross-workgroup read straight through the data-pool boundary, and one that
  // self-heal would then act on in the wrong workgroup. Resolving it here also
  // gives `readContainedFile` the realpath'd root its per-file fd check needs.
  //
  // Absent and escaping take the same silent exit: most workgroups have no
  // claims directory at all, so warning here would fire on every poll for
  // every one of them. Both mean the same thing — read nothing.
  let dir: string | null;
  try {
    const workgroupDir = fs.realpathSync(path.join(root, workgroupId));
    dir = containedRealpath(workgroupDir, path.join(workgroupDir, 'claims'));
  } catch {
    dir = null; // no workgroup dir — shared FS not enabled, or nothing claimed yet
  }
  if (dir === null) return [];

  let all: string[];
  try {
    all = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return []; // no claims dir — workgroup shared FS not enabled, or nothing claimed yet
  }

  const entries = all.length > MAX_CLAIM_FILES ? oldestFirst(dir, all).slice(0, MAX_CLAIM_FILES) : all;
  const skipped = all.length - entries.length;
  if (skipped > 0) {
    // LOUD, never a silent truncation. There is no honest place to surface
    // this as a row: `readClaims` returns `BoardClaim`s that self-heal
    // (`modules/claims/self-heal.ts`) re-reads BY SLUG and stamps on disk, and
    // that nudge/steer look up by slug — a synthetic claim would be a fake
    // slug those paths would try to act on. So the log line is the surface.
    log.warn('Claims board: more claim files than the read cap, reading only the oldest', {
      workgroupId,
      total: all.length,
      cap: MAX_CLAIM_FILES,
      skipped,
    });
  }

  const claims: BoardClaim[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    // Containment, file type, size cap and the read are one operation on one
    // descriptor — see `readContainedFile`. A per-file check that a later
    // `readFileSync` could outrun is not a check, and a plain `readFileSync`
    // on a FIFO blocks the open forever before any check can run.
    const read = readContainedFile('Claims board', dir, entry, workgroupId, MAX_CLAIM_BYTES);
    if (read === null) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(read.text) as Record<string, unknown>;
    } catch (err) {
      log.warn('Claims board: unparseable claim, skipping', { file, err });
      continue;
    }

    // Parked wins over everything else: a parked note routinely says "not
    // done" (that's the point of leaving a note), and the finished-claim
    // filter below would otherwise have to guess whether that means finished
    // or handed off. Checked before TTL/finished logic so neither can shadow it.
    const isParked = typeof raw.status === 'string' && raw.status.trim().toLowerCase() === 'parked';

    // A claim that says it finished is not live work, whatever its timestamps
    // say. 14 of 15 live claims on the first real render were completed work
    // left on disk — rendering those as "nobody is coming back for these" is
    // both wrong and the loudest thing on the board. Same predicate the
    // escalation sweep uses, so the board and the alert agree by construction.
    if (!isParked && declaresItselfFinished(raw)) continue;

    let state: ClaimState;
    let staleMs: number;
    if (isParked) {
      const parkedAt = typeof raw.parked_at === 'string' ? Date.parse(raw.parked_at) : NaN;
      staleMs = Number.isFinite(parkedAt) ? now - parkedAt : 0;
      // Parked is a WAYPOINT, not a terminus. It used to return here with no
      // expiry at all, which made it an absorbing state: a park meant "someone
      // should pick this up" and then nothing ever did. Live evidence at the
      // time of this fix — 7 parked claims in one workgroup, three of them
      // with no ttl_hours at all, the oldest sitting 93 hours. A state with no
      // exit is the shape of the whole problem, so parked now decays into
      // stale, which is already the state everything downstream treats as
      // "free to take, and say so out loud".
      state = staleMs > PARK_GRACE_MS ? 'stale' : 'parked';
    } else {
      const claimedAt = typeof raw.claimed_at === 'string' ? raw.claimed_at : '';
      const ttlHours = typeof raw.ttl_hours === 'number' ? raw.ttl_hours : NaN;
      ({ state, staleMs } =
        claimedAt && Number.isFinite(ttlHours)
          ? classify(claimedAt, ttlHours, now)
          : { state: 'stale' as ClaimState, staleMs: 0 });
    }

    claims.push({
      slug: entry.replace(/\.json$/, ''),
      owner: typeof raw.owner === 'string' && raw.owner ? raw.owner : 'unknown',
      // Notes routinely run to paragraphs of handoff detail. The board is a
      // scan surface: first sentence only, full text stays in the file.
      note: typeof raw.note === 'string' ? noteHeadline(raw.note) : '',
      threadId: typeof raw.thread_id === 'string' && raw.thread_id ? raw.thread_id : null,
      state,
      staleMs,
      escalated: typeof raw.escalated_at === 'string',
    });
  }
  return claims;
}

function duration(ms: number): string {
  const mins = Math.round(Math.abs(ms) / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.abs(ms) / 3600000;
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
}

const SECTION: Record<ClaimState, { icon: string; label: string }> = {
  stale: { icon: '🔴', label: 'Stale — nobody is coming back for these' },
  parked: { icon: '🅿️', label: 'Parked — needs an owner' },
  expiring: { icon: '🟡', label: 'Past TTL — still inside the grace window' },
  live: { icon: '🟢', label: 'Live' },
};
/**
 * How long a parked claim may sit before it is treated as abandoned. A park is
 * a handoff offer; if nobody takes it inside a day, the offer lapsed.
 */
export const PARK_GRACE_MS = 24 * 60 * 60 * 1000;

const ORDER: ClaimState[] = ['stale', 'parked', 'expiring', 'live'];

/**
 * One section per state, most urgent first, so the part that needs a human is
 * at the top of the canvas rather than under a long list of healthy work.
 *
 * `linkFor` resolves a claim's thread to a URL and is injected so this stays a
 * pure renderer — the canvas passes the Slack adapter's permalink builder, and
 * tests pass nothing.
 */
// A projection must say on its face when it was drawn and what wins on
// disagreement — the claims/ directory is the source of truth, this is a read.
function stampLine(): string {
  return `_claims as of ${formatLocalTime(new Date().toISOString(), TIMEZONE)} — source of truth: the claims/ directory_`;
}

export function renderClaims(claims: BoardClaim[], linkFor: (threadId: string) => string | null = () => null): string {
  if (claims.length === 0) {
    return `**Who’s on what** — _nothing claimed right now._\n\n${stampLine()}`;
  }

  const lines: string[] = [`**Who’s on what — ${claims.length}**`, ''];
  for (const state of ORDER) {
    const group = claims.filter((c) => c.state === state).sort((a, b) => b.staleMs - a.staleMs);
    if (group.length === 0) continue;

    lines.push(`${SECTION[state].icon} ${SECTION[state].label} · ${group.length}`);
    for (const c of group) {
      const age =
        c.state === 'live'
          ? `${duration(c.staleMs)} left`
          : c.state === 'parked'
            ? `parked ${duration(c.staleMs)}`
            : `${duration(c.staleMs)} past TTL`;
      const url = c.threadId ? linkFor(c.threadId) : null;
      const thread = url ? ` · [thread](${url})` : '';
      // An escalated claim has already been announced; marking it here stops a
      // reader re-reporting something the channel was told about hours ago.
      const flagged = c.escalated ? ' · _escalated_' : '';
      const note = c.note ? ` — ${c.note}` : '';
      lines.push(`- \`${c.slug}\` — **${c.owner}**, ${age}${note}${thread}${flagged}`);
    }
    lines.push('');
  }
  lines.push(stampLine());
  return lines.join('\n').trimEnd();
}
