import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 074 — in-flight `create_room` markers.
 *
 * `create_room` makes two side effects that cannot be one atomic act: a Slack
 * channel, then the `messaging_groups` rows and invites that make it a room.
 * Slack refuses a second channel with the same name, so a run that creates the
 * channel and then fails leaves a state no retry can finish — every re-run
 * dies on `name_taken`.
 *
 * The obvious repair, "adopt any channel already carrying that name", is
 * WRONG, and this table exists because of that. A name collision is not
 * evidence of a previous attempt: the colliding channel may be an established
 * room belonging to a sibling, and adopting it would invite the requested
 * agents into a conversation with its own history — an approval card promising
 * a new private room silently becoming a disclosure of an old one.
 *
 * A row here is the only evidence that counts. It is written immediately after
 * `conversations.create` returns and deleted once the room is fully wired, so
 * its presence means exactly "this caller created this channel for this room
 * name and did not finish". A `name_taken` with no row is a genuine collision
 * with somebody else's channel and is reported as one.
 *
 * Fork-only: upstream has no equivalent (its rooms are MPIMs, which have no
 * names to collide).
 */
export const migration075: Migration = {
  version: 75,
  name: 'slack-room-creations',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS slack_room_creations (
        platform_id    TEXT PRIMARY KEY,
        room_key       TEXT NOT NULL,
        room_name      TEXT NOT NULL,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        -- The workspace the channel was created in. Slack channel ids are
        -- workspace-scoped, and one agent group can hold bots in several
        -- workspaces, so a marker that omitted this would answer a request
        -- originating in workspace B with workspace A's channel id.
        team_id        TEXT NOT NULL,
        -- The roster the creating request resolved. A marker proves the
        -- channel is this caller's unfinished creation; it does NOT prove the
        -- channel is right for a LATER request under the same name. Without
        -- this, a second request naming different agents would adopt a channel
        -- already holding the first request's participants and their messages
        -- — the same disclosure the marker exists to prevent, one step later.
        roster         TEXT NOT NULL,
        request_id     TEXT,
        created_at     TEXT NOT NULL
      );

      -- The lookup the adopt branch makes: "did THIS caller, in THIS
      -- workspace, leave a channel half-built under THIS name?". room_key is
      -- the normalized name, so the lookup matches however it was spelled.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_room_creations_caller_key
        ON slack_room_creations(agent_group_id, team_id, room_key);
    `);
  },
};
