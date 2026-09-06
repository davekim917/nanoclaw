/**
 * Prechecks and hold builders for the two room actions.
 *
 * THE PRECHECK IS ALSO THE RESOLVER. `runGuarded` (src/delivery-guard.ts) runs
 * `precheck` before the guard and before the handler, on a fresh dispatch AND
 * on an approved replay, and it hands the SAME `content` object to all three.
 * That is the seam this module uses to keep the guard's `decide` synchronous:
 * every fact the decision needs but cannot await — which agent group a name
 * resolves to, which workgroup each side belongs to, which Slack conversation
 * a room name means — is derived here and stamped onto `content`.
 *
 * Two consequences worth stating plainly, because they are the whole security
 * argument:
 *
 *  1. The stamped authorization facts are re-derived on every run, so an
 *     approved replay is checked against LIVE state. A sibling relationship
 *     revoked while the card sat unanswered demotes the decision back to a
 *     hold; a destination repointed at a different agent group fails
 *     `grantCoversRequest` and the replay denies.
 *  2. The room identity is the deliberate exception (case 12): a stamped
 *     `room_platform_id` is validated, never re-resolved from the name. It is
 *     still validated against the caller's live candidate set, which is also
 *     why accepting a caller-supplied channel id is safe — the id skips name
 *     resolution, never authorization.
 *
 * A precheck failure answers the requesting agent and returns false, so a
 * malformed, unresolvable, ambiguous or cross-workspace request never becomes
 * an approval card an admin has to read.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import {
  ADD_TO_ROOM_ACTION,
  CALLER_WORKGROUP_KEY,
  CREATE_ROOM_ACTION,
  ROOM_PLATFORM_ID_KEY,
  TARGET_AGENT_GROUP_KEY,
  TARGET_WORKGROUP_KEY,
} from './guard.js';
import {
  RoomActionError,
  assertSameWorkspace,
  callerParticipant,
  participantForAgentGroup,
  resolveAgentByName,
  parseSlackChannelId,
  resolveRoomByName,
  resolveRoomByPlatformId,
  roomInviter,
  type CandidateRoom,
  type RoomParticipant,
} from './resolve.js';

/** Keys the prechecks stamp for the guard, the card and the handler. */
export const RESOLVED_PARTICIPANTS_KEY = 'resolved_participants';
export const RESOLVED_ROOM_NAME_KEY = 'room_name';

/** `workgroup_id` falls back to `folder` — the fork's workgroup identity for a
 *  standalone group, and the expression `assertSameWorkgroupWiring` compares. */
function workgroupOf(group: AgentGroup): string {
  return group.workgroup_id ?? group.folder;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Report a domain refusal to the requesting agent; anything else is a bug. */
async function refuse(session: Session, action: string, err: unknown): Promise<false> {
  if (err instanceof RoomActionError) {
    await notifyAgent(session, `${action} failed: ${err.message}`);
    return false;
  }
  log.error(`${action} precheck threw`, { sessionId: session.id, err });
  await notifyAgent(session, `${action} failed: ${err instanceof Error ? err.message : String(err)}`);
  return false;
}

// ── create_room ──

export async function validateCreateRoom(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const name = trimmed(content.name);
  if (!name) {
    await notifyAgent(session, 'create_room failed: name is required.');
    return false;
  }
  const agents = Array.isArray(content.agents) ? content.agents.map(trimmed).filter(Boolean) : [];
  if (agents.length === 0) {
    await notifyAgent(session, 'create_room failed: agents must be a non-empty list of agent names.');
    return false;
  }

  try {
    const caller = await callerParticipant(session);
    const callerGroup = await getAgentGroup(session.agent_group_id);
    if (!callerGroup) throw new RoomActionError('source agent group not found');

    const participants: RoomParticipant[] = [caller];
    const seen = new Set<string>([caller.agentGroupId]);
    for (const agentName of agents) {
      const group = await resolveAgentByName(session.agent_group_id, agentName);
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      participants.push(await participantForAgentGroup(group, caller.teamId));
    }
    // Before any Slack call: a roster spanning two workspaces cannot become
    // one conversation, and Slack's own error would name neither side.
    assertSameWorkspace(participants);

    content.name = name;
    content.agents = agents;
    content[CALLER_WORKGROUP_KEY] = workgroupOf(callerGroup);
    content[RESOLVED_PARTICIPANTS_KEY] = participants;
    return true;
  } catch (err) {
    return refuse(session, 'create_room', err);
  }
}

export async function requestCreateRoomHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;
  const name = trimmed(content.name);
  const participants = (content[RESOLVED_PARTICIPANTS_KEY] as RoomParticipant[] | undefined) ?? [];
  const members = participants.map((p) => p.agentGroupName).join(', ');

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: CREATE_ROOM_ACTION,
    // The card's payload is the tool call, not the resolution: the approved
    // replay re-enters the same entry and the precheck re-derives everything
    // against live state.
    payload: {
      name,
      agents: content.agents,
      ...(trimmed(content.purpose) ? { purpose: trimmed(content.purpose) } : {}),
      requestId: content.requestId ?? null,
    },
    title: `Create Slack room: ${name}`,
    question:
      `Agent "${sourceGroup.name}" wants to open a private Slack room "${name}" holding you and ${members}. ` +
      `Approving creates a Slack channel on ${sourceGroup.name}'s own bot token, invites each listed agent's ` +
      `bot user plus your Slack account, and wires the room to every participating agent group so they can ` +
      `all read and post there. Approve only if you asked for this — an agent can be talked into opening a ` +
      `room by anything it reads.`,
  });
}

