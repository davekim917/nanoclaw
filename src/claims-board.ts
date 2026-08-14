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
 * `ESCALATION_GRACE_MS` come from the escalation sweep, so the board and the
 * alert can never disagree about what "stale" means. A third definition living
 * here is exactly how a board starts lying.
 *
 * Rendered into the existing channel canvas rather than a canvas of its own.
 * The board answers "what work exists"; claims answer "who has it". Those are
 * one status board, and a second canvas would be one more place to look — the
 * thing that made the standalone dashboard go unread.
 */

import fs from 'fs';
import path from 'path';

import { TIMEZONE } from './config.js';
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
 * Every claim in a workgroup, classified. Unparseable files are skipped with a
 * warning rather than throwing — one bad file must not blank the whole board.
 * A claim missing `claimed_at`/`ttl_hours` counts as stale for the same reason
 * `claim.sh` does: it must never read as an indefinite hold on the work.
 */
export function readClaims(workgroupId: string, now: number, root: string = claimsBaseDir()): BoardClaim[] {
  const dir = path.join(root, workgroupId, 'claims');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return []; // no claims dir — workgroup shared FS not enabled, or nothing claimed yet
  }

  const claims: BoardClaim[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
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
      state = 'parked';
      const parkedAt = typeof raw.parked_at === 'string' ? Date.parse(raw.parked_at) : NaN;
      staleMs = Number.isFinite(parkedAt) ? now - parkedAt : 0;
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

export function renderClaims(
  claims: BoardClaim[],
  linkFor: (threadId: string) => string | null = () => null,
): string {
  if (claims.length === 0) {
    return `**Who’s on what** — _nothing claimed right now._\n\n${stampLine()}`;
  }

  const lines: string[] = [`**Who’s on what — ${claims.length}**`, ''];
  for (const state of ORDER) {
    const group = claims
      .filter((c) => c.state === state)
      .sort((a, b) => b.staleMs - a.staleMs);
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
