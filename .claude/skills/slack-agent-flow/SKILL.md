---
name: slack-agent-flow
description: Give one or more agents their own Slack bot and put a team of them in a single shared room. Walks the fork's flow end to end — create the agent groups, install a Slack app per agent as a suffix token, restart, wire each bot's DM, then open one shared room. Use for "build me a team of agents in Slack", "give this agent its own Slack bot", or "put these agents in a room together".
---

# Slack agent flow

Turns "create a designer, a builder and a reviewer for this project" into a
working Slack construct: each agent as its own bot with its own DM, plus one
shared room holding all of them and the human.

This is an operational skill — it installs no code. Everything it does is
`ncl` work, `/add-slack`'s app install repeated per agent, and one run of the
`/slack-a2a-rooms` opener.

Each agent gets its own Slack app, installed by hand and held in `.env` as a
suffix token (`SLACK_BOT_TOKEN_<SUFFIX>`). Step 3 walks that install, once per
agent. An agent that asks for a room gets one from the opener script in step 6,
run by an operator.

## Prerequisites

- The Slack channel installed (`/add-slack`) with at least one working bot.
- `/slack-a2a-rooms` applied, if the team gets a shared room.
- Admin rights in the Slack workspace to create an app per agent.
- An owner or admin in `user_roles` to approve `create_agent` and the wiring
  changes.

## The flow

### 1. Settle the roster first

Slack group DMs never grow in place — changing the membership mints a **new**
conversation — so a room added to later means re-wiring. Ask for the whole
team up front: how many agents, what each is for, and whether they share one
room or work only in DMs.

### 2. Create each agent group

From an existing Slack-wired agent, `create_agent` is the path that produces a
working sibling in one step, behind an owner/admin approval card. It creates
the folder under `groups/`, the `agent_groups` row, the container config, the
role text as `standing-instructions.md`, and the `agent_destinations` grants in
both directions. The agent is reachable by `send_message` as soon as the card
is approved. Pass each agent's purpose from step 1 as its `instructions`.

`ncl groups create` is **not** the same thing, despite the name:

```bash
ncl groups create --folder <slug> --name "<display name>"
```

That provisions the folder and the `container_configs` row and stops there. It
takes no instructions, so the group boots with no role, and it writes no
destinations, so no sibling can reach it by `send_message`. Use it only for an
agent that will be addressed over a channel, or finish the job by hand:

```bash
# the role text create_agent would have staged
$EDITOR groups/<slug>/standing-instructions.md

# the grants create_agent would have opened, one per direction and per sibling
ncl destinations add --agent-group-id <new group id> --local-name <sibling name> \
  --target-type agent --target-id <sibling group id>
ncl destinations add --agent-group-id <sibling group id> --local-name <new name> \
  --target-type agent --target-id <new group id>
```

The two paths behave differently on a re-run, which matters when step 2 half
finishes. `ncl groups create` is idempotent on `--folder`: it returns the
existing group and repairs its filesystem. `create_agent` is not. It picks a
fresh folder rather than reusing one (`designer` becomes `designer-2`), and the
scoped-env token guard then refuses that folder because `DESIGNER_2` overlaps
`DESIGNER`'s variable prefix. So a `create_agent` re-run stops with a folder
collision error naming the group it just tried to work around.

Resume by hand instead. Find the group that already exists, then run the
`standing-instructions.md` edit and the two `ncl destinations add` commands
above against its id:

```bash
ncl groups list --json
```

At this point each agent exists. It has no Slack presence yet — that is
step 3, and it is the one an agent cannot do for itself.

Put the whole team in **one workgroup** before any of them spawns. The
workgroup is the data-pool boundary — shared chat archive, the one memory
canon, shared files, workgroup-level OneCLI secrets ([docs/workgroups.md](../../../docs/workgroups.md)).
Neither creation path sets it: `createAgentGroup`'s INSERT omits
`workgroup_id`, so `resolveWorkgroupIdAtSpawn` falls back to the folder name
and the first spawn writes each agent into a workgroup of one. Routed messages
between them still work, which is what makes this easy to miss — the agents
talk and share nothing.

