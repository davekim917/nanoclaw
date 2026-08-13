/**
 * Work-claims escalation SLA (fleet-hardening Phase 2.2).
 *
 * The work-claims convention (container/skills/work-claims/SKILL.md) lets
 * sibling agents in a workgroup claim a unit of work (a PR, a seam, an
 * issue) so nobody duplicates it. Claims live at
 * `data/workgroups/<workgroup-id>/claims/<slug>.json`. The take-over rule
 * (rule 4 of the skill) handles a stale claim a sibling notices and picks
 * up — but nothing handles a stale claim NO sibling ever notices: abandoned
 * work rotting silently forever (the skill's own "Known ceiling" section
 * names a host sweep as the upgrade path for exactly this gap).
 *
 * This module scans for claims stale past a grace period beyond their own
 * TTL and escalates them ONCE to the workgroup's escalation channel, via a
 * direct outbound.db write (writeOutboundDirect) — the same zero-container
 * mechanism the command gate uses to answer without waking anything. A
 * workgroup with no configured destination, or no live session bound to its
 * destination channel, is skipped and logged — this module never creates a
 * session or wakes a container.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { findAnySessionForMessagingGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { outboundDbPath, writeOutboundDirect } from '../../session-manager.js';

interface Claim {
  owner?: unknown;
  claimed_at?: unknown;
  ttl_hours?: unknown;
  note?: unknown;
  escalated_at?: unknown;
  released_at?: unknown;
  status?: unknown;
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
function declaresItselfFinished(claim: Claim): boolean {
  if (typeof claim.released_at === 'string' && claim.released_at.trim() !== '') return true;
  if (
    typeof claim.status === 'string' &&
    ['done', 'released', 'complete', 'completed'].includes(claim.status.trim().toLowerCase())
  ) {
    return true;
  }
  return typeof claim.note === 'string' && /^\s*released\b/i.test(claim.note);
}

/** Grace window past a claim's own TTL expiry before it counts as "abandoned"
 *  rather than merely stale-and-takeable (the sibling take-over path owns
 *  the first ttl_hours..grace window on its own). */
export const ESCALATION_GRACE_MS = 2 * 60 * 60 * 1000; // 2h

// A few JSON files per workgroup is cheap to scan, but still throttled — no
// reason to stat the tree every 60s sweep tick.
const SCAN_INTERVAL_MS = 10 * 60 * 1000;

interface EscalationDestination {
  channelType: string;
  platformId: string;
}

/**
 * Per-workgroup escalation destination, read from
 * `data/workgroups/<id>/escalation.json` ({channelType, platformId}) —
 * operator-authored runtime config, deliberately NOT tracked source (channel
 * ids are installation-private). No file = the workgroup opted out of claim
 * escalation. Graduates to central workgroup config if a richer rule set
 * ever grows here.
 */
export function readEscalationDestination(root: string, workgroupId: string): EscalationDestination | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, workgroupId, 'escalation.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (typeof raw.channelType === 'string' && typeof raw.platformId === 'string') {
      return { channelType: raw.channelType, platformId: raw.platformId };
    }
    log.warn('Claims escalation: escalation.json missing channelType/platformId', { workgroupId });
    return undefined;
  } catch {
    return undefined;
  }
}

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

/** Pure — should this claim be (re-)escalated right now? */
export function shouldEscalate(claim: Claim, now: number): boolean {
  if (typeof claim.claimed_at !== 'string' || typeof claim.ttl_hours !== 'number') return false;
  if (declaresItselfFinished(claim)) return false;
  if (!isStalePastGrace(claim.claimed_at, claim.ttl_hours, now).stale) return false;
  if (typeof claim.escalated_at !== 'string') return true;
  // Re-claimed (takeover) after the last escalation → treat as fresh work,
  // eligible to escalate again if it goes stale a second time.
  const claimedAt = Date.parse(claim.claimed_at);
  const escalatedAt = Date.parse(claim.escalated_at);
  return Number.isFinite(claimedAt) && Number.isFinite(escalatedAt) && claimedAt > escalatedAt;
}

/** Pure — throttle gate for the scan cadence. */
export function shouldSkipClaimsScan(lastRanAtMs: number, now: number): boolean {
  return now - lastRanAtMs < SCAN_INTERVAL_MS;
}

function listDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listClaimFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export interface EscalationCandidate {
  file: string;
  workgroupId: string;
  slug: string;
  claim: Claim;
  staleMs: number;
  dest: EscalationDestination;
}

/**
 * Scan every workgroup with a configured escalation destination for claims
 * due to escalate. Pure filesystem read — no DB, no delivery. Unparseable
 * claim JSON is logged and skipped, never thrown.
 */
export function findEscalationCandidates(root: string, now: number): EscalationCandidate[] {
  const candidates: EscalationCandidate[] = [];
  for (const workgroupId of listDirs(root)) {
    const dest = readEscalationDestination(root, workgroupId);
    if (!dest) continue;
    const claimsDir = path.join(root, workgroupId, 'claims');
    for (const file of listClaimFiles(claimsDir)) {
      let claim: Claim;
      try {
        claim = JSON.parse(fs.readFileSync(file, 'utf8')) as Claim;
      } catch (err) {
        log.warn('Claims escalation: unparseable claim JSON, skipping', { file, err });
        continue;
      }
      if (!shouldEscalate(claim, now)) continue;
      const { staleMs } = isStalePastGrace(claim.claimed_at as string, claim.ttl_hours as number, now);
      candidates.push({ file, workgroupId, slug: path.basename(file, '.json'), claim, staleMs, dest });
    }
  }
  return candidates;
}

/**
 * First sentence of a claim note, capped — the alert only has to identify the
 * work. Notes routinely run several hundred characters of handoff detail
 * (open questions, verification state, who owes an answer), and that belongs
 * in the file, which is what a human or a digest actually reads.
 */