// ── add_to_room ──

export async function validateAddToRoom(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const roomArg = trimmed(content.room);
  const agentArg = trimmed(content.agent);
  const stampedRoomId = trimmed(content[ROOM_PLATFORM_ID_KEY]);
  if (!roomArg && !stampedRoomId) {
    await notifyAgent(session, 'add_to_room failed: room is required.');
    return false;
  }
  if (!agentArg) {
    await notifyAgent(session, 'add_to_room failed: agent is required.');
    return false;
  }

  try {
    const callerGroup = await getAgentGroup(session.agent_group_id);
    if (!callerGroup) throw new RoomActionError('source agent group not found');

    // Three ways to name the room, all landing on the same candidate-set
    // check. A stamped id is case 12 (an approved replay binds to the room
    // that was carded, never to the name). An id in the PUBLIC `room`
    // argument is the recovery the ambiguity error itself prescribes — it is
    // the only field the tool emits, so refusing it there would make that
    // advice impossible to follow. Otherwise the name resolves.
    const suppliedId = stampedRoomId || parseSlackChannelId(roomArg);
    const room: CandidateRoom = suppliedId
      ? await resolveRoomByPlatformId(session.agent_group_id, suppliedId)
      : await resolveRoomByName(session.agent_group_id, roomArg);

    // The INVITER is a bot already in that room, not necessarily the caller:
    // a room reaches the candidate set when it is wired to the caller OR to a
    // sibling, and siblings keep separate bot identities, so sharing a
    // workgroup never implies sharing channel membership. The room's
    // workspace, not the caller's, is therefore what the newcomer must match.
    const inviter = roomInviter(room, session.agent_group_id);
    const targetGroup = await resolveAgentByName(session.agent_group_id, agentArg);
    const target = await participantForAgentGroup(targetGroup, inviter.teamId);
    assertSameWorkspace([inviter, target]);

    content.room = roomArg || room.name;
    content.agent = agentArg;
    content[CALLER_WORKGROUP_KEY] = workgroupOf(callerGroup);
    content[TARGET_AGENT_GROUP_KEY] = targetGroup.id;
    content[TARGET_WORKGROUP_KEY] = workgroupOf(targetGroup);
    content[ROOM_PLATFORM_ID_KEY] = room.platformId;
    content[RESOLVED_ROOM_NAME_KEY] = room.name;
    content[RESOLVED_PARTICIPANTS_KEY] = [inviter, target];
    return true;
  } catch (err) {
    return refuse(session, 'add_to_room', err);
  }
}

export async function requestAddToRoomHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;
  const agent = trimmed(content.agent);
  const roomName = trimmed(content[RESOLVED_ROOM_NAME_KEY]) || trimmed(content.room);
  const platformId = trimmed(content[ROOM_PLATFORM_ID_KEY]);

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: ADD_TO_ROOM_ACTION,
    // The resolved room id and target agent group travel on the card so the
    // approval binds to them (guard.grantCoversRequest). The name does not
    // bind: it is here for the reader, not for the check.
    payload: {
      room: content.room,
      agent,
      [ROOM_PLATFORM_ID_KEY]: platformId,
      [TARGET_AGENT_GROUP_KEY]: content[TARGET_AGENT_GROUP_KEY],
      [RESOLVED_ROOM_NAME_KEY]: roomName,
      requestId: content.requestId ?? null,
    },
    title: `Add ${agent} to Slack room: ${roomName}`,
    question:
      `Agent "${sourceGroup.name}" wants to add agent "${agent}" to the Slack room "${roomName}" ` +
      `(${platformId}). "${agent}" is outside "${sourceGroup.name}"'s workgroup, so approving lets it read ` +
      `everything posted in that room from now on. Approve only if you asked for this.`,
  });
}
