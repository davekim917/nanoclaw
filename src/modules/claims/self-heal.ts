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
 *   1. `waiting on <person>: …` notes are never NUDGED or reassigned. That note
 *      shape is the human-blocked discipline from
 *      container/skills/work-claims/SKILL.md. Nudging it tells an agent to move
 *      work it already correctly stopped on; reassigning it moves the block to a
 *      second agent. What it gets instead is silence for PARK_GRACE_MS and then
 *      exactly one escalation that @-mentions the named human — see
 *      `decideHumanBlocked`. This used to be an absolute exemption, which meant
 *      a claim parked on a person could never be spoken about again; "do not nag
 *      on a timer" is not the same rule as "never speak".
 *   2. A claim with no `thread_id` is never nudged. There is no honest room to
 *      nudge in — the same reason dashboard/nudge.ts 409s rather than guessing.
 *   3. A claim that says it finished is not stalled work (declaresItselfFinished).
 *   4. A claim already `parked` WITH a handoff note (isHandedOffPark). Parking
 *      on the record IS the action a nudge would ask for; PARK_GRACE_MS decay
 *      making it stale-eligible again is a board-visibility rule, not a reason
 *      to re-ask. All three nudge options are no-ops for such a claim.
 *
 * A nudge is meant to produce WORK, not chat. Moving the claim — finishing,
 * releasing, parking — is a silent state change: the claims board and the
 * Observatory already render claim state, and the agents' own instructions
 * forbid announcing completion. The single sanctioned post is "a human owes me
 * a decision", which is the one fact no board can show. That is enforced twice:
 * the prompt says it, and NUDGE_TASK_QUIET_ARGS caps the task at one chat send
 * with no streaming status.
 *
 * The ladder is deliberately slow and deliberately short: nudge the owner, nudge
 * it once more a day later, and only then — behind its own separate flag —
 * offer the work to a sibling. A human-blocked claim skips the ladder entirely
 * and gets its own single rung. Takeover is the only step where one agent takes
 * another's work with no human in the loop, and a misfire recreates the
 * duplicate-work problem claims exist to prevent, so it arms separately from
 * everything else here. After that the claim is left alone, red, forever.
 *
 * Nothing here is unaccounted for: every action stamps the claim file and logs a
 * structured line (that is the audit trail — deliberately NOT a chat post); with
 * the flag off, the same detection runs and logs `self-heal: would …` while
 * spawning nothing.
 */
import fs from 'fs';
import path from 'path';

import { MAX_CLAIM_BYTES, PARK_GRACE_MS, readClaims, resolveClaimsDir, type BoardClaim } from '../../claims-board.js';
import { SELF_HEAL_ENABLED, SELF_HEAL_TAKEOVER_ENABLED } from '../../config.js';
import { readContainedFile } from '../../dashboard/api/attention-fs.js';
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

/**
 * How much note a park has to carry to count as a handoff rather than a walk-away.
 *
 * `claim.sh park` REFUSES an empty note, so "has a note" is not a signal — every
 * script-written park has one. What separates "schema done, handlers TODO" from
 * "parked" / "wip" / "not done" is that the first names both the state and what
 * is needed next, and two facts do not fit in three words.
 */
// ponytail: word count, not meaning. Upgrade path if junk notes get wordier is
// the same one the board would need — a note-quality check the skill enforces
// at write time, in claim.sh, not a classifier here.
export const HANDOFF_NOTE_MIN_WORDS = 4;

/**
 * A park that told a successor what they need is a COMPLETED action, not a
 * stall — the whole point of `park` is stepping off work on the record. It
 * decays to `stale` on the board after PARK_GRACE_MS (claims-board.ts) so a
 * human still sees it, and that is the right amount of pressure. Nudging it
 * asks the agent to redo the thing it already did: all three options below are
 * no-ops for a claim that is already parked with a note.
 *
 * A park with a throwaway note is the genuine abandonment case, and it keeps
 * the 24h decay.
 */
export function isHandedOffPark(raw: { status?: unknown; note?: unknown }): boolean {
  if (typeof raw.status !== 'string' || raw.status.trim().toLowerCase() !== 'parked') return false;
  const words = typeof raw.note === 'string' ? raw.note.trim().split(/\s+/).filter(Boolean) : [];
  return words.length >= HANDOFF_NOTE_MIN_WORDS;
}

