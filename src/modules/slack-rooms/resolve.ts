/**
 * Name → thing resolution for the room actions, and the two refusals that
 * must happen before any Slack call.
 *
 * Everything here is pure-ish domain logic over the DB and the in-memory Slack
 * bot registry; nothing in this file talks to Slack. That split is deliberate:
 * the guard's decision and the approval card are built from these results, so
 * they must be derivable without a network round trip.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup, getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getKnownSlackBots, type SlackBotIdentity } from '../../channels/slack-mentions.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { getDestinationByName, normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import { getCandidateRoomRows } from './db.js';

/** Domain failure with an agent-presentable message. Never carries a token. */
export class RoomActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomActionError';
  }
}

/** One agent group's Slack presence: which bot speaks for it, and where. */
export interface RoomParticipant {
  agentGroupId: string;
  agentGroupName: string;
  /** The fork's adapter identity — `channel_type === instance` (see slack-lib.ts). */
  channelType: string;
  /** Slack `U…` id of that bot, from the registry populated at adapter init. */
  botUserId: string;
  /** Slack `T…` id — the same-workspace assert compares these. */
  teamId: string;
}

/**
 * A room the caller may name: one Slack conversation, one row per bot.
 *
 * Identity is `(teamId, platformId)`, NOT the platform id alone. Slack channel
 * ids are workspace-scoped, and this fork runs several workspaces in one host,
 * so two unrelated channels can carry the same id. Keying on the id alone
 * collapsed them into one room whose name came from whichever row sorted
 * first, made an id lookup silently ambiguous, and could hand `roomInviter`
 * the wrong workspace's bot.
 *
 * `teamId` is null only when NO row's channel type has a registered bot — the
 * workspace is then genuinely unknown, and `roomInviter` refuses such a room
 * rather than guessing.
 */
export interface CandidateRoom {
  /** `slack:C…` — the canonical `messaging_groups.platform_id` form. */
  platformId: string;
  /** Slack `T…` of the workspace these rows live in; null when unknowable. */
  teamId: string | null;
  name: string;
  rows: MessagingGroup[];
}

/**
 * The Slack presence of one agent group.
 *
 * An agent group can in principle be wired on several Slack channel types.
 * `preferTeamId` (the caller's workspace) is the disambiguator, which is also
 * what makes the cross-workspace refusal precise: an agent whose only Slack
 * bot lives in another workspace fails here with a message naming both
 * workspaces, rather than at `conversations.invite` with a Slack error naming
 * neither.
 *
 * A channel type with no entry in the bot registry is NOT usable: the registry
 * is populated by `auth.test` at adapter init, so a missing entry means this
 * host is not actually running that bot. Failing closed here is what keeps the
 * same-workspace assert honest — an unverifiable participant can never be
 * silently treated as same-workspace.
 */
export async function participantForAgentGroup(
  group: AgentGroup,
  preferTeamId: string | null,
  bots: ReadonlyMap<string, SlackBotIdentity> = getKnownSlackBots(),
): Promise<RoomParticipant> {
  const wired = [
    ...new Set(
      (await getMessagingGroupsByAgentGroup(group.id))
        .filter((mg) => mg.channel_type === 'slack' || mg.channel_type.startsWith('slack-'))
        .map((mg) => mg.instance ?? mg.channel_type),
    ),
  ].sort();
  if (wired.length === 0) {
    throw new RoomActionError(
      `agent "${group.name}" has no Slack presence (no Slack wiring found) — wire its bot to a channel first`,
    );
  }

  const running = wired.filter((channelType) => bots.has(channelType));
  if (running.length === 0) {
    throw new RoomActionError(
      `agent "${group.name}" has no running Slack bot on this host (looked at ${wired.join(', ')}) — ` +
        `its adapter has not registered an identity, so its workspace cannot be verified`,
    );
  }

  const chosen = (preferTeamId && running.find((c) => bots.get(c)!.teamId === preferTeamId)) || running[0]!;
  const identity = bots.get(chosen)!;
  return {
    agentGroupId: group.id,
    agentGroupName: group.name,
    channelType: chosen,
    botUserId: identity.userId,
    teamId: identity.teamId,
  };
}

/**
 * The calling agent's own participant record. Its channel type is the
 * session's origin when the request arrived over Slack (the bot the human is
 * actually talking to), and otherwise its wired presence — a task or a2a
 * session has no Slack origin but the agent still has a bot.
 */
