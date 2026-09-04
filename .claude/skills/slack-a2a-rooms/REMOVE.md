# Remove slack-a2a-rooms

Apply copies two files and nothing else — no barrel line, no `.env` key, no
dependency. Rooms already opened are ordinary Slack conversations and their
`messaging_groups` / wirings rows are user data, so removal deliberately
leaves them alone.

1. Delete the copied files:

   ```bash
   rm -f scripts/open-a2a-room.ts scripts/open-a2a-room.test.ts
   ```

No rebuild is needed — nothing under `src/` was touched, and `dist/` never
carried the opener.

Sibling bots keep talking to each other after removal — that admission lives
in `src/modules/permissions/access.ts` and the hop governor in
`src/channels/slack-hop-limit.ts`, neither of which this skill installs. To
retire a room itself, delete its wirings (`ncl wirings delete --id <id>`) and
leave or archive the conversation from Slack.

To also drop the agent-facing conventions, delete
`container/skills/slack-a2a-rooms/`. Container skills are auto-discovered from
that directory at spawn, so the next container to start simply stops seeing
it.
