/**
 * Acts on stale work claims: nudge the owner, nudge once more a day later, then
 * (behind its own flag, since a misfire recreates duplicate work) offer it to a
 * sibling; after that the claim is left red forever. Detection is the board's,
 * verbatim, so board and automation can't disagree.
 *
 * Never nudged: `waiting on <person>:` notes (they get one @-mention escalation
 * past PARK_GRACE_MS instead), claims with no `thread_id`, claims that declare
 * themselves finished, and parks carrying a handoff note.
 *
 * Nudges must produce WORK, not chat: the only sanctioned post is "a human owes
 * me a decision", enforced by the prompt and by NUDGE_TASK_QUIET_ARGS. Every
 * action stamps the claim file (the audit trail); with the flag off it only logs.
 */
import fs from 'fs';
import path from 'path';

import { MAX_CLAIM_BYTES, PARK_GRACE_MS, readClaims, resolveClaimsDir, type BoardClaim } from '../../claims-board.js';
import { SELF_HEAL_ENABLED, SELF_HEAL_TAKEOVER_ENABLED } from '../../config.js';
import { readContainedFile } from '../../dashboard/api/attention-fs.js';
import { log } from '../../log.js';
import { claimsBaseDir, declaresItselfFinished } from './escalation.js';

/** The sweep calls this every tick; the throttle lives here. */
export const SELF_HEAL_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/** Between rungs. */
export const SELF_HEAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const SELF_HEAL_MAX_NUDGES = 2;

/** Anchored: a note merely mentioning waiting mid-prose is not the discipline. */
export function isWaitingOnHuman(note: string): boolean {
  return /^\s*waiting on\b/i.test(note);
}

/** A deliberate operator hold is not a stale handoff and never self-heals. */
export function isExplicitlyPaused(raw: { status?: unknown }): boolean {
  return typeof raw.status === 'string' && raw.status.trim().toLowerCase() === 'paused';
}

/**
 * `claim.sh park` refuses an empty note, so "has a note" is no signal; a real
 * handoff names both the state and what is needed next.
 */
const HANDOFF_NOTE_MIN_WORDS = 4;

/**
 * A park with a real handoff note is a completed action, not a stall; it still
 * decays to `stale` on the board after PARK_GRACE_MS. A throwaway note keeps
 * the decay and counts as abandonment.
 */
export function isHandedOffPark(raw: { status?: unknown; note?: unknown }): boolean {
  if (typeof raw.status !== 'string' || raw.status.trim().toLowerCase() !== 'parked') return false;
  const words = typeof raw.note === 'string' ? raw.note.trim().split(/\s+/).filter(Boolean) : [];
  return words.length >= HANDOFF_NOTE_MIN_WORDS;
}

interface SelfHealStamps {
  claimed_at?: unknown;
  auto_nudged_at?: unknown;
  auto_nudge_count?: unknown;
  auto_heal_exhausted_at?: unknown;
  /** A backoff, not a rung. */
  auto_heal_unresolved_at?: unknown;
}

type SelfHealAction = 'nudge' | 'takeover' | 'exhaust' | 'escalate-human';

interface SelfHealDecision {
  action: SelfHealAction | 'none';
  nudge?: number;
  reason: string;
}

/** A re-claim (fresh `claimed_at` newer than the last stamp) restarts the ladder. */
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
 * Backoff after no deliverable target resolved. Deliberately NOT a spent rung:
 * unresolvability says nothing about the owner, it only means "stop asking for
 * a day". A re-claim clears it.
 */
function inUnresolvedBackoff(stamps: SelfHealStamps, now: number): boolean {
  const at = typeof stamps.auto_heal_unresolved_at === 'string' ? Date.parse(stamps.auto_heal_unresolved_at) : NaN;
  if (!Number.isFinite(at)) return false;
  const claimedAt = typeof stamps.claimed_at === 'string' ? Date.parse(stamps.claimed_at) : NaN;
  if (Number.isFinite(claimedAt) && claimedAt > at) return false;
  return now - at < SELF_HEAL_COOLDOWN_MS;
}

/**
 * Returned verbatim: narrowing the named blocker to one person would be the
 * host guessing. Falls back to a generic phrase so the prompt stays readable.
 */
export function namedHuman(note: string): string {
  const m = /^\s*waiting on\s+([^:\n]{1,80}?)\s*:/i.exec(note);
  return m ? m[1].trim() : 'whoever you are waiting on';
}

/**
 * Human-blocked: silent inside PARK_GRACE_MS (the same constant at which the
 * board turns a park red, so the two can't drift), one escalation past it,
 * then never again. Not an exemption: an exempt claim parked on a person was
 * never surfaced to anyone.
 */