export async function callerParticipant(
  session: Session,
  bots: ReadonlyMap<string, SlackBotIdentity> = getKnownSlackBots(),
): Promise<RoomParticipant> {
  const group = await getAgentGroup(session.agent_group_id);
  if (!group) throw new RoomActionError('source agent group not found');

  const originMg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const originChannelType = originMg?.instance ?? originMg?.channel_type;
  if (originChannelType && bots.has(originChannelType)) {
    const identity = bots.get(originChannelType)!;
    return {
      agentGroupId: group.id,
      agentGroupName: group.name,
      channelType: originChannelType,
      botUserId: identity.userId,
      teamId: identity.teamId,
    };
  }
  return participantForAgentGroup(group, null, bots);
}

/**
 * An agent name → its agent group, through the CALLER's destination namespace
 * — the same names `send_message` takes. An agent can therefore only room with
 * agents it can already message; there is no separate room ACL to keep in sync.
 */
export async function resolveAgentByName(callerAgentGroupId: string, name: string): Promise<AgentGroup> {
  const localName = normalizeName(name);
  const dest = await getDestinationByName(callerAgentGroupId, localName);
  if (!dest || dest.target_type !== 'agent') {
    throw new RoomActionError(
      `unknown agent "${name}" — you have no agent destination named "${localName}". ` +
        `Use the names your send_message destinations use.`,
    );
  }
  const group = await getAgentGroup(dest.target_id);
  if (!group) throw new RoomActionError(`agent group behind destination "${localName}" no longer exists`);
  return group;
}

/**
 * Refuse a roster whose bots do not all live in one Slack workspace.
 *
 * Slack user ids are workspace-scoped, so `conversations.invite` with a
 * foreign id fails with an error that names neither the instance nor the
 * workspace. Same shape (and same reason) as `assertSameWorkspace` in the
 * `slack-a2a-rooms` fallback script, which this action automates.
 */
export function assertSameWorkspace(participants: RoomParticipant[]): void {
  const teams = [...new Set(participants.map((p) => p.teamId))];
  if (teams.length <= 1) return;
  const byTeam = teams
    .map(
      (team) =>
        `${team}: ${participants
          .filter((p) => p.teamId === team)
          .map((p) => p.agentGroupName)
          .join(', ')}`,
    )
    .join('; ');
  throw new RoomActionError(
    `participants span ${teams.length} Slack workspaces, and one conversation cannot cross workspaces — ${byTeam}`,
  );
}

/**
 * Group the candidate rows into rooms — one entry per Slack conversation,
 * keyed by `(teamId, platformId)`. See CandidateRoom for why the workspace is
 * half of the key.
 */