`workgroup_id` lives on the `agent_groups` row and no `ncl` verb owns it, so
this is the query wrapper's job (the same way `/clone-as-codex` does it):

```bash
# the workgroup the team joins — an existing agent's, or a new id of your choosing
WG=$(pnpm exec tsx scripts/q.ts data/v2.db \
  "select coalesce(workgroup_id, folder) from agent_groups where folder='<source folder>'" | tr -d '\n')

# stop here if the folder did not match a row — see below for why this matters
[ -n "$WG" ] || { echo "no agent group with folder '<source folder>'"; exit 1; }

# one per new agent, before its first spawn
pnpm exec tsx scripts/q.ts data/v2.db \
  "update agent_groups set workgroup_id='${WG}' where folder='<new folder>'"
```

Check `WG` before running any update. A folder that matches no row makes the
select print nothing and still exit 0, and `scripts/q.ts` opens the database
without `PRAGMA foreign_keys`, so the update writes an empty `workgroup_id`
over every new agent instead of being refused by the column's reference to
`workgroups(id)`. Nothing surfaces until first spawn, where the reconciler
tries to insert that empty id and `workgroups.id`'s `CHECK (id GLOB '[a-z]*')`
rejects it. Every spawn then fails the same way, so the agents are unreachable
rather than merely misfiled.

An agent that has already spawned is sitting in its own workgroup of one, and
rehoming it is a data migration rather than a column edit. Its memory canon is
a real directory at `data/workgroups/<its own folder>/memory`, reached through
a `groups/<folder>/memory` symlink that points at the container path and so
looks identical before and after the move. Changing the column and restarting
re-points that symlink at the shared canon and leaves the old directory behind:
`prepareWorkgroupMemoryMember` treats the unchanged link plus an existing
target as already correct, and it never merges the two trees. The agent comes
back healthy with none of what it wrote.

Migrate the canon first, then set the column:

```bash
pnpm exec tsx scripts/migrate-workgroup-memory.ts inventory \
  --workgroup <its own folder> --report /tmp/wg-memory.json
pnpm exec tsx scripts/migrate-workgroup-memory.ts apply --report /tmp/wg-memory.json
```

Read the inventory before applying it, and keep the report: `rollback --report`
reverses the apply. Restart the group once the column is set
(`ncl groups restart --id <group id>`) so the next spawn mounts the shared
canon.

### 3. Install one Slack app per agent

Repeat `/add-slack`'s app-creation steps once per agent, in the same
workspace. Name each bot after its agent plus a suffix so Slack's
`@`-autocomplete groups them (`helper`, `helper-research`). The bot display
name, the env suffix and the resulting channelType are independent but should
be kept aligned:

```bash
SLACK_BOT_TOKEN_<SUFFIX>=xoxb-…      # → channelType slack-<suffix-lowercased-with-dashes>
SLACK_APP_TOKEN_<SUFFIX>=xapp-…      # Socket Mode
```

`/clone-as-codex` and `/clone-as-opencode` are a different entry point, not a
shortcut for this step: each one creates its own new agent group, folder and
container config alongside the app. Reach for one **instead of** step 2 when
what you want is a provider sibling of an existing agent. For the groups step 2
created, do the app install here and read `/clone-as-codex`'s env-var section
as the reference for the token layout.

Add `mpim:write` to exactly **one** app — the one that will open rooms, which
is the first name you pass to `--instances` in step 6. The rest need only the
`mpim:read` and `mpim:history` that `/add-slack` already asks for. Adding a
scope requires a reinstall, which mints a new bot token, so add it before you
paste that app's token rather than after.

### 4. Restart the host

The adapter reads the suffix tokens at startup. There is no hot-start here, so
a new bot is invisible until a restart. Use the install's own helper — it picks
launchd or systemd, derives the unit from the install slug, and waits for the
`ncl` socket so the wiring step below does not race the restart:

```bash
bash setup/lib/restart.sh
```

Confirm each new channelType registered:

```bash
grep 'Slack workspace connecting' logs/nanoclaw.log | tail
```

### 5. Wire each agent's DM

Have the human DM each new bot once. The host auto-creates the
`messaging_groups` row; on an install with auto-wire on, the wiring too.
Confirm and fill in what is missing:

