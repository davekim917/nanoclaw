/**
 * request_choice — a non-blocking button card backed by the approvals primitive.
 *
 * The container's `request_choice` MCP tool writes a `request_choice` system
 * action and returns at once. This module turns it into a card with the
 * agent's own options as buttons, via requestApproval with deliveryTarget
 * 'thread':
 *
 *   - no `to`: into the session's own conversation and thread — the routing
 *     the container sees (session-manager.ts:600-617);
 *   - `to`: top-level in the named destination (the card IS the ask), after the
 *     host re-authorizes the container's routing (authorizedDestination).
 *
 * The card outlives the container. The pending_approvals row is central, and a
 * module approval row carries no expiry: the only writer of `expires_at` on one
 * is the reject-with-reason hold (src/db/sessions.ts:748-751), which a choice
 * card never enters. `approvers` narrows who may answer; `key` retires the agent
 * group's open card under the same key once the new one has posted ("replace,
 * never stack").
 *
 * An authorized click (approvals/choices.ts) reaches relayChoice, which writes
 * one host-marked line into the session a typed reply in the card's thread
 * would reach, and wakes it. What a value means, and who ought to answer, is
 * the agent's business; this module only carries the answer back.
 */
import type { OptionStyle, RawOption } from '../../channels/ask-question.js';
import { resolveThreadPolicy } from '../../channels/channel-defaults.js';
import { getChannelAdapter, getChannelDefaults } from '../../channels/channel-registry.js';
import { withCentralSync } from '../../db/central-lease.js';
import { getDb, hasTable } from '../../db/connection.js';
import {
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { getPendingApprovalByRequestId, getPendingApprovalsByAction } from '../../db/sessions.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { resolveSession, sessionMessageExists } from '../../session-manager.js';
import { isChannelVariant, type MessagingGroup, type PendingApproval, type Session } from '../../types.js';
import { registerChoiceHandler, retireChoice, type ChoiceHandlerContext } from '../approvals/choices.js';
import { notifyAgent, requestApprovalOutcome, type RequestApprovalOptions } from '../approvals/primitive.js';
import { parseReleaseShipScope, releaseShipScopeJson, type ReleaseShipScope } from '../approvals/release-ship-scope.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';
import { getUser } from '../permissions/db/users.js';

export const REQUEST_CHOICE_ACTION = 'request_choice';
export const MAX_CHOICE_OPTIONS = 10;
export const MAX_CHOICE_APPROVERS = 20;
export const SUPERSEDED_LINE = '↩️ Superseded by a newer ask';
/** The host-only event tag on a relayed answer (notifyAgent); the agent acts on nothing else. */
export const CHOICE_RESPONSE_EVENT = 'choice_response';
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const USER_ID_RE = /^[^:\s]+:\S+$/;
const OPTION_STYLES = new Set<unknown>(['primary', 'danger', 'default']);

export interface ChoiceRequest {
  choiceId: string;
  title: string;
  question: string;
  options: Array<{ label: string; value: string; style?: OptionStyle }>;
  /** Replace-never-stack key: a newer ask under the same key retires this one. */
  key?: string;
  /** Namespaced user ids allowed to answer; each must hold admin privilege on the group. */
  approvers?: string[];
  /** Routing the container resolved `to` into. Container-written, so re-authorized here. */
  target?: { name: string; channelType: string; platformId: string };
  /** Host-owned release authorization meaning; display/options are canonicalized below. */
  approvalScope?: ReleaseShipScope;
}

/**
 * Validate the container's payload. The MCP tool validates first; this is the
 * host's own check, since the outbound row is container-written.
 */
export function parseChoiceRequest(content: Record<string, unknown>): ChoiceRequest | { error: string } {
  const { choiceId, title, question, options, key, approvers, to, channelType, platformId, approvalScope } = content;
  if (typeof choiceId !== 'string' || !ID_RE.test(choiceId)) return { error: 'choiceId is missing or malformed' };
  const scope = approvalScope === undefined ? undefined : parseReleaseShipScope(approvalScope);
  if (approvalScope !== undefined && !scope) return { error: 'approvalScope is malformed' };
  const canonical = scope ? canonicalReleaseChoice(scope) : undefined;
  const genericTitle = typeof title === 'string' && title.trim() ? title : undefined;
  const genericQuestion = typeof question === 'string' && question.trim() ? question : undefined;
  if (!canonical && !genericTitle) return { error: 'title is required' };
  if (!canonical && !genericQuestion) return { error: 'question is required' };
  const parsed: ChoiceRequest['options'] = canonical?.options ?? [];
  if (!canonical) {
    if (!Array.isArray(options) || options.length < 1 || options.length > MAX_CHOICE_OPTIONS) {
      return { error: `options must hold 1 to ${MAX_CHOICE_OPTIONS} entries` };
    }
    const seen = new Set<string>();
    for (const raw of options as unknown[]) {
      const { label, value, style } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (typeof label !== 'string' || !label.trim()) return { error: 'every option needs a non-empty label' };
      if (typeof value !== 'string' || !value) return { error: `option "${label}" needs a non-empty value` };
      if (seen.has(value)) return { error: `option values must be unique ("${value}" repeats)` };
      if (style !== undefined && !OPTION_STYLES.has(style)) return { error: `option "${label}" has an unknown style` };
      seen.add(value);
      parsed.push({ label, value, ...(style !== undefined ? { style: style as OptionStyle } : {}) });
    }
  }
  if (key !== undefined && (typeof key !== 'string' || !ID_RE.test(key))) {
    return { error: 'key must be 1-128 characters of letters, digits and . _ : -' };
  }
  if (
    approvers !== undefined &&
    (!Array.isArray(approvers) ||
      approvers.length < 1 ||
      approvers.length > MAX_CHOICE_APPROVERS ||
      !approvers.every((a) => typeof a === 'string' && USER_ID_RE.test(a)))
  ) {
    return {
      error: `approvers must hold 1 to ${MAX_CHOICE_APPROVERS} namespaced user ids (<channel>:<user id>)`,
    };
  }
  let target: ChoiceRequest['target'];
  if (to !== undefined || channelType !== undefined || platformId !== undefined) {
    if (typeof to !== 'string' || !to || typeof channelType !== 'string' || typeof platformId !== 'string') {
      return { error: 'a destination needs to, channelType and platformId' };
    }
    target = { name: to, channelType, platformId };
  }
  return {
    choiceId,
    title: canonical?.title ?? genericTitle!,
    question: canonical?.question ?? genericQuestion!,
    options: parsed,
    ...(key !== undefined ? { key } : {}),
    ...(approvers !== undefined ? { approvers: [...new Set(approvers as string[])] } : {}),
    ...(target ? { target } : {}),
    ...(scope ? { approvalScope: scope } : {}),
  };
}

function canonicalReleaseChoice(scope: ReleaseShipScope): Pick<ChoiceRequest, 'title' | 'question' | 'options'> {
  return {
    title: `Release approval: ${scope.repository}#${scope.pullRequest}`,
    question: `Ship ${scope.repository}#${scope.pullRequest} from ${scope.base} at ${scope.headSha}?`,
    options: [
      { label: 'Ship', value: 'ship', style: 'primary' },
      { label: 'Hold', value: 'hold', style: 'danger' },
    ],
  };
}

async function handleRequestChoice(content: Record<string, unknown>, session: Session): Promise<void> {
  const request = parseChoiceRequest(content);
  if ('error' in request) {
    await notifyAgent(session, `request_choice failed: ${request.error}`);
    return;
  }

  // Refuse a choiceId reuse while the earlier card is still live. Without
  // this, two pending approvals could share one request_id: the reused card
  // review finding (choice_receipts keys on the host-minted approval_id
  // precisely so a reuse never collapses two receipts into one, but a
  // clicker can still be shown the wrong card's text if two cards answer to
  // the same id — refusing the second ask up front is the cheaper fix).
  // Scoped globally, not per agent group: a compromised agent's own group is
  // sufficient to create the collision either way.
  //
  // This read is the FAST PATH, not the guarantee. It and the insert inside
  // requestApprovalOutcome are separated by every await below — approver
  // validation, destination authorization — and delivery is excluded per
  // session (src/delivery.ts `inflightDeliveries`, keyed on session.id), so
  // two sessions of this agent group can both read "nothing pending" here.
  // The guarantee is migration 078's partial unique index, honoured as
  // 'duplicate-request' at the insert; this check only saves the work when
  // the reuse is plain rather than racing.
  if (await getPendingApprovalByRequestId(request.choiceId)) {
    log.warn('request_choice refused: choiceId already has a pending approval', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      choiceId: request.choiceId,
    });
    await notifyAgent(session, duplicateChoiceRefusal(request.choiceId));
    return;
  }

  // Narrow, never widen: every named approver must already be allowed to answer.
  if (request.approvers) {
    const outsider = await withCentralSync(
      () => request.approvers!.find((userId) => !hasAdminPrivilege(userId, session.agent_group_id)),
      'request_choice approvers',
    );
    if (outsider !== undefined) {
      await notifyAgent(
        session,
        `request_choice failed: approver "${outsider}" is not an owner or admin of this agent group.`,
      );
      return;
    }
  }

  let conversation: RequestApprovalOptions['conversation'];
  if (request.target) {
    const mg = await authorizedDestination(session, request.target.channelType, request.target.platformId);
    if (!mg) {
      log.warn('request_choice refused: not one of the agent group’s destinations', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        channelType: request.target.channelType,
        platformId: request.target.platformId,
      });
      await notifyAgent(session, `request_choice failed: "${request.target.name}" is not one of your destinations.`);
      return;
    }
    // Top-level in the destination: the card is the ask, and replies thread under it.
    conversation = { channelType: mg.channel_type, platformId: mg.platform_id, threadId: null, instance: mg.instance };
  }

  const options: RawOption[] = request.options.map((o) => ({
    label: o.label,
    value: o.value,
    ...(o.style ? { style: o.style } : {}),
  }));
  // Delivery failures notify the agent from inside requestApprovalOutcome;
  // a lost reservation does not, because only this module knows what a
  // reused choiceId means — so it gets the same refusal as the fast path.
  const outcome = await requestApprovalOutcome({
    session,
    agentName: session.agent_group_id,
    action: REQUEST_CHOICE_ACTION,
    requestId: request.choiceId,
    payload: {
      choiceId: request.choiceId,
      ...(request.key !== undefined ? { key: request.key } : {}),
      ...(request.approvers ? { approvers: request.approvers } : {}),
      ...(request.approvalScope ? { approvalScope: request.approvalScope } : {}),
    },
    title: request.title,
    question: request.question,
    deliveryTarget: 'thread',
    conversation,
    options,
  });

  if (outcome === 'duplicate-request') {
    log.warn('request_choice refused: choiceId lost the reservation to a concurrent ask', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      choiceId: request.choiceId,
    });
    await notifyAgent(session, duplicateChoiceRefusal(request.choiceId));
    return;
  }

  // Post first, then retire: an ask that failed to post leaves the old card live.
  if (outcome === 'posted' && request.key !== undefined) {
    const own = await getPendingApprovalByRequestId(request.choiceId);
    // Gone already means a newer same-key ask retired it: nothing older to retire.
    if (own) await supersedeOpenChoices(session.agent_group_id, request.key, own);
  }
}

