/**
 * Work claims rendered as a board section. Owns no staleness rule of its own: it uses
 * `modules/claims/escalation.ts`, so the board and the dashboard's `escalated` badge can't disagree.
 */

import fs from 'fs';
import path from 'path';

import { TIMEZONE } from './config.js';
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
type ClaimState = 'live' | 'expiring' | 'stale' | 'parked' | 'paused';

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
 * The directory is agent-writable, and this loop runs synchronously on the event loop inside a dashboard poll, so
 * both the file count and each file's size are capped. 500 is far above organic growth.
 */
const MAX_CLAIM_FILES = 500;

/** Tighter than attention-fs's default because this reads every file in a directory. Shared with self-heal. */
export const MAX_CLAIM_BYTES = 64 * 1024;

/** Past the count cap, keep the least recently written: abandoned claims are what the board exists to surface. */
function oldestFirst(dir: string, entries: string[]): string[] {
  const mtime = new Map<string, number>();
  for (const entry of entries) {
    // `lstat`, never `stat`: it never traverses a symlink and never blocks on a FIFO.
    const st = fs.lstatSync(path.join(dir, entry), { throwIfNoEntry: false });
    mtime.set(entry, st ? st.mtimeMs : Infinity);
  }
  return [...entries].sort((a, b) => mtime.get(a)! - mtime.get(b)!);
}

/**
 * Realpath'd and proven inside the workgroup's folder, or null. `claims/` is agent-writable and could be a
 * symlink into a sibling workgroup. Self-heal re-resolves it fresh at its own later read. Never throws.
 */
export function resolveClaimsDir(root: string, workgroupId: string): string | null {
  try {
    const workgroupDir = fs.realpathSync(path.join(root, workgroupId));
    return containedRealpath(workgroupDir, path.join(workgroupDir, 'claims'));
  } catch {
    return null; // no workgroup dir — shared FS not enabled, or nothing claimed yet
  }
}

/**
 * One bad entry (unparseable, FIFO, oversized, symlinked out) is skipped, never allowed to blank the board. A claim
 * missing `claimed_at`/`ttl_hours` counts as stale: it must never read as an indefinite hold.
 */
export function readClaims(workgroupId: string, now: number, root: string = claimsBaseDir()): BoardClaim[] {
  const dir = resolveClaimsDir(root, workgroupId);
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
    // Loud, never silent; not a synthetic row, since self-heal and nudge would act on its fake slug.
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
    // Containment, type, size and read on one descriptor; a plain readFileSync blocks forever on a FIFO.
    const read = readContainedFile('Claims board', dir, entry, workgroupId, MAX_CLAIM_BYTES);
    if (read === null) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(read.text) as Record<string, unknown>;
    } catch (err) {
      log.warn('Claims board: unparseable claim, skipping', { file, err });
      continue;
    }

    // An operator pause wins over every expiry path; resuming needs a new explicit instruction.
    const isPaused = typeof raw.status === 'string' && raw.status.trim().toLowerCase() === 'paused';

    // Checked before the finished filter: a parked note routinely says "not done".
    const isParked = typeof raw.status === 'string' && raw.status.trim().toLowerCase() === 'parked';

    if (!isPaused && !isParked && declaresItselfFinished(raw)) continue;

    let state: ClaimState;
    let staleMs: number;
    if (isPaused) {
      const pausedAt = typeof raw.paused_at === 'string' ? Date.parse(raw.paused_at) : NaN;
      staleMs = Number.isFinite(pausedAt) ? now - pausedAt : 0;
      state = 'paused';
    } else if (isParked) {
      const parkedAt = typeof raw.parked_at === 'string' ? Date.parse(raw.parked_at) : NaN;
      staleMs = Number.isFinite(parkedAt) ? now - parkedAt : 0;
      // Parked must decay into stale: with no exit it is an absorbing state nobody picks up.
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
  paused: { icon: '⏸️', label: 'Paused — explicit operator hold' },
  parked: { icon: '🅿️', label: 'Parked — needs an owner' },
  expiring: { icon: '🟡', label: 'Past TTL — still inside the grace window' },
  live: { icon: '🟢', label: 'Live' },
};
export const PARK_GRACE_MS = 24 * 60 * 60 * 1000;

const ORDER: ClaimState[] = ['stale', 'paused', 'parked', 'expiring', 'live'];

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
          : c.state === 'paused'
            ? `paused ${duration(c.staleMs)}`
            : c.state === 'parked'
              ? `parked ${duration(c.staleMs)}`
              : `${duration(c.staleMs)} past TTL`;
      const url = c.threadId ? linkFor(c.threadId) : null;
      const thread = url ? ` · [thread](${url})` : '';
      const flagged = c.escalated ? ' · _escalated_' : '';
      const note = c.note ? ` — ${c.note}` : '';
      lines.push(`- \`${c.slug}\` — **${c.owner}**, ${age}${note}${thread}${flagged}`);
    }
    lines.push('');
  }
  lines.push(stampLine());
  return lines.join('\n').trimEnd();
}
