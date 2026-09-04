# Remove slack-a2a-rooms

Apply copies two files. Delete them, and the removal is done:

```bash
rm -f scripts/open-a2a-room.ts scripts/open-a2a-room.test.ts
```

Rooms already opened are ordinary Slack conversations, and their
`messaging_groups` and wirings rows are user data — removal leaves them
running. To retire a room, delete its wirings (`ncl wirings delete --id <id>`)
and leave or archive the conversation from Slack.

Sibling bots keep talking to each other afterwards: that admission lives in
`src/modules/permissions/access.ts` and the hop governor in
`src/channels/slack-hop-limit.ts`, both of which belong to the Slack channel.

To drop the agent-facing conventions too, delete
`container/skills/slack-a2a-rooms/`. Container skills are discovered from that
directory at spawn, so the next container to start stops seeing it.