/**
 * The refusal for a choiceId that is already live. One wording for both the
 * fast-path read and the lost reservation, so an agent cannot tell a race
 * from a plain reuse — there is nothing it could usefully do differently.
 */
function duplicateChoiceRefusal(choiceId: string): string {
  return `request_choice failed: choiceId "${choiceId}" already has a pending answer.`;
}

/**
 * The messaging group a container-resolved destination names, if this agent
 * group may post there — the check an ordinary outbound message gets
 * (delivery.ts:1127-1156): resolve the group origin-first, then allow the
 * session's own chat, and require an agent_destinations channel row for any
 * other (skipped, as there, when the agent-to-agent module's table is absent).
 */
async function authorizedDestination(
  session: Session,
  channelType: string,
  platformId: string,
): Promise<MessagingGroup | undefined> {
  const originMg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const mg =
    originMg && originMg.channel_type === channelType && originMg.platform_id === platformId
      ? originMg
      : await getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) return undefined;
  if (session.messaging_group_id === mg.id || !(await hasTable(getDb(), 'agent_destinations'))) return mg;
  const row = await getDb().get(
    'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
    session.agent_group_id,
    'channel',
    mg.id,
  );
  return row ? mg : undefined;
}

/**
 * Replace, never stack: retire every open request_choice card this agent
 * group posted under `key` BEFORE `newest` (createdBefore), so the newest card
 * always survives. Two same-key asks from different sessions of one group can
 * be handled at the same time — the active poll (delivery.ts:521-524) and the
 * sweep (delivery.ts:896-905) are separate loops — and "everything but my own
 * row" let each retire the other, leaving no card open.
 *
 * The key lives in the row's payload JSON, not a column of its own: open
 * choice cards per group are few, getPendingApprovalsByAction already narrows
 * to this action (indexed by idx_pending_approvals_action_status), filtering in
 * JS keeps the query portable (no json_extract), and a column would be schema
 * for one action.
 */
