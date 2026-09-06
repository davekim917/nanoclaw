/**
 * Steer write path for `POST /dashboard/api/observatory/steer`.
 *
 * Nudge's sibling, and deliberately its inverse. `nudge.ts` composes the whole
 * prompt from the claim file so a browser can never author a line of what an
 * agent is told; steer exists precisely for the case where a HUMAN has
 * something to say that no file contains — "drop it, ship the
 * other one", "the blocker just cleared". Everything else is nudge's shape: same role gate
 * (`canAssign`), same one-shot task through `dispatch`, same rule that the task
 * lands in the work's OWN thread rather than wherever the agent happens to be.
 *
 * Because the text IS client-authored here, the gate carries more weight than
 * it does for nudge: only an owner / global admin / admin of the target group
 * can reach it, the body is length-capped, and it is quoted into the prompt as
 * an attributed instruction from a named person rather than pasted as if the
 * system said it.
 *
 * Nothing here ever GUESSES a room — nudge's barge-in doctrine holds — but a
 * room that is already data is not a guess, and both callers have one:
 *
 * - **Claim with a thread** → post into it.
 * - **Claim with no thread** → the operator NAMES the room (`channel`), because
 *   a claim file carries no channel of its own. That anchors a real parent +
 *   thread (support-threads' postParent → createThread precedent) and RECORDS
 *   the new `thread_id` back onto the claim file, so the next steer, the next
 *   nudge and the board's own link all continue the same conversation.
 * - **Release-board item** → its room comes off the BOARD (`item.channel`,
 *   the same field assign routes by and the queue renders as its Room column),
 *   never off the request: the operator confirms the target in the composer,
 *   but a browser can never redirect the post. Only an item with no channel at
 *   all has nothing to aim at, and that is the one 409.
 *
 * The asymmetry that remains is honest and deliberate: an item has no file to
 * write a thread id back to, so its thread is returned in the response and not
 * persisted. See the `ponytail:` note at that branch.
 */
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

import { readClaims } from '../claims-board.js';
import { getChannelAdapter } from '../channels/channel-registry.js';
import { dispatch } from '../cli/dispatch.js';
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { claimsBaseDir } from '../modules/claims/escalation.js';
import { canAssign } from './assign.js';
import { readReleaseState, threadPermalink, threadPlatformId } from './api/observatory.js';
import type { AgentGroup } from '../types.js';
import type { AuthHandler } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Long enough for a paragraph of direction, short enough that nobody pastes a log into an agent's prompt. */
const MAX_TEXT = 2000;

// Double-click protection, NOT nudge's per-claim dedupe: an operator may
// legitimately steer the same claim twice in a minute, just never with the
// same words by accident. Keyed on the text, so a second thought goes through.
const SEND_DEDUPE_MS = 60 * 1000;
const recentSends = new Map<string, number>();

/** Test-only, same precedent as _resetNudgeDedupeForTesting. */
export function _resetSteerDedupeForTesting(): void {
  recentSends.clear();
}

/**
 * Serializes the resolve → open → claim window for ONE item, in this process.
 *
 * The `observatory_item_threads` PRIMARY KEY already guarantees one thread per
 * item: a losing insert is detectable (`changes === 0`) and its steer is
 * re-pointed at the winner. But by then the loser has ALREADY posted a parent
 * message to Slack, so the board stays right while the channel collects an
 * orphan thread nobody will ever answer in.
 *
 * ponytail: the host is a single Node process (see CLAUDE.md — it is the one
 * that serves this endpoint), so a keyed in-process lock is enough to make that
 * window atomic and costs eight lines. The PK behind it is what still holds if
 * a restart ever lands between two clicks — belt, then braces, in that order.
 * A cross-process host would need the claim-before-post dance instead.
 */
const itemThreadLocks = new Map<string, Promise<unknown>>();

async function withItemThreadLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const ahead = itemThreadLocks.get(key);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  itemThreadLocks.set(key, mine);
  // Never inherit a predecessor's failure — it queued behind us, it did not
  // poison us. Its own caller already saw the error.
  if (ahead) await ahead.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (itemThreadLocks.get(key) === mine) itemThreadLocks.delete(key);
  }
}

