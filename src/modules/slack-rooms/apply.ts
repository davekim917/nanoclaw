/**
 * The two room-action bodies — what runs on ALLOW (a trusted global-scope
 * caller, a sibling add, or an approved replay).
 *
 * Slack side effects go through the adapter's narrow per-instance call surface
 * (`createConversation` / `inviteUsers` in src/channels/slack.ts): this module
 * names an instance and never holds a bot token.
 *
 * ROOM SHAPE. A room is ONE Slack private channel and N `messaging_groups`
 * rows — one per participating bot channel type, all carrying the same
 * `platform_id`. That is forced by the fork's routing key: an inbound event
 * arrives stamped with the receiving bot's own channel type, and the router
 * looks up `(channel_type, platform_id, instance)` exactly, so a room with one
 * shared row would be heard by exactly one bot. It is the same fan-out the
 * `slack-a2a-rooms` fallback script prints `ncl` commands for; this action
 * automates it.
 *
 * PRIVATE CHANNEL, NOT MPIM. Upstream opens an MPIM, and Slack never grows an
 * MPIM in place — every add forks a new conversation and re-wires everyone.
 * A private channel grows, so `add_to_room` invites into the SAME conversation
 * and only adds the newcomer's row. Upstream's "the room moved" notice has no
 * analogue here.
 *
 * PARTIAL FAILURE, and what create_room is allowed to adopt. Slack refuses a
 * second channel with the same name, so a run that creates the channel and
 * then fails leaves a state no retry can finish. Adoption is the repair — but
 * it keys on a MARKER, never on a name. A `slack_room_creations` row is
 * written the moment `conversations.create` returns and deleted once the room
 * is fully wired, so its presence means exactly "this caller created this
 * channel for this room name and did not finish". Adopting on a name match
 * instead would be unsound: a colliding channel may be an established room of
 * a sibling's, and adopting it turns a card promising a NEW private room into
 * a disclosure of an old one's history (migration 074 carries the same note).
 * A `name_taken` with no marker is therefore reported as the collision it is.
 */
import { createConversation, inviteUsers, isSlackNameTaken, setConversationPurpose } from '../../channels/slack.js';
import { resolveUnknownSenderPolicy } from '../../channels/channel-defaults.js';
import { insertOrAdopt } from '../../db/insert-or-adopt.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { pickApprover } from '../approvals/primitive.js';
import { resolveOperatorSlackUserId } from '../../slack-user-identity.js';
import { ROOM_PLATFORM_ID_KEY } from './guard.js';
import { RESOLVED_PARTICIPANTS_KEY, RESOLVED_ROOM_NAME_KEY } from './request.js';
import { RoomActionError, resolveRoomByPlatformId, roomKey, type RoomParticipant } from './resolve.js';
import { clearRoomCreation, findRoomCreation, recordRoomCreation } from './db.js';

function randomSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The Slack account to invite alongside the bots: the first approver who
 * belongs to the CALLER's workspace (PR 1's workspace-aware helper). Null when
 * nobody qualifies — the room is still created, holding bots only, and the
 * agent is told so rather than the whole action failing on a missing human.
 */
async function operatorSlackUserId(agentGroupId: string, callerChannelType: string): Promise<string | null> {
  return resolveOperatorSlackUserId(await pickApprover(agentGroupId), callerChannelType)?.slackUserId ?? null;
}

/**
 * One `messaging_groups` row for this bot on this conversation, plus its
 * wiring. Idempotent: an existing row is adopted, an existing wiring is left
 * alone, so a re-run after a partial failure completes instead of throwing.
 */
async function wireParticipant(
  participant: RoomParticipant,
  platformId: string,
  roomName: string,
): Promise<{ mg: MessagingGroup; wired: boolean }> {
  const candidate: MessagingGroup = {
    id: `mg-${randomSuffix()}`,
    channel_type: participant.channelType,
    platform_id: platformId,
    // The fork sets instance = channel_type everywhere; the router's lookup is
    // exact-on-instance, so a row stamped otherwise is never reached.
    instance: participant.channelType,
    name: roomName,
    is_group: 1,
    unknown_sender_policy: resolveUnknownSenderPolicy(participant.channelType, true, participant.channelType),
    denied_at: null,
    created_at: new Date().toISOString(),
  };
  const { row: mg } = await insertOrAdopt(candidate, createMessagingGroup, () =>
    getMessagingGroupByPlatform(participant.channelType, platformId, participant.channelType),
  );

  const existing = (await getMessagingGroupAgents(mg.id)).find((w) => w.agent_group_id === participant.agentGroupId);
  if (existing) return { mg, wired: false };

  const wiring: MessagingGroupAgent = {
    id: `mga-${randomSuffix()}`,
    messaging_group_id: mg.id,
    agent_group_id: participant.agentGroupId,
    // A room is a group conversation: agents engage on mention, and keep the
    // rest of the feed as context.
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    // Both flags are load-bearing and both differ from the `ncl wirings create`
    // fallbacks (shared/drop): `drop` discards the turns an agent was not
    // mentioned in, which is exactly the shared context a room exists for.
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: new Date().toISOString(),
  };
  await insertOrAdopt(wiring, createMessagingGroupAgent, async () =>
    (await getMessagingGroupAgents(mg.id)).find((w) => w.agent_group_id === participant.agentGroupId),
  );
  return { mg, wired: true };
}

// ── create_room ──