async function supersedeOpenChoices(agentGroupId: string, key: string, newest: PendingApproval): Promise<void> {
  for (const row of await getPendingApprovalsByAction(REQUEST_CHOICE_ACTION)) {
    if (row.status !== 'pending' || row.agent_group_id !== agentGroupId || !createdBefore(row, newest)) continue;
    if (payloadKey(row) !== key) continue;
    if (await retireChoice(row, SUPERSEDED_LINE)) {
      log.info('Choice superseded by a newer ask', { approvalId: row.approval_id, agentGroupId, key });
    }
  }
}

/** Strictly earlier: created_at (ISO, so string order is time order), then approval_id to break a tie. */
function createdBefore(row: PendingApproval, newest: PendingApproval): boolean {
  if (row.created_at !== newest.created_at) return row.created_at < newest.created_at;
  return row.approval_id < newest.approval_id;
}

function payloadKey(row: PendingApproval): string | undefined {
  try {
    const key = (JSON.parse(row.payload) as { key?: unknown }).key;
    return typeof key === 'string' ? key : undefined;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a corrupt payload has no key to match
  } catch {
    return undefined;
  }
}

/**
 * The session a typed reply in the card's thread would reach, resolved as the
 * router resolves one — thread policy (router.ts:955-983), per-thread
 * promotion (router.ts:1248-1251), then resolveSession (router.ts:1331-1336),
 * which creates the session when absent. So a click behaves like a reply in
 * the ask's thread and lands where that conversation already lives.
 * Undefined when the card's channel is not wired to the agent group (a
 * destination only), and the caller falls back to the requester.
 */