function decideHumanBlocked(
  claim: BoardClaim,
  raw: SelfHealStamps & { note?: unknown; status?: unknown },
  now: number,
): SelfHealDecision {
  if (claim.staleMs <= PARK_GRACE_MS) return { action: 'none', reason: 'waiting-on-human' };
  // Reuses the ladder's terminal stamp, so there is exactly one escalation.
  if (effectiveState(raw).exhausted) return { action: 'none', reason: 'exhausted' };
  if (inUnresolvedBackoff(raw, now)) return { action: 'none', reason: 'unresolved-backoff' };
  if (!claim.threadId) return { action: 'none', reason: 'no-thread' };
  if (declaresItselfFinished(raw)) return { action: 'none', reason: 'declares-finished' };
  return { action: 'escalate-human', reason: 'human-blocked-past-window' };
}

/**
 * `claim` must already be `stale`; exclusions are re-checked here so a future
 * second caller can't bypass them.
 */
function decideSelfHeal(
  claim: BoardClaim,
  raw: SelfHealStamps & { note?: unknown; status?: unknown },
  now: number,
): SelfHealDecision {
  if (claim.state !== 'stale') return { action: 'none', reason: 'not-stale' };
  if (isExplicitlyPaused(raw)) return { action: 'none', reason: 'explicitly-paused' };
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

function claimStateLine(claim: BoardClaim): string {
  const hours = Math.max(0, Math.round(claim.staleMs / 3600000));
  // staleMs means "since parked" for a park and "past TTL" otherwise.
  return (
    `state: ${claim.state} · ${hours}h ${claim.state === 'parked' ? 'since parked' : 'past due'} · owner: ${claim.owner}` +
    (claim.escalated ? ' · already escalated once' : '') +
    (claim.note ? `\nnote on the claim: ${claim.note}` : '')
  );
}

/**
 * Link back to the claim thread: an alert that lands top-level otherwise gets
 * answered under the alert, in a thread the owning agent isn't reading.
 * Resolved host-side because a Slack thread id carries no workspace URL.
 */
function threadLinkLine(threadUrl: string | null | undefined): string {
  return threadUrl
    ? `Include this link to the claim's thread in that message: ${threadUrl} — and ask them to reply THERE, where ` +
        `the context is, not under your post. A reply to the alert itself starts a second thread on the same topic.\n`
    : '';
}

/**
 * Shared by the human (dashboard/nudge.ts) and autonomous paths so they can't
 * drift. Moving the claim is SILENT (the board already renders it, and
 * announcing it flooded channels); the one thing that posts is a human who
 * owes a decision.
 */
export function buildNudgePrompt(claim: BoardClaim, origin: string, threadUrl?: string | null): string {
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
    `it may land at the top of a channel rather than in the thread you are reading this in.\n` +
    threadLinkLine(threadUrl) +
    `\nPost NOTHING for 1 or 2. The claims board and the Observatory already show claim state, so announcing a finish, ` +
    `a release or a park duplicates what a human can already see — and your standing instructions forbid it. Option 3 ` +
    `is the ONLY sanctioned post here, because a blocked hand-off is the one thing no board can show. Do not hedge by ` +
    `posting anyway.\n` +
    `A claim neither moved nor released by the end of this task is the failure this exists to end.`
  );
}

/**
 * Enforcement, because the prompt alone doesn't hold: `quiet_status` drops
 * streaming progress writes, `chat_limit: 1` allows exactly the one sanctioned
 * post. Not `mute_chat`: that would make "name the human who blocks you"
 * impossible.
 */
export const NUDGE_TASK_QUIET_ARGS = { quiet_status: true, chat_limit: 1 } as const;

/**
 * The addressee is not the owner, so declining is a first-class answer and is
 * what posts; taking the claim already rewrites the board.
 */
export function buildTakeoverPrompt(claim: BoardClaim, threadUrl?: string | null): string {
  const claimSh = 'bash /app/skills/work-claims/claim.sh';
  return (
    `Self-heal takeover — the claim \`${claim.slug}\`, owned by ${claim.owner}, has been stale through two ` +
    `automatic nudges with no movement. Work-claims rule 4: a claim past its TTL may be taken over by anyone.\n` +
    `${claimStateLine(claim)}\n\n` +
    `Do ONE of these two before this task ends:\n` +
    `1. Take it over — \`${claimSh} take ${claim.slug} <hours> "<takeover: what you are picking up>"\` — then work it. ` +
    `Post nothing: the take rewrites the owner on the board, which is where anyone looking will read it.\n` +
    `2. Post ONE message saying why this should NOT be taken over (already done, superseded, blocked on a named human) ` +
    `— that reason is the one thing the board cannot show. If it is done, also release it: \`${claimSh} release ${claim.slug}\`.\n` +
    threadLinkLine(threadUrl) +
    `\n` +
    `Do not silently leave it: this is the last automatic step, and after it the claim just sits red on the board.`
  );
}