export async function candidateRooms(
  callerAgentGroupId: string,
  bots: ReadonlyMap<string, SlackBotIdentity> = getKnownSlackBots(),
): Promise<CandidateRoom[]> {
  const byKey = new Map<string, CandidateRoom>();
  for (const row of await getCandidateRoomRows(callerAgentGroupId)) {
    const teamId = bots.get(row.instance ?? row.channel_type)?.teamId ?? null;
    // NUL is not a legal character in either half, so the composite key
    // cannot be forged by a channel id that happens to contain the separator.
    const key = `${teamId ?? ''}\u0000${row.platform_id}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      if (!existing.name && row.name) existing.name = row.name;
      continue;
    }
    byKey.set(key, { platformId: row.platform_id, teamId, name: row.name ?? '', rows: [row] });
  }
  return [...byKey.values()];
}

/**
 * A Slack channel id supplied where a room name is expected, canonicalized to
 * the `slack:C…` form `messaging_groups.platform_id` carries — or null when
 * the value is an ordinary name.
 *
 * The ambiguity error tells the agent to name the room by its channel id, and
 * the tool's own description repeats that, so the id has to arrive through the
 * PUBLIC `room` argument: it is the only field the tool emits. Accepting it
 * there is safe for the same reason accepting a stamped id is — the result is
 * checked against the caller's candidate set, so an id is a shortcut past name
 * resolution and never past authorization.
 *
 * Slack ids are `C…` for public channels and `G…` for the private ones this
 * module creates; `D…` (a DM) is deliberately not accepted, because a DM is
 * never a room.
 */
export function parseSlackChannelId(value: string): string | null {
  const bare = value.trim().replace(/^slack:/, '');
  return /^[CG][A-Z0-9]{2,}$/.test(bare) ? `slack:${bare}` : null;
}

/**
 * The bot that will do the inviting for an existing room, and its workspace.
 *
 * NOT the caller's bot. A room reaches the candidate set when it is wired to
 * the caller OR to a sibling, and in the second case the caller's own bot is
 * not a member of that Slack channel at all — inviting through it fails with
 * `not_in_channel`. Siblings deliberately keep separate bot identities, so
 * sharing a workgroup never implies sharing channel membership. The room's own
 * rows are the authoritative record of which bots are in it, so the inviter is
 * picked from them, and the room's workspace (not the caller's) is what the
 * newcomer has to match.
 *
 * The caller is preferred when it IS in the room — it is the bot the human is
 * talking to, so its failures are the ones the agent can explain.
 */
export function roomInviter(
  room: CandidateRoom,
  callerAgentGroupId: string,
  bots: ReadonlyMap<string, SlackBotIdentity> = getKnownSlackBots(),
): RoomParticipant {
  const rows = room.rows.filter((r) => bots.has(r.instance ?? r.channel_type));
  if (rows.length === 0) {
    throw new RoomActionError(
      `no bot in room ${room.platformId} is running on this host, so nobody can invite into it ` +
        `(rows: ${room.rows.map((r) => r.instance ?? r.channel_type).join(', ') || 'none'})`,
    );
  }
  return {
    agentGroupId: callerAgentGroupId,
    agentGroupName: 'room member',
    channelType: rows[0]!.instance ?? rows[0]!.channel_type,
    botUserId: bots.get(rows[0]!.instance ?? rows[0]!.channel_type)!.userId,
    teamId: bots.get(rows[0]!.instance ?? rows[0]!.channel_type)!.teamId,
  };
}

/**
 * One participant as an approval-bindable string. Every axis a swap could
 * happen on is in it: the agent group, the adapter instance that speaks for
 * it, the Slack bot user that actually gets invited, and the workspace.
 */
export function rosterStamp(participants: RoomParticipant[]): string[] {
  return participants.map((p) => `${p.agentGroupId}|${p.channelType}|${p.botUserId}|${p.teamId}`).sort();
}

/** Rooms in the caller's candidate set carrying this name. Never throws. */
export async function findRoomsByName(callerAgentGroupId: string, roomName: string): Promise<CandidateRoom[]> {
  const wanted = roomKey(roomName);
  return (await candidateRooms(callerAgentGroupId)).filter((room) => roomKey(room.name) === wanted);
}

/** `"ops room"` and `"Ops-Room"` name the same room. Slack normalizes too.
 *  Exported so the create-marker store keys on the same normalization the
 *  name lookup uses — a marker findable under one spelling and not another
 *  would resurrect exactly the retry hole it exists to close. */
export function roomKey(name: string): string {
  return normalizeName(name);
}

/**
 * The room an `add_to_room` names, resolved WITHIN the caller's candidate set.
 *
 * Three outcomes, and the middle one is fork issue #388: no match is a named
 * error, several matches is a named error LISTING the candidates, and exactly
 * one is the room. Upstream's "newest wins" tie-break is deliberately not
 * ported — silently picking one of two same-named rooms is how an agent grows
 * a conversation the requester never meant.
 */
export async function resolveRoomByName(callerAgentGroupId: string, roomName: string): Promise<CandidateRoom> {
  const matches = await findRoomsByName(callerAgentGroupId, roomName);
  if (matches.length === 0) {
    throw new RoomActionError(
      `no Slack room named "${roomName}" is wired to you or to another agent in your workgroup`,
    );
  }
  if (matches.length > 1) {
    throw new RoomActionError(
      `"${roomName}" is ambiguous — ${matches.length} rooms in your workgroup carry that name ` +
        `(${matches.map((m) => m.platformId).join(', ')}). Ask the operator which one, and name it by its ` +
        `Slack channel id instead.`,
    );
  }
  return matches[0]!;
}

/**
 * The room an approved replay acts on, resolved by ID.
 *
 * Case 12: an approval binds to the room that was carded, not to the name.
 * Re-resolving by name at approve time would let a rename — or a second room
 * created under the same name while the card sat unanswered — redirect the
 * invite. The candidate set is still re-checked live, so an approval for a
 * room the caller has since lost access to no longer executes.
 *
 * The same path also serves a caller that names a Slack channel id directly:
 * accepting a caller-supplied id is safe precisely BECAUSE the id is validated
 * against the same candidate set the name path resolves within — the id is a
 * shortcut past name resolution, never past authorization.
 */
export async function resolveRoomByPlatformId(callerAgentGroupId: string, platformId: string): Promise<CandidateRoom> {
  const matches = (await candidateRooms(callerAgentGroupId)).filter((r) => r.platformId === platformId);
  if (matches.length === 0) {
    throw new RoomActionError(`room ${platformId} is no longer wired to you or to another agent in your workgroup`);
  }
  if (matches.length > 1) {
    // Slack channel ids are workspace-scoped, so one id in two of this host's
    // workspaces is two different rooms. Naming one by id is then genuinely
    // ambiguous, and guessing would be picking a workspace at random.
    throw new RoomActionError(
      `${platformId} names a room in ${matches.length} of this host's Slack workspaces ` +
        `(${matches.map((m) => m.teamId ?? 'unknown workspace').join(', ')}) — name the room instead.`,
    );
  }
  return matches[0]!;
}