async function cardConversationSession(
  approval: PendingApproval,
  requester: Session | undefined,
): Promise<Session | undefined> {
  const agentGroupId = approval.agent_group_id ?? requester?.agent_group_id;
  if (!agentGroupId || !approval.channel_type || !approval.platform_id) return undefined;
  const originMg = requester?.messaging_group_id ? await getMessagingGroup(requester.messaging_group_id) : undefined;
  const mg =
    originMg && originMg.channel_type === approval.channel_type && originMg.platform_id === approval.platform_id
      ? originMg
      : await getMessagingGroupByPlatform(approval.channel_type, approval.platform_id, approval.instance ?? undefined);
  if (!mg) return undefined;
  const wiring = await getMessagingGroupAgentByPair(mg.id, agentGroupId);
  if (!wiring) return undefined;

  const adapterKey = mg.instance ?? mg.channel_type;
  const threadsEnabled = resolveThreadPolicy(
    wiring.threads ?? null,
    getChannelDefaults(adapterKey, mg.channel_type),
    mg.is_group === 1,
    getChannelAdapter(adapterKey)?.supportsThreads === true,
  );
  let sessionMode = wiring.session_mode;
  if (threadsEnabled && sessionMode !== 'agent-shared' && mg.is_group !== 0) sessionMode = 'per-thread';
  const threadId = threadsEnabled ? (approval.thread_id ?? replyThreadId(mg, approval.platform_message_id)) : null;
  const { session } = await resolveSession(agentGroupId, mg.id, threadId, sessionMode);
  return session;
}

/**
 * Thread id of a reply in the thread under message `messageId` on `mg`'s
 * channel. Slack only: the adapter encodes a thread as `slack:<channel>:<ts>`
 * (@chat-adapter/slack 4.29.0, dist/index.js:3767-3769) and the messaging
 * group stores the channel-root id `slack:<channel>` (chat-sdk-bridge.ts:1010-1016),
 * the composition router.ts:494-495 already uses for root DMs. A card's
 * platform_message_id is its Slack ts: the bridge returns postMessage's id
 * (chat-sdk-bridge.ts:1385-1389), which is chat.postMessage's `ts`
 * (dist/index.js:2844-2848). Elsewhere: null, where a channel-root reply lands.
 */
