/**
 * `POST /dashboard/api/threads/:id/message` — the console's ONE primitive.
 *
 * Two parameters: which agent, what text. Steer, push-forward, ship, assign and
 * reassign are all this same action; the only difference is whether the chosen
 * agent already holds a session on the thread. When it does, this is exactly the
 * session-message path with the session looked up for you. When it does not,
 * this resolves one first — that, and nothing else, is what "assign" means here.
 *
 * **It invents no privilege.** Every write goes through `applySessionSteer`,
 * with the gate it already had (owner / global admin / admin of the target
 * group), its rate limit, its idempotency reservation and its platform echo.
 * The one thing this file adds is running `canSteer` *before* resolving the
 * session: resolving can CREATE a session row, and a caller who may not steer
 * must not be able to cause that side effect. Same gate, run earlier.
 *
 * ## Which room, and therefore which agents
 *
 * `observatory-steer.ts` already solved "deliver into a thread that may not have
 * a session", and this is that solution generalised off release-board items and
 * claim slugs onto plain threads:
 *
 *   - steer's `wiredGroupForThread` asks "is this agent wired to the channel
 *     this thread runs in?" and refuses when it is not. That rule is unchanged
 *     here — it is the whole reason a browser cannot make an agent speak in a
 *     room it does not belong to — but it is resolved through
 *     `wiredAgentsByChannel()`, whose channel key comes from
 *     `threadChannelKey()`. That parser knows Discord addresses a channel as
 *     `<platform>:<guild>:<channel>`, which steer's two-segment
 *     `threadPlatformId` does not.
 *   - steer OPENS a thread when the work has none (postParent → createThread).
 *     Nothing here ever does: a row in this queue IS a thread, so the room
 *     already exists and there is nothing to choose. That is why this needs no
 *     `channel` parameter, no `observatory_item_threads` claim and no
 *     in-process lock — the duplicate-thread race steer guards against cannot
 *     occur when no thread is being created.
 *
 * ## Hand-over notifies both sides
 *
 * `container/skills/work-claims/SKILL.md`: `take` REFUSES a claim held live by
 * another agent (exit 3). A parked or stale claim is free to take. So handing a
 * thread to a new agent while the incumbent still holds a live claim walks that
 * agent into a locked door, and the only key in reach is `--takeover`, which the
 * convention says "records an override; it does not make one correct".
 *
 * So a hand-over sends two messages: the operator's own text to the new agent
 * with the claim named, and a SERVER-COMPOSED note to the holder asking it to
 * park or release. The holder's note is never free text — the operator is
 * addressing one agent, and a second agent receiving words they did not write is
 * the shape of every "who told you that?" incident.
 *
 * `live` is the only state that triggers it, and that is not a rounding: the
 * board's `live` is precisely `now <= claimed_at + ttl_hours`, which is
 * precisely `claim.sh`'s exit-3 condition. `expiring` and `stale` are both
 * already takeable, and `parked` is explicitly free.
 */
import { getRawDb } from '../db/index.js';
import { log } from '../log.js';
import { resolveSession } from '../session-manager.js';
import { readChannelDirectory, readClaimsByThread, threadChannelKey, wiredAgentsByChannel } from './api/threads.js';
import { ownerMatchesAgent } from './api/observatory.js';
import { applySessionSteer, canSteer } from './steer.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** `steer.ts:146`'s own cap. Everything this file composes must still fit inside it. */
const EXECUTOR_TEXT_LIMIT = 4000;

/**
 * How long an interpolated identity is allowed to be — a display name, a claim
 * slug, a claim holder. None is capped at its source, so the budget is stated
 * rather than assumed.
 */
const IDENTITY_MAX = 120;

/**
 * Operator text cap. Lower than `steer.ts`'s own 4000 on purpose: the operator's
 * words are QUOTED into a composed prompt (see `composeOperatorMessage`) and a
 * hand-over appends the claim context on top, so a message that passes here must
 * still pass there rather than failing with a length error the operator cannot
 * account for.
 *
 * MEASURED, not hand-tuned: composing the worst case — every identity slot at
 * its budget, hand-over context present — is the only way to count the slots
 * without getting the count wrong. Reword the wrapper and this follows.
 */
export const MAX_OPERATOR_TEXT =
  EXECUTOR_TEXT_LIMIT -
  composeOperatorMessage({
    who: 'x'.repeat(IDENTITY_MAX),
    text: '',
    claimContext: composeClaimContext({
      who: 'x'.repeat(IDENTITY_MAX),
      claimSlug: 'x'.repeat(IDENTITY_MAX),
      holder: 'x'.repeat(IDENTITY_MAX),
    }),
  }).length;

interface ThreadMessageBody {
  agent_group_id?: string;
  idempotency_key?: string;
  text?: string;
}

