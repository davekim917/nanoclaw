/**
 * Self-heal class 3 — stale work claims.
 *
 * A claim past its TTL plus grace (or a park nobody took inside PARK_GRACE_MS)
 * means one thing: work someone said they owned, that has not moved, and that
 * no human is going to notice. The board already shows it in red. This is the
 * part that acts on it.
 *
 * Detection is the board's, verbatim — `readClaims` + `state === 'stale'`. A
 * second staleness rule living here is exactly how a board and its automation
 * start disagreeing, and the automation is the one that would be wrong loudly.
 *
 * Three exclusions are load-bearing, not defensive padding:
 *
 *   1. `waiting on <person>: …` notes are NEVER acted on. That note shape is
 *      the human-blocked discipline from container/skills/work-claims/SKILL.md.
 *      Nudging it tells an agent to move work it already correctly stopped on;
 *      reassigning it moves the block to a second agent. It stays red on the
 *      board, which is where a human is supposed to see it.
 *   2. A claim with no `thread_id` is never nudged. There is no honest room to
 *      nudge in — the same reason dashboard/nudge.ts 409s rather than guessing.
 *   3. A claim that says it finished is not stalled work (declaresItselfFinished).
 *
 * The ladder is deliberately slow and deliberately short: nudge the owner, nudge
 * it once more a day later, and only then — behind its own separate flag —
 * offer the work to a sibling. Takeover is the only step where one agent takes
 * another's work with no human in the loop, and a misfire recreates the
 * duplicate-work problem claims exist to prevent, so it arms separately from
 * everything else here. After that the claim is left alone, red, forever.
 *
 * Nothing here is silent. Every action stamps the claim file and logs a
 * structured line; with the flag off, the same detection runs and logs
 * `self-heal: would …` while spawning nothing.
 */
import fs from 'fs';
import path from 'path';

import { readClaims, type BoardClaim } from '../../claims-board.js';
import { SELF_HEAL_ENABLED, SELF_HEAL_TAKEOVER_ENABLED } from '../../config.js';
import { log } from '../../log.js';
import { claimsBaseDir, declaresItselfFinished } from './escalation.js';

/** Scan cadence — the sweep calls this every tick; the throttle lives here. */
export const SELF_HEAL_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Between rungs. A stale claim has already burned its TTL plus a 2h grace
 * before the first nudge; a day between nudges is the difference between
 * "nobody is coming back" and "the owner is mid-turn on something else".
 */
export const SELF_HEAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** 2 owner nudges + 1 takeover, per claim period. */
export const SELF_HEAL_MAX_NUDGES = 2;

/**
 * The park-when-blocked note shape from the work-claims skill:
 * `waiting on <person>: <what you asked>`. Anchored — a note that merely
 * mentions waiting somewhere in the middle is prose, not the discipline.
 */
export function isWaitingOnHuman(note: string): boolean {
  return /^\s*waiting on\b/i.test(note);
}

/** Ladder state, as stamped on the claim file. No new schema. */
export interface SelfHealStamps {
  claimed_at?: unknown;
  auto_nudged_at?: unknown;
  auto_nudge_count?: unknown;
  auto_heal_exhausted_at?: unknown;
}

export type SelfHealAction = 'nudge' | 'takeover' | 'exhaust';

export interface SelfHealDecision {
  action: SelfHealAction | 'none';
  /** 1 or 2 for a nudge — which owner nudge this is. */
  nudge?: number;
  /** Why, for the log line. Always set. */
  reason: string;
}

/**
 * Effective nudge count. A re-claim (fresh `claimed_at` newer than the last
 * stamp) is new work by a new owner, so the ladder starts over — the same rule
 * `shouldEscalate` applies to `escalated_at` (escalation.ts).
 */
function effectiveState(stamps: SelfHealStamps): { count: number; lastAt: number; exhausted: boolean } {
  const lastAt = typeof stamps.auto_nudged_at === 'string' ? Date.parse(stamps.auto_nudged_at) : NaN;
  const claimedAt = typeof stamps.claimed_at === 'string' ? Date.parse(stamps.claimed_at) : NaN;
  const reclaimed = Number.isFinite(claimedAt) && Number.isFinite(lastAt) && claimedAt > lastAt;
  if (reclaimed || !Number.isFinite(lastAt)) return { count: 0, lastAt: NaN, exhausted: false };
  const rawCount = typeof stamps.auto_nudge_count === 'number' ? stamps.auto_nudge_count : 0;
  return {
    count: rawCount,
    lastAt,
    exhausted: typeof stamps.auto_heal_exhausted_at === 'string',
  };
}