export async function handleCreateRoom(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = String(content.name);
  const purpose = typeof content.purpose === 'string' ? content.purpose : '';
  const participants = (content[RESOLVED_PARTICIPANTS_KEY] as RoomParticipant[] | undefined) ?? [];

  try {
    if (participants.length === 0) throw new RoomActionError('no participants resolved');
    const creator = participants[0]!;
    const operator = await operatorSlackUserId(session.agent_group_id, creator.channelType);

    // Resume only what THIS caller left unfinished under THIS name.
    const pending = await findRoomCreation(session.agent_group_id, roomKey(name));
    const adopted = Boolean(pending);
    const room = pending
      ? { channelId: pending.platform_id.slice('slack:'.length), name: pending.room_name }
      : await createConversation(creator.channelType, { name, isPrivate: true }).catch((err: unknown) => {
          if (!isSlackNameTaken(err)) throw err;
          throw new RoomActionError(
            `Slack already has a channel named "${name}", and it is not one this room left half-built. ` +
              `Adopting it would put everyone you named into that channel's existing history, so it is refused: ` +
              `pick a different name, or use add_to_room if that channel is already one of your rooms.`,
          );
        });

    const platformId = `slack:${room.channelId}`;
    // The marker goes in BEFORE any invite or wiring, so a failure anywhere
    // after this point is resumable and a failure before it left no channel.
    if (!pending) {
      await recordRoomCreation({
        platform_id: platformId,
        room_key: roomKey(name),
        room_name: room.name,
        agent_group_id: session.agent_group_id,
        request_id: typeof content.requestId === 'string' ? content.requestId : null,
        created_at: new Date().toISOString(),
      });
    }
    // Rows BEFORE invites: a channel that exists but is in no row is
    // unreachable by a retry, while a channel whose rows exist is adopted by
    // the branch above however far the invites got.
    for (const participant of participants) {
      await wireParticipant(participant, platformId, room.name);
    }

    const invitees = [
      ...participants.filter((p) => p.agentGroupId !== creator.agentGroupId).map((p) => p.botUserId),
      ...(operator ? [operator] : []),
    ];
    await inviteUsers(creator.channelType, room.channelId, invitees);
    // Best effort, and only on a room this call created — overwriting the
    // purpose of a room that already existed is not what "create" asked for.
    const purposeApplied = adopted ? false : await setConversationPurpose(creator.channelType, room.channelId, purpose);
    // Fully wired and invited — the room is no longer unfinished, so the
    // marker that authorized resuming it goes away.
    await clearRoomCreation(platformId);

    const members = participants.map((p) => p.agentGroupName).join(', ');
    const mentions = participants
      .filter((p) => p.agentGroupId !== session.agent_group_id)
      .map((p) => `<@${p.botUserId}>`)
      .join(' ');
    await notifyAgent(
      session,
      `Room "${room.name}" is live (${platformId}) with ${members}${operator ? ' and the operator' : ''}` +
        `${operator ? '' : ' — no approver with a Slack identity in your workspace was found, so it holds bots only'}` +
        `${adopted ? ' — an earlier attempt had already created it, and this run finished the wiring and invites' : ''}` +
        `${purpose && !purposeApplied && !adopted ? ' — Slack would not accept the purpose line, so the room has none' : ''}. ` +
        `Everyone is wired, so post a short introduction there now in your own voice, tagging each agent ` +
        `literally (${mentions}) — the tags render as mentions and are how you engage them in that room.`,
    );
    log.info('create_room completed', {
      platformId,
      roomName: room.name,
      adopted: Boolean(adopted),
      purposeApplied,
      participantCount: participants.length,
      agentGroupId: session.agent_group_id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await notifyAgent(session, `create_room failed: ${message}`);
    log.error('create_room failed', { name, agentGroupId: session.agent_group_id, err: message });
  }
}

// ── add_to_room ──

export async function handleAddToRoom(content: Record<string, unknown>, session: Session): Promise<void> {
  const platformId = String(content[ROOM_PLATFORM_ID_KEY] ?? '');
  const roomName = String(content[RESOLVED_ROOM_NAME_KEY] ?? content.room ?? '');
  const participants = (content[RESOLVED_PARTICIPANTS_KEY] as RoomParticipant[] | undefined) ?? [];

  try {
    const target = participants[1];
    // participants[0] is a bot already IN the room (resolve.ts::roomInviter),
    // which is not always the caller: a room wired only to a sibling is a
    // legitimate candidate, and the caller's own bot is not a member of it.
    const inviter = participants[0];
    if (!inviter || !target) throw new RoomActionError('participants were not resolved');

    // Re-read by ID, never by name: the approval bound to this conversation.
    const room = await resolveRoomByPlatformId(session.agent_group_id, platformId);
    if (room.rows.some((r) => (r.instance ?? r.channel_type) === target.channelType)) {
      await notifyAgent(session, `add_to_room: "${target.agentGroupName}" is already in room "${roomName}".`);
      return;
    }

    // conversations.invite only works from a member, so it goes out on the
    // inviter's bot.
    await inviteUsers(inviter.channelType, platformId.slice('slack:'.length), [target.botUserId]);
    await wireParticipant(target, platformId, room.name || roomName);

    await notifyAgent(
      session,
      `"${target.agentGroupName}" was added to room "${room.name || roomName}" (${platformId}) and is wired there. ` +
        `The room did not move — a Slack private channel grows in place. Post a one-line introduction of them ` +
        `there now, tagging <@${target.botUserId}> literally so the mention renders.`,
    );
    log.info('add_to_room completed', {
      platformId,
      addedAgentGroupId: target.agentGroupId,
      agentGroupId: session.agent_group_id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await notifyAgent(session, `add_to_room failed: ${message}`);
    log.error('add_to_room failed', { platformId, agentGroupId: session.agent_group_id, err: message });
  }
}