/** The agent group a claim owner names, among the ones on this thread. */
interface ThreadAgent {
  agent_group_id: string;
  name: string;
  folder: string;
  session_id: string;
}

/** Active sessions on this thread, with the identity a claim owner is matched against. */
function agentsOnThread(threadId: string): ThreadAgent[] {
  return getRawDb()
    .prepare(
      `SELECT s.id AS session_id, ag.id AS agent_group_id, ag.name AS name, ag.folder AS folder
         FROM sessions s
         JOIN agent_groups ag ON ag.id = s.agent_group_id
        WHERE s.thread_id = ? AND s.status = 'active'
        ORDER BY COALESCE(s.last_outbound_at, s.last_active, s.created_at) DESC`,
    )
    .all(threadId) as ThreadAgent[];
}

/** The workgroup-scoped claim on this thread, if any. */
function claimOnThread(agentGroupIds: string[], threadId: string, now: number, claimsRoot?: string) {
  return readClaimsByThread(agentGroupIds, now, claimsRoot).get(threadId) ?? null;
}

/**
 * The note the CURRENT holder gets. Server-composed, always — see the file
 * header. It names what changed, who has it now, and the one action that keeps
 * the sanctioned path open.
 */
export function composeReleaseNote(opts: { who: string; newAgentName: string; claimSlug: string }): string {
  return (
    `Hand-over from the Observatory: ${opts.who} has handed the work on this thread to ${opts.newAgentName}.\n\n` +
    `You hold the live claim \`${opts.claimSlug}\` on it. Please park it ` +
    `(\`bash $CLAIM park ${opts.claimSlug} "handed to ${opts.newAgentName} from the Observatory"\`) ` +
    `if there is unfinished state worth reading, or release it if you are done. ` +
    `While it stays live their \`take\` refuses with exit 3, and \`--takeover\` only records an override — ` +
    `it does not make one correct.\n\n` +
    `Stop working this thread; ${opts.newAgentName} has it from here.`
  );
}

/**
 * The operator's words, wrapped — attributed on the way in, obliged to produce
 * an answer on the way out.
 *
 * Both halves are ported from the surfaces this one replaces, and neither is
 * decoration:
 *
 * - **Attribution.** `assign.ts:113` requires the agent's first message to name
 *   who sent it, so everyone in the room knows where an instruction came from
 *   without asking. Posting the operator's bare text loses that: the agent
 *   answers, and the room sees an agent that changed course for no visible
 *   reason.
 * - **The no-silence clause.** `nudge.ts` and `observatory-steer.ts` both close
 *   with it — an instruction that ends in silence is the failure the button
 *   exists to end. An agent that cannot act must say so HERE and name what
 *   blocks it; going quiet is not one of the options.
 *
 * The operator's own words are QUOTED verbatim and attributed to a named person,
 * exactly as `observatory-steer.ts:12-16` describes. Nothing here paraphrases,
 * summarises or replaces them — the wrapper is around the text, never over it.
 */
export function composeOperatorMessage(opts: { who: string; text: string; claimContext?: string }): string {
  return (
    `${opts.who} sent this from the Observatory console — on this thread.\n\n` +
    `They said, verbatim:\n"""\n${opts.text}\n"""\n` +
    (opts.claimContext ?? '') +
    `\n\nAct on that in THIS thread. Open your reply by naming where it came from — ` +
    `"${opts.who} asked, via the Observatory —" — so nobody in the room has to ask. ` +
    `If you cannot act on it, say so here and name what blocks you: ` +
    `a message from the Observatory that ends in silence is the failure this button exists to end.`
  );
}

/** What gets appended to the operator's text so the receiving agent knows the claim is not free yet. */
export function composeClaimContext(opts: { who: string; claimSlug: string; holder: string }): string {
  return (
    `\n\n---\nHanded to you from the Observatory by ${opts.who}. ` +
    `The claim \`${opts.claimSlug}\` on this thread is still held live by ${opts.holder}; ` +
    `they have been asked to park or release it. Wait for that and then \`take\` it — do not \`--takeover\`.`
  );
}

export interface ThreadMessageDeps {
  now?: number;
  claimsRoot?: string;
}

