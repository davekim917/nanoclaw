/**
 * Steer write path (`POST /dashboard/api/observatory/steer`): nudge's inverse, carrying a HUMAN's own text. Same role
 * gate (`canAssign`), same one-shot task, same rule that the task lands in the work's OWN thread. Because the text is
 * client-authored, it is length-capped and quoted as an attributed instruction from a named person.
 * Never guesses a room. A claim with a thread posts into it. A claim with no thread needs the operator to name
 * `channel`; the new thread id is recorded back onto the claim file. A release-board item's room comes off the BOARD
 * (`item.channel`), never off the request; an item with no channel is the one 409. An item has no file to record a
 * thread on, so `observatory_item_threads` holds it.
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
import { refuseUnassignableInWorkgroup } from './assign.js';
import { readReleaseState, threadPermalink, threadPlatformId } from './api/observatory.js';
import type { AuthHandler } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const MAX_TEXT = 2000;

// Double-click protection keyed on the text, not nudge's per-claim dedupe: steering the same claim twice with
// different words is legitimate.
const SEND_DEDUPE_MS = 60 * 1000;
const recentSends = new Map<string, number>();

export function _resetSteerDedupeForTesting(): void {
  recentSends.clear();
}

/**
 * Serializes resolve → open → claim for one item in this process. The PRIMARY KEY already guarantees one thread per
 * item, but a losing insert has by then posted an orphan parent message to Slack. The host is a single Node process,
 * so an in-process lock suffices; the PK still covers a restart mid-window.
 */
const itemThreadLocks = new Map<string, Promise<unknown>>();

export async function withItemThreadLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const ahead = itemThreadLocks.get(key);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  itemThreadLocks.set(key, mine);
  // Never inherit a predecessor's failure; its own caller saw the error.
  if (ahead) await ahead.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (itemThreadLocks.get(key) === mine) itemThreadLocks.delete(key);
  }
}

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

/** Returns the thread that WON (ours, or the incumbent's on a lost race), so the caller never has a second thread. */
export async function claimItemThread(
  workgroupId: string,
  itemId: string,
  threadId: string,
  userId: string,
): Promise<string> {
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

/** An agent can only be made to speak where it is wired. */
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

const channelKey = (name: string): string => name.replace(/^#/, '').toLowerCase();

/**
 * Adds only `thread_id`, preserving every other field (`claim.sh` owns the schema). Atomic write-then-rename because
 * the claim's agent may be writing the file concurrently, and a half-written claim reads as lost. Never throws: the
 * thread is already real.
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
    // Re-read wins: a thread the owning agent backfilled meanwhile is the one the room uses.
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
 * Anchors a real thread in one of this agent's wired rooms. One implementation for claims and items so the wiring
 * check cannot drift.
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
    // chat-sdk routes on the ENCODED thread id (`<platform_id>:<thread>`); createThread returns the bare one.
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
  /** Required ONLY to open a thread for a claim that has none. */
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

  const refusal = await refuseUnassignableInWorkgroup(ctx.user.id, agentGroupId, workgroupId);
  if (refusal) return refusal;

  const targetId = claimSlug ?? itemId!;
  const dedupeKey = `${workgroupId}:${targetId}:${createHash('sha256').update(text).digest('hex')}`;
  const last = recentSends.get(dedupeKey);
  if (last && Date.now() - last < SEND_DEDUPE_MS) return json(429, { error: 'just_sent_that' });

  const who = ctx.user.display_name ?? ctx.user.id;

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

    // One item, one thread: the first steer opens it and every later one continues it, rather than a second press
    // opening a duplicate thread for the same work.
    type Resolved = { error: Response } | { threadId: string; messagingGroupId: string; created: boolean };
    const resolved = await withItemThreadLock<Resolved>(`${workgroupId}:${itemId}`, async () => {
      const known = await readItemThread(workgroupId, itemId);
      if (known) {
        const target = await wiredGroupForThread(agentGroupId, known.thread_id);
        if (!target) return { error: json(409, { error: 'agent_not_wired_to_thread_channel' }) };
        return { threadId: known.thread_id, messagingGroupId: target.id, created: false };
      }

      // The room comes off the BOARD, never the request.
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
      // Under the lock this always wins in-process; ON CONFLICT covers a restart mid-window and hands back the
      // incumbent.
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
      recordedOnClaim = recordClaimThread(workgroupId, claim.slug, threadId);
    }
  }

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
    // A thread just opened is real whether or not the task landed; say so.
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
    // Posted into the item's existing thread, not a new one.
    ...(existing ? { existing: true } : {}),
    ...(recordedOnClaim === null ? {} : { recordedOnClaim }),
  });
};