/** The thread an item's work already lives in, or null when nobody has opened one. */
export async function readItemThread(workgroupId: string, itemId: string): Promise<ItemThreadRow | null> {
  return (
    (await getDb().get<ItemThreadRow>(
      `SELECT thread_id, created_at, created_by
         FROM observatory_item_threads
        WHERE workgroup_id = ? AND item_id = ?`,
      workgroupId,
      itemId,
    )) ?? null
  );
}

export interface ItemThreadRow {
  thread_id: string;
  created_at: string;
  created_by: string;
}

/**
 * Claim this item's thread. Returns the thread that WON — ours if the insert
 * landed, the incumbent's if we lost the race — so the caller always has
 * somewhere real to post and never a second thread to apologise for.
 */
async function claimItemThread(workgroupId: string, itemId: string, threadId: string, userId: string): Promise<string> {
  const res = await getDb().run(
    `INSERT INTO observatory_item_threads (workgroup_id, item_id, thread_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workgroup_id, item_id) DO NOTHING`,
    workgroupId,
    itemId,
    threadId,
    new Date().toISOString(),
    userId,
  );
  if (res.changes > 0) return threadId;
  return (await readItemThread(workgroupId, itemId))?.thread_id ?? threadId;
}

/**
 * The wired messaging group behind a thread id — the same "an agent can only be
 * made to speak where it belongs" check the claim-with-a-thread branch runs.
 */
async function wiredGroupForThread(
  agentGroupId: string,
  threadId: string,
): Promise<{ id: string; name: string } | undefined> {
  return getDb().get<{ id: string; name: string }>(
    `SELECT mg.id, mg.name
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
      WHERE mga.agent_group_id = ? AND mg.platform_id = ?`,
    agentGroupId,
    await threadPlatformId(threadId),
  );
}

/** '#Qa-Room' / 'qa-room' → 'qa-room', for name matching. Assign's rule, same reason. */
const channelKey = (name: string): string => name.replace(/^#/, '').toLowerCase();

/**
 * Record a freshly-created thread onto the claim file, preserving every other
 * field — `claim.sh` owns this schema and writes the same flat JSON object, so
 * this only ever adds `thread_id`. Atomic (write-then-rename) because the
 * claim's own agent may be writing the file at the same moment, and a
 * half-written claim reads as a lost claim.
 *
 * Never throws: the thread is already real by the time this runs, so a failed
 * record-back is a degraded result to report, not a reason to fail the steer.
 */
export function recordClaimThread(
  workgroupId: string,
  slug: string,
  threadId: string,
  root: string = claimsBaseDir(),
): boolean {
  const file = path.join(root, workgroupId, 'claims', `${slug}.json`);
  try {
    const claim = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    // Re-read wins: if the owning agent backfilled a thread while we were
    // posting, theirs is the one the room is actually using.
    if (typeof claim['thread_id'] === 'string' && claim['thread_id']) return false;
    const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...claim, thread_id: threadId }, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log.warn('observatory steer: could not record thread on claim file', { workgroupId, slug, threadId, err });
    return false;
  }
}

/**
 * Anchor a real thread in one of this agent's wired rooms and return its
 * encoded id — the support-threads postParent → createThread precedent.
 *
 * One implementation for both callers on purpose: a claim opening its first
 * thread and a board item opening one differ only in what they call the thing,
 * and two copies of this would drift on the wiring check that keeps an agent
 * from being made to speak where it doesn't belong.
 */
async function openThreadFor(
  agentGroupId: string,
  channel: string,
  announcement: string,
  title: string,
  firstMessage: string,
): Promise<{ threadId: string; messagingGroupId: string } | { error: Response }> {
  const wired = await getDb().all<{ id: string; name: string; platform_id: string; channel_type: string }>(
    `SELECT mg.id, mg.name, mg.platform_id, mg.channel_type
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
      WHERE mga.agent_group_id = ?`,
    agentGroupId,
  );
  const target = wired.find((m) => channelKey(m.name) === channelKey(channel));
  if (!target) return { error: json(409, { error: 'agent_not_wired_to_channel', channel }) };

  const adapter = getChannelAdapter(target.channel_type);
  if (!adapter || typeof adapter.postParent !== 'function' || typeof adapter.createThread !== 'function') {
    return { error: json(409, { error: 'channel_cannot_open_threads', channel: target.name }) };
  }

  try {
    const { messageId } = await adapter.postParent(target.platform_id, announcement);
    const created = await adapter.createThread(target.platform_id, messageId, title.slice(0, 80), firstMessage);
    // chat-sdk routes on the ENCODED thread id (`<platform_id>:<thread>`);
    // createThread returns the bare one. Same normalization as
    // orchestrator-dispatch and support-threads.
    return {
      threadId: created.threadId.includes(':') ? created.threadId : `${target.platform_id}:${created.threadId}`,
      messagingGroupId: target.id,
    };
  } catch (err) {
    log.warn('observatory steer: could not open a thread', { channel: target.name, err });
    return { error: json(502, { error: 'thread_create_failed', channel: target.name }) };
  }
}

