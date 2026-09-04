---
name: slack-a2a-rooms
description: How to behave in a shared Slack room with sibling agents — mention-driven turn taking, who posts an introduction, the bot-to-bot hop budget, and why room history is not shared memory. Read this when you are in a Slack group DM that holds other agents, when a sibling @-mentions you, or before introducing a new sibling in a room.
---

# Sharing a Slack room with sibling agents

A room is one Slack group conversation holding a human and two or more agents,
each with its own bot user. You hear the others' messages the same way you hear
a human's. Everything below is convention, not enforcement — the platform will
not stop you from getting this wrong.

## Answer what you were woken for

A room's wiring decides when you take a turn. On the default setting that is an
explicit mention of you, and nothing else; a room configured for sticky
engagement keeps you in the thread after the first mention, so later turns
reach you without one. Either way the rule is the same: respond to the turn
that woke you, and treat the surrounding conversation as context you have read
rather than a queue you owe replies to.

The same rule points the other way: **a sibling only hears you if you mention
it.** Write `@name` — the display name you see for that agent in the
conversation. You will never see a raw Slack user id: mentions are rewritten to
`@name` on the way in, and your `@name` is rewritten back into a real Slack
mention on the way out. Writing an id-shaped placeholder yourself produces
plain text that notifies nobody. A reply that names a sibling in prose without
mentioning it reaches nobody either.

When the exchange has converged, stop mentioning anyone. That is how a
conversation ends.

## Do not ping-pong

There is a hop budget: after a run of consecutive agent-to-agent turns with no
human message, sibling traffic in that thread is dropped until a human speaks.
Do not treat that ceiling as the stopping rule — self-limit well below it. Do
the work, converge, hand back to the human. Two agents alternating
acknowledgements is the failure mode the budget exists to catch, and hitting it
means a human has to come rescue the thread.

## You introduce the agents you bring in

When a sibling you created or requested joins a room, **you** post the
introduction — nobody else does. Keep it to one or two lines in your own voice:
what the new agent is for, and an `@name` mention of it. No mechanics, no
member list, no setup narration.

## Teams get one room

When the user asks for several agents on one project, they want **one** shared
room with all of them, not one room per pair. Say so if the request is
drifting toward the second. Slack mints a _new_ conversation whenever a group
DM's membership changes, so a room cannot grow in place — an agent added later
means a new room and fresh wiring. Ask for the full roster up front.

## Room history is not memory

Rooms, DMs and channels are separate conversations and do not share history.
Anything durable — a decision, a preference, ongoing state — goes in your
memory directory. Do not assume a sibling read something you said in a
different conversation, and do not assume you will still have the room's
transcript next session.

## Creating siblings

`create_agent` gives you a new agent group and a `send_message` destination you
can address immediately. It does not put that agent in your workgroup, so it
starts out able to hear you but sharing none of your archive, memory or files —
say so when you report the new agent, because an operator has to place it. A Slack bot for that agent is an operator step:
someone installs a second Slack app and adds its token. So when the user asks
for an agent that shows up in Slack, create the group, tell them the Slack side
needs an operator, and name the `slack-agent-flow` skill as where those steps
live. Report the roster and stop there rather than promising a bot or a room.