/**
 * Pure — which rung this claim is on right now. `claim` must already be the
 * board's `stale` state; the exclusions are re-checked here so the decision is
 * testable on its own and cannot be bypassed by a future second caller.
 */
export function decideSelfHeal(
  claim: BoardClaim,
  raw: SelfHealStamps & { note?: unknown },
  now: number,
): SelfHealDecision {
  if (claim.state !== 'stale') return { action: 'none', reason: 'not-stale' };
  const note = typeof raw.note === 'string' ? raw.note : '';
  if (isWaitingOnHuman(note)) return { action: 'none', reason: 'waiting-on-human' };
  if (!claim.threadId) return { action: 'none', reason: 'no-thread' };
  if (declaresItselfFinished(raw)) return { action: 'none', reason: 'declares-finished' };

  const { count, lastAt, exhausted } = effectiveState(raw);
  if (exhausted) return { action: 'none', reason: 'exhausted' };
  if (count === 0) return { action: 'nudge', nudge: 1, reason: 'first-nudge' };
  if (Number.isFinite(lastAt) && now - lastAt < SELF_HEAL_COOLDOWN_MS) {
    return { action: 'none', reason: 'cooling-down' };
  }
  if (count < SELF_HEAL_MAX_NUDGES) return { action: 'nudge', nudge: count + 1, reason: 'repeat-nudge' };
  if (count === SELF_HEAL_MAX_NUDGES) return { action: 'takeover', reason: 'nudges-spent' };
  return { action: 'exhaust', reason: 'takeover-spent' };
}

/** Shared header both prompts open with — state, age, owner, note. */
function claimStateLine(claim: BoardClaim): string {
  const hours = Math.max(0, Math.round(claim.staleMs / 3600000));
  // staleMs means "since parked" for a parked claim and "past TTL" otherwise —
  // label it honestly rather than telling a parked claim it is overdue.
  return (
    `state: ${claim.state} · ${hours}h ${claim.state === 'parked' ? 'since parked' : 'past due'} · owner: ${claim.owner}` +
    (claim.escalated ? ' · already escalated once' : '') +
    (claim.note ? `\nnote on the claim: ${claim.note}` : '')
  );
}

/**
 * The push-it-forward contract, composed entirely from the claim file.
 *
 * Shared by the human path (dashboard/nudge.ts, `origin` = who clicked) and the
 * autonomous path here, so the two can never drift into telling an agent
 * different things about the same claim. The three options are the whole point:
 * an item neither moved nor released by the end of the task is the failure this
 * exists to end, and "name the human who blocks you" is the exit that stops a
 * nudge loop on genuinely blocked work.
 */
export function buildNudgePrompt(claim: BoardClaim, origin: string): string {
  return (
    `${origin} — the claim \`${claim.slug}\` has stopped moving.\n` +
    `${claimStateLine(claim)}\n\n` +
    `Do ONE of these three, in this thread, before this task ends — there is no fourth option:\n` +
    `1. Finish it, and say so here.\n` +
    `2. Release it — \`bash /app/skills/work-claims/claim.sh release ${claim.slug}\`, or ` +
    `\`park ${claim.slug} "<what a successor needs to know>"\` if it needs a new owner — then say here that it is free.\n` +
    `3. Post what BLOCKS you, naming the human who owns that blocker.\n\n` +
    `An item neither moved nor released by the end of this task is the failure this button exists to end.`
  );
}

/**
 * Takeover has a different contract from a nudge: the agent being addressed is
 * not the owner, so "finish it" is not one of its options until it has actually
 * taken the claim. Declining is a first-class answer — a sibling that says why
 * it is not the right owner has still moved the claim out of silence.
 */
export function buildTakeoverPrompt(claim: BoardClaim): string {
  return (
    `Self-heal takeover — the claim \`${claim.slug}\`, owned by ${claim.owner}, has been stale through two ` +
    `automatic nudges with no movement. Work-claims rule 4: a claim past its TTL may be taken over by anyone.\n` +
    `${claimStateLine(claim)}\n\n` +
    `Do ONE of these two, in this thread, before this task ends:\n` +
    `1. Take it over — \`bash /app/skills/work-claims/claim.sh take ${claim.slug} <hours> "<takeover: what you are picking up>"\` ` +
    `— then work it, and say here that you own it now.\n` +
    `2. Say here why this should NOT be taken over (already done, superseded, blocked on a human) — and if it is done, ` +
    `release it: \`bash /app/skills/work-claims/claim.sh release ${claim.slug}\`.\n\n` +
    `Do not silently leave it: this is the last automatic step, and after it the claim just sits red on the board.`
  );
}

