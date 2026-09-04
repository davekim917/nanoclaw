---
name: slack-a2a-rooms
description: Open a Slack agent-to-agent room — a group DM (MPIM) holding a human plus two or more of this host's sibling bots, each hearing the room over its own connection. Ships scripts/open-a2a-room.ts to create the room and prints the ncl commands that wire it to each agent group. Use when the user wants two or more agents talking to each other and to a human in one Slack conversation.
---

# Slack agent-to-agent rooms

Lets two or more of this host's Slack bots talk to each other — and to a human
— in a shared group DM (MPIM). `conversations.open` with
`users=[<human>, <other bot user id>…]` works from a bot token holding
`mpim:write` and returns an `is_mpim` channel; each bot then receives the
others' messages over its own connection as ordinary `message` events with
`channel_type: "mpim"` and `bot_id` set.

Each participating agent needs its own Slack app and its own suffix token —
that is this fork's one-app-per-agent model, and `/clone-as-codex` (or
`/clone-as-opencode`) walks the whole second-app install if a sibling does not
have one yet.

## What this fork does differently

Upstream ships this skill on top of a bot-inbound guard that **drops every
bot-authored message by default** and re-admits it only inside rooms listed in
a `SLACK_A2A_ROOMS` allowlist. This fork inverts that: sibling bots talking to
each other in ordinary channels is a first-class feature, so
`isSiblingBotSender` (`src/modules/permissions/access.ts`) admits them past the
access gate everywhere, and `slack-hop-limit.ts` bounds only a runaway —
per thread, counting only this host's own bots, `SLACK_MAX_BOT_HOPS` default 24.

So there is **no allowlist to register a room in**, and nothing here writes to
`.env`. Opening the room is the whole mechanical step; the rest is wiring the
conversation to each agent group, which is ordinary `ncl` work.

## Requires

- **The Slack channel installed** (`/add-slack`), with at least two bot
  identities configured as suffix tokens (`SLACK_BOT_TOKEN_<SUFFIX>` →
  channelType `slack-<suffix>`; the unsuffixed `SLACK_BOT_TOKEN` is the
  primary instance).
- **The `mpim:write` scope on the app that opens the room.** Only the
  first-listed instance calls `conversations.open`; the others are members and
  need nothing beyond the `mpim:read` and `mpim:history` that `/add-slack`
  already asks for. `mpim:write` is not on that list, so the caller almost
  always needs it added. Pick one app as the opener and grant it there rather
  than to the whole set — the scope carries room-creation capability and a
  reinstall for each app it is added to.

Tell the user:

```nc:operator
For the ONE Slack app that will open rooms (the first name you pass to --instances):
1. Go to api.slack.com/apps → that app → OAuth & Permissions.
2. Under Bot Token Scopes add: mpim:write (keep the existing mpim:read and mpim:history).
3. Reinstall the app to the workspace — this mints a NEW Bot User OAuth Token (xoxb-…).
4. Replace that app's SLACK_BOT_TOKEN_<SUFFIX> value in .env with the new token.

The other participating apps need no change. If you later want a different app to open
rooms, repeat these steps for that one.
```

A reinstall invalidates the old token, so a bot whose `.env` line is not
updated goes silent until it is.

## Apply

### 1. Check the Slack channel is installed

The opener reads tokens through the adapter's suffix convention and its test
drives the adapter's real parser, so both need the installed Slack channel.
The sibling-bot admission is checked too: without it, bot senders would be
held at the access gate and a room would look open but stay silent.

```nc:run effect:check
test -f src/channels/slack.ts && grep -q 'export function parseSlackWorkspaces' src/channels/slack.ts && grep -q 'export function isSiblingBotSender' src/modules/permissions/access.ts
```

### 2. Copy the room opener and its test

