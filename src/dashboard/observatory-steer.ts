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
 * Three thread outcomes, matching what each surface can honestly know:
 *
 * - **Claim with a thread** → post into it.
 * - **Claim with no thread** → the operator must NAME the room (`channel`).
 *   The server never picks one: nudge's comment is right that guessing a wired
 *   channel is a barge-in, and a claim file carries no channel of its own. A
 *   named room is a human decision, not a guess, so that case anchors a real
 *   parent + thread (support-threads' postParent → createThread precedent) and
 *   RECORDS the new `thread_id` back onto the claim file — the next steer, the
 *   next nudge and the board's own link all find it.
 * - **Release-board item** → 409 unless the board itself carries a thread.
 *   Items have no thread provenance at all (`ReleaseStateItem` has none, and
 *   the live board emits none), and inventing one is the barge-in again.
 */
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

import { readClaims } from '../claims-board.js';
import { getChannelAdapter } from '../channels/channel-registry.js';
import { dispatch } from '../cli/dispatch.js';
import { getDb } from '../db/index.js';
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

  const role = canAssign(ctx.user.id, agentGroupId);
  if (!role.ok) return json(role.reason === 'not_found' ? 404 : 403, { error: role.reason });

  const agent = getDb()
    .prepare(`SELECT * FROM agent_groups WHERE id = ? AND workgroup_id = ?`)
    .get(agentGroupId, workgroupId) as AgentGroup | undefined;
  if (!agent) return json(404, { error: 'agent_group_not_in_workgroup' });

  const targetId = claimSlug ?? itemId!;
  const dedupeKey = `${workgroupId}:${targetId}:${createHash('sha256').update(text).digest('hex')}`;
  const last = recentSends.get(dedupeKey);
  if (last && Date.now() - last < SEND_DEDUPE_MS) return json(429, { error: 'just_sent_that' });

  // ── Resolve the thread this steer lands in ────────────────────────────────
  let threadId: string;
  let messagingGroupId: string;
  let subject: string;
  let threadCreated = false;
  let recordedOnClaim: boolean | null = null;

  if (itemId) {
    const item = readReleaseState(workgroupId)?.items.find((i) => i.id === itemId);
    if (!item) return json(404, { error: 'item_not_on_board' });
    // The release board is the item's only thread provenance and it publishes
    // none. Assign is how an item gets a thread; steer will find it next time.
    return json(409, {
      error: 'item_has_no_thread',
      hint: 'release-board items carry no thread — assign it to an agent first, then steer the claim it opens',
    });
  }

  const claim = readClaims(workgroupId, Date.now()).find((c) => c.slug === claimSlug);
  if (!claim) return json(404, { error: 'claim_not_found' });
  subject = `the claim \`${claim.slug}\` (owner: ${claim.owner})`;

  if (claim.threadId) {
    // Same rule as nudge: an agent can only be made to speak where it belongs.
    const target = getDb()
      .prepare(
        `SELECT mg.id, mg.name
           FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mga.agent_group_id = ? AND mg.platform_id = ?`,
      )
      .get(agentGroupId, threadPlatformId(claim.threadId)) as { id: string; name: string } | undefined;
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
    const wired = getDb()
      .prepare(
        `SELECT mg.id, mg.name, mg.platform_id, mg.channel_type
           FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mga.agent_group_id = ?`,
      )
      .all(agentGroupId) as { id: string; name: string; platform_id: string; channel_type: string }[];
    const target = wired.find((m) => channelKey(m.name) === channelKey(body.channel!));
    if (!target) return json(409, { error: 'agent_not_wired_to_channel', channel: body.channel });

    const adapter = getChannelAdapter(target.channel_type);
    if (!adapter || typeof adapter.postParent !== 'function' || typeof adapter.createThread !== 'function') {
      return json(409, { error: 'channel_cannot_open_threads', channel: target.name });
    }

    const who = ctx.user.display_name ?? ctx.user.id;
    try {
      const { messageId } = await adapter.postParent(
        target.platform_id,
        `${claim.slug} — steered from the Observatory by ${who}`,
      );
      const created = await adapter.createThread(target.platform_id, messageId, claim.slug.slice(0, 80), text);
      // chat-sdk routes on the ENCODED thread id (`<platform_id>:<thread>`);
      // createThread returns the bare one. Same normalization as
      // orchestrator-dispatch and support-threads.
      threadId = created.threadId.includes(':') ? created.threadId : `${target.platform_id}:${created.threadId}`;
    } catch (err) {
      log.warn('observatory steer: could not open a thread', { claimSlug, channel: target.name, err });
      return json(502, { error: 'thread_create_failed', channel: target.name });
    }
    messagingGroupId = target.id;
    threadCreated = true;
    recordedOnClaim = recordClaimThread(workgroupId, claim.slug, threadId);
  }

  // ── The steer itself ──────────────────────────────────────────────────────
  const who = ctx.user.display_name ?? ctx.user.id;
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
  log.info('observatory steer', { userId: ctx.user.id, targetId, agentGroupId, threadCreated, seriesId });
  return json(200, {
    ok: true,
    seriesId,
    threadId,
    threadUrl: threadPermalink(threadId),
    threadCreated,
    ...(recordedOnClaim === null ? {} : { recordedOnClaim }),
  });
};
