/**
 * The one scoped read the room actions need: the CANDIDATE ROOM SET.
 *
 * Fork issue #388. Upstream's `resolveRoomFamily` scans every messaging group
 * on the install and picks the newest name match, which on this fork means an
 * `add_to_room` in workgroup A can name — and then grow — a room that belongs
 * to workgroup B. The candidate set below is the fix: a room is reachable by
 * name only when it is already wired to the caller, or wired to an agent group
 * that shares the caller's workgroup. Nothing outside that set is nameable, so
 * another workgroup's room is unreachable by construction rather than by a
 * comparison someone has to remember to write.
 *
 * `COALESCE(workgroup_id, folder)` is the fork's workgroup identity for an
 * agent group (migration 036 backfills it; a standalone group's workgroup IS
 * its folder), and it is the same expression `assertSameWorkgroupWiring`
 * compares on — the two must agree or a room this resolver hands back would be
 * refused at wiring time.
 */
import { getDb } from '../../db/connection.js';
import type { MessagingGroup } from '../../types.js';

/**
 * An in-flight `create_room`: this caller created this Slack channel for this
 * room name and has not finished wiring it. Migration 074 explains why a name
 * collision alone is not allowed to stand in for this evidence.
 */
export interface SlackRoomCreation {
  platform_id: string;
  room_key: string;
  room_name: string;
  agent_group_id: string;
  /** Slack `T…` the channel was created in — see migration 074. */
  team_id: string;
  /** JSON array: the roster stamp the creating request resolved. */
  roster: string;
  request_id: string | null;
  created_at: string;
}

/** Record a channel the moment Slack returns it, before anything else runs. */
export async function recordRoomCreation(row: SlackRoomCreation): Promise<void> {
  await getDb().run(
    `INSERT INTO slack_room_creations
         (platform_id, room_key, room_name, agent_group_id, team_id, roster, request_id, created_at)
       VALUES (@platform_id, @room_key, @room_name, @agent_group_id, @team_id, @roster, @request_id, @created_at)
     ON CONFLICT(platform_id) DO NOTHING`,
    row,
  );
}

/** The unfinished channel this caller left in this workspace under this key. */
export async function findRoomCreation(
  agentGroupId: string,
  teamId: string,
  roomKey: string,
): Promise<SlackRoomCreation | undefined> {
  return getDb().get<SlackRoomCreation>(
    'SELECT * FROM slack_room_creations WHERE agent_group_id = ? AND team_id = ? AND room_key = ?',
    agentGroupId,
    teamId,
    roomKey,
  );
}

/** Drop the marker once the room is fully wired — it is only ever evidence of
 *  an UNFINISHED create. */
export async function clearRoomCreation(platformId: string): Promise<void> {
  await getDb().run('DELETE FROM slack_room_creations WHERE platform_id = ?', platformId);
}

/**
 * Every Slack group messaging-group row the caller may name, one row per
 * participating bot channel type (the fork keeps a row per bot for one
 * conversation, so a single room appears here as several rows sharing a
 * `platform_id`).
 *
 * Denied rows are excluded: an owner who refused a channel must not have it
 * silently re-adopted by an agent naming it in chat.
 */
export async function getCandidateRoomRows(callerAgentGroupId: string): Promise<MessagingGroup[]> {
  return getDb().all<MessagingGroup>(
    `SELECT DISTINCT mg.*
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE mg.channel_type LIKE 'slack%'
          AND mg.is_group = 1
          AND mg.denied_at IS NULL
          AND mg.platform_id LIKE 'slack:%'
          AND COALESCE(ag.workgroup_id, ag.folder) = (
                SELECT COALESCE(workgroup_id, folder) FROM agent_groups WHERE id = ?
              )
        ORDER BY mg.created_at ASC, mg.id ASC`,
    callerAgentGroupId,
  );
}
