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