/**
 * The one message a human-blocked claim ever produces. The @-mention IS the
 * delivery (a human's notification, an agent's wake); naming someone without
 * mentioning them notifies nobody. Fires once: `applyDecision` stamps
 * `auto_heal_exhausted_at` on delivery.
 */
function buildHumanEscalationPrompt(claim: BoardClaim, threadUrl?: string | null): string {
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
    `you need — because it may land at the top of a channel rather than in the thread you are reading this in.\n` +
    threadLinkLine(threadUrl) +
    `\nThis is the LAST automatic step for this claim. Nothing will ask again.`
  );
}

interface SelfHealTarget {
  agentGroupId: string;
  messagingGroupId: string;
  name: string;
  /**
   * Set only for a `system:tasks:<seriesId>` claim (its thread is a task
   * session). `null` means the channel with no thread, distinct from `undefined`.
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
  root?: string;
  /** null = unresolvable. */
  resolveOwner?: (workgroupId: string, claim: BoardClaim) => Promise<SelfHealTarget | null>;
  resolveSibling?: (
    workgroupId: string,
    claim: BoardClaim,
    excludeAgentGroupId: string | null,
  ) => Promise<SelfHealTarget | null>;
  /** Returns false on failure. */
  createTask?: (input: SelfHealTaskInput) => Promise<boolean>;
  resolveThreadUrl?: (threadId: string) => Promise<string | null>;
  enabled?: boolean;
  takeoverEnabled?: boolean;
}

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

/**
 * Safe read of a claim by slug against a FIFO, directory, device node,
 * oversized file, or symlink out of `claims/`. Never throws; null for all of
 * those. `dir` is resolved FRESH each call: a path proven safe before an
 * `await` only narrows the swap window for an agent with write access.
 */
function resolveAndReadClaim(
  label: string,
  root: string,
  workgroupId: string,
  slug: string,
): { file: string; text: string } | null {
  const dir = resolveClaimsDir(root, workgroupId);
  if (dir === null) {
    log.warn(`${label}: claims directory unreadable or escapes the workgroup, skipping`, { workgroupId, slug });
    return null;
  }
  const read = readContainedFile(label, dir, `${slug}.json`, workgroupId, MAX_CLAIM_BYTES);
  if (read === null) return null; // already logged by readContainedFile
  return { file: path.join(dir, `${slug}.json`), text: read.text };
}

/**
 * Atomic tmp+rename, as claim.sh writes. THROWS on an unreadable claim: every
 * caller runs after the action being recorded, and dropping the stamp would
 * re-fire the same rung every scan.
 */