export async function sendThreadMessage(
  threadId: string,
  body: ThreadMessageBody,
  ctx: AuthedRequestContext,
  deps: ThreadMessageDeps = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const now = deps.now ?? Date.now();
  const agentGroupId = (body.agent_group_id ?? '').trim();
  const idempotencyKey = (body.idempotency_key ?? '').trim();
  const text = (body.text ?? '').trim();

  if (!threadId || !agentGroupId || !idempotencyKey) return { status: 400, body: { error: 'invalid_request' } };
  if (!text) return { status: 400, body: { error: 'empty_message' } };
  if (text.length > MAX_OPERATOR_TEXT) {
    return { status: 400, body: { error: 'message_too_long', max_length: MAX_OPERATOR_TEXT } };
  }

  // Gate FIRST — see the file header. §2a's disclose-as-not-found, same as
  // every other mutating handler on this surface.
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(agentGroupId)) {
    return { status: 404, body: { error: 'not_found' } };
  }
  if (!canSteer(ctx.user.id, agentGroupId).ok) return { status: 404, body: { error: 'not_found' } };

  const onThread = agentsOnThread(threadId);
  const target = onThread.find((a) => a.agent_group_id === agentGroupId) ?? null;

  let sessionId: string;
  let createdSession = false;
  if (target) {
    sessionId = target.session_id;
  } else {
    // Assign: the agent has never spoken here. Same wiring rule steer enforces —
    // an agent that is not wired to this thread's channel cannot be made to
    // speak in it, and a thread whose channel nothing names has no room at all.
    const channelKey = threadChannelKey(threadId, readChannelDirectory().known);
    const wired = wiredAgentsByChannel()
      .get(channelKey)
      ?.find((a) => a.agent_group_id === agentGroupId);
    if (!wired) return { status: 409, body: { error: 'agent_not_wired_to_thread_channel', channel: channelKey } };
    const resolved = await resolveSession(agentGroupId, wired.messaging_group_id, threadId, wired.session_mode);
    sessionId = resolved.session.id;
    createdSession = resolved.created;
  }

  // ── Hand-over (§4 of the action model) ────────────────────────────────────
  const claim = claimOnThread(
    [...new Set([agentGroupId, ...onThread.map((a) => a.agent_group_id)])],
    threadId,
    now,
    deps.claimsRoot,
  );
  const chosenName = target?.name ?? agentNameOf(agentGroupId);
  const holder =
    claim && claim.state === 'live'
      ? (onThread.find((a) => ownerMatchesAgent(claim.owner, { name: a.name, folder: a.folder })) ?? null)
      : null;
  const handingOver = !!claim && claim.state === 'live' && holder?.agent_group_id !== agentGroupId;

  const who = ctx.user.display_name ?? ctx.user.id;
  const outgoing = composeOperatorMessage({
    who,
    text,
    ...(handingOver && claim
      ? { claimContext: composeClaimContext({ who, claimSlug: claim.slug, holder: claim.owner }) }
      : {}),
  });

  const result = await applySessionSteer(sessionId, { idempotency_key: idempotencyKey, text: outgoing }, ctx);
  if (result.status !== 202) return result;

  let handoff: Record<string, unknown> | null = null;
  if (handingOver && claim) {
    let notified = false;
    if (holder) {
      // The holder's note rides the SAME gate — if this operator may not steer
      // the holder's group, the note simply does not go and the response says
      // so. Nothing here widens anything to make it go.
      const note = await applySessionSteer(
        holder.session_id,
        {
          idempotency_key: `${idempotencyKey}:release-note`,
          text: composeReleaseNote({ who, newAgentName: chosenName, claimSlug: claim.slug }),
        },
        ctx,
      );
      notified = note.status === 202;
      if (!notified) {
        log.warn('thread message: hand-over note to the claim holder did not land', {
          threadId,
          holder: holder.agent_group_id,
          status: note.status,
        });
      }
    }
    handoff = {
      claim_slug: claim.slug,
      claim_owner: claim.owner,
      holder_agent_group_id: holder?.agent_group_id ?? null,
      notified,
    };
  }

  log.info('thread message', {
    userId: ctx.user.id,
    threadId,
    agentGroupId,
    sessionId,
    createdSession,
    handedOver: handingOver,
  });
  return {
    status: 202,
    body: {
      ...result.body,
      thread_id: threadId,
      agent_group_id: agentGroupId,
      session_id: sessionId,
      // True only when this send is what brought the agent onto the thread.
      created_session: createdSession,
      handoff,
    },
  };
}

function agentNameOf(agentGroupId: string): string {
  const row = getRawDb().prepare('SELECT name FROM agent_groups WHERE id = ?').get(agentGroupId) as
    | { name: string }
    | undefined;
  return row?.name ?? agentGroupId;
}

export const threadMessageHandler: AuthHandler = async (req, params, ctx) => {
  // Thread ids carry `:` and `.`, both legal unencoded — but a client that
  // percent-encodes them must work too. Same rule as threadsDetailHandler.
  const raw = params['id'] ?? '';
  let threadId = raw;
  try {
    threadId = decodeURIComponent(raw);
  } catch {
    /* not percent-encoded — use it verbatim */
  }

  let body: ThreadMessageBody;
  try {
    body = (await req.json()) as ThreadMessageBody;
  } catch {
    return json(400, { error: 'invalid_request' });
  }

  try {
    const result = await sendThreadMessage(threadId, body, ctx);
    return json(result.status, result.body);
  } catch (err) {
    log.warn('threadMessageHandler: failed', { threadId, err });
    return json(500, { error: 'internal_error' });
  }
};