/** Ladder state, as stamped on the claim file. No new schema. */
export interface SelfHealStamps {
  claimed_at?: unknown;
  auto_nudged_at?: unknown;
  auto_nudge_count?: unknown;
  auto_heal_exhausted_at?: unknown;
  /** Last time no deliverable target could be resolved — a backoff, not a rung. */
  auto_heal_unresolved_at?: unknown;
}

export type SelfHealAction = 'nudge' | 'takeover' | 'exhaust' | 'escalate-human';

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
 * Backoff after a sweep could not resolve anywhere to deliver.
 *
 * Deliberately NOT a spent rung: an unresolvable target says nothing about
 * whether the owner needs nudging, so re-arming must not cost the claim one of
 * its two nudges. It is only a "stop asking for a day". Without it the sweep
 * re-decided `first-nudge`, failed, and re-logged every scan forever — 1035
 * warnings from 8 claims in one log, the loudest line in the file.
 *
 * Same re-claim reset as `effectiveState`: a fresh `claimed_at` is new work,
 * possibly in a thread that DOES resolve, so it clears the backoff immediately.
 */
function inUnresolvedBackoff(stamps: SelfHealStamps, now: number): boolean {
  const at = typeof stamps.auto_heal_unresolved_at === 'string' ? Date.parse(stamps.auto_heal_unresolved_at) : NaN;
  if (!Number.isFinite(at)) return false;
  const claimedAt = typeof stamps.claimed_at === 'string' ? Date.parse(stamps.claimed_at) : NaN;
  if (Number.isFinite(claimedAt) && claimedAt > at) return false;
  return now - at < SELF_HEAL_COOLDOWN_MS;
}

/**
 * Who the note says owes the answer, out of `waiting on <person>: <what>`.
 *
 * Returned verbatim, including "the reviewer or the operator" — the note names whoever
 * the agent believed was blocking, and narrowing that to one person here would
 * be the host guessing. Falls back to a generic phrase rather than an empty
 * mention, because the prompt has to stay readable when the note is malformed.
 */
export function namedHuman(note: string): string {
  const m = /^\s*waiting on\s+([^:\n]{1,80}?)\s*:/i.exec(note);
  return m ? m[1].trim() : 'whoever you are waiting on';
}

/**
 * The human-blocked rung — a suppression WINDOW, not an exemption.
 *
 * `waiting on <person>` is the park-when-blocked discipline from the work-claims
 * skill, and nudging it on a timer tells an agent to move work it correctly
 * stopped on. That was the reason this returned `none` unconditionally. It
 * overshot: unconditional means a claim parked on a human is exempt from the
 * ladder FOREVER, so the one state that genuinely needs a person is the one
 * state nobody is ever told about. Live proof: two claims sat `parked` on
 * "waiting on <two people>" for ~40h with no notification ever sent.
 *
 * So: silent inside the window, one escalation past it, then never again.
 *
 * The window is `PARK_GRACE_MS`, reused rather than re-invented, because that
 * constant is already the boundary at which the board stops calling a park
 * healthy and starts rendering it red (claims-board.ts). One constant, one
 * meaning — a second timeout here would be a second opinion about when a
 * hand-off has lapsed, and the two would drift.
 *
 * Note that for a PARKED claim the window has already elapsed by construction:
 * `readClaims` only reports `stale` for a park once it is past PARK_GRACE_MS,
 * and `decideSelfHeal` returns early on anything not `stale`. The check still
 * runs, because a claim can also carry a `waiting on` note without being parked,
 * and that one is measured past its own TTL.
 */