```bash
ncl messaging-groups list --channel-type slack-<suffix> --json
ncl wirings create --messaging-group-id <id> --agent-group-id <agent group id> \
  --session-mode per-thread --ignored-message-policy accumulate
```

`/manage-channels` does the same conversationally.

**Both flags are load-bearing, on DM and room wirings alike.** A wiring the
router creates by itself is stamped `session_mode: 'per-thread'` and
`ignored_message_policy: 'accumulate'` (`src/router.ts`), but `ncl wirings
create` resolves only `engage_mode` from the channel declaration and falls back
to `shared` and `drop` for these two. So a hand-made wiring silently behaves
differently from every auto-wired one: every Slack thread collapses into one
session, and each turn the agent was not addressed in is discarded instead of
being kept as background context.

### 6. Open one shared room

One room for the whole team, not one per pair:

```bash
pnpm exec tsx scripts/open-a2a-room.ts --instances <agent-a>,<agent-b>,<agent-c> --user <human U…>
```

Then wire the room to each agent group. Each bot sees the conversation under
its **own** channelType, so the room needs one `messaging_groups` row and one
wiring per participating agent. `/slack-a2a-rooms` covers the wiring and the
access-policy detail.

### 7. Introduce the team

The agent that requested the team posts the introduction in the room — one or
two lines naming what each new agent is for and mentioning it as `@name`.
Agents never handle raw Slack ids: inbound mentions are rewritten to `@name`
before they reach the model, and `src/channels/slack-mentions.ts` rewrites an
agent's `@name` back into Slack's mention token on the way out. Nothing posts
the introduction automatically.

## Verify

Walk it once, in this order — each check tells you which step to go back to:

1. `ncl groups list --json` shows every new agent group, and
   `pnpm exec tsx scripts/q.ts data/v2.db "select folder, workgroup_id from agent_groups"`
   shows one shared `workgroup_id` across the team rather than one per folder.
2. A DM to each new bot gets a reply. No reply means step 4 or step 5.
3. In the room, @-mentioning an agent gets a reply. No reply means that
   agent's room wiring (step 6), not its DM.
4. One agent @-mentions another in the room and the second answers. That is
   the sibling-to-sibling path working end to end.

## Conventions worth setting

The agent-facing versions of these live in the container skill
`slack-a2a-rooms`, which agents load on demand. Put anything a specific team
must always follow in that group's `standing-instructions.md`, where it becomes
standing context rather than something the agent has to go and read.

- **Mention-driven turn taking.** A room is a group context, so the Slack group
  declaration applies: `engageMode: 'mention'`, which means every turn needs its
  own mention — engagement does not persist across the thread. Opt a room into
  sticky engagement per wiring with `ncl wirings update --engage-mode
mention-sticky` if that is what the team wants. A reply that names a sibling
  in prose without mentioning it reaches nobody.
- **Self-limit the ping-pong.** Consecutive sibling turns with no human message
  are capped per thread by `SLACK_MAX_BOT_HOPS` (default 24), but that is a
  backstop, not the stopping rule. Converge and hand back to the human.
- **Room history is not shared memory.** Rooms and DMs are separate
  conversations. Durable facts go in each agent's memory directory.

## Troubleshooting

**A new bot never connects after the restart.** Its suffix is missing a second
credential. The adapter skips a workspace that has a bot token but neither an
app token nor a signing secret, and logs `Slack workspace has no signing secret
and no app token, skipping`.

**The bot connects but never answers a DM.** No wiring on its
`messaging_groups` row (step 5), or the row's `unknown_sender_policy` is
holding the human as an unknown sender. `ncl messaging-groups list --json`
shows both.

**A sibling's message in the room reaches nobody.** Almost always a missing
`@name` mention rather than a permissions problem — sibling bots are admitted
past the access gate everywhere on this fork.

**`conversations.open` fails with `missing_scope`.** The app listed first in
`--instances` is the one that opens the room, and it needs `mpim:write`. Add
the scope there, reinstall, and update that app's token line. See step 3.

**An agent says it will open a room and then nothing happens.** Room creation
is an operator step: the agent creates the groups and hands you the roster, and
you run the opener in step 6. Tell it to report the roster and stop.