This skill ships two files alongside this document; copy them into the tree at
the same relative paths (overwrite; the skill's copies are canonical):

```nc:copy
scripts/open-a2a-room.ts
scripts/open-a2a-room.test.ts
```

- `open-a2a-room.ts` — resolves each named instance's bot token and bot user
  id, opens the MPIM as the first-listed instance, posts an intro, and prints
  the channel id plus the `ncl` commands to wire it.
- `open-a2a-room.test.ts` — pins the opener's `SLACK_BOT_TOKEN_<SUFFIX>`
  derivation against the adapter's real `parseSlackWorkspaces`, so a change to
  either side of that convention goes red here instead of at 2am against a
  live workspace.

### 3. Typecheck and validate

Typecheck first — `tsconfig.scripts.json` covers `scripts/**`, so this leg
guards the opener's typed use of the env reader and the adapter against drift.

```nc:run effect:build
pnpm run typecheck
```

```nc:run effect:test
pnpm exec vitest run scripts/open-a2a-room.test.ts
```

## Opening a room

```bash
pnpm exec tsx scripts/open-a2a-room.ts --instances dana,eli --user <your-slack-user-id>
```

- `--instances` takes two or more instance names, comma separated. Either
  spelling works: the channelType as `ncl` prints it
  (`slack-example-labs-codex`) or the bare suffix (`example-labs-codex`);
  `slack` or `default` means the primary unsuffixed token. The first listed
  instance is the caller — it opens the conversation and posts the intro.
- `--user` is the human's Slack user id (`U…`/`W…`). Without it you get a
  bots-only room, which needs at least three instances, because Slack collapses
  a two-party open into a 1:1 IM.
- The script prints the room's channel id. It writes nothing — not to `.env`,
  not to the database.

## Wiring the room

A room is an ordinary Slack conversation, so it becomes an ordinary messaging
group. Each participating agent needs a wiring on **its own instance's** row:
one room, one `messaging_groups` row per bot, because each bot sees the
conversation under its own channelType.

1. @-mention one of the bots in the room once. The host auto-creates that
   bot's `messaging_groups` row and, on an install with auto-wire on, the
   wiring too.
2. Confirm what exists and fill in the rest:

   ```bash
   ncl messaging-groups list --channel-type slack-<suffix> --json
   ncl wirings create --messaging-group-id <id> --agent-group-id <agent group id> \
     --session-mode per-thread --ignored-message-policy accumulate
   ```

   **Both flags are load-bearing.** A wiring the router creates by itself is
   stamped `session_mode: 'per-thread'` and `ignored_message_policy:
'accumulate'` (`src/router.ts`), but `ncl wirings create` resolves only
   `engage_mode` from the channel declaration and falls back to `shared` and
   `drop` for these two. Omit them and a hand-made room wiring behaves unlike
   every auto-wired one: the room's threads collapse into a single session, and
   every turn the agent was not mentioned in is discarded rather than kept as
   the ambient context the agents are told to rely on.

3. Repeat step 2 for each other participating agent, using that agent's own
   channelType.

`/manage-channels` does the same thing conversationally if you would rather
not assemble the ids by hand.

**Access policy.** Sibling bots are admitted by `isSiblingBotSender` without
any policy change, so a room usually needs none. A human in the room who is
not yet a known sender is governed by the row's `unknown_sender_policy` as
usual; a private room with known humans is a reasonable place to relax it:

```bash
ncl messaging-groups update --id <id> --unknown-sender-policy public
```

## Engagement: every turn needs a mention

An MPIM is a _group_ context in the channel-defaults model (Slack DMs are only
`D…` channels), so the Slack group declaration applies: `engageMode: 'mention'`
(`SLACK_DEFAULTS`, `src/channels/slack.ts`). Each turn an agent takes needs its
own mention — engagement does **not** persist across a thread the way
`mention-sticky` would. Bot-to-bot conversation is therefore mention-driven by
design: agent A's reply reaches agent B only when it @-mentions B, and the
chain continues only as long as each reply mentions the next speaker.

If a room should keep an agent engaged after the first mention, opt in per
wiring — Slack declares `threads: true` for groups, so sticky is not coerced
away here:

```bash
ncl wirings update --id <wiring id> --engage-mode mention-sticky
```

Slack does not emit `app_mention` for bot-authored messages, but mention
detection still works on the message text. Note the direction of translation:
inbound, `<@U…>` tokens are rewritten to `@displayName` before an agent sees
them, and outbound, `src/channels/slack-mentions.ts` rewrites an agent's
`@name` back into Slack's mention token. Agents therefore write `@name`, never
a raw id. Prompt them (group CLAUDE.md / standing instructions) to mention the
sibling they want an answer from, and to stop mentioning anyone once the
exchange has converged. The agent-facing half of these conventions ships as the
container skill of the same name (`container/skills/slack-a2a-rooms/`), which
agents load on demand.

## Troubleshooting

**`conversations.open failed: missing_scope`.** The app you listed FIRST has no
`mpim:write` — that is the one that opens the room, and the only one that needs
the scope. Add it there, reinstall, and update that app's
`SLACK_BOT_TOKEN_<SUFFIX>` line — see Requires above.

**`missing SLACK_BOT_TOKEN_X in .env`.** The instance name does not match a
configured suffix. `ncl messaging-groups list --json` shows the channelTypes
this host actually registered; pass one of those.

**`auth.test failed: invalid_auth`.** The token in `.env` was invalidated by a
reinstall. Copy the current Bot User OAuth Token from the app's OAuth &
Permissions page.

**The room opens but a bot never answers.** Three things to check, in order:
that bot has a wiring on its own instance's `messaging_groups` row (see
Wiring); it was actually @-mentioned; and the thread has not hit
`SLACK_MAX_BOT_HOPS` consecutive sibling turns with no human message, which
pauses sibling traffic in that thread until a human speaks.

**A group DM never reaches a bot at all.** That app is missing `mpim:read` /
`mpim:history` or the `message.mpim` bot event — `/add-slack`'s troubleshooting
section covers it.

## Notes

- **MPIM id prefix.** Older workspaces mint MPIM ids starting with `G`, newer
  ones with `C`. Nothing here branches on the prefix, but the adapter's
  visibility helper calls a `C…` id "workspace"-visible, which is cosmetic.
- **Rooms never grow in place.** Slack mints a _new_ conversation when an MPIM's
  membership changes, so adding an agent later means opening a new room and
  wiring it. Open rooms complete where you can.
- **Cross-host rooms.** The opener only handles tokens that live in this
  host's `.env`. For sibling bots on a different NanoClaw host, run it where
  the first bot's token lives and wire the room on the other host by hand.
- **Edited bot messages** (`message_changed`) are not delivered as new inbound.
- **Attribution.** A bot sender's `users` row takes whatever display name the
  bridge serialized, which is often `unknown` for bot events because
  `event.username` is frequently absent.