function noteHeadline(note: string): string {
  const full = note.trim().replace(/\s+/g, ' ');
  const sentence = /^.*?[.!?](?=\s|$)/.exec(full)?.[0] ?? full;
  const head = sentence.length > 200 ? sentence.slice(0, 199).trimEnd() : sentence;
  return head.length < full.length ? `${head} …` : head;
}

function formatEscalationText(candidate: EscalationCandidate): string {
  const owner = typeof candidate.claim.owner === 'string' ? candidate.claim.owner : 'unknown';
  const rawNote = typeof candidate.claim.note === 'string' ? candidate.claim.note.trim() : '';
  const staleHours = (candidate.staleMs / (60 * 60 * 1000)).toFixed(1);
  const ttl = typeof candidate.claim.ttl_hours === 'number' ? candidate.claim.ttl_hours : undefined;

  return [
    `⚠️ **Abandoned work claim** — \`${candidate.slug}\``,
    rawNote ? noteHeadline(rawNote) : '(no note)',
    '',
    `- **Owner:** ${owner}`,
    ttl === undefined
      ? `- **Stale:** ${staleHours}h past grace`
      : `- **Stale:** ${staleHours}h past grace, on a ${ttl}h TTL`,
    `- **Next:** nothing happens automatically — ${owner} releases it, or anyone takes it over.`,
  ].join('\n');
}

/** Stamp escalated_at onto the claim file — atomic tmp+rename, same convention as the skill's own claim write. */
function stampEscalated(candidate: EscalationCandidate, now: number): void {
  const updated = { ...candidate.claim, escalated_at: new Date(now).toISOString() };
  const dir = path.dirname(candidate.file);
  const tmp = path.join(dir, `.tmp.${path.basename(candidate.file)}.${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
  fs.renameSync(tmp, candidate.file);
}

export interface EscalationDeliveryDeps {
  resolveMessagingGroup: (channelType: string, platformId: string) => { id: string } | undefined;
  resolveSession: (messagingGroupId: string) => { agent_group_id: string; id: string } | undefined;
  hasOutbound: (agentGroupId: string, sessionId: string) => boolean;
  writeMessage: (
    agentGroupId: string,
    sessionId: string,
    message: {
      id: string;
      kind: string;
      platformId: string | null;
      channelType: string | null;
      threadId: string | null;
      content: string;
    },
  ) => void;
}

const defaultDeps: EscalationDeliveryDeps = {
  resolveMessagingGroup: getMessagingGroupByPlatform,
  // Any active session on the channel — it is only the pipe. The outbound
  // row below carries `threadId: null`, so the escalation posts to the channel
  // root regardless of which session's outbound.db it travels through, and
  // never wakes a container. Asking for a ROOT session here was the bug: a
  // per-thread channel has none, so this returned undefined every time.
  resolveSession: (messagingGroupId) => findAnySessionForMessagingGroup(messagingGroupId),
  hasOutbound: (agentGroupId, sessionId) => fs.existsSync(outboundDbPath(agentGroupId, sessionId)),
  writeMessage: writeOutboundDirect,
};

/**
 * Deliver + dedupe-stamp one candidate. Never wakes a container: delivery is
 * a direct outbound.db write, the same mechanism the command gate uses to
 * answer without spawning. Log-and-skip on any resolution failure.
 */
export function escalateClaim(
  candidate: EscalationCandidate,
  now: number,
  deps: EscalationDeliveryDeps = defaultDeps,
): boolean {
  const dest = candidate.dest;
  const mg = deps.resolveMessagingGroup(dest.channelType, dest.platformId);
  if (!mg) {
    log.warn('Claims escalation: no messaging group for destination', {
      workgroupId: candidate.workgroupId,
      ...dest,
    });
    return false;
  }
  const session = deps.resolveSession(mg.id);
  if (!session) {
    log.warn('Claims escalation: no live session for escalation channel', {
      workgroupId: candidate.workgroupId,
      messagingGroupId: mg.id,
    });
    return false;
  }
  if (!deps.hasOutbound(session.agent_group_id, session.id)) {
    log.warn('Claims escalation: session has no outbound.db yet', { sessionId: session.id });
    return false;
  }

  deps.writeMessage(session.agent_group_id, session.id, {
    id: `claim-escalation-${candidate.workgroupId}-${candidate.slug}-${now}`,
    kind: 'chat',
    platformId: dest.platformId,
    channelType: dest.channelType,
    threadId: null,
    content: JSON.stringify({
      text: formatEscalationText(candidate),
      _system: { kind: 'claim_escalation', workgroupId: candidate.workgroupId, slug: candidate.slug },
    }),
  });
  stampEscalated(candidate, now);
  log.info('Claims escalation: escalated abandoned claim', {
    workgroupId: candidate.workgroupId,
    slug: candidate.slug,
    staleHours: (candidate.staleMs / (60 * 60 * 1000)).toFixed(1),
  });
  return true;
}

let lastScanAtMs = 0;

/** Sweep entry point — call once per host-sweep tick; throttled internally to SCAN_INTERVAL_MS. */
export function sweepClaimsEscalation(now: number = Date.now(), root: string = claimsBaseDir()): void {
  if (shouldSkipClaimsScan(lastScanAtMs, now)) return;
  lastScanAtMs = now;
  for (const candidate of findEscalationCandidates(root, now)) {
    try {
      escalateClaim(candidate, now);
    } catch (err) {
      log.warn('Claims escalation: failed to escalate candidate', { file: candidate.file, err });
    }
  }
}

/** Test-only: reset the module-level throttle timestamp between test cases. */
export function _resetClaimsScanThrottleForTesting(): void {
  lastScanAtMs = 0;
}
