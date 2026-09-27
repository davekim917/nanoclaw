/**
 * Pure work-claims staleness math, read by the claims board and the
 * dashboard's `escalated` badge. Claims live at
 * `data/workgroups/<workgroup-id>/claims/<slug>.json`.
 */
import path from 'path';

import { DATA_DIR } from '../../config.js';

interface Claim {
  owner?: unknown;
  claimed_at?: unknown;
  ttl_hours?: unknown;
  note?: unknown;
  escalated_at?: unknown;
  released_at?: unknown;
  status?: unknown;
  thread_id?: unknown;
}

/**
 * Agents also stamp completion in place (`released_at`, `status`, a note
 * opening with RELEASED) instead of deleting the file; read those as finished.
 */
export function declaresItselfFinished(claim: { released_at?: unknown; status?: unknown; note?: unknown }): boolean {
  const note = typeof claim.note === 'string' ? claim.note : '';

  // "Released" often means stepping OFF unfinished work ("RELEASED, not done…",
  // "RELEASED, HELD…"). Open work with no owner must stay visible, so a claim
  // that contradicts itself is not finished.
  if (/\bnot\s+(done|complete|completed|finished)\b|\bheld\b/i.test(note)) return false;

  if (typeof claim.released_at === 'string' && claim.released_at.trim() !== '') return true;
  if (
    typeof claim.status === 'string' &&
    ['done', 'released', 'complete', 'completed'].includes(claim.status.trim().toLowerCase())
  ) {
    return true;
  }
  return /^\s*released\b/i.test(note);
}

/** Grace past a claim's TTL before it counts as abandoned rather than takeable. */
export const ESCALATION_GRACE_MS = 2 * 60 * 60 * 1000; // 2h

export function claimsBaseDir(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'workgroups');
}

export function isStalePastGrace(
  claimedAtIso: string,
  ttlHours: number,
  now: number,
): { stale: boolean; staleMs: number } {
  const claimedAt = Date.parse(claimedAtIso);
  if (!Number.isFinite(claimedAt) || !Number.isFinite(ttlHours)) return { stale: false, staleMs: 0 };
  const expiresAt = claimedAt + ttlHours * 60 * 60 * 1000;
  const staleMs = now - expiresAt;
  return { stale: staleMs > ESCALATION_GRACE_MS, staleMs };
}

/** Abandoned: stale past grace, unfinished, unparked, not flagged this claim period. */
export function shouldEscalate(claim: Claim, now: number): boolean {
  if (typeof claim.claimed_at !== 'string' || typeof claim.ttl_hours !== 'number') return false;
  // Parking and pausing are deliberate holds, not abandonment.
  if (typeof claim.status === 'string' && ['parked', 'paused'].includes(claim.status.trim().toLowerCase()))
    return false;
  if (declaresItselfFinished(claim)) return false;
  if (!isStalePastGrace(claim.claimed_at, claim.ttl_hours, now).stale) return false;
  if (typeof claim.escalated_at !== 'string') return true;
  // Re-claimed after the last flag: fresh work, eligible to flag again.
  const claimedAt = Date.parse(claim.claimed_at);
  const escalatedAt = Date.parse(claim.escalated_at);
  return Number.isFinite(claimedAt) && Number.isFinite(escalatedAt) && claimedAt > escalatedAt;
}

/** First sentence of the note, capped; the full handoff detail stays in the file. */
export function noteHeadline(note: string): string {
  const full = note.trim().replace(/\s+/g, ' ');
  const sentence = /^.*?[.!?](?=\s|$)/.exec(full)?.[0] ?? full;
  const head = sentence.length > 200 ? sentence.slice(0, 199).trimEnd() : sentence;
  return head.length < full.length ? `${head} …` : head;
}
