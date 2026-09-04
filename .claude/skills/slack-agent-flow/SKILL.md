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

## What this fork does not do

Upstream automates the Slack half: an agent calls `create_agent` and the host
provisions a Slack app for it through a managed broker, hot-starts the adapter
mid-process, opens the DM and the room, and offers `create_room` /
`add_to_room` MCP tools plus a room canvas. **This fork has declined that
provisioning model** (fork issue #234). It runs one Slack app per agent via
suffix tokens, installed deliberately.

Concretely, the following upstream steps have no equivalent here and are not
part of this flow:

| Upstream step                                                                                       | Here                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Managed app provisioning (`NANOCLAW_INSTALL_TOKEN` / `SLACK_MANAGER_TOKEN`, `apps.manifest.create`) | Install each Slack app by hand — `/add-slack`, or `/clone-as-codex` for a sibling of an existing group |
| `/migrate-slack-agents`                                                                             | Must not be run on this install                                                                        |
| Adapter hot-start after boot                                                                        | Restart the host so the new suffix token registers                                                     |
| `create_room` / `add_to_room` MCP tools                                                             | `pnpm exec tsx scripts/open-a2a-room.ts` from `/slack-a2a-rooms`                                       |
| Room canvas tab holding the room contract                                                           | Not built. Put the roster in the room's first message                                                  |
| `SLACK_A2A_ROOMS` allowlist registration                                                            | Not needed — sibling bots are admitted everywhere                                                      |
| `scripts/slack-agent-flow-finish.ts` resume script                                                  | Each step below is independently re-runnable                                                           |

What carries over unchanged is the _shape_ of the result and the conventions
for running it, which is what the rest of this document covers.

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

From an existing Slack-wired agent, `create_agent` is the sanctioned path: it
creates the folder under `groups/`, the `agent_groups` row and the
bidirectional `send_message` grants, behind an owner/admin approval card. The
agent is reachable by `send_message` as soon as the card is approved.

From the host, the equivalent is:

```bash
ncl groups create --folder <slug> --name "<display name>"
```

It is idempotent on `--folder`, so a re-run after a partial setup is safe.

At this point each agent exists and can be messaged by its siblings. It has no
Slack presence yet — that is the next step, and it is the one an agent cannot
do for itself.

### 3. Install one Slack app per agent

Repeat `/add-slack`'s app-creation steps once per agent, in the same
workspace. For a sibling of an existing group, `/clone-as-codex` (or
`/clone-as-opencode`) already scripts this whole leg including the env keys and
the folder layout — use it rather than redoing the work here.

Naming that works: the agent's name plus a suffix, so Slack's `@`-autocomplete
groups them (`helper`, `helper-research`). The bot display name, the env
suffix and the resulting channelType are independent but should be kept
aligned:

```bash
SLACK_BOT_TOKEN_<SUFFIX>=xoxb-…      # → channelType slack-<suffix-lowercased-with-dashes>
SLACK_APP_TOKEN_<SUFFIX>=xapp-…      # Socket Mode
```

**Add `mpim:write` to the scope list** if the agent will be in a shared room.
`/add-slack`'s list does not include it, and it is what `conversations.open`
needs. Adding a scope requires a reinstall, which mints a new bot token — so
add it before you paste the token, not after.

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
ncl wirings create --messaging-group-id <id> --agent-group-id <agent group id>
```

`/manage-channels` does the same conversationally.

For a **room** wiring, add `--ignored-message-policy accumulate`. `ncl wirings
create` falls back to `drop` when the flag is omitted, and a room agent that
drops every turn it was not mentioned in arrives at its next mention with no
idea what the team discussed.

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

1. `ncl groups list --json` shows every new agent group.
2. A DM to each new bot gets a reply. No reply means step 4 or step 5.
3. In the room, @-mentioning an agent gets a reply. No reply means that
   agent's room wiring (step 6), not its DM.
4. One agent @-mentions another in the room and the second answers. That is
   the sibling-to-sibling path working end to end.

## Conventions worth setting

These are what upstream ships as always-on agent instructions. Here they live
in the container skill `slack-a2a-rooms`, which agents load on demand — put
anything a specific team must always follow in that group's
`standing-instructions.md` instead of assuming it.

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

**`conversations.open` fails with `missing_scope`.** The calling app has no
`mpim:write`. See step 3.

**An agent asks to create a room itself.** There is no `create_room` tool here.
The agent should create the groups and then tell the operator to run the opener
in step 6.