function replyThreadId(mg: MessagingGroup, messageId: string | null): string | null {
  // Same predicate as isSlackChannelType (router.ts:444-448); router.ts imports module code, so not imported here.
  const slack = mg.channel_type === 'slack' || isChannelVariant(mg.channel_type, 'slack');
  if (!messageId || !slack || !mg.platform_id.startsWith('slack:')) return null;
  return `${mg.platform_id}:${messageId}`;
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The line the agent receives:
 *
 *   choice_response choice_id=<id> approval_id=<aid> value=<v> label=<l> user_id=<id> user_name=<n>
 *   [release_scope=<canonical-json>]
 *
 * Fixed key order, every value percent-encoded with encodeURIComponent, so it
 * stays one line whatever a label or name contains, and it reaches the model
 * unchanged: the runner XML-escapes chat text (& < > ", formatter.ts:716-718
 * in container/agent-runner/src), and encodeURIComponent output contains none
 * of those. Lone surrogates, which encodeURIComponent throws on, become U+FFFD.
 * Anyone can type this line, and a host note can echo text it was sent, so the
 * agent trusts it only inside a message the runner marks origin="host" AND
 * event="choice_response" (notifyAgent with CHOICE_RESPONSE_EVENT).
 *
 * `approval_id` is the host-minted id `choice_receipts` (migration 077) keys
 * on — `choice_id` alone is agent-chosen and not unique, so an agent that
 * wants to cite the durable receipt for this answer needs the approval id,
 * not just the choice id. Scoped release cards append `release_scope`, but
 * only after the host has re-validated the pending row's saved payload. It is
 * an encoded copy of the host-canonical JSON, not agent-supplied display text.
 */
export function formatChoiceResponse(fields: {
  choiceId: string;
  approvalId: string;
  value: string;
  label: string;
  userId: string;
  userName: string | null;
  /** Host-validated canonical JSON for a release_ship card; omitted for generic cards. */
  releaseScope?: string;
}): string {
  const pairs: Array<[string, string]> = [
    ['choice_id', fields.choiceId],
    ['approval_id', fields.approvalId],
    ['value', fields.value],
    ['label', fields.label],
    ['user_id', fields.userId],
    ['user_name', fields.userName ?? ''],
  ];
  // Keep the generic response byte-for-byte compatible for existing parsers.
  if (fields.releaseScope !== undefined) pairs.push(['release_scope', fields.releaseScope]);
  const encode = (v: string): string => encodeURIComponent(v.replace(LONE_SURROGATE_RE, '�'));
  return ['choice_response', ...pairs.map(([k, v]) => `${k}=${encode(v)}`)].join(' ');
}

/** A corrupt pending payload can never add scope to a host-origin response. */
function responseReleaseScope(approval: PendingApproval): string | undefined {
  try {
    const payload = JSON.parse(approval.payload) as { approvalScope?: unknown };
    const scope = parseReleaseShipScope(payload.approvalScope);
    return scope ? releaseShipScopeJson(scope) : undefined;
    // eslint-disable-next-line no-catch-all/no-catch-all -- malformed stored payload must remain unscoped
  } catch {
    return undefined;
  }
}

async function relayChoice(ctx: ChoiceHandlerContext): Promise<Session | null> {
  const target = (await cardConversationSession(ctx.approval, ctx.requester)) ?? ctx.requester;
  if (!target) return null;
  // The click reaches the host without the platform's display name
  // (ResponsePayload, src/response-registry.ts:15-28), so the name comes from
  // the clicker's users row — an authorized clicker holds a user_roles row,
  // which references users(id) (src/db/schema.ts:88-89).
  const user = await getUser(ctx.userId);
  const id = `choice-answer-${ctx.approval.approval_id}`;
  try {
    await notifyAgent(
      target,
      formatChoiceResponse({
        choiceId: ctx.approval.request_id,
        approvalId: ctx.approval.approval_id,
        value: ctx.value,
        label: ctx.label,
        userId: ctx.userId,
        userName: user?.display_name ?? null,
        releaseScope: responseReleaseScope(ctx.approval),
      }),
      { id, event: CHOICE_RESPONSE_EVENT },
    );
  } catch (err) {
    // notifyAgent inserts the row, then reads the session back and wakes it
    // (primitive.ts). A failure after the insert still leaves a due row, and
    // the sweep wakes a session with due rows (sweep-scheduling/index.ts:76,
    // sweep-continuation/index.ts:674) — so a recorded answer is delivered.
    // Only an unrecorded one may reopen the card (ChoiceHandler contract).
    if (await sessionMessageExists(target.agent_group_id, target.id, id)) {
      log.warn('Choice answer recorded but the wake failed — the sweep will wake the session', {
        approvalId: ctx.approval.approval_id,
        sessionId: target.id,
        err,
      });
      return target;
    }
    throw err;
  }
  return target;
}

registerDeliveryAction(
  REQUEST_CHOICE_ACTION,
  handleRequestChoice,
  unguarded(
    "posts a card into the session's own conversation or an agent_destinations channel re-checked here, as a chat message would; who may answer is enforced at click time (admin privilege, approvals/choices.ts)",
  ),
);
registerChoiceHandler(REQUEST_CHOICE_ACTION, relayChoice);