function stampClaim(root: string, workgroupId: string, slug: string, patch: Record<string, unknown>): void {
  const found = resolveAndReadClaim('self-heal stamp', root, workgroupId, slug);
  if (found === null) {
    throw new Error(`self-heal: cannot stamp claim ${workgroupId}/${slug} — unreadable or escapes the workgroup`);
  }
  const raw = JSON.parse(found.text) as Record<string, unknown>;
  const tmp = path.join(path.dirname(found.file), `.tmp.${path.basename(found.file)}.${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify({ ...raw, ...patch }, null, 2));
  fs.renameSync(tmp, found.file);
}

interface WiredCandidate {
  agentGroupId: string;
  messagingGroupId: string;
  name: string;
  folder: string;
  /**
   * Set only by task-series claims. `null` means the channel with no thread,
   * distinct from `undefined` ("use the claim's thread").
   */
  deliverThreadId?: string | null;
}

/**
 * A task-series claim's thread is `system:tasks:<seriesId>`, a session with no
 * messaging group, so the channel join matches nothing. The task session row
 * IS the owner. Destination, ranked: the newest `task_thread_anchors` row
 * (where output actually landed), then the series' routing stamp, else none.
 * Same precedence the display side uses. The wiring join still applies.
 */
async function taskSeriesCandidates(workgroupId: string, threadId: string): Promise<WiredCandidate[]> {
  const { getDb } = await import('../../db/connection.js');
  const owner = await getDb().get<{ sessionId: string; agentGroupId: string; name: string; folder: string }>(
    `SELECT s.id AS sessionId, ag.id AS agentGroupId, ag.name AS name, ag.folder AS folder
         FROM sessions s
         JOIN agent_groups ag ON ag.id = s.agent_group_id
        WHERE s.thread_id = ? AND ag.workgroup_id = ?
        ORDER BY s.created_at DESC
        LIMIT 1`,
    threadId,
    workgroupId,
  );
  if (!owner) return [];

  // Newest anchor wins: the channel the series spoke in last.
  const anchor = await getDb().get<{
    channelType: string;
    platformId: string;
    threadPlatformId: string;
    messagingGroupId: string;
  }>(
    `SELECT a.channel_type AS channelType, a.platform_id AS platformId, a.thread_platform_id AS threadPlatformId,
              mg.id AS messagingGroupId
         FROM task_thread_anchors a
         JOIN messaging_groups mg ON mg.platform_id = a.platform_id AND mg.channel_type = a.channel_type
         JOIN messaging_group_agents mga
              ON mga.messaging_group_id = mg.id AND mga.agent_group_id = ?
        WHERE a.session_id = ?
        ORDER BY a.created_at DESC
        LIMIT 1`,
    owner.agentGroupId,
    owner.sessionId,
  );
  const where = anchor
    ? { messagingGroupId: anchor.messagingGroupId, deliverThreadId: `${anchor.platformId}:${anchor.threadPlatformId}` }
    : // `system:tasks:<seriesId>` — the series id is everything after the prefix.
      await seriesRoutingStamp(owner.agentGroupId, owner.sessionId, threadId.split(':').slice(2).join(':'));
  if (!where) return [];

  return [{ agentGroupId: owner.agentGroupId, name: owner.name, folder: owner.folder, ...where }];
}

/** Lazy (a session-DB open): only after the anchor lookup missed. */
async function seriesRoutingStamp(
  agentGroupId: string,
  sessionId: string,
  seriesId: string,
): Promise<{ messagingGroupId: string; deliverThreadId: string | null } | null> {
  // Read-only: a probe must never provision or migrate the session. No mailbox
  // reads as "no routing stamp".
  const [{ readSessionInbound }, { getDb }] = await Promise.all([
    import('../mailbox/index.js'),
    import('../../db/connection.js'),
  ]);
  // Not in one lease block: a row changing between the two reads costs at most
  // one stale destination, re-resolved later.
  const stamp = readSessionInbound(
    { agentGroupId, sessionId },
    (mailbox) => mailbox.getLatestTaskRoutingStamp(seriesId),
    { busyTimeoutMs: 5000, recoverJournal: true },
  );
  if (!stamp) return null; // `--isolated`: stamped no routing on purpose

  const mg = await getDb().get<{ messagingGroupId: string }>(
    `SELECT mg.id AS messagingGroupId
         FROM messaging_groups mg
         JOIN messaging_group_agents mga
              ON mga.messaging_group_id = mg.id AND mga.agent_group_id = ?
        WHERE mg.platform_id = ? AND mg.channel_type = ?`,
    agentGroupId,
    stamp.platformId,
    stamp.channelType,
  );
  return mg ? { messagingGroupId: mg.messagingGroupId, deliverThreadId: stamp.threadId } : null;
}

/**
 * Wired by DB join on platform id, NOT by live session: un-engaged traffic mints
 * no sessions, and "newest session on this messaging group" would deliver into
 * an unrelated thread's container.
 */
export async function wiredCandidates(workgroupId: string, threadId: string): Promise<WiredCandidate[]> {
  const [{ getDb }, { threadPlatformId }, { isTaskThread }] = await Promise.all([
    import('../../db/connection.js'),
    import('../../dashboard/api/observatory.js'),
    import('../../db/sessions.js'),
  ]);
  if (isTaskThread(threadId)) return taskSeriesCandidates(workgroupId, threadId);
  const platformId = await threadPlatformId(threadId);
  return getDb().all<WiredCandidate>(
    `SELECT ag.id AS agentGroupId, ag.name AS name, ag.folder AS folder, mg.id AS messagingGroupId
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE ag.workgroup_id = ? AND mg.platform_id = ?`,
    workgroupId,
    platformId,
  );
}

/**
 * `claim.owner` is the per-channel assistant name, so match through the same
 * resolver the spawn path uses, falling back to the group name. Never guess:
 * nudging the wrong agent group is worse than not nudging.
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
    const group = await getAgentGroup(row.agentGroupId);
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
  // A miss must log what it looked at, or it can't be diagnosed later.
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
 * `caller: 'host'` with explicit `messaging_group` + `thread_id` is the only
 * routing shape that doesn't need an existing session.
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
        // For a task-series claim `null` means "the channel, no thread", not "fall back".
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

async function defaultResolveThreadUrl(threadId: string): Promise<string | null> {
  const { threadPermalink } = await import('../../dashboard/api/observatory.js');
  return threadPermalink(threadId);
}

let lastRanAtMs = 0;

export function _resetSelfHealThrottleForTesting(): void {
  lastRanAtMs = 0;
}

export function shouldSkipSelfHealScan(lastRan: number, now: number): boolean {
  return now - lastRan < SELF_HEAL_SCAN_INTERVAL_MS;
}

/**
 * With `NANOCLAW_SELF_HEAL` off it only logs what it would do; takeover also
 * requires `NANOCLAW_SELF_HEAL_TAKEOVER`.
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
  const resolveThreadUrl = deps.resolveThreadUrl ?? defaultResolveThreadUrl;

  const outcomes: SelfHealOutcome[] = [];
  for (const workgroupId of listWorkgroupDirs(root)) {
    for (const claim of readClaims(workgroupId, now, root)) {
      if (claim.state !== 'stale') continue;

      // Re-read through `resolveAndReadClaim`: the file is an agent's choice up
      // to this line. A skip is free, since nothing has been decided yet.
      const found = resolveAndReadClaim('self-heal', root, workgroupId, claim.slug);
      if (found === null) continue; // already logged

      let raw: SelfHealStamps & { note?: unknown; status?: unknown };
      try {
        raw = JSON.parse(found.text) as SelfHealStamps & { note?: unknown; status?: unknown };
      } catch (err) {
        log.warn('self-heal: unparseable claim, skipping', { file: found.file, err });
        continue;
      }

      const decision = decideSelfHeal(claim, raw, now);
      if (decision.action === 'none') continue;

      const outcome = await applyDecision({
        workgroupId,
        claim,
        root,
        decision,
        now,
        enabled,
        takeoverEnabled,
        resolveOwner,
        resolveSibling,
        createTask,
        resolveThreadUrl,
      });
      outcomes.push(outcome);
    }
  }
  return outcomes;
}

async function applyDecision(args: {
  workgroupId: string;
  claim: BoardClaim;
  root: string;
  decision: SelfHealDecision;
  now: number;
  enabled: boolean;
  takeoverEnabled: boolean;
  resolveOwner: NonNullable<SelfHealDeps['resolveOwner']>;
  resolveSibling: NonNullable<SelfHealDeps['resolveSibling']>;
  createTask: NonNullable<SelfHealDeps['createTask']>;
  resolveThreadUrl: NonNullable<SelfHealDeps['resolveThreadUrl']>;
}): Promise<SelfHealOutcome> {
  const { workgroupId, claim, root, decision, now, enabled, takeoverEnabled } = args;
  const base = { workgroupId, slug: claim.slug, action: decision.action, reason: decision.reason };

  if (decision.action === 'exhaust') {
    if (!enabled) {
      log.info('self-heal: would exhaust stale claim', { class: 'stale-claim', ...base });
      return { ...base, applied: false };
    }
    stampClaim(root, workgroupId, claim.slug, { auto_heal_exhausted_at: new Date(now).toISOString() });
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
    // Never guess a target. The backoff stamp keeps this to one line per day
    // without spending a nudge; shadow mode stamps nothing.
    if (enabled) stampClaim(root, workgroupId, claim.slug, { auto_heal_unresolved_at: new Date(now).toISOString() });
    log.warn('self-heal: no deliverable target for stale claim', { class: 'stale-claim', ...base });
    return { ...base, applied: false, reason: decision.action === 'takeover' ? 'no-sibling' : 'owner-unresolved' };
  }

  // A task-series claim's own thread is not linkable; `null` means channel-level.
  const contextThread = target.deliverThreadId !== undefined ? target.deliverThreadId : claim.threadId;
  const threadUrl = contextThread ? await args.resolveThreadUrl(contextThread) : null;
  const prompt =
    decision.action === 'takeover'
      ? buildTakeoverPrompt(claim, threadUrl)
      : decision.action === 'escalate-human'
        ? buildHumanEscalationPrompt(claim, threadUrl)
        : buildNudgePrompt(
            claim,
            `Automatic nudge ${decision.nudge} of ${SELF_HEAL_MAX_NUDGES} from the host (self-heal)`,
            threadUrl,
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

  // Stamp AFTER delivery: a failed send must not burn a rung. `escalate-human`
  // is terminal, so it stamps exhausted plus `auto_nudged_at` (effectiveState
  // reads exhaustion through it, or the escalation repeats daily).
  stampClaim(
    root,
    workgroupId,
    claim.slug,
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