interface SteerBody {
  workgroupId?: string;
  agentGroupId?: string;
  claimSlug?: string;
  itemId?: string;
  text?: string;
  /** Room name (e.g. '#dispatch') — required ONLY to open a thread for a claim that has none. */
  channel?: string;
}

export const observatorySteerHandler: AuthHandler = async (req, _params, ctx) => {
  let body: SteerBody;
  try {
    body = (await req.json()) as SteerBody;
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const { workgroupId, agentGroupId, claimSlug, itemId } = body;
  if (!workgroupId || !agentGroupId || (!claimSlug && !itemId)) {
    return json(400, { error: 'workgroupId, agentGroupId and one of claimSlug/itemId are required' });
  }
  if (claimSlug && itemId) return json(400, { error: 'steer one thing at a time — claimSlug or itemId, not both' });

  const text = (body.text ?? '').trim();
  if (!text) return json(400, { error: 'empty_text' });
  if (text.length > MAX_TEXT) return json(400, { error: 'text_too_long', maxLength: MAX_TEXT });

  const role = await canAssign(ctx.user.id, agentGroupId);
  if (!role.ok) return json(role.reason === 'not_found' ? 404 : 403, { error: role.reason });

  const agent = await getDb().get<AgentGroup>(
    `SELECT * FROM agent_groups WHERE id = ? AND workgroup_id = ?`,
    agentGroupId,
    workgroupId,
  );
  if (!agent) return json(404, { error: 'agent_group_not_in_workgroup' });

  const targetId = claimSlug ?? itemId!;
  const dedupeKey = `${workgroupId}:${targetId}:${createHash('sha256').update(text).digest('hex')}`;
  const last = recentSends.get(dedupeKey);
  if (last && Date.now() - last < SEND_DEDUPE_MS) return json(429, { error: 'just_sent_that' });

  const who = ctx.user.display_name ?? ctx.user.id;

  // ── Resolve the thread this steer lands in ────────────────────────────────
  let threadId: string;
  let messagingGroupId: string;
  let subject: string;
  let threadCreated = false;
  let existing = false;
  let recordedOnClaim: boolean | null = null;

  if (itemId) {
    const item = (await readReleaseState(workgroupId))?.items.find((i) => i.id === itemId);
    if (!item) return json(404, { error: 'item_not_on_board' });
    subject = `the board item ${item.id} — "${item.title}"`;

    // One item, one thread. An item has no file of its own to write a thread id
    // back to (a claim does — see recordClaimThread), so `observatory_item_threads`
    // is that file: the FIRST steer opens the thread, every later one continues
    // it. Without this the board's one-click ship opened a second thread for the
    // same work on the second press, by anyone, and the agent got the same ask
    // twice in two places with no way to see the other.
    type Resolved = { error: Response } | { threadId: string; messagingGroupId: string; created: boolean };
    const resolved = await withItemThreadLock<Resolved>(`${workgroupId}:${itemId}`, async () => {
      const known = await readItemThread(workgroupId, itemId);
      if (known) {
        const target = await wiredGroupForThread(agentGroupId, known.thread_id);
        if (!target) return { error: json(409, { error: 'agent_not_wired_to_thread_channel' }) };
        return { threadId: known.thread_id, messagingGroupId: target.id, created: false };
      }

      // The item's room comes off the BOARD, not off the request — the operator
      // confirms it in the composer, but a browser can never redirect the post.
      // No channel is the one case with nothing to aim at.
      if (!item.channel) {
        return {
          error: json(409, {
            error: 'item_has_no_room',
            hint: 'the board records no room for this item — nothing to open a thread in',
          }),
        };
      }
      const opened = await openThreadFor(
        agentGroupId,
        item.channel,
        `${item.id} — steered from the Observatory by ${who}`,
        item.id,
        text,
      );
      if ('error' in opened) return { error: opened.error };
      // Claim it before returning. Under the lock this always wins in-process;
      // the ON CONFLICT is what covers a restart landing mid-window, and it
      // hands back the incumbent rather than the thread we just opened.
      const won = await claimItemThread(workgroupId, itemId, opened.threadId, ctx.user.id);
      if (won !== opened.threadId) {
        const target = await wiredGroupForThread(agentGroupId, won);
        if (!target) return { error: json(409, { error: 'agent_not_wired_to_thread_channel' }) };
        return { threadId: won, messagingGroupId: target.id, created: false };
      }
      return { threadId: opened.threadId, messagingGroupId: opened.messagingGroupId, created: true };
    });

    if ('error' in resolved) return resolved.error;
    threadId = resolved.threadId;
    messagingGroupId = resolved.messagingGroupId;
    threadCreated = resolved.created;
    existing = !resolved.created;
  } else {
    const claim = readClaims(workgroupId, Date.now()).find((c) => c.slug === claimSlug);
    if (!claim) return json(404, { error: 'claim_not_found' });
    subject = `the claim \`${claim.slug}\` (owner: ${claim.owner})`;

    if (claim.threadId) {
      // Same rule as nudge: an agent can only be made to speak where it belongs.
      const target = await getDb().get<{ id: string; name: string }>(
        `SELECT mg.id, mg.name
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mga.agent_group_id = ? AND mg.platform_id = ?`,
        agentGroupId,
        await threadPlatformId(claim.threadId),
      );
      if (!target) return json(409, { error: 'agent_not_wired_to_thread_channel' });
      threadId = claim.threadId;
      messagingGroupId = target.id;
    } else {
      if (!body.channel) {
        return json(409, {
          error: 'claim_has_no_thread',
          hint: 'name the room to open one — the server will not pick a channel for you',
        });
      }
      const opened = await openThreadFor(
        agentGroupId,
        body.channel,
        `${claim.slug} — steered from the Observatory by ${who}`,
        claim.slug,
        text,
      );
      if ('error' in opened) return opened.error;
      threadId = opened.threadId;
      messagingGroupId = opened.messagingGroupId;
      threadCreated = true;
      // Unlike an item, a claim HAS a file — so the thread we just opened becomes
      // its thread, and the next steer continues the conversation.
      recordedOnClaim = recordClaimThread(workgroupId, claim.slug, threadId);
    }
  }

  // ── The steer itself ──────────────────────────────────────────────────────
  const prompt =
    `${who} steered this from the Observatory — on ${subject}.\n\n` +
    `They said, verbatim:\n"""\n${text}\n"""\n\n` +
    `Act on that in THIS thread. If you cannot, say so here and name what blocks you — ` +
    `a steer that ends in silence is the failure this button exists to end.`;

  const res = await dispatch(
    {
      id: `steer-${Date.now()}`,
      command: 'tasks-create',
      args: {
        group: agentGroupId,
        name: `steer ${targetId}`,
        prompt,
        process_after: new Date().toISOString(),
        messaging_group: messagingGroupId,
        thread_id: threadId,
      },
    },
    { caller: 'host' },
  );

  if (!res.ok) {
    log.warn('observatory steer: task create failed', { targetId, agentGroupId, error: res });
    // A thread we just opened is real whether or not the task landed — say so
    // rather than letting the operator think nothing happened.
    return json(502, { error: 'task_create_failed', ...(threadCreated ? { threadId, threadCreated } : {}) });
  }

  recentSends.set(dedupeKey, Date.now());
  const seriesId = (res.data as { series_id?: string } | null | undefined)?.series_id ?? null;
  log.info('observatory steer', { userId: ctx.user.id, targetId, agentGroupId, threadCreated, existing, seriesId });
  return json(200, {
    ok: true,
    seriesId,
    threadId,
    threadUrl: await threadPermalink(threadId),
    threadCreated,
    // The board already had a thread for this item and we posted into it, not
    // a new one. The UI says so rather than reporting a fresh send.
    ...(existing ? { existing: true } : {}),
    ...(recordedOnClaim === null ? {} : { recordedOnClaim }),
  });
};