/** An agent group wired to the claim's own thread channel. */
export interface SelfHealTarget {
  agentGroupId: string;
  messagingGroupId: string;
  /** Display name we matched on, for the log line. */
  name: string;
}

export interface SelfHealTaskInput {
  target: SelfHealTarget;
  claim: BoardClaim;
  prompt: string;
  name: string;
}

export interface SelfHealDeps {
  /** Claims root — `data/workgroups` in production. */
  root?: string;
  /** Owner's agent group, wired to the claim's thread channel. null = unresolvable. */
  resolveOwner?: (workgroupId: string, claim: BoardClaim) => Promise<SelfHealTarget | null>;
  /** Any OTHER agent group in the workgroup wired to that channel. */
  resolveSibling?: (
    workgroupId: string,
    claim: BoardClaim,
    excludeAgentGroupId: string | null,
  ) => Promise<SelfHealTarget | null>;
  /** One-shot task into the claim's own thread. Returns false on failure. */
  createTask?: (input: SelfHealTaskInput) => Promise<boolean>;
  enabled?: boolean;
  takeoverEnabled?: boolean;
}

/** What the sweep did (or would have done) — returned so the tick and tests can assert on it. */
export interface SelfHealOutcome {
  workgroupId: string;
  slug: string;
  action: SelfHealAction | 'none';
  reason: string;
  /** false in shadow mode, or when the target could not be resolved. */
  applied: boolean;
  target?: string;
}

function listWorkgroupDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Atomic tmp+rename, the same convention claim.sh itself writes with. */
function stampClaim(file: string, patch: Record<string, unknown>): void {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const tmp = path.join(path.dirname(file), `.tmp.${path.basename(file)}.${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify({ ...raw, ...patch }, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Agent groups in `workgroupId` wired to the channel the claim's thread lives
 * in — the same join dashboard/nudge.ts uses to refuse a nudge into a channel
 * the agent does not belong to. Resolved from the DB by platform id, NOT by
 * looking for a live session: un-engaged traffic no longer mints sessions, so
 * "no live session on this channel" is the normal case, and a session-based
 * lookup would make delivery fail exactly when it is most needed.
 *
 * Do NOT reach for a "pick whichever session is newest on this messaging
 * group" helper here (the pattern `findAnySessionForMessagingGroup` used to
 * provide, since deleted as dead code): picking whichever is newest would
 * drop delivery into an unrelated thread's container. Route by the DB join
 * above instead.
 */
async function wiredCandidates(
  workgroupId: string,
  threadId: string,
): Promise<Array<{ agentGroupId: string; messagingGroupId: string; name: string; folder: string }>> {
  const [{ getDb }, { threadPlatformId }] = await Promise.all([
    import('../../db/index.js'),
    import('../../dashboard/api/observatory.js'),
  ]);
  return getDb()
    .prepare(
      `SELECT ag.id AS agentGroupId, ag.name AS name, ag.folder AS folder, mg.id AS messagingGroupId
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE ag.workgroup_id = ? AND mg.platform_id = ?`,
    )
    .all(workgroupId, threadPlatformId(threadId)) as Array<{
    agentGroupId: string;
    messagingGroupId: string;
    name: string;
    folder: string;
  }>;
}

/**
 * `claim.owner` is `$NANOCLAW_ASSISTANT_NAME` (claim.sh:54) — the agent's
 * user-facing name, which varies per channel. So the match runs through the
 * same resolver the spawn path uses to produce that env var, against the
 * channel the claim's thread is in, and falls back to the structural group
 * name. An owner we cannot resolve is skipped, never guessed: nudging the
 * wrong agent group is worse than not nudging.
 */
async function defaultResolveOwner(workgroupId: string, claim: BoardClaim): Promise<SelfHealTarget | null> {
  if (!claim.threadId) return null;
  const rows = await wiredCandidates(workgroupId, claim.threadId);
  if (rows.length === 0) return null;
  const wanted = claim.owner.trim().toLowerCase();
  const [{ resolveAssistantName }, { readContainerConfig }, { getAgentGroup }] = await Promise.all([
    import('../../container-runner.js'),
    import('../../container-config.js'),
    import('../../db/agent-groups.js'),
  ]);
  for (const row of rows) {
    if (row.name.trim().toLowerCase() === wanted) {
      return { agentGroupId: row.agentGroupId, messagingGroupId: row.messagingGroupId, name: row.name };
    }
    const group = getAgentGroup(row.agentGroupId);
    if (!group) continue;
    let display: string;
    try {
      display = await resolveAssistantName(group, readContainerConfig(row.folder), row.messagingGroupId);
    } catch (err) {
      log.warn('self-heal: assistant-name resolution failed', { agentGroupId: row.agentGroupId, err });
      continue;
    }
    if (display.trim().toLowerCase() === wanted) {
      return { agentGroupId: row.agentGroupId, messagingGroupId: row.messagingGroupId, name: display };
    }
  }
  return null;
}

async function defaultResolveSibling(
  workgroupId: string,
  claim: BoardClaim,
  exclude: string | null,
): Promise<SelfHealTarget | null> {
  if (!claim.threadId) return null;
  const rows = await wiredCandidates(workgroupId, claim.threadId);
  // ponytail: first wired sibling wins. Add a least-loaded pick if a workgroup
  // ever has enough siblings on one channel for the choice to matter.
  const row = rows.find((r) => r.agentGroupId !== exclude);
  return row ? { agentGroupId: row.agentGroupId, messagingGroupId: row.messagingGroupId, name: row.name } : null;
}

/**
 * One-shot task into the claim's own thread. `caller: 'host'` with an explicit
 * `messaging_group` + `thread_id` is the only routing shape that does not
 * depend on a session already existing: `resolveTaskRouting` reads the
 * messaging-group ROW, and `resolveTaskSession` mints the agent group's task
 * session if it is missing.
 */
async function defaultCreateTask(input: SelfHealTaskInput): Promise<boolean> {
  const { dispatch } = await import('../../cli/dispatch.js');
  const res = await dispatch(
    {
      id: `self-heal-${Date.now()}`,
      command: 'tasks-create',
      args: {
        group: input.target.agentGroupId,
        name: input.name,
        prompt: input.prompt,
        process_after: new Date().toISOString(),
        messaging_group: input.target.messagingGroupId,
        thread_id: input.claim.threadId,
      },
    },
    { caller: 'host' },
  );
  if (!res.ok) {
    log.warn('self-heal: task create failed', { slug: input.claim.slug, target: input.target.agentGroupId, res });
    return false;
  }
  return true;
}

let lastRanAtMs = 0;

/** Test-only, same precedent as _resetNudgeDedupeForTesting. */
export function _resetSelfHealThrottleForTesting(): void {
  lastRanAtMs = 0;
}

/** Pure — throttle gate for the scan cadence (mirrors the retired claims scan). */
export function shouldSkipSelfHealScan(lastRan: number, now: number): boolean {
  return now - lastRan < SELF_HEAL_SCAN_INTERVAL_MS;
}

/**
 * Scan every workgroup for stale claims and walk each one up the ladder.
 *
 * Zero tokens until an action actually fires: the scan is a directory read and
 * a JSON parse. With `NANOCLAW_SELF_HEAL` off it logs what it would have done
 * and returns; takeover additionally requires `NANOCLAW_SELF_HEAL_TAKEOVER`.
 */
export async function sweepClaimsSelfHeal(
  now: number = Date.now(),
  deps: SelfHealDeps = {},
): Promise<SelfHealOutcome[]> {
  if (deps.root === undefined && shouldSkipSelfHealScan(lastRanAtMs, now)) return [];
  if (deps.root === undefined) lastRanAtMs = now;

  const root = deps.root ?? claimsBaseDir();
  const enabled = deps.enabled ?? SELF_HEAL_ENABLED;
  const takeoverEnabled = deps.takeoverEnabled ?? SELF_HEAL_TAKEOVER_ENABLED;
  const resolveOwner = deps.resolveOwner ?? defaultResolveOwner;
  const resolveSibling = deps.resolveSibling ?? defaultResolveSibling;
  const createTask = deps.createTask ?? defaultCreateTask;

  const outcomes: SelfHealOutcome[] = [];
  for (const workgroupId of listWorkgroupDirs(root)) {
    for (const claim of readClaims(workgroupId, now, root)) {
      if (claim.state !== 'stale') continue;
      const file = path.join(root, workgroupId, 'claims', `${claim.slug}.json`);
      let raw: SelfHealStamps & { note?: unknown };
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SelfHealStamps & { note?: unknown };
      } catch (err) {
        log.warn('self-heal: unparseable claim, skipping', { file, err });
        continue;
      }

      const decision = decideSelfHeal(claim, raw, now);
      if (decision.action === 'none') continue;

      const outcome = await applyDecision({
        workgroupId,
        claim,
        file,
        decision,
        now,
        enabled,
        takeoverEnabled,
        resolveOwner,
        resolveSibling,
        createTask,
      });
      outcomes.push(outcome);
    }
  }
  return outcomes;
}

async function applyDecision(args: {
  workgroupId: string;
  claim: BoardClaim;
  file: string;
  decision: SelfHealDecision;
  now: number;
  enabled: boolean;
  takeoverEnabled: boolean;
  resolveOwner: NonNullable<SelfHealDeps['resolveOwner']>;
  resolveSibling: NonNullable<SelfHealDeps['resolveSibling']>;
  createTask: NonNullable<SelfHealDeps['createTask']>;
}): Promise<SelfHealOutcome> {
  const { workgroupId, claim, file, decision, now, enabled, takeoverEnabled } = args;
  const base = { workgroupId, slug: claim.slug, action: decision.action, reason: decision.reason };

  // Terminal rung: no delivery, just the stamp that stops the ladder re-running.
  if (decision.action === 'exhaust') {
    if (!enabled) {
      log.info('self-heal: would exhaust stale claim', { class: 'stale-claim', ...base });
      return { ...base, applied: false };
    }
    stampClaim(file, { auto_heal_exhausted_at: new Date(now).toISOString() });
    log.warn('self-heal: stale claim exhausted — left red on the board', { class: 'stale-claim', ...base });
    return { ...base, applied: true };
  }

  if (decision.action === 'takeover' && !takeoverEnabled) {
    log.info('self-heal: would take over stale claim (takeover flag off)', { class: 'stale-claim', ...base });
    return { ...base, applied: false, reason: 'takeover-disabled' };
  }

  const owner = await args.resolveOwner(workgroupId, claim);
  const target =
    decision.action === 'takeover' ? await args.resolveSibling(workgroupId, claim, owner?.agentGroupId ?? null) : owner;
  if (!target) {
    // Never guess a room or an agent: an unresolvable target means the claim
    // stays exactly where it is, visible and red, with one line saying why.
    log.warn('self-heal: no deliverable target for stale claim', { class: 'stale-claim', ...base });
    return { ...base, applied: false, reason: decision.action === 'takeover' ? 'no-sibling' : 'owner-unresolved' };
  }

  const prompt =
    decision.action === 'takeover'
      ? buildTakeoverPrompt(claim)
      : buildNudgePrompt(
          claim,
          `Automatic nudge ${decision.nudge} of ${SELF_HEAL_MAX_NUDGES} from the host (self-heal)`,
        );

  if (!enabled) {
    log.info(`self-heal: would ${decision.action} stale claim`, {
      class: 'stale-claim',
      ...base,
      nudge: decision.nudge,
      target: target.agentGroupId,
    });
    return { ...base, applied: false, target: target.agentGroupId };
  }

  const sent = await args.createTask({
    target,
    claim,
    prompt,
    name: `${decision.action === 'takeover' ? 'take over' : 'push'} ${claim.slug}`,
  });
  if (!sent) return { ...base, applied: false, reason: 'delivery-failed', target: target.agentGroupId };

  // Stamp AFTER delivery: a failed send must not burn a rung. The count is the
  // ladder's whole memory, so takeover writes the value that makes the next
  // decision `exhaust`.
  stampClaim(file, {
    auto_nudged_at: new Date(now).toISOString(),
    auto_nudge_count: decision.action === 'takeover' ? SELF_HEAL_MAX_NUDGES + 1 : (decision.nudge ?? 1),
  });
  log.warn(`self-heal: ${decision.action} sent for stale claim`, {
    class: 'stale-claim',
    ...base,
    ...(decision.nudge ? { nudge: decision.nudge } : {}),
    target: target.agentGroupId,
    targetName: target.name,
    threadId: claim.threadId,
  });
  return { ...base, applied: true, target: target.agentGroupId };
}
