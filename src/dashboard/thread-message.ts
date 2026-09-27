/**
 * `POST /dashboard/api/threads/:id/message`: the console's one primitive, which agent plus what text. Steer, push,
 * ship, assign and reassign differ only in whether the chosen agent already holds a session on the thread; if not,
 * one is resolved first.
 * It invents no privilege: every write goes through `applySessionSteer` with its gate, rate limit, idempotency and
 * echo. `canSteer` runs BEFORE resolving the session because resolving can CREATE a session row.
 * An agent must be wired to the thread's channel (resolved via `threadChannelKey`, which handles Discord's
 * `<platform>:<guild>:<channel>`). No thread is ever created here, so there is no duplicate-thread race to guard.
 * Hand-over notifies both sides: `claim.sh take` refuses a claim held `live` by another agent, so a hand-over also
 * sends the holder a SERVER-COMPOSED note to park or release (never free text: an agent receiving words the operator
 * did not address to it is the "who told you that?" shape). Only `live` triggers it; `expiring`, `stale` and `parked`
 * are already takeable.
 */
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { resolveSession } from '../session-manager.js';
import { readChannelDirectory, readClaimsByThread, threadChannelKey, wiredAgentsByChannel } from './api/threads.js';
import { ownerMatchesAgent } from './api/observatory.js';
import { applySessionSteer, canSteer } from './steer.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** `steer.ts`'s own cap; everything composed here must fit inside it. */
const EXECUTOR_TEXT_LIMIT = 4000;

/** None of the interpolated identities (display name, claim slug, holder) is capped at its source. */
const IDENTITY_MAX = 120;

/**
 * Lower than `steer.ts`'s cap because the text is quoted into a composed prompt plus hand-over context. MEASURED by
 * composing the worst case, so rewording the wrapper updates it.
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

interface ThreadAgent {
  agent_group_id: string;
  name: string;
  folder: string;
  session_id: string;
}

async function agentsOnThread(threadId: string): Promise<ThreadAgent[]> {
  return getDb().all<ThreadAgent>(
    `SELECT s.id AS session_id, ag.id AS agent_group_id, ag.name AS name, ag.folder AS folder
       FROM sessions s
       JOIN agent_groups ag ON ag.id = s.agent_group_id
      WHERE s.thread_id = ? AND s.status = 'active'
      ORDER BY COALESCE(s.last_outbound_at, s.last_active, s.created_at) DESC`,
    threadId,
  );
}

async function claimOnThread(agentGroupIds: string[], threadId: string, now: number, claimsRoot?: string) {
  return (await readClaimsByThread(agentGroupIds, now, claimsRoot)).get(threadId) ?? null;
}

/** The note the CURRENT holder gets. Server-composed, always. */
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
 * The operator's words, quoted verbatim and attributed to a named person, never paraphrased. The wrapper requires the
 * agent to name who sent it (so the room sees why it changed course) and forbids silence: an agent that cannot act
 * must say what blocks it.
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

/** Tells the receiving agent the claim is not free yet. */
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

  // Gate FIRST. Out of scope → 404.
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(agentGroupId)) {
    return { status: 404, body: { error: 'not_found' } };
  }
  if (!(await canSteer(ctx.user.id, agentGroupId)).ok) return { status: 404, body: { error: 'not_found' } };

  const onThread = await agentsOnThread(threadId);
  const target = onThread.find((a) => a.agent_group_id === agentGroupId) ?? null;

  let sessionId: string;
  let createdSession = false;
  if (target) {
    sessionId = target.session_id;
  } else {
    // An agent not wired to this thread's channel cannot be made to speak in it.
    const channelKey = threadChannelKey(threadId, (await readChannelDirectory()).known);
    const wired = (await wiredAgentsByChannel()).get(channelKey)?.find((a) => a.agent_group_id === agentGroupId);
    if (!wired) return { status: 409, body: { error: 'agent_not_wired_to_thread_channel', channel: channelKey } };
    // An operator chose this exact conversation; shared ingress wiring must not redirect it into a channel-wide or
    // agent-wide session.
    const resolved = await resolveSession(agentGroupId, wired.messaging_group_id, threadId, 'per-thread');
    if (
      resolved.session.thread_id !== threadId ||
      resolved.session.messaging_group_id !== wired.messaging_group_id ||
      resolved.session.agent_group_id !== agentGroupId
    )
      return { status: 409, body: { error: 'session_destination_mismatch' } };
    sessionId = resolved.session.id;
    createdSession = resolved.created;
  }

  const claim = await claimOnThread(
    [...new Set([agentGroupId, ...onThread.map((a) => a.agent_group_id)])],
    threadId,
    now,
    deps.claimsRoot,
  );
  const chosenName = target?.name ?? (await agentNameOf(agentGroupId));
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
      // The holder's note rides the SAME gate: if the operator may not steer the holder's group, it does not go and
      // the response says so.
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
      // True only when this send brought the agent onto the thread.
      created_session: createdSession,
      handoff,
    },
  };
}

async function agentNameOf(agentGroupId: string): Promise<string> {
  const row = await getDb().get<{ name: string }>('SELECT name FROM agent_groups WHERE id = ?', agentGroupId);
  return row?.name ?? agentGroupId;
}

export const threadMessageHandler: AuthHandler = async (req, params, ctx) => {
  // A client that percent-encodes `:` and `.` must work too.
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