function decideHumanBlocked(
  claim: BoardClaim,
  raw: SelfHealStamps & { note?: unknown },
  now: number,
): SelfHealDecision {
  if (claim.staleMs <= PARK_GRACE_MS) return { action: 'none', reason: 'waiting-on-human' };
  // Reuses the ladder's own terminal stamp, so one escalation is all there is.
  if (effectiveState(raw).exhausted) return { action: 'none', reason: 'exhausted' };
  if (inUnresolvedBackoff(raw, now)) return { action: 'none', reason: 'unresolved-backoff' };
  if (!claim.threadId) return { action: 'none', reason: 'no-thread' };
  if (declaresItselfFinished(raw)) return { action: 'none', reason: 'declares-finished' };
  return { action: 'escalate-human', reason: 'human-blocked-past-window' };
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
  if (isWaitingOnHuman(note)) return decideHumanBlocked(claim, raw, now);
  if (isHandedOffPark(raw)) return { action: 'none', reason: 'parked-with-handoff' };
  if (!claim.threadId) return { action: 'none', reason: 'no-thread' };
  if (declaresItselfFinished(raw)) return { action: 'none', reason: 'declares-finished' };

  const { count, lastAt, exhausted } = effectiveState(raw);
  if (exhausted) return { action: 'none', reason: 'exhausted' };
  if (inUnresolvedBackoff(raw, now)) return { action: 'none', reason: 'unresolved-backoff' };
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
 *
 * Moving the claim is SILENT. The first version of this prompt made options 1
 * and 2 announce themselves ("then say here that it is free"), and the result
 * was the measurable failure: 22 nudges in a day produced 22 channel posts, of
 * which ~half of one channel's traffic was agents narrating a state change the
 * claims board and the Observatory already render. It also contradicted the
 * agents' own standing instruction never to announce completion. The one thing
 * a board cannot show is a human who owes a decision, so that is the one thing
 * that posts.
 */
export function buildNudgePrompt(claim: BoardClaim, origin: string): string {
  const claimSh = 'bash /app/skills/work-claims/claim.sh';
  return (
    `${origin} — the claim \`${claim.slug}\` has stopped moving.\n` +
    `${claimStateLine(claim)}\n\n` +
    `MOVE the claim before this task ends — there is no fourth option:\n` +
    `1. Finish the work, then \`${claimSh} release ${claim.slug}\`.\n` +
    `2. Stopping without finishing: \`${claimSh} park ${claim.slug} "<what a successor needs to know>"\`. ` +
    `Dead or superseded: \`${claimSh} release ${claim.slug}\`.\n` +
    `3. SOMEONE ELSE — a human or another agent — owes you a decision or an action you cannot proceed without: ` +
    `\`${claimSh} park ${claim.slug} "waiting on <person-or-agent>: <what you asked>"\`, AND post ONE message that ` +
    `@-mentions whoever owes it. The mention is what delivers the ask — a notification to a human, a wake to an agent; ` +
    `a plain name reaches neither. Write it to stand alone — say which claim, what is blocked, and who owes the answer; ` +
    `it may land at the top of a channel rather than in the thread you are reading this in.\n\n` +
    `Post NOTHING for 1 or 2. The claims board and the Observatory already show claim state, so announcing a finish, ` +
    `a release or a park duplicates what a human can already see — and your standing instructions forbid it. Option 3 ` +
    `is the ONLY sanctioned post here, because a blocked hand-off is the one thing no board can show. Do not hedge by ` +
    `posting anyway.\n` +
    `A claim neither moved nor released by the end of this task is the failure this exists to end.`
  );
}

/**
 * Task-create args every nudge is spawned with, on both paths.
 *
 * The prompt above is instruction; this is the enforcement, and it exists
 * because instructions demonstrably do not hold on their own. `quiet_status`
 * drops the streaming 💭 progress writes — those carry the task row's routing
 * and land in the channel whatever the prompt says. `chat_limit: 1` caps the
 * turn at a single chat send at the agent-runner's write layer
 * (`container/agent-runner/src/db/messages-out.ts`), which is exactly the one
 * post option 3 is allowed. Not `mute_chat`: that would make option 3
 * impossible, and a silently blocked agent is the outcome this whole ladder is
 * trying to prevent.
 */
export const NUDGE_TASK_QUIET_ARGS = { quiet_status: true, chat_limit: 1 } as const;

/**
 * Takeover has a different contract from a nudge: the agent being addressed is
 * not the owner, so "finish it" is not one of its options until it has actually
 * taken the claim. Declining is a first-class answer — a sibling that says why
 * it is not the right owner has still moved the claim out of silence.
 *
 * Same posting rule as the nudge: taking the claim rewrites the owner on the
 * board, so announcing it is duplication. Declining is not visible anywhere,
 * so declining is what posts.
 */
export function buildTakeoverPrompt(claim: BoardClaim): string {
  const claimSh = 'bash /app/skills/work-claims/claim.sh';
  return (
    `Self-heal takeover — the claim \`${claim.slug}\`, owned by ${claim.owner}, has been stale through two ` +
    `automatic nudges with no movement. Work-claims rule 4: a claim past its TTL may be taken over by anyone.\n` +
    `${claimStateLine(claim)}\n\n` +
    `Do ONE of these two before this task ends:\n` +
    `1. Take it over — \`${claimSh} take ${claim.slug} <hours> "<takeover: what you are picking up>"\` — then work it. ` +
    `Post nothing: the take rewrites the owner on the board, which is where anyone looking will read it.\n` +
    `2. Post ONE message saying why this should NOT be taken over (already done, superseded, blocked on a named human) ` +
    `— that reason is the one thing the board cannot show. If it is done, also release it: \`${claimSh} release ${claim.slug}\`.\n\n` +
    `Do not silently leave it: this is the last automatic step, and after it the claim just sits red on the board.`
  );
}

/**
 * The one message a human-blocked claim is allowed to produce, ever.
 *
 * It exists because a park that named a person notified nobody. The note shape
 * `waiting on <person>: <what you asked>` is a record, not a delivery — and the
 * two live claims that motivated this sat on it for ~40h while the Observatory
 * rendered them as a human owing a decision that the human had never been told
 * about.
 *
 * So the entire contract is the @-mention. `container/CLAUDE.md` binds the shape
 * (`👉 @<person> — <what they do, by when>`) and says why: the mention IS the
 * delivery mechanism — a human's notification, an agent's wake — and there is no
 * slot for a bare name. A message that says "waiting on the operator" and does not
 * mention them is this bug all over again, one layer up.
 *
 * Unlike a nudge this asks for no work, so it offers no ladder of options: if
 * the answer already arrived the claim should just move, and if it has not, the
 * ask has to reach someone. Either way this fires once — `applyDecision` stamps
 * `auto_heal_exhausted_at` on delivery, and the claim is then left red forever.
 */
export function buildHumanEscalationPrompt(claim: BoardClaim): string {
  const claimSh = 'bash /app/skills/work-claims/claim.sh';
  const hours = Math.max(0, Math.round(claim.staleMs / 3600000));
  const who = namedHuman(claim.note);
  return (
    `The claim \`${claim.slug}\` has been blocked on a person for ${hours}h and nobody has been told.\n` +
    `${claimStateLine(claim)}\n\n` +
    `Its note parks it on: ${who}. A note is a record, not a notification — parking it sent no one anything, ` +
    `which is why it has sat this long.\n\n` +
    `FIRST check whether the answer already arrived (the thread, the PR, the issue). If it did, this is not blocked: ` +
    `finish it or \`${claimSh} release ${claim.slug}\`, and post NOTHING — the board already shows claim state.\n\n` +
    `If it is genuinely still blocked, post ONE message that @-mentions ${who} and ends with the ask:\n` +
    `👉 @<person> — <the decision or action you need, and by when>\n` +
    `The @-mention is the whole point: it is what raises a notification. A plain name reaches nobody, and writing ` +
    `one is how this claim got here. Write the message to stand alone — name the claim, what is blocked, and what ` +
    `you need — because it may land at the top of a channel rather than in the thread you are reading this in.\n\n` +
    `This is the LAST automatic step for this claim. Nothing will ask again.`
  );
}

/** An agent group wired to the claim's own thread channel. */
export interface SelfHealTarget {
  agentGroupId: string;
  messagingGroupId: string;
  /** Display name we matched on, for the log line. */
  name: string;
  /**
   * Where to deliver, when that is NOT the claim's own thread. Set only for a
   * `system:tasks:<seriesId>` claim, whose thread is a task session rather than
   * a real channel thread — see `taskSeriesCandidates`. `null` means the
   * channel with no thread, which is distinct from `undefined`.
   */
  deliverThreadId?: string | null;
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

interface WiredCandidate {
  agentGroupId: string;
  messagingGroupId: string;
  name: string;
  folder: string;
  /**
   * Deliver here instead of the claim's own thread. Set only by task-series
   * claims, whose thread is a task session and never a real destination.
   * `null` means the channel with no thread — a legitimate answer, distinct
   * from `undefined` ("use the claim's thread").
   */
  deliverThreadId?: string | null;
}

/**
 * A claim taken inside a scheduled task has no channel to nudge into: its
 * thread is `system:tasks:<seriesId>`, and a task session is deliberately
 * minted with `messaging_group_id = null` (session-manager `resolveTaskSession`),
 * so the channel join above matches nothing. Most autonomous work happens in
 * scheduled tasks, which made that the single biggest hole in this path — 805
 * of 1035 "no deliverable target" warnings in one log, and self-reinforcing:
 * a nudge is DELIVERED as a task, so an owner who re-claims while working it
 * rewrites the claim's thread to that nudge task's own `system:tasks:*` thread
 * and the claim can never be nudged again.
 *
 * WHO is not a guess: the task session row IS the series' owner, a strictly
 * better signal than reverse-mapping a channel.
 *
 * WHERE has two sources that are NOT the same thing, so they are ranked:
 *
 *   1. `task_thread_anchors` — where the series' output actually LANDED. First
 *      choice for a nudge: it is the live context the claim was worked in.
 *      Only ~46% of task sessions have one (64 of 138 measured), because an
 *      anchor is written only once a session posts into a thread.
 *   2. the series' routing STAMP on its `messages_in` row — where an
 *      unaddressed reply is supposed to land (`ncl tasks` help: "Routing (where
 *      an unaddressed reply lands)"). It exists from task-definition time
 *      whether or not the series ever spoke, but the agent picks its real
 *      destination per fire via `send_message` (tasks.ts:715), so it is second
 *      choice, never first.
 *   3. neither — no target. "Unrouted" is the honest answer; the backoff above
 *      is what keeps it from being a loud one.
 *
 * Same precedence the display side uses, deliberately: two answers to "what
 * channel does a task session belong to" would be worse than either alone.
 * The wiring join is kept on both so we can still only address a channel the
 * agent group actually belongs to.
 */
async function taskSeriesCandidates(workgroupId: string, threadId: string): Promise<WiredCandidate[]> {
  const { getDb } = await import('../../db/index.js');
  const db = getDb();
  const owner = db
    .prepare(
      `SELECT s.id AS sessionId, ag.id AS agentGroupId, ag.name AS name, ag.folder AS folder
         FROM sessions s
         JOIN agent_groups ag ON ag.id = s.agent_group_id
        WHERE s.thread_id = ? AND ag.workgroup_id = ?
        ORDER BY s.created_at DESC
        LIMIT 1`,
    )
    .get(threadId, workgroupId) as
    | { sessionId: string; agentGroupId: string; name: string; folder: string }
    | undefined;
  if (!owner) return [];

  // Newest anchor wins — a series that has posted in two channels is talking in
  // the one it spoke in last, and picking arbitrarily is how a nudge lands in a
  // room nobody is reading.
  const anchor = db
    .prepare(
      `SELECT a.channel_type AS channelType, a.platform_id AS platformId, a.thread_platform_id AS threadPlatformId,
              mg.id AS messagingGroupId
         FROM task_thread_anchors a
         JOIN messaging_groups mg ON mg.platform_id = a.platform_id AND mg.channel_type = a.channel_type
         JOIN messaging_group_agents mga
              ON mga.messaging_group_id = mg.id AND mga.agent_group_id = ?
        WHERE a.session_id = ?
        ORDER BY a.created_at DESC
        LIMIT 1`,
    )
    .get(owner.agentGroupId, owner.sessionId) as
    | { channelType: string; platformId: string; threadPlatformId: string; messagingGroupId: string }
    | undefined;
  const where = anchor
    ? { messagingGroupId: anchor.messagingGroupId, deliverThreadId: `${anchor.platformId}:${anchor.threadPlatformId}` }
    : // `system:tasks:<seriesId>` — the series id is everything after the prefix.
      await seriesRoutingStamp(db, owner.agentGroupId, owner.sessionId, threadId.split(':').slice(2).join(':'));
  if (!where) return [];

  return [{ agentGroupId: owner.agentGroupId, name: owner.name, folder: owner.folder, ...where }];
}

/**
 * Rung 2 — the series' own routing stamp, read from its task row.
 *
 * Reaching here costs a session-DB file open, so it is deliberately lazy: only
 * `system:tasks:*` claims get here, only after the anchor lookup missed, and
 * only once per backoff window (a claim that resolves to nothing is stamped and
 * left alone for a day). No cache — the backoff already is the throttle.
 */
async function seriesRoutingStamp(
  db: import('better-sqlite3').Database,
  agentGroupId: string,
  sessionId: string,
  seriesId: string,
): Promise<{ messagingGroupId: string; deliverThreadId: string | null } | null> {
  const { inboundDbPath, withInboundDb } = await import('../../session-manager.js');
  if (!fs.existsSync(inboundDbPath(agentGroupId, sessionId))) return null;

  const stamp = withInboundDb(agentGroupId, sessionId, (inbound) =>
    inbound
      .prepare(
        `SELECT platform_id AS platformId, channel_type AS channelType, thread_id AS threadId
           FROM messages_in
          WHERE kind = 'task' AND series_id = ? AND platform_id IS NOT NULL
          ORDER BY seq DESC
          LIMIT 1`,
      )
      .get(seriesId),
  ) as { platformId: string; channelType: string; threadId: string | null } | undefined;
  if (!stamp) return null; // `--isolated`: stamped no routing on purpose

  const mg = db
    .prepare(
      `SELECT mg.id AS messagingGroupId
         FROM messaging_groups mg
         JOIN messaging_group_agents mga
              ON mga.messaging_group_id = mg.id AND mga.agent_group_id = ?
        WHERE mg.platform_id = ? AND mg.channel_type = ?`,
    )
    .get(agentGroupId, stamp.platformId, stamp.channelType) as { messagingGroupId: string } | undefined;
  return mg ? { messagingGroupId: mg.messagingGroupId, deliverThreadId: stamp.threadId } : null;
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
 * below instead.
 *
 * Exported for its own test: both resolvers funnel through here, so this is the
 * one place the "which room can we actually reach?" question is answered.
 */
export async function wiredCandidates(workgroupId: string, threadId: string): Promise<WiredCandidate[]> {
  const [{ getDb }, { threadPlatformId }, { isTaskThread }] = await Promise.all([
    import('../../db/index.js'),
    import('../../dashboard/api/observatory.js'),
    import('../../db/sessions.js'),
  ]);
  if (isTaskThread(threadId)) return taskSeriesCandidates(workgroupId, threadId);
  return getDb()
    .prepare(
      `SELECT ag.id AS agentGroupId, ag.name AS name, ag.folder AS folder, mg.id AS messagingGroupId
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE ag.workgroup_id = ? AND mg.platform_id = ?`,
    )
    .all(workgroupId, threadPlatformId(threadId)) as WiredCandidate[];
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
  const considered: string[] = [];
  const [{ resolveAssistantName }, { readContainerConfig }, { getAgentGroup }] = await Promise.all([
    import('../../container-runner.js'),
    import('../../container-config.js'),
    import('../../db/agent-groups.js'),
  ]);
  for (const row of rows) {
    considered.push(row.name);
    if (row.name.trim().toLowerCase() === wanted) {
      return {
        agentGroupId: row.agentGroupId,
        messagingGroupId: row.messagingGroupId,
        name: row.name,
        deliverThreadId: row.deliverThreadId,
      };
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
    considered.push(display);
    if (display.trim().toLowerCase() === wanted) {
      return {
        agentGroupId: row.agentGroupId,
        messagingGroupId: row.messagingGroupId,
        name: display,
        deliverThreadId: row.deliverThreadId,
      };
    }
  }
  // A miss has to say what it looked at. Without this the caller logs only
  // "no deliverable target", which is unfalsifiable after the fact: an
  // investigation into 14 such warnings could rule out every testable cause and
  // still not name the mechanism, because the candidate set was gone by then.
  log.warn('self-heal: owner did not match any wired agent on the thread', {
    slug: claim.slug,
    wanted,
    threadId: claim.threadId,
    considered,
  });
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
  return row
    ? {
        agentGroupId: row.agentGroupId,
        messagingGroupId: row.messagingGroupId,
        name: row.name,
        deliverThreadId: row.deliverThreadId,
      }
    : null;
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
        // The claim's own thread, except for a task-series claim whose "thread"
        // is a task session and never a destination — that one carries its own,
        // and `null` there means "the channel, no thread", not "fall back".
        thread_id: input.target.deliverThreadId !== undefined ? input.target.deliverThreadId : input.claim.threadId,
        ...NUDGE_TASK_QUIET_ARGS,
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

      // Re-resolved FRESH, not the `dir` `readClaims` used a moment ago: that
      // call already proved the claims directory was safe to read at THAT
      // instant, but `claims/` is agent-writable and can be swapped for a
      // symlink between then and now just as easily as a single leaf can.
      const dir = resolveClaimsDir(root, workgroupId);
      if (dir === null) {
        log.warn('self-heal: claims directory unreadable or escapes the workgroup, skipping', {
          workgroupId,
          slug: claim.slug,
        });
        continue;
      }
      const file = path.join(dir, `${claim.slug}.json`);

      // This re-reads the SAME claim `readClaims` just classified, moments
      // earlier — every property of the file on disk (FIFO, directory,
      // symlinked elsewhere, oversized) is still an agent's choice right up to
      // this line, so it goes through the same `readContainedFile` seam
      // `claims-board.ts` uses rather than a raw `readFileSync`. A plain
      // `readFileSync` here opens for reading unconditionally, and opening a
      // FIFO for reading BLOCKS until a writer appears — on the host's single
      // event loop, which is also the sweep that would need to run again to
      // ever notice. `MAX_CLAIM_BYTES` is the board's own cap, imported rather
      // than re-declared, so this path and the board's can never read the same
      // claim at two different limits.
      const read = readContainedFile('self-heal', dir, `${claim.slug}.json`, workgroupId, MAX_CLAIM_BYTES);
      if (read === null) continue; // already logged by readContainedFile — FIFO, oversized, escaping, or absent

      let raw: SelfHealStamps & { note?: unknown };
      try {
        raw = JSON.parse(read.text) as SelfHealStamps & { note?: unknown };
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
    // The stamp is what keeps that ONE line from becoming one per scan forever
    // — it backs the claim off for a day without spending a nudge. Shadow mode
    // stamps nothing, so a dry run still reports the full picture every scan.
    if (enabled) stampClaim(file, { auto_heal_unresolved_at: new Date(now).toISOString() });
    log.warn('self-heal: no deliverable target for stale claim', { class: 'stale-claim', ...base });
    return { ...base, applied: false, reason: decision.action === 'takeover' ? 'no-sibling' : 'owner-unresolved' };
  }

  const prompt =
    decision.action === 'takeover'
      ? buildTakeoverPrompt(claim)
      : decision.action === 'escalate-human'
        ? buildHumanEscalationPrompt(claim)
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

  const verb = { takeover: 'take over', 'escalate-human': 'escalate', nudge: 'push' }[
    decision.action as 'takeover' | 'escalate-human' | 'nudge'
  ];
  const sent = await args.createTask({ target, claim, prompt, name: `${verb} ${claim.slug}` });
  if (!sent) return { ...base, applied: false, reason: 'delivery-failed', target: target.agentGroupId };

  // Stamp AFTER delivery: a failed send must not burn a rung. The count is the
  // ladder's whole memory, so takeover writes the value that makes the next
  // decision `exhaust`.
  // `escalate-human` is terminal on delivery, so it stamps the ladder's own
  // exhausted marker rather than a rung. `auto_nudged_at` goes with it because
  // `effectiveState` reads exhaustion through that timestamp — without it the
  // stamp is invisible and the one-shot escalation would repeat every day.
  stampClaim(
    file,
    decision.action === 'escalate-human'
      ? { auto_nudged_at: new Date(now).toISOString(), auto_heal_exhausted_at: new Date(now).toISOString() }
      : {
          auto_nudged_at: new Date(now).toISOString(),
          auto_nudge_count: decision.action === 'takeover' ? SELF_HEAL_MAX_NUDGES + 1 : (decision.nudge ?? 1),
        },
  );
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
