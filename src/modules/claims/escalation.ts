/**
 * Work-claims staleness math (fleet-hardening Phase 2.2).
 *
 * The work-claims convention (container/skills/work-claims/SKILL.md) lets
 * sibling agents in a workgroup claim a unit of work (a PR, a seam, an
 * issue) so nobody duplicates it. Claims live at
 * `data/workgroups/<workgroup-id>/claims/<slug>.json`. The take-over rule
 * (rule 4 of the skill) handles a stale claim a sibling notices and picks
 * up.
 *
 * This module used to also POST a Slack alert for claims stale past grace
 * that no sibling ever noticed (`sweepClaimsEscalation`, wired into the host
 * sweep). That posting path was retired 2026-08-20: the fleet routinely
 * leaves work unfinished for hours by design, the Observatory now surfaces
 * claim state visually, and a push alert nobody actions is just noise. What
 * remains here is the pure staleness/finished-state math — `claims-board.ts`
 * (Observatory/dashboard claim state) and `dashboard/api/workgroups.ts` (the
 * `escalated` badge) both read it directly and must keep working.
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
  /** Routing id of the thread the work was claimed in, straight from the claimant's `session_routing`. */
  thread_id?: unknown;
}

/**
 * A claim that says it is finished, whatever shape it said it in.
 *
 * The `work-claims` skill says releasing means deleting the file, and a deleted
 * file is never scanned. But agents also stamp completion in place — a
 * `released_at`, a `status`, a note that opens with RELEASED — and leave the
 * file as an audit trail. That is not the documented protocol, and it is also
 * not something to page a human about: the claim is telling us the work is
 * done. On the first live escalation batch (2026-08-12) two of four alerts
 * were claims carrying `released_at` AND `status: "done"`, one of them naming
 * the merge commit that closed it.
 *
 * Read as "finished", not "well-formed" — the point is to not alarm on a claim
 * that already answered the question the alarm would ask.
 */
export function declaresItselfFinished(claim: { released_at?: unknown; status?: unknown; note?: unknown }): boolean {
  const note = typeof claim.note === 'string' ? claim.note : '';

  // "Released" does NOT mean "done" in practice — agents use it for stepping
  // OFF work, and say so in the same breath. Two live examples on 2026-08-13,
  // both carrying released_at AND status:"released":
  //   xzo-gh-522-618      "RELEASED, not done. … needs a QA re-verification run only"
  //   xzo-gh-571-600      "RELEASED, HELD not done. PR #768 … 8 review threads open"
  // The second is an open do-not-merge PR that nobody owns. Treating those as
  // finished filtered them off the board AND exempted them from escalation, so
  // the one state this whole system exists to surface — open work with no
  // owner — was the single state guaranteed invisible everywhere at once.
  // A claim that contradicts itself is not finished; the contradiction wins.
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

/** Grace window past a claim's own TTL expiry before it counts as "abandoned"
 *  rather than merely stale-and-takeable (the sibling take-over path owns
 *  the first ttl_hours..grace window on its own). */
export const ESCALATION_GRACE_MS = 2 * 60 * 60 * 1000; // 2h

export function claimsBaseDir(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'workgroups');
}

/** Pure — is `claimedAt + ttlHours` more than ESCALATION_GRACE_MS in the past? */
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

/**
 * Pure — is this claim currently in the "abandoned" state: stale past grace,
 * unfinished, unparked, and not already flagged for the current claim
 * period? `dashboard/api/workgroups.ts` reads this directly to compute a
 * claim's `escalated` badge (no push alert fires from it anymore — this is
 * read-only state).
 */
export function shouldEscalate(claim: Claim, now: number): boolean {
  if (typeof claim.claimed_at !== 'string' || typeof claim.ttl_hours !== 'number') return false;
  // Parking is a deliberate handoff and pausing is an explicit operator hold;
  // neither is abandonment and neither gets an escalation badge.
  if (typeof claim.status === 'string' && ['parked', 'paused'].includes(claim.status.trim().toLowerCase()))
    return false;
  if (declaresItselfFinished(claim)) return false;
  if (!isStalePastGrace(claim.claimed_at, claim.ttl_hours, now).stale) return false;
  if (typeof claim.escalated_at !== 'string') return true;
  // Re-claimed (takeover) after the last flag → treat as fresh work,
  // eligible to flag again if it goes stale a second time.
  const claimedAt = Date.parse(claim.claimed_at);
  const escalatedAt = Date.parse(claim.escalated_at);
  return Number.isFinite(claimedAt) && Number.isFinite(escalatedAt) && claimedAt > escalatedAt;
}

/**
 * First sentence of a claim note, capped — the board only has to identify
 * the work at a glance. Notes routinely run several hundred characters of
 * handoff detail (open questions, verification state, who owes an answer),
 * and that belongs in the file, which is what a human reads when they open it.
 */
export function noteHeadline(note: string): string {
  const full = note.trim().replace(/\s+/g, ' ');
  const sentence = /^.*?[.!?](?=\s|$)/.exec(full)?.[0] ?? full;
  const head = sentence.length > 200 ? sentence.slice(0, 199).trimEnd() : sentence;
  return head.length < full.length ? `${head} …` : head;
}
